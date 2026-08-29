import { logger } from '../common/logger.js';
import { QueryCategory, ClassificationResult, SourcePlan, DataSource, RoutedResult } from '../common/types.js';
import { brainSkills } from './skills.js';
import { matchSkillFromInput } from './skill_matcher.js';

interface CategoryRouting {
  sources: SourcePlan[];
  offerTools: boolean;
  maxIterations: number;
}

const ROUTING_TABLE: Record<QueryCategory, CategoryRouting> = {
  general: {
    sources: [
      { source: 'llm', confidence: 0.95 },
    ],
    offerTools: false,
    maxIterations: 1,
  },
  memory: {
    sources: [
      { source: 'memory_store', confidence: 0.9 },
      { source: 'llm', confidence: 0.5 },
    ],
    offerTools: false,
    maxIterations: 1,
  },
  project: {
    sources: [
      { source: 'file_system', confidence: 0.9, skillName: 'list_files' },
      { source: 'git', confidence: 0.7, skillName: 'git_manager' },
      { source: 'web_search', confidence: 0.4, skillName: 'web_search' },
    ],
    offerTools: true,
    maxIterations: 3,
  },
  code: {
    sources: [
      { source: 'llm_with_context', confidence: 0.85 },
      { source: 'web_search', confidence: 0.5, skillName: 'web_search' },
    ],
    offerTools: true,
    maxIterations: 5,
  },
  web: {
    sources: [
      { source: 'web_search', confidence: 0.9, skillName: 'web_search' },
      { source: 'llm_synthesis', confidence: 0.3 },
    ],
    offerTools: true,
    maxIterations: 3,
  },
  tool: {
    sources: [
      { source: 'skill_direct', confidence: 0.95 },
      { source: 'llm_confirm', confidence: 0.7 },
    ],
    offerTools: true,
    maxIterations: 3,
  },
};

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

export class ConfidenceRouter {
  private static instance: ConfidenceRouter;
  private llmClient: any = null;
  private systemPrompt: string = '';
  private confidenceThreshold: number = DEFAULT_CONFIDENCE_THRESHOLD;

  private constructor() {}

  static getInstance(): ConfidenceRouter {
    if (!ConfidenceRouter.instance) {
      ConfidenceRouter.instance = new ConfidenceRouter();
    }
    return ConfidenceRouter.instance;
  }

