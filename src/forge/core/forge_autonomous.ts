/**
 * Atlas Forge Autonomous - Autonomous execution mode
 * 
 * Low-level async task queue. The active mission count is agora sourced
 * from the mission system (forgeRunner) so the dashboard reflects real state.
 */

import { logger } from '../../common/logger.js';
import { generateId } from '../../common/utils.js';
import { forgeRunner } from '../missions/forge_runner.js';

export interface AutonomousTask {
  id: string;
  goal: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  startedAt?: number;
  completedAt?: number;
  result?: any;
}

export class ForgeAutonomous {
  private static instance: ForgeAutonomous;
  private autonomousTasks: Map<string, AutonomousTask> = new Map();
  private maxConcurrent = 3;
  private activeCount = 0;

  private constructor() {}

  static getInstance(): ForgeAutonomous {
    if (!ForgeAutonomous.instance) {
      ForgeAutonomous.instance = new ForgeAutonomous();
    }
    return ForgeAutonomous.instance;
  }

  canRunAutonomously(): boolean {
    return this.activeCount < this.maxConcurrent;
  }

  async executeAutonomous(goal: string, executor: (goal: string) => Promise<any>): Promise<AutonomousTask> {
    if (!this.canRunAutonomously()) {
      throw new Error('Autonomous execution not available: insufficient trust level or too many concurrent tasks');
    }

    const task: AutonomousTask = {
      id: generateId('auto'),
      goal,
      status: 'running',
      startedAt: Date.now(),
    };

    this.autonomousTasks.set(task.id, task);
    this.activeCount++;

    logger.info('forge_autonomous', `Starting autonomous task: ${task.id} — "${goal.slice(0, 60)}"`);

    try {
      task.result = await executor(goal);
      task.status = 'completed';
      task.completedAt = Date.now();
      logger.info('forge_autonomous', `Completed: ${task.id}`);
    } catch (err) {
      task.status = 'failed';
      task.result = (err as Error).message;
      task.completedAt = Date.now();
      logger.error('forge_autonomous', `Failed: ${task.id} — ${err}`);
    } finally {
      this.activeCount--;
    }

    return task;
  }

  getTask(taskId: string): AutonomousTask | undefined {
    return this.autonomousTasks.get(taskId);
  }

  listTasks(): AutonomousTask[] {
    const tasks = Array.from(this.autonomousTasks.values());

    // Include active mission as a running autonomous task
    if (forgeRunner.isRunning()) {
      const plan = forgeRunner.getCurrentPlan();
      if (plan) {
        const missionTask: AutonomousTask = {
          id: plan.id,
          goal: plan.goal,
          status: 'running',
          startedAt: plan.startedAt,
          result: `${plan.ideas.length}/${plan.totalVariants} ideas completadas`,
        };
        tasks.unshift(missionTask);
      }
    }

    return tasks;
  }

  getActiveTaskCount(): number {
    // Reflect real mission state: active mission counts as active autonomous work
    if (forgeRunner.isRunning()) {
      const plan = forgeRunner.getCurrentPlan();
      const taskCount = 1 + (plan?.ideas?.length ?? 0);
      return Math.max(1, taskCount);
    }
    return this.activeCount;
  }
}

export const forgeAutonomous = ForgeAutonomous.getInstance();
