/**
 * Atlas Dashboard - System overview and health monitoring
 */

import { forgeGate } from '../forge/core/forge_gate.js';
import { scheduler } from '../brain/scheduler.js';
import { brainSkills } from '../brain/skills.js';
import { messageQueue } from '../brain/message_queue.js';
import { proposalManager } from '../forge/proposals/proposal_manager.js';
import { forgeAutonomous } from '../forge/core/forge_autonomous.js';
import { autoSkillGenerator } from '../forge/skills/auto_generator.js';
import { logsPanel } from './tui/logs_panel.js';

export interface DashboardState {
  forgeStats: { totalEscalations: number; pendingProposals: number };
  pendingProposalsCount: number;
  scheduledTasks: number;
  registeredSkills: number;
  generatedSkills: number;
  queueSize: number;
  autonomousTaskCount: number;
  logStats: { total: number; byLevel: Record<string, number> };
  uptime: number;
}

export class Dashboard {
  private static instance: Dashboard;
  private startTime = Date.now();

  private constructor() {}

  static getInstance(): Dashboard {
    if (!Dashboard.instance) {
      Dashboard.instance = new Dashboard();
    }
    return Dashboard.instance;
  }

  getState(): DashboardState {
    const forgeStats = forgeGate.getStats();
    const logStats = logsPanel.getStats();

    return {
      forgeStats,
      pendingProposalsCount: proposalManager.getPending().length,
      scheduledTasks: scheduler.list().length,
      registeredSkills: brainSkills.list().length,
      generatedSkills: autoSkillGenerator.listGenerated().length,
      queueSize: messageQueue.size(),
      autonomousTaskCount: forgeAutonomous.getActiveTaskCount(),
      logStats,
      uptime: Date.now() - this.startTime,
    };
  }

  render(): string {
    const state = this.getState();
    const uptimeMin = Math.floor(state.uptime / 60000);
    const uptimeSec = Math.floor((state.uptime % 60000) / 1000);

    return `
╔══════════════════════════════════════╗
║         ATLAS AGENT DASHBOARD        ║
╠══════════════════════════════════════╣
║ Uptime:       ${uptimeMin}m ${uptimeSec}s                  ║
╠══════════════════════════════════════╣
║ FORGE                                ║
║   Escalations: ${String(state.forgeStats.totalEscalations).padEnd(5)}                ║
║   Proposals:   ${String(state.pendingProposalsCount).padEnd(5)}                ║
║   Autonomous:  ${String(state.autonomousTaskCount).padEnd(5)}                ║
╠══════════════════════════════════════╣
║ BRAIN                                ║
║   Skills:      ${String(state.registeredSkills).padEnd(5)}                ║
║   Generated:   ${String(state.generatedSkills).padEnd(5)}                ║
║   Scheduled:   ${String(state.scheduledTasks).padEnd(5)}                ║
║   Queue:       ${String(state.queueSize).padEnd(5)}                ║
╠══════════════════════════════════════╣
║ LOGS: ${String(state.logStats.total).padEnd(5)} entries                  ║
╚══════════════════════════════════════╝
`.trim();
  }
}

export const dashboard = Dashboard.getInstance();
