/**
 * Atlas Forge Reasoner - Deep reasoning engine for complex problems
 * Multi-step reasoning with chain-of-thought when LLM available
 * Heuristic decomposition as fallback
 */

import { logger } from '../../common/logger.js';
import { ForgeInput } from '../../common/types.js';
import { forgeDecision, ForgeDecisionResult } from './forge_decision.js';
import { forgeContext } from './forge_context.js';

export interface ReasoningStep {
  step: number;
  thought: string;
  conclusion?: string;
}

export interface ReasoningResult {
  steps: ReasoningStep[];
  finalDecision: ForgeDecisionResult;
  totalThinkingTime: number;
}

export class ForgeReasoner {
  private static instance: ForgeReasoner;
  private llmClient: any = null;

  private constructor() {}

  static getInstance(): ForgeReasoner {
    if (!ForgeReasoner.instance) {
      ForgeReasoner.instance = new ForgeReasoner();
    }
    return ForgeReasoner.instance;
  }

  setLLMClient(client: any): void {
    this.llmClient = client;
    forgeDecision.setLLMClient(client);
  }

  async reason(input: ForgeInput): Promise<ReasoningResult> {
    const startTime = Date.now();
    logger.info('forge_reasoner', `Reasoning on: "${input.problem.slice(0, 80)}"`);

    let steps: ReasoningStep[] = [];

    if (this.llmClient) {
      steps = await this.chainOfThought(input);
    } else {
      steps = this.heuristicDecomposition(input);
    }

    const finalDecision = await forgeDecision.decide(input);

    const totalThinkingTime = Date.now() - startTime;
    logger.info('forge_reasoner', `Reasoning complete: ${finalDecision.action} (${totalThinkingTime}ms, ${steps.length} steps)`);

    return { steps, finalDecision, totalThinkingTime };
  }

  private async chainOfThought(input: ForgeInput): Promise<ReasoningStep[]> {
    const context = forgeContext.buildContext(input);
    const prompt = `You are Atlas Forge Reasoner. Think step-by-step about this problem.

CONTEXT:
${context}

PROBLEM: ${input.problem}

Think through this systematically. For each step:
1. What information do I have?
2. What am I missing?
3. What are the possible approaches?
4. What are the risks?
5. What is my conclusion?

Respond in JSON array:
[{"step": 1, "thought": "...", "conclusion": "..."}, ...]`;

    try {
      const response = await this.llmClient.chatCompletion([
        { role: 'system', content: 'You are Atlas Forge Reasoner. Respond only in valid JSON.' },
        { role: 'user', content: prompt },
      ]);

      return JSON.parse(response);
    } catch (err) {
      logger.warn('forge_reasoner', `CoT failed, using heuristics: ${err}`);
      return this.heuristicDecomposition(input);
    }
  }

  private heuristicDecomposition(input: ForgeInput): ReasoningStep[] {
    const steps: ReasoningStep[] = [];

    steps.push({
      step: 1,
      thought: `Analyzing problem: "${input.problem.slice(0, 100)}"`,
      conclusion: 'Problem identified',
    });

    const lower = input.problem.toLowerCase();
    const hasRisk = ['delete', 'remove', 'format', 'shutdown', 'reset'].some(k => lower.includes(k));
    const hasCreative = ['create', 'build', 'design', 'architect'].some(k => lower.includes(k));
    const hasAutomation = ['monitor', 'schedule', 'automate', 'batch'].some(k => lower.includes(k));

    steps.push({
      step: 2,
      thought: `Risk detected: ${hasRisk}, Creative: ${hasCreative}, Automation: ${hasAutomation}`,
      conclusion: hasRisk ? 'High-risk operation' : hasCreative ? 'Creative operation' : hasAutomation ? 'Automation task' : 'Standard operation',
    });

    steps.push({
      step: 3,
      thought: 'Determining action based on analysis',
      conclusion: hasRisk ? 'Needs user approval (propose)' : hasCreative ? 'Needs Forge reasoning' : hasAutomation ? 'Can run autonomously' : 'Brain can handle',
    });

    return steps;
  }
}

export const forgeReasoner = ForgeReasoner.getInstance();
