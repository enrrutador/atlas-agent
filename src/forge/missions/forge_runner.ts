/**
 * Atlas Forge Runner - Cognitive cycle executor for autonomous missions
 * 
 * Executes a deep reasoning cycle for each idea:
 * MARCO → HIPÓTESIS → INVESTIGAR → CRITICAR → ANALIZAR → CUANTIFICAR →
 * EVALUAR → SINTETIZAR → REGISTRAR → AUTO-REVISAR
 * 
 * Each step is a real LLM call + web tools, not a shortcut.
 */

import { logger } from '../../common/logger.js';
import { generateId, delay } from '../../common/utils.js';
import { webTool } from '../../arms/tools/web/index.js';
import { ForgeLLMClient } from './forge_llm.js';
import { AtlasConfig } from '../../common/types.js';

export interface CognitiveStep {
  step: string;
  thought: string;
  data?: any;
  timestamp: number;
}

export interface IdeaResult {
  id: string;
  index: number;
  title: string;
  summary: string;
  deepAnalysis: string;
  risks: string;
  nextSteps: string;
  openQuestions: string;
  score: number;
  researchSources: string[];
  cognitiveSteps: CognitiveStep[];
  completedAt: number;
}

export interface MissionPlan {
  id: string;
  goal: string;
  totalVariants: number;
  variants: string[];
  criteria: string;
  status: 'planning' | 'executing' | 'completed' | 'failed' | 'paused';
  ideas: IdeaResult[];
  currentIdeaIndex: number;
  startedAt: number;
  completedAt?: number;
}

export type NotifyCallback = (message: string) => Promise<void>;
export type QuestionCallback = (question: string) => Promise<string>;
export type IdeaCompletedCallback = (idea: IdeaResult, total: number) => Promise<void>;

export class ForgeRunner {
  private static instance: ForgeRunner;
  private llm: ForgeLLMClient | null = null;
  private running = false;
  private currentPlan: MissionPlan | null = null;
  private aborted = false;
  private betweenIdeasDelay = 5000;

  private constructor() {}

  static getInstance(): ForgeRunner {
    if (!ForgeRunner.instance) {
      ForgeRunner.instance = new ForgeRunner();
    }
    return ForgeRunner.instance;
  }

  setLLMClient(config: AtlasConfig): void {
    this.llm = new ForgeLLMClient(config);
  }

  isRunning(): boolean {
    return this.running;
  }

  getCurrentPlan(): MissionPlan | null {
    return this.currentPlan;
  }

  abort(): void {
    this.aborted = true;
    logger.info('forge_runner', 'Abort signal received');
  }

  /**
   * Execute a full mission: N ideas, each through the cognitive cycle
   */
  async executeMission(
    plan: MissionPlan,
    onNotify: NotifyCallback,
    onQuestion: QuestionCallback,
    onIdeaComplete: IdeaCompletedCallback,
  ): Promise<MissionPlan> {
    if (this.running) {
      throw new Error('Forge is already running a mission');
    }

    this.running = true;
    this.aborted = false;
    this.currentPlan = plan;
    plan.status = 'executing';

    logger.info('forge_runner', `Starting mission: "${plan.goal}" (${plan.totalVariants} variants)`);

    try {
      for (let i = plan.currentIdeaIndex; i < plan.totalVariants; i++) {
        if (this.aborted) {
          await onNotify(`⏸️ Forge pausado por el usuario en idea ${i + 1}/${plan.totalVariants}. Progreso guardado.`);
          plan.status = 'paused';
          break;
        }

        await onNotify(`🧠 Forge procesando idea ${i + 1}/${plan.totalVariants}...`);

        const variant = plan.variants[i] || `Variante ${i + 1} de: ${plan.goal}`;
        const idea = await this.executeCognitiveCycle(plan, i, variant, onQuestion);

        plan.ideas.push(idea);
        plan.currentIdeaIndex = i + 1;

        await onIdeaComplete(idea, plan.totalVariants);

        if (i < plan.totalVariants - 1) {
          await delay(this.betweenIdeasDelay);
        }
      }

      if (!this.aborted) {
        plan.status = 'completed';
        plan.completedAt = Date.now();
        await onNotify(this.buildFinalSummary(plan));
      }

    } catch (err) {
      logger.error('forge_runner', `Mission failed: ${err}`);
      plan.status = 'failed';
      await onNotify(`❌ Forge falló en idea ${plan.currentIdeaIndex + 1}/${plan.totalVariants}: ${(err as Error).message}. Progreso guardado.`);
    } finally {
      this.running = false;
      this.currentPlan = null;
    }

    return plan;
  }

