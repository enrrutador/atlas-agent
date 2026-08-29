import type { Skill } from '../src/core/skills.js';
import { orchestrate, askKimi, getKimiStatus } from '../src/core/kimi_orchestrator.js';

/**
 * multi_agent — Kimi K2.6 multi-agent orchestration
 *
 * Atlas usa este skill cuando detecta que una tarea es compleja y se
 * beneficia de múltiples especialistas trabajando en paralelo.
 *
 * El LLM simplemente describe la tarea en "task" y el sistema decide
 * automáticamente si necesita 1, 2, 3... hasta 6 agentes.
 *
 * No hace falta especificar roles ni acciones — Kimi lo decide.
 */

const multiAgentSkill: Skill = {
  name: 'multi_agent',
  description: `Orquestación inteligente con Kimi K2.6 + hasta 6 agentes GLM-5.1 especializados en paralelo.
Usalo para tareas complejas que se benefician de múltiples perspectivas: implementar features completas,
analizar y refactorizar código, resolver bugs complejos, crear documentación técnica.
JSON Args: { "task": "descripción de la tarea", "context": "contexto adicional opcional", "maxAgents": 6 }
Para consulta directa a Kimi: { "task": "pregunta", "directKimi": true }`,

  execute: async (args: {
    task?: string;
    context?: string;
    maxAgents?: number;
    directKimi?: boolean;
    // Legacy support
    action?: string;
    goal?: string;
    question?: string;
  }) => {
    // Normalize args — support both new simple API and legacy action-based API
    const task = args.task || args.goal || args.question || '';
    const context = args.context || '';
    const maxAgents = Math.min(args.maxAgents || 6, 6);
    const directKimi = args.directKimi || args.action === 'ask_kimi';

    // Status check
    if (args.action === 'status' || task === 'status') {
      const s = getKimiStatus();
      return {
        success: true,
        available: s.available,
        model: s.model,
        message: s.available
          ? `✅ Kimi K2.6 listo\nModelo: ${s.model}`
          : '❌ Kimi no disponible — verificá KIMI_API_KEY en .env',
      };
    }

    if (!task) {
      return {
        success: false,
        message: 'Describí la tarea en el campo "task". Ejemplo: { "task": "implementar autenticación JWT" }',
      };
    }

    // Direct Kimi query (no sub-agents)
    if (directKimi) {
      try {
        const response = await askKimi(
          `Sos Kimi, el orquestador de Atlas-Agent. Respondés en español de forma técnica, 
precisa y directa. Sos experto en arquitectura de software, TypeScript y Node.js.`,
          task,
          2000
        );
        return { success: true, response, message: response };
      } catch (e: any) {
        return { success: false, message: `Error consultando Kimi: ${e.message}` };
      }
    }

    // Full orchestration
    try {
      console.log(`[MULTI_AGENT] Orchestrating: "${task.slice(0, 80)}"`);

      const result = await orchestrate(task, context, maxAgents);

      // Kimi decided this doesn't need multi-agent
      if (!result) {
        return {
          success: true,
          orchestrated: false,
          message: 'Esta tarea no requiere múltiples agentes. Ejecutala directamente.',
        };
      }

      const agentLog = result.agentResults
        .map(r => `${r.success ? '✅' : '❌'} ${r.role} — ${(r.durationMs / 1000).toFixed(1)}s`)
        .join('\n');

      console.log(`[MULTI_AGENT] Done: ${result.agentsUsed} agents in ${(result.totalDurationMs / 1000).toFixed(1)}s`);

      return {
        success: true,
        orchestrated: true,
        agentsUsed: result.agentsUsed,
        complexity: result.plan.estimatedComplexity,
        strategy: result.plan.strategy,
        totalSeconds: (result.totalDurationMs / 1000).toFixed(1),
        agentLog,
        result: result.synthesis,
        // message is what Atlas shows to the user
        message: result.synthesis,
      };
    } catch (e: any) {
      return { success: false, message: `Error en orquestación: ${e.message}` };
    }
  },
};

export default multiAgentSkill;
