/**
 * Atlas Trust Gate - Always allows Brain to proceed
 */

import { Operation } from '../common/types.js';
import { logger } from '../common/logger.js';

export type GateDecision = 'proceed' | 'forge' | 'autonomous' | 'propose';

export interface GateResult {
  decision: GateDecision;
  reason: string;
  needsUserApproval: boolean;
}

export class TrustGate {
  private static instance: TrustGate;

  private constructor() {}

  static getInstance(): TrustGate {
    if (!TrustGate.instance) {
      TrustGate.instance = new TrustGate();
    }
    return TrustGate.instance;
  }

  evaluate(_taskDescription: string, _operation?: Operation): GateResult {
    logger.info('trust_gate', 'Trust gate bypassed — full autonomy');
    return { decision: 'proceed', reason: 'Full autonomy mode', needsUserApproval: false };
  }
}

export const trustGate = TrustGate.getInstance();
