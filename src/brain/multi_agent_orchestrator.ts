import { logger } from '../common/logger.js';
import { ClassificationResult, SourcePlan, RoutedResult, AgentTask, OrchestratorPlan } from '../common/types.js';
import { sourceAgentOrchestrator } from './source_agents.js';
import { confidenceRouter } from './confidence_router.js';
import { feedbackLoop } from './feedback_loop.js';
import { semanticCache } from './semantic_cache.js';
import { synthesizer } from './synthesizer.js';
import { SubQuestion } from './subquestion_decomposer.js';
import { generateId } from '../common/utils.js';

export class MultiAgentOrchestrator {
  private static instance: MultiAgentOrchestrator;
  private activeTasks: Map<string, AgentTask> = new Map();
  private maxConcurrent = 3;
  private taskTimeoutMs = 30000;

  private constructor() {}

  static getInstance(): MultiAgentOrchestrator {
    if (!MultiAgentOrchestrator.instance) {
      MultiAgentOrchestrator.instance = new MultiAgentOrchestrator();
    }
    return MultiAgentOrchestrator.instance;
  }

  setLLMClient(_client: any): void {
  }

  setSystemPrompt(_prompt: string): void {
  }

  async orchestrate(
    input: string,
    messages: any[],
    classification: ClassificationResult,
  ): Promise<RoutedResult> {
    const plan = this.createPlan(input, classification);
    logger.info('multi_agent_orchestrator', `Plan: ${plan.tasks.length} tasks, strategy: ${plan.strategy}, merge: ${plan.mergeStrategy}`);

    switch (plan.strategy) {
      case 'parallel':
        return this.executeParallel(plan, messages, input, classification);
      case 'pipeline':
        return this.executePipeline(plan, messages, input, classification);
      case 'sequential':
      default:
        return this.executeSequential(plan, messages, input, classification);
    }
  }

  async orchestrateCompound(
    subQuestions: SubQuestion[],
    messages: any[],
    strategy: 'sequential' | 'parallel' | 'pipeline',
  ): Promise<Array<{ subQuestion: string; result: RoutedResult; synthesizedResponse: string }>> {
    const results: Array<{ subQuestion: string; result: RoutedResult; synthesizedResponse: string }> = [];

    if (strategy === 'parallel') {
      const promises = subQuestions.map(async sq => {
        const cached = semanticCache.get(sq.text, sq.classification.category);
        if (cached) {
          return { subQuestion: sq.text, result: cached.result, synthesizedResponse: cached.synthesizedResponse };
        }

        const plan = this.createPlan(sq.text, sq.classification);
        const result = await this.executeSequential(plan, messages, sq.text, sq.classification);
        const synthesized = await synthesizer.synthesize(result, sq.classification.category, sq.text);
        return { subQuestion: sq.text, result, synthesizedResponse: synthesized };
      });

      const settled = await Promise.allSettled(promises);
      for (const r of settled) {
        if (r.status === 'fulfilled') {
          results.push(r.value);
        }
      }
    } else if (strategy === 'pipeline') {
      let contextAccumulator = '';
      for (const sq of subQuestions) {
        const cached = semanticCache.get(sq.text, sq.classification.category);
        if (cached) {
          results.push({ subQuestion: sq.text, result: cached.result, synthesizedResponse: cached.synthesizedResponse });
          contextAccumulator += cached.synthesizedResponse + '\n';
          continue;
        }

        const enrichedMessages = [
          ...messages,
          ...(contextAccumulator ? [{ role: 'assistant' as const, content: contextAccumulator }] : []),
        ];
        const plan = this.createPlan(sq.text, sq.classification);
        const result = await this.executeSequential(plan, enrichedMessages, sq.text, sq.classification);
        const synthesized = await synthesizer.synthesize(result, sq.classification.category, sq.text);
        results.push({ subQuestion: sq.text, result, synthesizedResponse: synthesized });
        contextAccumulator += synthesized + '\n';
      }
    } else {
      for (const sq of subQuestions) {
        const cached = semanticCache.get(sq.text, sq.classification.category);
        if (cached) {
          results.push({ subQuestion: sq.text, result: cached.result, synthesizedResponse: cached.synthesizedResponse });
          continue;
        }

        const plan = this.createPlan(sq.text, sq.classification);
        const result = await this.executeSequential(plan, messages, sq.text, sq.classification);
        const synthesized = await synthesizer.synthesize(result, sq.classification.category, sq.text);
        results.push({ subQuestion: sq.text, result, synthesizedResponse: synthesized });
      }
    }

    return results;
  }

  createPlan(input: string, classification: ClassificationResult): OrchestratorPlan {
    const sourcePlan = confidenceRouter.getSourcePlan(classification);

    const adjustedPlan = sourcePlan.map(sp => ({
      ...sp,
      confidence: feedbackLoop.getAdjustedConfidence(classification.category, sp.source, sp.confidence),
    })).filter(sp => sp.confidence >= 0.3);

    if (adjustedPlan.length === 0) {
      adjustedPlan.push({ source: 'llm' as const, confidence: 0.5 });
    }

    const needsParallel = this.shouldRunParallel(input, classification, adjustedPlan);

    const tasks: AgentTask[] = adjustedPlan.map(_sp => ({
      id: generateId(),
      input,
      category: classification.category,
      classification,
      status: 'pending' as const,
      startTime: 0,
      retries: 0,
    }));

    const strategy = needsParallel ? 'parallel' : 'sequential';
    const mergeStrategy = this.selectMergeStrategy(classification, adjustedPlan);

    return { tasks, strategy, mergeStrategy };
  }

