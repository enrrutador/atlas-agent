/**
 * Atlas Mission Manager - Manages autonomous Forge missions
 * 
 * 1 mission at a time, persistence, reanudación after restart.
 * Interfaces with Telegram for proactive notifications.
 */

import { logger } from '../../common/logger.js';
import { generateId } from '../../common/utils.js';
import { MissionPlan, forgeRunner, IdeaResult } from './forge_runner.js';
import { AtlasConfig } from '../../common/types.js';
import fs from 'fs';
import path from 'path';

const MISSIONS_DIR = path.join(process.cwd(), 'data', 'missions');

export class MissionManager {
  private static instance: MissionManager;
  private currentPlan: MissionPlan | null = null;
  private config: AtlasConfig | null = null;
  private questionPending: {
    resolve: (answer: string) => void;
    question: string;
  } | null = null;

  private constructor() {
    if (!fs.existsSync(MISSIONS_DIR)) {
      fs.mkdirSync(MISSIONS_DIR, { recursive: true });
    }
  }

  static getInstance(): MissionManager {
    if (!MissionManager.instance) {
      MissionManager.instance = new MissionManager();
    }
    return MissionManager.instance;
  }

  setConfig(config: AtlasConfig): void {
    this.config = config;
  }

  /**
   * True if Forge is currently waiting for a user answer
   */
  isAwaitingAnswer(): boolean {
    return this.questionPending !== null;
  }

  /**
   * Get the question Forge is waiting an answer to
   */
  getPendingQuestion(): string | null {
    return this.questionPending?.question ?? null;
  }

  /**
   * Deliver a user answer to Forge (resumes the mission)
   */
  answerQuestion(answer: string): boolean {
    if (!this.questionPending) return false;
    const pending = this.questionPending;
    this.questionPending = null;
    pending.resolve(answer);
    return true;
  }

  /**
   * Timeout for a question with no response (default 30min)
   */
  answerQuestionTimeout(): void {
    if (this.questionPending) {
      this.answerQuestion('sin respuesta');
    }
  }

  /**
   * Create and start a new mission. Only 1 at a time.
   */
  async startMission(
    goal: string,
    totalVariants: number,
    onNotify: (msg: string) => Promise<void>,
    onQuestion: (q: string) => Promise<string>,
    onIdeaComplete: (idea: IdeaResult, total: number) => Promise<void>,
  ): Promise<MissionPlan> {
    if (forgeRunner.isRunning()) {
      const current = forgeRunner.getCurrentPlan();
      const status = current ? `trabajando en: "${current.goal}" (${current.ideas.length}/${current.totalVariants})` : 'ocupado';
      throw new Error(`Forge ya está activo: ${status}. Usá /forge status o /forge cancel`);
    }

    const variants = await this.generateVariants(goal, totalVariants);
    const criteria = await this.defineCriteria(goal);

    const plan: MissionPlan = {
      id: generateId('mission'),
      goal,
      totalVariants,
      variants,
      criteria,
      status: 'planning',
      ideas: [],
      currentIdeaIndex: 0,
      startedAt: Date.now(),
    };

    this.currentPlan = plan;
    this.savePlan(plan);

    await onNotify(`🚀 **Forge inició la misión:**\n\n"${goal}"\n\n📋 ${totalVariants} variantes a investigar\n🧠 Ciclo cognitivo: marco → hipótesis → investigación → crítica → análisis → cuantificación → evaluación → síntesis → auto-revisión\n\n⏳ Te aviso con cada idea completa.`);

    const questionHandler = this.createQuestionHandler(onQuestion);

    forgeRunner.executeMission(plan, onNotify, questionHandler, onIdeaComplete)
      .then((completedPlan: MissionPlan) => {
        this.currentPlan = completedPlan;
        this.savePlan(completedPlan);
      })
      .catch((err: Error) => {
        logger.error('mission_manager', `Mission runner failed: ${err}`);
        if (this.currentPlan) {
          this.currentPlan.status = 'failed';
          this.savePlan(this.currentPlan);
        }
      });

    return plan;
  }

  /**
   * Get current mission status
   */
  getStatus(): string {
    const plan = this.currentPlan;
    if (!plan) {
      const lastPlan = this.getLastPlan();
      if (lastPlan) {
        return `Forge inactivo. Última misión: "${lastPlan.goal}" (${lastPlan.status}, ${lastPlan.ideas.length}/${lastPlan.totalVariants} ideas)`;
      }
      return 'Forge inactivo. No hay misiones.';
    }

    const elapsed = ((Date.now() - plan.startedAt) / 60000).toFixed(0);
    let status = `🔧 **Forge activo:** "${plan.goal}"\n`;
    status += `📊 Progreso: ${plan.ideas.length}/${plan.totalVariants} ideas (${elapsed} min)\n`;

    if (plan.ideas.length > 0) {
      const lastIdea = plan.ideas[plan.ideas.length - 1];
      status += `✅ Última: "${lastIdea.title}" (${lastIdea.score}/10)\n`;
    }

    status += `⏱️ Tiempo: ${elapsed} minutos`;
    return status;
  }