  /**
   * Execute the full cognitive cycle for a single idea
   */
  private async executeCognitiveCycle(
    plan: MissionPlan,
    index: number,
    variant: string,
    onQuestion: QuestionCallback,
  ): Promise<IdeaResult> {
    if (!this.llm) throw new Error('LLM client not configured');

    const steps: CognitiveStep[] = [];
    const researchSources: string[] = [];
    const t = () => Date.now();

    // 1. MARCO — Define the problem precisely
    const marco = await this.stepMarco(plan.goal, variant, plan.criteria);
    steps.push({ step: 'MARCO', thought: marco, timestamp: t() });

    // 2. HIPÓTESIS — Generate preliminary approaches
    const hipotesis = await this.stepHipotesis(plan.goal, variant, marco);
    steps.push({ step: 'HIPÓTESIS', thought: hipotesis, timestamp: t() });

    // 3. INVESTIGAR — Triangulate with real sources
    const { research, sources } = await this.stepInvestigar(plan.goal, variant, hipotesis);
    researchSources.push(...sources);
    steps.push({ step: 'INVESTIGAR', thought: research, timestamp: t() });

    // 4. CRITICAR — Expose assumptions, counterarguments, biases
    const criticar = await this.stepCriticar(plan.goal, variant, hipotesis, research);
    steps.push({ step: 'CRITICAR', thought: criticar, timestamp: t() });

    // 5. ANALIZAR — Breakdown + second order thinking
    const analizar = await this.stepAnalizar(plan.goal, variant, research, criticar);
    steps.push({ step: 'ANALIZAR', thought: analizar, timestamp: t() });

    // 6. CUANTIFICAR — Approximate numbers
    const cuantificar = await this.stepCuantificar(plan.goal, variant, research);
    steps.push({ step: 'CUANTIFICAR', thought: cuantificar, timestamp: t() });

    // 7. EVALUAR — Score against criteria
    const evaluar = await this.stepEvaluar(plan.goal, variant, plan.criteria, hipotesis, research, criticar, cuantificar);
    steps.push({ step: 'EVALUAR', thought: evaluar, timestamp: t() });

    // Ask user if score is low (ambiguous idea)
    const tempScore = await this.extractScore(evaluar);
    if (tempScore < 5) {
      await onQuestion(`La idea "${variant.slice(0, 60)}" tiene evaluación baja (${tempScore}/10). ¿Querés que profundice en un ángulo específico o que siga con la siguiente idea?`);
    }

    // 8. SINTETIZAR — Actionable idea
    const sintetizar = await this.stepSintetizar(plan.goal, variant, marco, hipotesis, research, criticar, analizar, cuantificar, evaluar);
    steps.push({ step: 'SINTETIZAR', thought: sintetizar, timestamp: t() });

    // 9. REGISTRAR — Open questions
    const registrar = await this.stepRegistrar(plan.goal, variant, marco, research, criticar, cuantificar);
    steps.push({ step: 'REGISTRAR', thought: registrar, timestamp: t() });

    // 10. AUTO-REVISAR — Check for logical gaps
    const autoRevisar = await this.stepAutoRevisar(sintetizar, criticar, registrar);
    steps.push({ step: 'AUTO-REVISAR', thought: autoRevisar, timestamp: t() });

    // Extract structured result from synthesis
    const result = await this.extractStructuredResult(sintetizar, evaluar, registrar, autoRevisar);

    return {
      id: generateId('idea'),
      index,
      title: result.title,
      summary: result.summary,
      deepAnalysis: result.deepAnalysis,
      risks: result.risks,
      nextSteps: result.nextSteps,
      openQuestions: result.openQuestions,
      score: result.score,
      researchSources,
      cognitiveSteps: steps,
      completedAt: Date.now(),
    };
  }

