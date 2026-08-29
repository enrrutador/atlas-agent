import type { Skill } from '../src/core/skills.js';

/**
 * FORGE — Razonamiento estructurado global del agente
 *
 * Dos modos de activación:
 * 1. MANUAL: El agente lo llama explícitamente cuando la respuesta obvia sería mediocre
 * 2. AUTOMÁTICO: El pre-action hook lo inyecta antes de acciones de riesgo/complejidad
 *
 * Diseño: NO hace llamadas API propias.
 * Devuelve un prompt estructurado que el agente ejecuta en su propio contexto.
 * Esto evita llamadas concurrentes y timeouts.
 */

interface ForgeInput {
  problem: string;
  context?: string;
  mode?: 'creative' | 'analytical' | 'decision';
}

const MODE_INSTRUCTIONS: Record<string, string> = {
  creative: `Modo CREATIVO: priorizá lo inesperado.
Alejate del camino obvio. Permitite ideas raras, contradictorias, imposibles.
El objetivo es producir algo que nadie más produciría.`,

  analytical: `Modo ANALÍTICO: revelá lo que no se ve.
¿Qué supuestos ocultos hay? ¿Qué contradicciones internas?
¿Qué consecuencias no obvias tiene esta acción o decisión?`,

  decision: `Modo DECISIÓN: elegí el mejor camino.
¿Cuál es la forma MÁS SIMPLE de lograr el objetivo?
¿Qué puede salir mal? ¿Es reversible?
¿Hay información que falta antes de actuar?
¿Esto es exactamente lo que Marcelo quiere, o hay una interpretación mejor?`,
};

const forgeSkill: Skill = {
  name: 'forge',
  description: `FORGE — Razonamiento estructurado en 3 capas. Tu espacio de pensamiento privado.
Ejecuta: exploración libre → crítica destructiva → síntesis creativa.
CUÁNDO USARLO: tareas complejas, decisiones con trade-offs, análisis profundos, cuando la respuesta obvia sería mediocre o riesgosa.
CUÁNDO NO USARLO: acciones simples y directas (búsquedas, recordatorios, lecturas de archivos).
El resultado es INVISIBLE para el usuario — actuá con la síntesis, no la muestres.
TAMBIÉN: cuando veas un bloque [PRE-ACTION FORGE] en el contexto, ese ES el forge — ejecutalo.
Args: { "problem": "qué resolver", "context": "contexto relevante", "mode": "creative|analytical|decision" }`,

  execute: async (args: ForgeInput): Promise<{ forge_prompt: string; instruction: string }> => {
    const { problem, context = '', mode = 'decision' } = args;

    if (!problem) {
      return {
        forge_prompt: '',
        instruction: 'No se especificó problema para forge.',
      };
    }

    const modeInstr = MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS.decision!;

    const forge_prompt = `
[FORGE ACTIVADO — RAZONAMIENTO INTERNO PRIVADO]
${modeInstr}

PROBLEMA: ${problem}
${context ? `CONTEXTO: ${context}` : ''}

━━ CAPA 1 — EXPLORACIÓN LIBRE ━━
Generá al menos 3 enfoques sin filtrar. Incluí el más simple posible Y el más inesperado.
No te autocensures.

━━ CAPA 2 — CRÍTICA DESTRUCTIVA ━━
Atacá cada enfoque sin piedad.
¿Qué falla? ¿Qué asume incorrectamente? ¿En qué caso colapsa?
¿Hay algo más simple que no consideraste?

━━ CAPA 3 — SÍNTESIS ━━
Con lo que sobrevivió la crítica, construí la mejor acción concreta.
Sé específico: ¿qué herramienta, con qué argumentos exactos, en qué orden?

[FIN FORGE — Ejecutá la síntesis. No muestres este proceso al usuario.]
`.trim();

    console.log(`[FORGE] Activado | modo: ${mode} | problema: ${problem.slice(0, 80)}`);

    return {
      forge_prompt,
      instruction: `Forge activado. Ejecutá el razonamiento y luego actuá con la síntesis. NO muestres el proceso.`,
    };
  },
};

export default forgeSkill;
