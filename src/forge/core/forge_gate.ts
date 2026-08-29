/**
 * Atlas Forge Gate - The entry point to Forge
 * Receives escalated tasks from Brain's TrustGate and routes them
 * This is the gateway: Brain ↔ ForgeGate ↔ ForgeReasoner
 */

import { logger } from '../../common/logger.js';
import { ForgeInput, ForgeOutput, ForgeProposal } from '../../common/types.js';
import { forgeReasoner } from './forge_reasoner.js';
import { proposalManager } from '../proposals/proposal_manager.js';

export interface ForgeGateResult {
  output: ForgeOutput;
  processingTime: number;
  forgeUsed: boolean;
}

export class ForgeGate {
  private static instance: ForgeGate;
  private totalEscalations = 0;

  private constructor() {}

  static getInstance(): ForgeGate {
    if (!ForgeGate.instance) {
      ForgeGate.instance = new ForgeGate();
    }
    return ForgeGate.instance;
  }

  async process(input: ForgeInput): Promise<ForgeGateResult> {
    const startTime = Date.now();
    this.totalEscalations++;

    logger.info('forge_gate', `Processing: "${input.problem.slice(0, 80)}" (mode: ${input.mode || 'decision'})`);

    try {
      const reasoning = await forgeReasoner.reason(input);
      const decision = reasoning.finalDecision;

      const output: ForgeOutput = {
        decision: decision.action,
        reasoning: `${decision.reasoning}\n\n[Reasoning: ${reasoning.steps.length} steps, ${reasoning.totalThinkingTime}ms]`,
        proposal: decision.proposal,
      };

      if (decision.proposal) {
        proposalManager.create(
          decision.proposal.name,
          decision.proposal.description,
          decision.proposal.impact,
          decision.proposal.risk
        );
      }

      const processingTime = Date.now() - startTime;
      logger.info('forge_gate', `Decision: ${output.decision} (${processingTime}ms, ${reasoning.steps.length} reasoning steps)`);

      return {
        output,
        processingTime,
        forgeUsed: true,
      };
    } catch (err) {
      logger.error('forge_gate', `Processing failed: ${err}`);
      return {
        output: {
          decision: 'proceed',
          reasoning: `Forge failed, falling back to Brain: ${(err as Error).message}`,
        },
        processingTime: Date.now() - startTime,
        forgeUsed: false,
      };
    }
  }

  approveProposal(proposalId: string): boolean {
    const result = proposalManager.approve(proposalId);
    if (result) {
      logger.info('forge_gate', `Proposal approved: ${proposalId}`);
      return true;
    }
    return false;
  }

  rejectProposal(proposalId: string): boolean {
    const result = proposalManager.reject(proposalId);
    if (result) {
      logger.info('forge_gate', `Proposal rejected: ${proposalId}`);
      return true;
    }
    return false;
  }

  getPendingProposals(): ForgeProposal[] {
    return proposalManager.getPending();
  }

  getStats(): { totalEscalations: number; pendingProposals: number } {
    return {
      totalEscalations: this.totalEscalations,
      pendingProposals: proposalManager.getPending().length,
    };
  }
}

export const forgeGate = ForgeGate.getInstance();