  /**
   * Abort current mission
   */
  abort(): boolean {
    if (!forgeRunner.isRunning()) return false;
    forgeRunner.abort();
    return true;
  }

  /**
   * Pause (after current idea finishes)
   */
  pause(): void {
    forgeRunner.abort();
  }

  /**
   * Save plan to disk for reanudación
   */
  private savePlan(plan: MissionPlan): void {
    try {
      const filePath = path.join(MISSIONS_DIR, `${plan.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(plan, null, 2));
      logger.info('mission_manager', `Plan saved: ${plan.id}`);
    } catch (err) {
      logger.error('mission_manager', `Failed to save plan: ${err}`);
    }
  }

  /**
   * Load plan from disk
   */
  private loadPlan(planId: string): MissionPlan | null {
    try {
      const filePath = path.join(MISSIONS_DIR, `${planId}.json`);
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
    } catch (err) {
      logger.error('mission_manager', `Failed to load plan: ${err}`);
    }
    return null;
  }

  /**
   * Get last plan (most recent)
   */
  private getLastPlan(): MissionPlan | null {
    try {
      const files = fs.readdirSync(MISSIONS_DIR)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse();

      if (files.length > 0) {
        return this.loadPlan(files[0].replace('.json', ''));
      }
    } catch (err) {
      logger.error('mission_manager', `Failed to get last plan: ${err}`);
    }
    return null;
  }

  /**
   * Resume a paused/failed mission
   */
  async resumeMission(
    planId: string,
    onNotify: (msg: string) => Promise<void>,
    onQuestion: (q: string) => Promise<string>,
    onIdeaComplete: (idea: IdeaResult, total: number) => Promise<void>,
  ): Promise<MissionPlan | null> {
    if (forgeRunner.isRunning()) {
      throw new Error('Forge ya está activo. Cancelá la misión actual primero.');
    }

    const plan = this.loadPlan(planId);
    if (!plan) {
      throw new Error(`Misión ${planId} no encontrada`);
    }

    if (plan.status === 'completed') {
      throw new Error(`La misión "${plan.goal}" ya está completada`);
    }

    if (plan.currentIdeaIndex >= plan.totalVariants) {
      throw new Error(`La misión "${plan.goal}" ya procesó todas las ideas`);
    }

    this.currentPlan = plan;
    await onNotify(`🔄 **Retomando misión:** "${plan.goal}" (${plan.ideas.length}/${plan.totalVariants} ideas hechas, continuando desde la ${plan.currentIdeaIndex + 1})`);

    const questionHandler = this.createQuestionHandler(onQuestion);

    forgeRunner.executeMission(plan, onNotify, questionHandler, onIdeaComplete)
      .then((completedPlan: MissionPlan) => {
        this.currentPlan = completedPlan;
        this.savePlan(completedPlan);
      })
      .catch((err: Error) => {
        logger.error('mission_manager', `Mission resume failed: ${err}`);
      });

    return plan;
  }

  /**
   * Creates an onQuestion handler that pauses and waits for the user answer.
   * The actual question display is delegated to the notify callback.
   */
  private createQuestionHandler(notify: (msg: string) => Promise<any>): (q: string) => Promise<string> {
    return (question: string): Promise<string> => {
      return new Promise<string>((resolve) => {
        let timer: NodeJS.Timeout | null = null;

        if (this.questionPending) {
          resolve('sin respuesta');
          return;
        }

        this.questionPending = {
          resolve: (answer: string) => {
            if (timer) clearTimeout(timer);
            resolve(answer);
          },
          question,
        };

        const timeoutMs = parseInt(process.env.FORGE_QUESTION_TIMEOUT_MS || '1800000', 10);
        timer = setTimeout(() => {
          if (this.questionPending?.question === question) {
            this.questionPending = null;
            resolve('sin respuesta');
          }
        }, timeoutMs);

        notify(`❓ **Forge necesita tu respuesta:**\n\n${question}\n\n(Si no respondés, asumo "sin respuesta" y sigo.)`).catch(() => {});
      });
    };
  }

  /**
   * Generate N variant descriptions using LLM
   */
  private async generateVariants(goal: string, n: number): Promise<string[]> {
    const variants: string[] = [];

    if (n <= 1) {
      return [goal];
    }

    if (!this.config) {
      for (let i = 0; i < n; i++) {
        variants.push(`Variante ${i + 1} de: ${goal}`);
      }
      return variants;
    }

    try {
      const { ForgeLLMClient } = await import('./forge_llm.js');
      const llm = new ForgeLLMClient(this.config);

      const response = await llm.chat([
        { role: 'system', content: `Generá exactamente ${n} variantes de una idea. Cada variante debe ser un ángulo DIFERENTE y específico. Respondé solo una variante por línea, sin numeración, sin explicaciones.` },
        { role: 'user', content: `Idea base: ${goal}\n\nGenerá ${n} variantes:` },
      ], 1000, 0.8);

      const lines = response.split('\n').filter(l => l.trim().length > 5).slice(0, n);

      for (let i = 0; i < n; i++) {
        variants.push(lines[i]?.trim() || `Variante ${i + 1} de: ${goal}`);
      }
    } catch (err) {
      logger.warn('mission_manager', `Variant generation failed: ${err}`);
      for (let i = 0; i < n; i++) {
        variants.push(`Variante ${i + 1} de: ${goal}`);
      }
    }

    return variants;
  }

  /**
   * Define evaluation criteria using LLM
   */
  private async defineCriteria(goal: string): Promise<string> {
    if (!this.config) return 'Factibilidad, costo, tiempo, diferenciación, escalabilidad';

    try {
      const { ForgeLLMClient } = await import('./forge_llm.js');
      const llm = new ForgeLLMClient(this.config);

      const response = await llm.chat([
        { role: 'system', content: 'Definí criterios de evaluación específicos para esta misión. Respuesta corta: 3-5 criterios con brief description.' },
        { role: 'user', content: `Misión: ${goal}\n\n¿Qué criterios son importantes para evaluar estas ideas?` },
      ], 300, 0.3);

      return response;
    } catch (err) {
      logger.warn('mission_manager', `Criteria definition failed: ${err}`);
      return 'Factibilidad técnica, costo vs retorno, tiempo de implementación, diferenciación, escalabilidad';
    }
  }

  /**
   * Parse a natural language mission request
   * Returns { goal, variants } or null if not a mission request
   */
  static parseMissionRequest(text: string): { goal: string; variants: number } | null {
    const lower = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const forgePatterns = [
      /forge\s*,?\s*(trabaj[áa]|pens[áa]|investig[áa]|analiz[áa]|hac[ée])/i,
      /activ[áa]\s+forge/i,
      /modo\s+forge/i,
      /forge\s+mode/i,
      /que\s+forge\s+(trabaj|pens|investig|analiz|hac)/i,
      /dej[áa]\s+(que\s+)?forge\s+(trabaj|pens|investig|analiz|hac)/i,
      /mand[áa]\s+a\s+forge/i,
      /encarg[áa]\s+(a\s+)?forge/i,
    ];

    const isForgeMission = forgePatterns.some(p => p.test(text)) ||
      (lower.includes('forge') && (lower.includes('toda la noche') || lower.includes('background') || lower.includes('autonomo') || lower.includes('10 opciones') || lower.includes('variantes')));

    if (!isForgeMission) return null;

    let variants = 10;
    const numMatch = text.match(/(\d+)\s*(?:variantes?|opciones?|ideas?|alternativas?|propuestas?)/i);
    if (numMatch) {
      variants = Math.min(20, Math.max(2, parseInt(numMatch[1])));
    }

    const goal = text
      .replace(/forge\s*,?\s*/gi, '')
      .replace(/activ[áa]\s+forge\s*,?\s*/gi, '')
      .replace(/modo\s+forge\s*,?\s*/gi, '')
      .replace(/forge\s+mode\s*,?\s*/gi, '')
      .replace(/que\s+forge\s+/gi, '')
      .replace(/dej[áa]\s+(que\s+)?forge\s+/gi, '')
      .replace(/mand[áa]\s+a\s+forge\s*,?\s*/gi, '')
      .replace(/encarg[áa]\s+(a\s+)?forge\s*,?\s*/gi, '')
      .replace(/trabaj[áa]\s+en\s+/gi, '')
      .replace(/pens[áa]\s+(en|sobre|acerc[ao])\s+/gi, '')
      .replace(/investig[áa]\s+/gi, '')
      .replace(/analiz[áa]\s+/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (goal.length < 10) return null;

    return { goal, variants };
  }
}

export const missionManager = MissionManager.getInstance();