  // ─────────────────────────────────────────────────────
  // COGNITIVE STEP IMPLEMENTATIONS
  // ─────────────────────────────────────────────────────

  private async stepMarco(goal: string, variant: string, criteria: string): Promise<string> {
    const response = await this.llm!.chat([
      { role: 'system', content: `Sos un consultor senior experto. Tu trabajo es definir con precisión quirúrgica el problema que se quiere resolver. Sé directo, sin rodeos. Respondé en español.` },
      { role: 'user', content: `META GENERAL: ${goal}
VARIANTE ESPECÍFICA: ${variant}
CRITERIOS DE ÉXITO: ${criteria}

Definí el problema con precisión:
1. ¿Qué exactamente se quiere lograr con esta variante?
2. ¿Para quién es? (target)
3. ¿Cuáles son las restricciones reales (tiempo, plata, conocimientos, herramientas)?
4. ¿Qué sería un resultado exitoso concreto?
5. ¿Qué NO es esta idea (para evitar scope creep)?` },
    ], 1024, 0.4);
    return response;
  }

  private async stepHipotesis(goal: string, variant: string, marco: string): Promise<string> {
    const response = await this.llm!.chat([
      { role: 'system', content: `Sos un innovador senior con capacidad analítica. Generá enfoques preliminares, incluyendo ideas no obvias y disruptivas. No descartes nada antes de evaluar. Respondé en español.` },
      { role: 'user', content: `META: ${goal}
VARIANTE: ${variant}
MARCO DEL PROBLEMA:
${marco}

Generá 3-5 enfoques preliminares para esta variante. Para cada uno:
- Enfoque: [descripción corta]
- Por qué podría funcionar
- Principales dudas

Incluí al menos un enfoque que parezca "loco pero interesante".` },
    ], 2048, 0.8);
    return response;
  }

  private async stepInvestigar(goal: string, variant: string, hipotesis: string): Promise<{ research: string; sources: string[] }> {
    const sources: string[] = [];

    const queries = await this.llm!.chat([
      { role: 'system', content: 'Generá exactamente 4 queries de búsqueda optimizados para investigación profunda. Separados por salto de línea. Solo los queries, sin numeración ni explicación.' },
      { role: 'user', content: `META: ${goal}
VARIANTE: ${variant}
HIPÓTESIS: ${hipotesis.slice(0, 500)}

Necesito queries de búsqueda para investigar la factibilidad, mercado, competencia, y rentabilidad de esta idea.` },
    ], 256, 0.3);

    const searchQueries = queries.split('\n').filter(q => q.trim().length > 5).slice(0, 4);

    let allResearch = '';
    for (const query of searchQueries) {
      try {
        const results = await webTool.search(query, 'web', 5);
        allResearch += `\n--- Query: ${query} ---\n${results}\n`;
        sources.push(query);
        await delay(1000);
      } catch (err) {
        logger.warn('forge_runner', `Search failed for "${query}": ${err}`);
      }
    }

    const topUrls = await this.llm!.chat([
      { role: 'system', content: 'Del texto de investigación extrae las 2 URLs más relevantes para profundizar (una por línea). Solo URLs, nada más.' },
      { role: 'user', content: allResearch.slice(0, 3000) },
    ], 200, 0.2);

    const urls = topUrls.split('\n').filter(u => u.startsWith('http')).slice(0, 2);
    for (const url of urls) {
      try {
        const scraped = await webTool.scrape(url, 'basic');
        allResearch += `\n--- Scrape: ${url} ---\n${scraped.slice(0, 2000)}\n`;
        sources.push(url);
        await delay(1500);
      } catch (err) {
        logger.warn('forge_runner', `Scrape failed for "${url}": ${err}`);
      }
    }

    const synthesis = await this.llm!.chat([
      { role: 'system', content: 'Sintetizá la investigación en un análisis conciso: datos clave, hallazgos relevantes, tendencias, y gaps de información. En español.' },
      { role: 'user', content: allResearch.slice(0, 6000) },
    ], 1500, 0.4);

    return { research: synthesis, sources };
  }

