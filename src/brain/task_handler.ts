import { logger } from '../common/logger.js';
import { brainSkills } from './skills.js';
import { Message, ForgeInput, ClassificationResult, FeedbackType } from '../common/types.js';
import { confidenceRouter } from './confidence_router.js';
import { synthesizer } from './synthesizer.js';
import { subQuestionDecomposer } from './subquestion_decomposer.js';
import { sourceAgentOrchestrator } from './source_agents.js';
import { semanticCache } from './semantic_cache.js';
import { feedbackLoop } from './feedback_loop.js';
import { multiAgentOrchestrator } from './multi_agent_orchestrator.js';

export interface TaskResult {
  success: boolean;
  response: string;
  escalated?: boolean;
  forgeInput?: ForgeInput;
  metadata?: Record<string, any>;
}

const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.6');
const CACHE_ENABLED = process.env.CACHE_ENABLED !== 'false';
const USE_MULTI_AGENT = process.env.USE_MULTI_AGENT !== 'false';

export class TaskHandler {
  private static instance: TaskHandler;
  private llmClient: any = null;
  private systemPrompt: string = '';
  private lastResponse: { query: string; category: string; source: string; response: string } | null = null;

  private constructor() {}

  static getInstance(): TaskHandler {
    if (!TaskHandler.instance) {
      TaskHandler.instance = new TaskHandler();
    }
    return TaskHandler.instance;
  }

  setLLMClient(client: any): void {
    this.llmClient = client;
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  async handle(messages: Message[], _sessionId: string): Promise<TaskResult> {
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== 'user') {
      return { success: false, response: 'No user message found' };
    }

    const input = lastMessage.content || '';
    logger.info('task_handler', `Processing: "${input.slice(0, 100)}"`);

    if (this.lastResponse) {
      const feedbackType = feedbackLoop.detectFeedback(input);
      if (feedbackType && messages.length >= 2) {
        return this.handleFeedback(input, feedbackType, messages);
      }
    }

    const selfQuery = input.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    if (/que (sabes|puedes) (hacer|usar)|cuales son tus (habilidades|skills|herramientas)|list.*skills|que herramientas|what can you do|que (cosas|tareas) (puedes|sabes)|de que eres capaz|que podes hacer|mostra.*(skills|herramientas)/i.test(selfQuery)) {
      const skills = brainSkills.list();
      const skillList = skills.map(s => ` • ${s.description}`).join('\n');
      return {
        success: true,
        response: `¡Hola! Soy Atlas, tu agente AI. Estas son las cosas que sé hacer:\n\n${skillList}\n\n¿En qué te ayudo?`,
      };
    }

    try {
      const decomposition = await subQuestionDecomposer.decompose(input);
      logger.info('task_handler', `Decomposition: isCompound=${decomposition.isCompound}, subQs=${decomposition.subQuestions.length}, strategy=${decomposition.strategy}`);

      if (decomposition.subQuestions.length === 1) {
        return this.processSingleQuery(messages, input, decomposition.subQuestions[0].classification);
      }

      let results: Array<{ subQuestion: string; result: { source: string; content: string; confidence: number }; synthesizedResponse: string }>;

      if (USE_MULTI_AGENT) {
        const orchestratorResults = await multiAgentOrchestrator.orchestrateCompound(
          decomposition.subQuestions,
          messages,
          decomposition.strategy as 'sequential' | 'parallel' | 'pipeline',
        );
        results = orchestratorResults.map(r => ({
          subQuestion: r.subQuestion,
          result: { source: r.result.source, content: r.result.content, confidence: r.result.confidence },
          synthesizedResponse: r.synthesizedResponse,
        }));
      } else {
        results = [];
        for (const sq of decomposition.subQuestions) {
          const taskResult = await this.processSingleQuery(messages, sq.text, sq.classification);
          results.push({
            subQuestion: sq.text,
            result: { source: taskResult.metadata?.source || 'unknown', content: taskResult.response, confidence: taskResult.metadata?.confidence || 0 },
            synthesizedResponse: taskResult.response,
          });
        }
      }

      const finalResponse = this.mergeSubResponses(results.map(r => ({
        subQuestion: r.subQuestion,
        response: r.synthesizedResponse,
        category: decomposition.subQuestions.find(sq => sq.text === r.subQuestion)?.classification.category || 'general',
        source: r.result.source,
      })));

      this.lastResponse = {
        query: input,
        category: 'compound',
        source: 'multi_agent',
        response: finalResponse,
      };

      return {
        success: true,
        response: finalResponse,
        metadata: {
          category: 'compound',
          subQuestions: decomposition.subQuestions.length,
          strategy: decomposition.strategy,
          subResults: results.map(r => ({ source: r.result.source })),
        },
      };
    } catch (err) {
      logger.error('task_handler', `Classification/routing failed: ${err}`);

      if (this.llmClient && this.systemPrompt) {
        logger.info('task_handler', 'Falling back to direct LLM after error');
        const workingMessages: any[] = [
          { role: 'system', content: this.systemPrompt },
          ...messages.slice(-6).map(m => ({ role: m.role, content: m.content ?? '' })),
        ];
        try {
          const response = await this.llmClient.chatCompletion(workingMessages, 1024);
          return {
            success: true,
            response: this.cleanupFillers(response),
            metadata: { source: 'llm_error_fallback' },
          };
        } catch {}
      }

      return {
        success: true,
        response: 'Procesando con Forge...',
        escalated: true,
        forgeInput: {
          problem: input,
          context: messages.slice(-10).map(m => `${m.role}: ${m.content}`).join('\n'),
          mode: 'decision',
        },
      };
    }
  }

