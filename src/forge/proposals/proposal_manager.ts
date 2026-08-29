/**
 * Atlas Forge Proposals - Manages proposals requiring user approval
 * Stores, tracks, and processes proposal lifecycle
 */

import { logger } from '../../common/logger.js';
import { ForgeProposal } from '../../common/types.js';
import { generateId } from '../../common/utils.js';
import fs from 'fs';
import path from 'path';

const PROPOSALS_FILE = path.join(process.cwd(), 'data', 'proposals.json');

export class ProposalManager {
  private static instance: ProposalManager;
  private proposals: Map<string, ForgeProposal> = new Map();

  private constructor() {
    this.load();
  }

  static getInstance(): ProposalManager {
    if (!ProposalManager.instance) {
      ProposalManager.instance = new ProposalManager();
    }
    return ProposalManager.instance;
  }

  create(name: string, description: string, impact: ForgeProposal['impact'], risk: ForgeProposal['risk']): ForgeProposal {
    const proposal: ForgeProposal = {
      id: generateId('prop'),
      name,
      description,
      impact,
      risk,
      status: 'pending',
      createdAt: Date.now(),
    };

    this.proposals.set(proposal.id, proposal);
    this.save();
    logger.info('proposals', `Created: ${proposal.id} — ${name}`);
    return proposal;
  }

  approve(id: string): ForgeProposal | null {
    const proposal = this.proposals.get(id);
    if (!proposal) return null;

    proposal.status = 'approved';
    this.save();
    logger.info('proposals', `Approved: ${id}`);
    return proposal;
  }

  reject(id: string): ForgeProposal | null {
    const proposal = this.proposals.get(id);
    if (!proposal) return null;

    proposal.status = 'rejected';
    this.save();
    logger.info('proposals', `Rejected: ${id}`);
    return proposal;
  }

  getPending(): ForgeProposal[] {
    return Array.from(this.proposals.values()).filter(p => p.status === 'pending');
  }

  getAll(): ForgeProposal[] {
    return Array.from(this.proposals.values());
  }

  get(id: string): ForgeProposal | undefined {
    return this.proposals.get(id);
  }

  private load(): void {
    try {
      if (fs.existsSync(PROPOSALS_FILE)) {
        const data = JSON.parse(fs.readFileSync(PROPOSALS_FILE, 'utf-8'));
        for (const p of data) {
          this.proposals.set(p.id, p);
        }
      }
    } catch (err) {
      logger.warn('proposals', `Load failed: ${err}`);
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(PROPOSALS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(PROPOSALS_FILE, JSON.stringify(Array.from(this.proposals.values()), null, 2));
    } catch (err) {
      logger.error('proposals', `Save failed: ${err}`);
    }
  }
}

export const proposalManager = ProposalManager.getInstance();