  private async stepCriticar(goal: string, variant: string, hipotesis: string, research: string): Promise<string> {
    const response = await this.llm!.chat([
      { role: 'system', content: `Sos un escéptico inteligente y constructivo. Tu trabajo es encontrar fallas, supuestos ocultos, y debilidades en el razonamiento. No destruyás: construís con kritik. Respondé en español.` },
      { role: 'user', content: `META: ${goal}
VARIANTE: ${variant}

HIPÓTESIS:
${hipotesis}

INVESTIGACIÓN:
${research}

CRITICÁ con profundidad:
1. ¿Qué supuestos estoy dando por verdades sin verificar?
2. ¿Qué está fallando en el razonamiento?
3. ¿Qué diría un escéptico profesional?
4. ¿Qué datos estoy ignorando o sesgando?
5. ¿Cuáles son las debilidades fatales de esta idea?
6. ¿Qué fuentes de investigación son poco confiables y por qué?` },
    ], 2048, 0.5);
    return response;
  }

  private async stepAnalizar(goal: string, variant: string, research: string, criticar: string): Promise<string> {
    const response = await this.llm!.chat([
      { role: 'system', content: `Sos un analista de segundo orden. Tu trabajo es pensar más allá de lo inmediato: ¿qué pasa DESPUÉS? ¿Qué consecuencias no obvias hay? ¿Qué cadenas de causa-efecto se activan? Respondé en español.` },
      { role: 'user', content: `META: ${goal}
VARIANTE: ${variant}

INVESTIGACIÓN:
${research}

CRÍTICA:
${criticar}

ANALIZÁ con second-order thinking:
1. ¿Qué consecuencias tiene esta idea a 3 meses, 6 meses, 1 año?
2. ¿Qué pasaría si funciona MUY BIEN? (escalabilidad, sobrecarga)
3. ¿Qué pasaría si falla? (escenario pesimista)
4. ¿Qué oportunidades secundarias se abren?
5. ¿Qué competidores o tendencias podrían cambiar el juego?
6. Desglose: componentes necesarios (tecnología, conocimiento, tiempo, dinero)` },
    ], 2048, 0.5);
    return response;
  }

  private async stepCuantificar(goal: string, variant: string, research: string): Promise<string> {
    const response = await this.llm!.chat([
      { role: 'system', content: `Sos un analista financiero y de mercado. Cuantificá todo lo que puedas. Si no tenés datos exactos, estimá con rango (ej: "USD 500-2000/mes") y explicá tu razonamiento. En español.` },
      { role: 'user', content: `META: ${goal}
VARIANTE: ${variant}

INVESTIGACIÓN:
${research}

CUANTIFICÁ:
1. Tamaño de mercado aproximado (usuarios, facturación)
2. Costo de implementación (setup + operación mensual)
3. Tiempo estimado hasta primer resultado
4. Margen / retorno esperado (rango)
5. Costo de oportunidad (qué se deja de hacer)
6. Métricas clave: CAC, LTV, churn estimado, etc.

Para cada número: dato + fuente/confianza + razonamiento.` },
    ], 2048, 0.4);
    return response;
  }

