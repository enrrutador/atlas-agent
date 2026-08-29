/**
 * Atlas Idle Builder - Creates autonomous tasks when Atlas is idle
 * Night Shift mode: proactively creates and executes tasks
 */

import { logger } from '../common/logger.js';
import { memoryStore } from '../memory/memory_store.js';

export interface IdleTask {
  id: string;
  goal: string;
  reason: string;
  priority: 'low' | 'medium' | 'high';
  createdAt: number;
}

export class IdleBuilder {
  private static instance: IdleBuilder;
  private idleTasks: IdleTask[] = [];
  private idleThresholdMs = 5 * 60 * 1000; // 5 min idle
  private lastActivity = Date.now();

  private constructor() {}

  static getInstance(): IdleBuilder {
    if (!IdleBuilder.instance) {
      IdleBuilder.instance = new IdleBuilder();
    }
    return IdleBuilder.instance;
  }

  recordActivity(): void {
    this.lastActivity = Date.now();
  }

  isIdle(): boolean {
    return Date.now() - this.lastActivity > this.idleThresholdMs;
  }

  async generateIdleTasks(): Promise<IdleTask[]> {
    if (!this.isIdle()) return [];

    const tasks: IdleTask[] = [];

    // Check memory stats for cleanup opportunities
    try {
      const stats = await memoryStore.getStats();
      if (stats.total > 100) {
        tasks.push({
          id: `idle_cleanup_${Date.now()}`,
          goal: 'Archive old memories and consolidate duplicates',
          reason: `${stats.total} memories stored, cleanup recommended`,
          priority: 'low',
          createdAt: Date.now(),
        });
      }
    } catch {
      // Memory not available yet
    }

    // Generate self-improvement tasks
    tasks.push({
      id: `idle_review_${Date.now()}`,
      goal: 'Review recent interactions for learning opportunities',
      reason: 'Periodic self-improvement cycle',
      priority: 'low',
      createdAt: Date.now(),
    });

    this.idleTasks = tasks;
    logger.info('idle_builder', `Generated ${tasks.length} idle tasks`);
    return tasks;
  }

  listIdleTasks(): IdleTask[] {
    return this.idleTasks;
  }

  setIdleThreshold(minutes: number): void {
    this.idleThresholdMs = minutes * 60 * 1000;
  }
}

export const idleBuilder = IdleBuilder.getInstance();
