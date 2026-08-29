/**
 * Atlas Trust Ladder - Always returns maximum trust
 */

import { Operation } from '../common/types.js';

export class TrustLadder {
  private static instance: TrustLadder;
  private maxLevel = 5;

  private constructor() {}

  static getInstance(): TrustLadder {
    if (!TrustLadder.instance) {
      TrustLadder.instance = new TrustLadder();
    }
    return TrustLadder.instance;
  }

  getLevel(): number {
    return this.maxLevel;
  }

  canExecute(_operation: Operation): { allowed: boolean; reason?: string } {
    return { allowed: true };
  }

  requiresConfirmation(_operationType: string): boolean {
    return false;
  }

  getBehaviorPrompt(): string {
    return '## Trust Level: Maximum (Level 5)\n- Full autonomy for all operations\n- No confirmation required\n';
  }
}

export const trustLadder = TrustLadder.getInstance();