  private async stepEvaluar(goal: string, variant: string, criteria: string, hipotesis: string, research: string, criticar: string, cuantificar: string): Promise<string> {
    const response = await this.llm!.chat([
      { role: 'system', content: `Sos un evaluador imparcial. Creá una matriz de evaluación con puntuaciones numéricas. Sé honesto: si algo es débil, decilo. En español.` },
      { role: 'user', content: `META: ${goal}
VARIANTE: ${variant}
CRITERIOS: ${criteria}

HIPÓTESIS:
${hipotesis}

INVESTIGACIÓN:
${research}

CRÍTICA:
${criticar}

CUANTIFICACIÓN:
${cuantificar}

EVALUÁ esta idea contra los criterios. Matriz:
| Criterio | Puntuación (1-10) | Justificación |
|---|---|---|
| Factibilidad técnica | | |
| Costo vs retorno | | |
| Tiempo de implementación | | |
| Diferenciación / competencia | | |
| Escalabilidad | | |
| Riesgo general | | |

Puntuación final promedio: X/10
¿Es recomendable avanzar? (sí/no/condicional)` },
    ], 2048, 0.3);
    return response;
  }

  private async stepSintetizar(goal: string, variant: string, marco: string, hipotesis: string, research: string, criticar: string, analizar: string, cuantificar: string, evaluar: string): Promise<string> {
    const response = await this.llm!.chat([
      { role: 'system', content: `Sos un consultor senior que entrega recomendaciones accionables. Sé directo, concreto, y jerárquico. No des vueltas. En español.` },
      { role: 'user', content: `META: ${goal}
VARIANTE: ${variant}

MARCO: ${marco.slice(0, 500)}
HIPÓTESIS: ${hipotesis.slice(0, 800)}
INVESTIGACIÓN: ${research.slice(0, 1500)}
CRÍTICA: ${criticar.slice(0, 1000)}
ANÁLISIS: ${analizar.slice(0, 1000)}
CUANTIFICACIÓN: ${cuantificar.slice(0, 1000)}
EVALUACIÓN: ${evaluar.slice(0, 1000)}

Sintetizá esta idea en:
1. TÍTULO de la idea (corto, memorable)
2. RESUMEN EJECUTIVO (3-5 oraciones)
3. ANÁLISIS PROFUNDO (por qué, cómo, contexto)
4. PRIMEROS PASOS CONCRETOS (top 5 acciones inmediatas)
5. RIESGOS PRINCIPALES (top 3)
6. QUÉ FALTA VALIDAR antes de empezar` },
    ], 3000, 0.5);
    return response;
  }

  private async stepRegistrar(goal: string, variant: string, marco: string, research: string, criticar: string, cuantificar: string): Promise<string> {
    const response = await this.llm!.chat([
      { role: 'system', content: `Sos un investigador riguroso. Registrá las incógnitas abiertas: qué quedó sin responder, qué requiere investigación adicional, qué supuestos quedaron sin validar. En español.` },
      { role: 'user', content: `META: ${goal}
VARIANTE: ${variant}
MARCO: ${marco.slice(0, 300)}
INVESTIGACIÓN: ${research.slice(0, 800)}
CRÍTICA: ${criticar.slice(0, 600)}
CUANTIFICACIÓN: ${cuantificar.slice(0, 600)}

Listá las incógnitas abiertas:
- Preguntas sin respuesta
- Supuestos sin validar
- Datos faltantes
- Riesgos no cuantificados
- Investigación adicional necesaria` },
    ], 1024, 0.3);
    return response;
  }

  private async stepAutoRevisar(sintetizar: string, criticar: string, registrar: string): Promise<string> {
    const response = await this.llm!.chat([
      { role: 'system', content: `Sos un editor crítico. Releé la síntesis, encontrá huecos lógicos, contradicciones, o afirmaciones sin sustento. Corregí lo que haga falta. En español.` },
      { role: 'user', content: `SÍNTESIS A REVISAR:
${sintetizar}

CRÍTICAS PREVIAS:
${criticar.slice(0, 500)}

INCOGNITAS:
${registrar.slice(0, 500)}

Revisá:
1. ¿Hay contradicciones internas?
2. ¿Algún punto de la síntesis no tiene sustento en la investigación?
3. ¿Qué afirmaciones son débiles y necesitan matiz?
4. ¿Qué se puede fortalecer o aclarar?
5. Corregí lo que haga falta.` },
    ], 1500, 0.3);
    return response;
  }