  private shouldRunParallel(_input: string, classification: ClassificationResult, sourcePlan: SourcePlan[]): boolean {
    if (classification.category === 'web' && sourcePlan.length >= 2) return true;
    if (classification.category === 'project' && sourcePlan.length >= 2) return true;
    if (sourcePlan.length > 1 && sourcePlan.every(s => s.confidence >= 0.6)) return true;
    return false;
  }

  private selectMergeStrategy(classification: ClassificationResult, sourcePlan: SourcePlan[]): OrchestratorPlan['mergeStrategy'] {
    if (classification.category === 'web') return 'summarize';
    if (classification.category === 'project') return 'concat';
    if (sourcePlan.length === 1) return 'best_confidence';
    return 'best_confidence';
  }

  private async executeSequential(
    _plan: OrchestratorPlan,
    messages: any[],
    input: string,
    classification: ClassificationResult,
  ): Promise<RoutedResult> {
    const sourcePlan = confidenceRouter.getSourcePlan(classification);
    const adjustedPlan = sourcePlan.map(sp => ({
      ...sp,
      confidence: feedbackLoop.getAdjustedConfidence(classification.category, sp.source, sp.confidence),
    })).sort((a, b) => b.confidence - a.confidence);

    for (const source of adjustedPlan) {
      const task: AgentTask = {
        id: generateId(),
        input,
        category: classification.category,
        classification,
        status: 'running',
        startTime: Date.now(),
        retries: 0,
      };
      this.activeTasks.set(task.id, task);

      try {
        const result = await Promise.race([
          sourceAgentOrchestrator.executeSource(source, messages, input, classification),
          this.createTimeout(this.taskTimeoutMs),
        ]);

        task.status = 'completed';
        task.endTime = Date.now();
        task.result = result;
        this.activeTasks.delete(task.id);

        if (result.confidence >= 0.5) {
          return result;
        }

        logger.info('multi_agent_orchestrator', `Source ${source.source} low confidence (${result.confidence}), next...`);
      } catch (err) {
        task.status = 'failed';
        task.endTime = Date.now();
        this.activeTasks.delete(task.id);
        logger.warn('multi_agent_orchestrator', `Source ${source.source} failed: ${err}`);
      }
    }

    return { source: 'llm' as const, content: 'No pude resolver eso.', confidence: 0 };
  }

  private async executeParallel(
    plan: OrchestratorPlan,
    messages: any[],
    input: string,
    classification: ClassificationResult,
  ): Promise<RoutedResult> {
    const sourcePlan = confidenceRouter.getSourcePlan(classification);
    const adjustedPlan = sourcePlan.map(sp => ({
      ...sp,
      confidence: feedbackLoop.getAdjustedConfidence(classification.category, sp.source, sp.confidence),
    })).filter(sp => sp.confidence >= 0.3).slice(0, this.maxConcurrent);

    const promises = adjustedPlan.map(async (source) => {
      try {
        const result = await Promise.race([
          sourceAgentOrchestrator.executeSource(source, messages, input, classification),
          this.createTimeout(this.taskTimeoutMs),
        ]);
        return { source, result };
      } catch (err) {
        logger.warn('multi_agent_orchestrator', `Parallel source ${source.source} failed: ${err}`);
        return { source, result: { source: source.source, content: '', confidence: 0 } as RoutedResult };
      }
    });

    const settled = await Promise.allSettled(promises);
    const results: Array<{ source: SourcePlan; result: RoutedResult }> = [];

    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value.result.confidence > 0) {
        results.push(r.value);
      }
    }

    if (results.length === 0) {
      return { source: 'llm' as const, content: 'No pude resolver eso.', confidence: 0 };
    }

    return this.mergeResults(results, plan.mergeStrategy, classification);
  }

  private async executePipeline(
    plan: OrchestratorPlan,
    messages: any[],
    input: string,
    classification: ClassificationResult,
  ): Promise<RoutedResult> {
    return this.executeSequential(plan, messages, input, classification);
  }

  private mergeResults(
    results: Array<{ source: SourcePlan; result: RoutedResult }>,
    strategy: OrchestratorPlan['mergeStrategy'],
    _classification: ClassificationResult,
  ): RoutedResult {
    if (results.length === 1) return results[0].result;

    switch (strategy) {
      case 'best_confidence': {
        const best = results.reduce((a, b) => a.result.confidence > b.result.confidence ? a : b);
        return best.result;
      }

      case 'concat': {
        const parts = results
          .filter(r => r.result.content)
          .map(r => r.result.content);
        const content = parts.join('\n\n');
        const confidence = Math.max(...results.map(r => r.result.confidence));
        return {
          source: results[0].result.source,
          content,
          confidence,
          metadata: { mergedSources: results.map(r => r.source.source) },
        };
      }

      case 'summarize': {
        const parts = results
          .filter(r => r.result.content)
          .map(r => r.result.content);
        const content = parts.join('\n\n');
        const confidence = Math.max(...results.map(r => r.result.confidence));
        return {
          source: results[0].result.source,
          content,
          confidence,
          metadata: { mergedSources: results.map(r => r.source.source), needsSynthesis: true },
        };
      }

      default:
        return results[0].result;
    }
  }

  private createTimeout(ms: number): Promise<RoutedResult> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Task timeout')), ms)
    );
  }

  getActiveTaskCount(): number {
    return this.activeTasks.size;
  }

  getActiveTasks(): AgentTask[] {
    return Array.from(this.activeTasks.values());
  }
}

export const multiAgentOrchestrator = MultiAgentOrchestrator.getInstance();