  setLLMClient(client: any): void {
    this.llmClient = client;
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  setConfidenceThreshold(threshold: number): void {
    this.confidenceThreshold = threshold;
  }

  getRouting(classification: ClassificationResult): CategoryRouting {
    return ROUTING_TABLE[classification.category] || ROUTING_TABLE.general;
  }

  getSourcePlan(classification: ClassificationResult): SourcePlan[] {
    const routing = this.getRouting(classification);
    let sources = [...routing.sources];

    if (classification.category === 'tool') {
      const skillMatch = matchSkillFromInput(
        classification.rawResponse || '',
        brainSkills.listRaw(),
      );
      if (skillMatch && skillMatch.confidence >= 0.15) {
        sources[0] = {
          ...sources[0],
          skillName: skillMatch.name,
          skillArgs: skillMatch.args,
        };
      }
    }

    if (classification.category === 'web' && classification.subIntent) {
      sources[0].skillArgs = {
        ...sources[0].skillArgs,
        query_type: classification.subIntent,
      };
    }

    return sources.filter(s => s.confidence >= this.confidenceThreshold);
  }

  async executeSource(
    plan: SourcePlan,
    messages: any[],
    input: string,
    classification: ClassificationResult,
  ): Promise<RoutedResult> {
    const source = plan.source;

    logger.info('confidence_router', `Executing source: ${source} (confidence: ${plan.confidence})`);

    try {
      switch (source) {
        case 'llm':
          return await this.executeLLM(messages, input, false);

        case 'llm_with_context':
          return await this.executeLLM(messages, input, true);

        case 'llm_synthesis':
          return await this.executeLLMSynthesis(messages, input);

        case 'llm_confirm':
          return await this.executeLLMConfirm(messages, input);

        case 'memory_store':
          return await this.executeMemory(input);

        case 'file_system':
          return await this.executeSkill(plan.skillName || 'list_files', plan.skillArgs || { path: '.' });

        case 'git':
          return await this.executeSkill('git_manager', plan.skillArgs || { command: 'status' });

        case 'web_search':
          return await this.executeWebSearch(input, classification);

        case 'web_scrape':
          return await this.executeSkill('web_scrape', plan.skillArgs || {});

        case 'skill_direct':
          return await this.executeSkillDirect(input, plan);

        default:
          return { source, content: 'Fuente no implementada', confidence: 0 };
      }
    } catch (err) {
      logger.error('confidence_router', `Source ${source} failed: ${err}`);
      return {
        source,
        content: `Error ejecutando ${source}: ${(err as Error).message}`,
        confidence: 0,
      };
    }
  }

  private async executeLLM(messages: any[], input: string, withTools: boolean): Promise<RoutedResult> {
    if (!this.llmClient) {
      return { source: 'llm', content: 'LLM no disponible', confidence: 0 };
    }

    const routing = ROUTING_TABLE.general;
    const workingMessages: any[] = [
      { role: 'system', content: this.systemPrompt },
      ...messages.slice(-6).map(m => ({ role: m.role, content: m.content ?? '' })),
    ];

    if (withTools && routing.offerTools) {
      const skills = brainSkills.listRaw();
      const toolDefs = skills.map(s => ({
        type: 'function' as const,
        function: {
          name: s.name,
          description: s.description,
          parameters: {
            type: 'object' as const,
            properties: Object.fromEntries(
              s.parameters.map(p => [p.name, { type: p.type, description: p.description }])
            ),
            required: s.parameters.filter(p => p.required).map(p => p.name),
          },
        },
      }));

      const response = await this.llmClient.chatCompletionWithTools(workingMessages, toolDefs, 1024);

      if (response.toolCalls && response.toolCalls.length > 0) {
        const results: string[] = [];
        workingMessages.push({
          role: 'assistant',
          content: response.content ?? null,
          tool_calls: response.toolCalls.map((tc: any) => ({
            id: tc.id,
            type: 'function',
            function: tc.function,
          })),
        });

        for (const tc of response.toolCalls) {
          let args: Record<string, any> = {};
          try { args = JSON.parse(tc.function.arguments); } catch { args = { input }; }

          try {
            const result = await brainSkills.execute(tc.function.name, args);
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            results.push(resultStr.slice(0, 8000));
            workingMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: resultStr.slice(0, 8000),
            });
          } catch (err) {
            workingMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `Error: ${(err as Error).message}`,
            });
          }
        }

        workingMessages.push({
          role: 'user',
          content: 'Sintetizá los resultados y respondé al usuario en español coloquial. No pegues datos crudos.',
        });