  private async extractScore(evaluar: string): Promise<number> {
    const match = evaluar.match(/(\d+(?:\.\d+)?)\s*\/\s*10/);
    if (match) {
      return Math.min(10, Math.max(1, parseFloat(match[1])));
    }
    const avgMatch = evaluar.match(/[Pp]romedio[:\s]*(\d+(?:\.\d+)?)/);
    if (avgMatch) {
      return Math.min(10, Math.max(1, parseFloat(avgMatch[1])));
    }
    return 5;
  }

  private async extractStructuredResult(sintetizar: string, evaluar: string, registrar: string, _autoRevisar: string): Promise<{
    title: string;
    summary: string;
    deepAnalysis: string;
    risks: string;
    nextSteps: string;
    openQuestions: string;
    score: number;
  }> {
    const response = await this.llm!.chat([
      { role: 'system', content: 'Extraé la siguiente información del texto. Respondé EXACTAMENTE en formato JSON válido, sin explicaciones.' },
      { role: 'user', content: `Texto:
${sintetizar.slice(0, 3000)}

Evaluación:
${evaluar.slice(0, 1500)}

{
  "title": "título corto de la idea",
  "summary": "resumen ejecutivo 3-5 oraciones",
  "deepAnalysis": "análisis profundo 2-3 párrafos",
  "risks": "riesgos principales top 3",
  "nextSteps": "primeros pasos top 5",
  "openQuestions": "incógnitas abiertas",
  "score": número del 1 al 10
}` },
    ], 1500, 0.2);

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          title: parsed.title || 'Sin título',
          summary: parsed.summary || sintetizar.slice(0, 300),
          deepAnalysis: parsed.deepAnalysis || sintetizar,
          risks: parsed.risks || 'No especificado',
          nextSteps: parsed.nextSteps || 'No especificado',
          openQuestions: parsed.openQuestions || registrar,
          score: Math.min(10, Math.max(1, parsed.score || 5)),
        };
      }
    } catch (err) {
      logger.warn('forge_runner', `Failed to parse structured result: ${err}`);
    }

    return {
      title: sintetizar.split('\n')[0]?.slice(0, 100) || 'Idea sin título',
      summary: sintetizar.slice(0, 500),
      deepAnalysis: sintetizar,
      risks: 'Ver análisis completo',
      nextSteps: 'Ver análisis completo',
      openQuestions: registrar,
      score: 5,
    };
  }

  private buildFinalSummary(plan: MissionPlan): string {
    const sorted = [...plan.ideas].sort((a, b) => b.score - a.score);
    const avg = plan.ideas.reduce((s, i) => s + i.score, 0) / plan.ideas.length;

    let summary = `🏁 **Forge completó la misión: ${plan.goal}**\n\n`;
    summary += `📊 **Resumen**: ${plan.ideas.length} ideas procesadas | Promedio: ${avg.toFixed(1)}/10\n\n`;
    summary += `🏆 **Top 3 ideas**:\n`;

    sorted.slice(0, 3).forEach((idea, i) => {
      summary += `\n**${i + 1}. ${idea.title}** (${idea.score}/10)\n`;
      summary += `${idea.summary}\n`;
    });

    summary += `\n📋 **Todas las ideas** (ordenadas por puntuación):\n`;
    sorted.forEach((idea, i) => {
      summary += `${i + 1}. ${idea.title} — ${idea.score}/10\n`;
    });

    summary += `\n⏳ Tiempo: ${plan.startedAt ? ((Date.now() - plan.startedAt) / 60000).toFixed(0) : '?'} minutos`;

    return summary;
  }
}

export const forgeRunner = ForgeRunner.getInstance();