  private async handleFeedback(input: string, feedbackType: FeedbackType, messages: Message[]): Promise<TaskResult> {
    if (!this.lastResponse) {
      return this.processSingleQuery(messages, input, (await require('./query_classifier.js').queryClassifier.classify(input)));
    }

    logger.info('task_handler', `Feedback detected: ${feedbackType} for previous response`);

    feedbackLoop.recordFeedback(
      this.lastResponse.query,
      this.lastResponse.category as any,
      this.lastResponse.source as any,
      this.lastResponse.response,
      feedbackType,
      input,
    );

    switch (feedbackType) {
      case 'correction':
      case 'clarification': {
        const originalQuery = this.lastResponse.query;
        const classification = await require('./query_classifier.js').queryClassifier.classify(originalQuery);
        const sourcePlan = confidenceRouter.getSourcePlan(classification);
        const adjustedPlan = sourcePlan.map(sp => ({
          ...sp,
          confidence: feedbackLoop.getAdjustedConfidence(classification.category, sp.source, sp.confidence),
        })).sort((a, b) => b.confidence - a.confidence);

        if (adjustedPlan.length > 1 && this.lastResponse) {
          const nextSource = adjustedPlan.find(sp => sp.source !== this.lastResponse!.source);
          if (nextSource && nextSource.confidence >= CONFIDENCE_THRESHOLD) {
            logger.info('task_handler', `Retrying with different source: ${nextSource.source} (original was: ${this.lastResponse.source})`);
            const result = await sourceAgentOrchestrator.executeSource(nextSource, messages, originalQuery, classification);
            const synthesized = await synthesizer.synthesize(result, classification.category, originalQuery);
            this.lastResponse = { query: originalQuery, category: classification.category, source: nextSource.source, response: synthesized };
            return {
              success: true,
              response: `Probé con otra fuente:\n\n${synthesized}`,
              metadata: { category: classification.category, source: nextSource.source, feedbackRetried: true },
            };
          }
        }

        if (this.llmClient && this.systemPrompt) {
          const workingMessages: any[] = [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: originalQuery },
            { role: 'assistant', content: this.lastResponse.response },
            { role: 'user', content: `Eso no es correcto. ${input}. Respondé de nuevo mejor.` },
          ];
          const response = await this.llmClient.chatCompletion(workingMessages, 1024);
          this.lastResponse = { query: originalQuery, category: classification.category, source: 'llm_retry', response };
          return {
            success: true,
            response: this.cleanupFillers(response),
            metadata: { category: classification.category, source: 'llm_retry', feedbackType },
          };
        }

        return {
          success: true,
          response: 'Entendido, voy a tener en cuenta tu corrección para la próxima.',
          metadata: { feedbackRecorded: true },
        };
      }

      case 'confirmation':
        return {
          success: true,
          response: '¡Genial! Si necesitás algo más, decime.',
          metadata: { feedbackRecorded: true },
        };

      case 'rejection':
        return {
          success: true,
          response: 'Entiendo, lo voy a tener en cuenta. Si querés, probá reformular la pregunta y lo intento de nuevo.',
          metadata: { feedbackRecorded: true },
        };

      default:
        return this.processSingleQuery(messages, input, (await require('./query_classifier.js').queryClassifier.classify(input)));
    }
  }

  private async processSingleQuery(
    messages: Message[],
    input: string,
    classification: ClassificationResult,
  ): Promise<TaskResult> {
    logger.info('task_handler', `Single query: "${input.slice(0, 80)}" → ${classification.category} (${classification.confidence}) via ${classification.source}`);

    if (CACHE_ENABLED) {
      const cached = semanticCache.get(input, classification.category);
      if (cached) {
        logger.info('task_handler', `Cache HIT for: "${input.slice(0, 60)}"`);
        this.lastResponse = { query: input, category: classification.category, source: cached.result.source, response: cached.synthesizedResponse };
        return {
          success: true,
          response: cached.synthesizedResponse,
          metadata: {
            category: classification.category,
            source: cached.result.source,
            confidence: cached.result.confidence,
            fromCache: true,
          },
        };
      }
    }

    const previousCorrection = feedbackLoop.getCorrectionForQuery(input, classification.category);
    if (previousCorrection) {
      logger.info('task_handler', `Found previous correction for similar query`);
    }

    const sourcePlan = confidenceRouter.getSourcePlan(classification);
    const adjustedPlan = sourcePlan.map(sp => ({
      ...sp,
      confidence: feedbackLoop.getAdjustedConfidence(classification.category, sp.source, sp.confidence),
    }));
    logger.info('task_handler', `Source plan: ${adjustedPlan.map(s => `${s.source}(${s.confidence.toFixed(2)})`).join(' → ')}`);

    for (const source of adjustedPlan) {
      if (source.confidence < CONFIDENCE_THRESHOLD) {
        logger.info('task_handler', `Skipping source ${source.source} (confidence ${source.confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLD})`);
        continue;
      }

      let result;
      if (USE_MULTI_AGENT) {
        result = await multiAgentOrchestrator.orchestrate(input, messages, classification);
      } else {
        result = await sourceAgentOrchestrator.executeSource(source, messages, input, classification);
      }

      if (result.confidence >= CONFIDENCE_THRESHOLD) {
        const synthesized = await synthesizer.synthesize(result, classification.category, input);
        logger.info('task_handler', `Response from ${result.source} (confidence: ${result.confidence})`);

        if (CACHE_ENABLED && classification.category !== 'tool') {
          semanticCache.store(input, classification.category, result, synthesized);
        }

        this.lastResponse = { query: input, category: classification.category, source: result.source, response: synthesized };

        return {
          success: true,
          response: synthesized,
          metadata: {
            category: classification.category,
            source: result.source,
            confidence: result.confidence,
            classificationSource: classification.source,
            subIntent: classification.subIntent,
          },
        };
      }

      logger.info('task_handler', `Source ${source.source} returned low confidence (${result.confidence}), trying next...`);
    }

    if (this.llmClient && this.systemPrompt) {
      logger.info('task_handler', 'All sources below threshold, falling back to direct LLM');
      const workingMessages: any[] = [
        { role: 'system', content: this.systemPrompt },
        ...messages.slice(-6).map(m => ({ role: m.role, content: m.content ?? '' })),
      ];
      const response = await this.llmClient.chatCompletion(workingMessages, 1024);
      this.lastResponse = { query: input, category: classification.category, source: 'llm_fallback', response };
      return {
        success: true,
        response: this.cleanupFillers(response),
        metadata: { category: classification.category, source: 'llm_fallback' },
      };
    }

    return {
      success: true,
      response: 'No pude resolver eso. Probá reformular la pregunta.',
      metadata: { category: classification.category },
    };
  }

  private mergeSubResponses(
    responses: Array<{ subQuestion: string; response: string; category: string; source: string }>,
  ): string {
    if (responses.length === 1) {
      return responses[0].response;
    }

    const allGeneral = responses.every(r => r.category === 'general');

    if (allGeneral && responses.length <= 2) {
      return responses.map(r => r.response).join('\n\n');
    }

    if (responses.length <= 3) {
      const parts = responses.map(r => {
        if (!allGeneral) {
          return `Sobre "${r.subQuestion.replace(/\?/g, '')}":\n${r.response}`;
        }
        return r.response;
      });
      return parts.join('\n\n');
    }

    const summaryParts = responses.map(r => {
      const brief = r.response.length > 300 ? r.response.slice(0, 300) + '...' : r.response;
      return `• ${brief}`;
    });
    return summaryParts.join('\n\n');
  }

  private cleanupFillers(text: string): string {
    return text
      .replace(/¿Puedo ayudarte con algo más\?/gi, '')
      .replace(/Avísame si necesitas algo\.?/gi, '')
      .replace(/Estoy aquí para ayudarte\.?/gi, '')
      .replace(/No dudes en preguntar\.?/gi, '')
      .trim() || text;
  }
}

export const taskHandler = TaskHandler.getInstance();
