/**
 * Atlas Task Planner - Breaks complex tasks into executable steps
 * Used by Brain when tasks need multi-step execution
 */

import { logger } from '../common/logger.js';

export interface PlanStep {
  id: string;
  action: string;
  tool?: string;
  args?: Record<string, any>;
  dependsOn?: string[];
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  result?: any;
  retryCount: number;
  maxRetries: number;
}

export interface Plan {
  id: string;
  goal: string;
  steps: PlanStep[];
  createdAt: number;
  status: 'planning' | 'executing' | 'completed' | 'failed';
}

export class TaskPlanner {
  private static instance: TaskPlanner;
  private plans: Map<string, Plan> = new Map();

  private constructor() {}

  static getInstance(): TaskPlanner {
    if (!TaskPlanner.instance) {
      TaskPlanner.instance = new TaskPlanner();
    }
    return TaskPlanner.instance;
  }

  createPlan(goal: string, steps: Omit<PlanStep, 'id' | 'status' | 'result' | 'retryCount'>[]): Plan {
    const plan: Plan = {
      id: `plan_${Date.now()}`,
      goal,
      steps: steps.map((s, i) => ({
        ...s,
        id: `step_${i + 1}`,
        status: 'pending' as const,
        result: undefined,
        retryCount: 0,
        maxRetries: s.maxRetries ?? 2,
      })),
      createdAt: Date.now(),
      status: 'planning',
    };

    this.plans.set(plan.id, plan);
    logger.info('task_planner', `Created plan: ${plan.id} — ${plan.steps.length} steps for "${goal.slice(0, 60)}"`);
    return plan;
  }

  async executePlan(planId: string, executor: (step: PlanStep) => Promise<any>): Promise<Plan> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Plan not found: ${planId}`);

    plan.status = 'executing';

    for (const step of plan.steps) {
      // Check dependencies
      if (step.dependsOn?.length) {
        const depsOk = step.dependsOn.every(depId => {
          const dep = plan.steps.find(s => s.id === depId);
          return dep?.status === 'done';
        });
        if (!depsOk) {
          step.status = 'skipped';
          logger.warn('task_planner', `Skipped ${step.id}: dependencies not met`);
          continue;
        }
      }

      step.status = 'running';
      try {
        step.result = await executor(step);
        step.status = 'done';
        logger.info('task_planner', `Step ${step.id} done`);
      } catch (err) {
        step.retryCount++;
        if (step.retryCount <= step.maxRetries) {
          step.status = 'pending';
          logger.warn('task_planner', `Step ${step.id} failed, retry ${step.retryCount}/${step.maxRetries}`);
          // Re-queue by decrementing loop
        } else {
          step.status = 'failed';
          step.result = (err as Error).message;
          logger.error('task_planner', `Step ${step.id} failed permanently: ${err}`);
        }
      }
    }

    const allDone = plan.steps.every(s => s.status === 'done' || s.status === 'skipped');
    plan.status = allDone ? 'completed' : 'failed';
    logger.info('task_planner', `Plan ${plan.id} → ${plan.status}`);
    return plan;
  }

  getPlan(planId: string): Plan | undefined {
    return this.plans.get(planId);
  }

  getActivePlans(): Plan[] {
    return Array.from(this.plans.values()).filter(p => p.status === 'executing' || p.status === 'planning');
  }
}

export const taskPlanner = TaskPlanner.getInstance();