        const finalResponse = await this.llmClient.chatCompletion(workingMessages, 1024);
        return {
          source: 'llm_with_context',
          content: finalResponse,
          confidence: 0.85,
          metadata: { toolsUsed: response.toolCalls.map((tc: any) => tc.function.name) },
        };
      }

      return {
        source: 'llm',
        content: response.content || 'No se me ocurrió qué decir.',
        confidence: 0.9,
      };
    }

    const response = await this.llmClient.chatCompletion(workingMessages, 1024);
    return {
      source: 'llm',
      content: response,
      confidence: 0.9,
    };
  }

  private async executeLLMSynthesis(messages: any[], _input: string): Promise<RoutedResult> {
    if (!this.llmClient) {
      return { source: 'llm_synthesis', content: '', confidence: 0 };
    }

    const workingMessages: any[] = [
      { role: 'system', content: this.systemPrompt },
      ...messages.slice(-6).map(m => ({ role: m.role, content: m.content ?? '' })),
    ];

    const response = await this.llmClient.chatCompletion(workingMessages, 512);
    return {
      source: 'llm_synthesis',
      content: response,
      confidence: 0.5,
    };
  }

  private async executeLLMConfirm(messages: any[], _input: string): Promise<RoutedResult> {
    if (!this.llmClient) {
      return { source: 'llm_confirm', content: '', confidence: 0 };
    }

    const workingMessages: any[] = [
      { role: 'system', content: this.systemPrompt },
      ...messages.slice(-6).map(m => ({ role: m.role, content: m.content ?? '' })),
    ];

    const response = await this.llmClient.chatCompletion(workingMessages, 256);
    return {
      source: 'llm_confirm',
      content: response,
      confidence: 0.7,
    };
  }

  private async executeMemory(input: string): Promise<RoutedResult> {
    if (!brainSkills.has('memory_recall')) {
      return { source: 'memory_store', content: 'No tengo memoria disponible.', confidence: 0.2 };
    }

    const query = input
      .replace(/(?:record[áa]|recuerda|acordate|que\s+(?:hablamos|dimos|guard|almacen|memoriz|anote))[\s:]*/i, '')
      .trim() || input;

    try {
      const result = await brainSkills.execute('memory_recall', { query });
      const content = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

      if (content.includes('No encontré nada')) {
        return { source: 'memory_store', content, confidence: 0.3 };
      }

      return { source: 'memory_store', content, confidence: 0.85 };
    } catch (err) {
      return { source: 'memory_store', content: `Error en memoria: ${(err as Error).message}`, confidence: 0 };
    }
  }

  private async executeWebSearch(input: string, classification: ClassificationResult): Promise<RoutedResult> {
    if (!brainSkills.has('web_search')) {
      return { source: 'web_search', content: 'Búsqueda web no disponible.', confidence: 0 };
    }

    const query = this.buildWebQuery(input, classification);

    try {
      const searchType = classification.subIntent === 'news' ? 'news' : 'web';
      const result = await brainSkills.execute('web_search', {
        query,
        type: searchType,
        count: 8,
      });

      const content = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return {
        source: 'web_search',
        content,
        confidence: 0.85,
        metadata: { query, type: searchType },
      };
    } catch (err) {
      return { source: 'web_search', content: `Error en búsqueda: ${(err as Error).message}`, confidence: 0 };
    }
  }

  private buildWebQuery(input: string, classification: ClassificationResult): string {
    let query = input
      .replace(/^(decime|dame|contame|mostrame|necesito|quiero|quisiera|pod[eé]s|busc[áa]|buscar|averigu[áa]|encontr[áa]|investig[áa])\s+/i, '')
      .replace(/\s*(por favor|porfa|pls|please|gracias)\s*$/i, '')
      .trim();

    if (classification.subIntent === 'weather') {
      if (!/hoy|ahora|actual/.test(query.toLowerCase())) {
        query += ' hoy';
      }
    }

    return query || input;
  }

  private async executeSkillDirect(input: string, plan: SourcePlan): Promise<RoutedResult> {
    const skillMatch = matchSkillFromInput(input, brainSkills.listRaw());
    const skillName = plan.skillName || skillMatch?.name;
    const skillArgs = plan.skillArgs || skillMatch?.args || {};

    if (!skillName || !brainSkills.has(skillName)) {
      return { source: 'skill_direct', content: 'No encontré la herramienta adecuada.', confidence: 0.2 };
    }

    try {
      const result = await brainSkills.execute(skillName, skillArgs);
      const content = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return {
        source: 'skill_direct',
        content,
        confidence: 0.9,
        metadata: { skillName },
      };
    } catch (err) {
      return { source: 'skill_direct', content: `Error: ${(err as Error).message}`, confidence: 0 };
    }
  }

  private async executeSkill(skillName: string, args: Record<string, any>): Promise<RoutedResult> {
    if (!brainSkills.has(skillName)) {
      return { source: skillName as DataSource, content: `Skill ${skillName} no disponible.`, confidence: 0 };
    }

    try {
      const result = await brainSkills.execute(skillName, args);
      const content = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return {
        source: skillName as DataSource,
        content,
        confidence: 0.85,
      };
    } catch (err) {
      return { source: skillName as DataSource, content: `Error: ${(err as Error).message}`, confidence: 0 };
    }
  }
}

export const confidenceRouter = ConfidenceRouter.getInstance();
