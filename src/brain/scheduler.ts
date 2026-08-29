/**
 * Atlas Scheduler - Time-based and recurring task scheduling
 * Supports: one-shot, recurring (interval), cron-like scheduling
 */

import { logger } from '../common/logger.js';

export interface ScheduledTask {
  id: string;
  name: string;
  action: () => Promise<any>;
  intervalMs?: number;
  executeAt?: number;
  recurring: boolean;
  lastRun?: number;
  nextRun: number;
  enabled: boolean;
}

export class Scheduler {
  private static instance: Scheduler;
  private tasks: Map<string, ScheduledTask> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private running = false;

  private constructor() {}

  static getInstance(): Scheduler {
    if (!Scheduler.instance) {
      Scheduler.instance = new Scheduler();
    }
    return Scheduler.instance;
  }

  schedule(task: Omit<ScheduledTask, 'id' | 'lastRun' | 'nextRun' | 'enabled'>): string {
    const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    const nextRun = task.executeAt || (task.intervalMs ? now + task.intervalMs : now);

    const scheduled: ScheduledTask = {
      ...task,
      id,
      nextRun,
      enabled: true,
    };

    this.tasks.set(id, scheduled);
    logger.info('scheduler', `Scheduled: ${task.name} (${task.recurring ? 'recurring' : 'one-shot'})`);

    if (this.running) {
      this.setTimer(scheduled);
    }

    return id;
  }

  cancel(taskId: string): boolean {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
    const removed = this.tasks.delete(taskId);
    if (removed) logger.info('scheduler', `Cancelled: ${taskId}`);
    return removed;
  }

  start(): void {
    this.running = true;
    for (const task of this.tasks.values()) {
      if (task.enabled) this.setTimer(task);
    }
    logger.info('scheduler', 'Started');
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    logger.info('scheduler', 'Stopped');
  }

  list(): Array<{ id: string; name: string; recurring: boolean; nextRun: number; enabled: boolean }> {
    return Array.from(this.tasks.values()).map(t => ({
      id: t.id,
      name: t.name,
      recurring: t.recurring,
      nextRun: t.nextRun,
      enabled: t.enabled,
    }));
  }

  private setTimer(task: ScheduledTask): void {
    const delay = Math.max(0, task.nextRun - Date.now());

    const timer = setTimeout(async () => {
      try {
        logger.info('scheduler', `Executing: ${task.name}`);
        await task.action();
        task.lastRun = Date.now();

        if (task.recurring && task.intervalMs) {
          task.nextRun = Date.now() + task.intervalMs;
          if (this.running && task.enabled) {
            this.setTimer(task);
          }
        } else {
          this.tasks.delete(task.id);
          this.timers.delete(task.id);
        }
      } catch (err) {
        logger.error('scheduler', `Task failed: ${task.name} — ${err}`);
      }
    }, delay);

    this.timers.set(task.id, timer);
  }
}

export const scheduler = Scheduler.getInstance();
