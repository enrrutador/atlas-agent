/**
 * Atlas Forge Decision - The core reasoning engine
 * Analyzes problems and produces decisions: proceed | forge | autonomous | propose
 * Uses LLM for complex reasoning when available, heuristic fallback otherwise
 */

import { logger } from '../../common/logger.js';
import { ForgeInput, ForgeOutput, ForgeProposal } from '../../common/types.js';
import { generateId } from '../../common/utils.js';
import { forgeContext } from './forge_context.js';
import { forgeMemory } from '../memory/forge_memory.js';

export interface ForgeDecisionResult {
  action: ForgeOutput['decision'];
  reasoning: string;
  proposal?: ForgeProposal;
  confidence: number;
}

export class ForgeDecision {
  private static instance: ForgeDecision;
  private llmClient: any = null;

  private constructor() {}

  static getInstance(): ForgeDecision {
    if (!ForgeDecision.instance) {
      ForgeDecision.instance = new ForgeDecision();
    }
    return ForgeDecision.instance;
  }

  setLLMClient(client: any): void {
    this.llmClient = client;
    logger.info('forge_decision', 'LLM client configured');
  }

  async decide(input: ForgeInput): Promise<ForgeDecisionResult> {
    const context = forgeContext.buildContext(input);

    const similar = await forgeMemory.getSimilar(input.problem);
    if (similar && similar.confidence >= 0.85) {
      logger.info('forge_decision', `Reusing past decision (confidence: ${similar.confidence}): ${similar.output}`);
      return {
        action: similar.output.includes('propose') ? 'propose' : similar.output.includes('forge') ? 'forge' : similar.output.includes('autonomous') ? 'autonomous' : 'proceed',
        reasoning: `Reused past decision: ${similar.output}`,
        confidence: similar.confidence,
      };
    }

    if (this.llmClient) {
      try {
        const result = await this.llmReason(input, context);
        await forgeMemory.store({
          type: 'decision',
          input: input.problem,
          output: result.action,
          confidence: result.confidence,
          tags: [result.action],
        });
        return result;
      } catch (err) {
        logger.warn('forge_decision', `LLM reasoning failed, falling back to heuristics: ${err}`);
      }
    }

    const result = this.heuristicReason(input, context);
    forgeMemory.store({
      type: 'decision',
      input: input.problem,
      output: result.action,
      confidence: result.confidence,
      tags: [result.action],
    }).catch(() => {});
    return result;
  }

  private async llmReason(input: ForgeInput, context: string): Promise<ForgeDecisionResult> {
    const prompt = `You are Atlas Forge — the decision-making core. Analyze the following problem and decide the best action.

CONTEXT:
${context}

PROBLEM: ${input.problem}
MODE: ${input.mode || 'decision'}

RESPOND IN JSON:
{
  "action": "proceed" | "forge" | "autonomous" | "propose",
  "reasoning": "your reasoning",
  "confidence": 0.0-1.0,
  "proposal": null or { "name": "...", "description": "...", "impact": "low|medium|high", "risk": "low|medium|high" }
}

Rules:
- "proceed": Brain can handle this with normal execution
- "forge": Needs Forge's creative/analytical reasoning to craft a solution
- "autonomous": Atlas can execute this independently without user confirmation
- "propose": Needs user approval before execution (high-impact action)
- Only create a proposal for "propose" decisions`;

    const response = await this.llmClient.chatCompletion([
      { role: 'system', content: 'You are Atlas Forge. Respond only in valid JSON.' },
      { role: 'user', content: prompt },
    ]);

    const parsed = JSON.parse(response);
    const result: ForgeDecisionResult = {
      action: parsed.action || 'proceed',
      reasoning: parsed.reasoning || 'No reasoning provided',
      confidence: parsed.confidence || 0.5,
    };

    if (parsed.proposal && parsed.action === 'propose') {
      result.proposal = {
        id: generateId('proposal'),
        name: parsed.proposal.name,
        description: parsed.proposal.description,
        impact: parsed.proposal.impact,
        risk: parsed.proposal.risk,
        status: 'pending',
        createdAt: Date.now(),
      };
    }

    logger.info('forge_decision', `LLM decision: ${result.action} (confidence: ${result.confidence})`);
    return result;
  }

  private heuristicReason(input: ForgeInput, _context: string): ForgeDecisionResult {
    const problem = input.problem.toLowerCase();

    // High-risk keywords → propose
    const highRiskKeywords = ['delete', 'remove', 'format', 'reset', 'drop', 'erase', 'shutdown', 'reboot'];
    if (highRiskKeywords.some(kw => problem.includes(kw))) {
      return {
        action: 'propose',
        reasoning: `Detected high-risk operation keyword in: "${input.problem.slice(0, 60)}"`,
        confidence: 0.7,
        proposal: {
          id: generateId('proposal'),
          name: 'High-risk operation',
          description: input.problem,
          impact: 'high',
          risk: 'high',
          status: 'pending',
          createdAt: Date.now(),
        },
      };
    }

    // Creative/analytical keywords → forge
    const forgeKeywords = ['create', 'design', 'build', 'architect', 'analyze', 'compare', 'evaluate', 'invent', 'improve'];
    if (forgeKeywords.some(kw => problem.includes(kw))) {
      return {
        action: 'forge',
        reasoning: `Detected creative/analytical intent, requires Forge reasoning`,
        confidence: 0.6,
      };
    }

    // Autonomous keywords
    const autoKeywords = ['monitor', 'watch', 'schedule', 'background', 'automate', 'batch'];
    if (autoKeywords.some(kw => problem.includes(kw))) {
      return {
        action: 'autonomous',
        reasoning: `Detected autonomous-compatible task, can run independently`,
        confidence: 0.6,
      };
    }

    // Default: proceed with Brain
    return {
      action: 'proceed',
      reasoning: `No special handling required, Brain can process this`,
      confidence: 0.8,
    };
  }
}

export const forgeDecision = ForgeDecision.getInstance();
