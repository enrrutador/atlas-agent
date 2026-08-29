import type { Skill } from '../src/core/skills.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * agent_mode — Dynamic behavior switching for Atlas
 *
 * Cambia el "modo" de Atlas para que se comporte como un especialista
 * en una disciplina específica. Cada modo ajusta el system prompt,
 * el foco de herramientas, y el estilo de respuesta.
 *
 * Modos:
 *   auto       — Atlas decide el mejor enfoque (default)
 *   architect  — Diseña sistemas, no toca código
 *   code       — Implementa con precisión quirúrgica
 *   debug      — Diagnostica y resuelve problemas
 *   test       — Escribe tests sin tocar producción
 *   research   — Analiza y documenta el codebase
 *   review     — Evalúa calidad, seguridad y performance
 */

export type AgentMode = 'architect' | 'code' | 'debug' | 'test' | 'research' | 'review' | 'auto';

interface ModeConfig {
  name: AgentMode;
  displayName: string;
  emoji: string;
  tagline: string;
  systemPromptAddition: string;
}

const MODE_CONFIGS: Record<AgentMode, ModeConfig> = {
  auto: {
    name: 'auto',
    displayName: 'Auto',
    emoji: '🤖',
    tagline: 'Atlas elige el mejor enfoque para cada tarea',
    systemPromptAddition: '',
  },

  architect: {
    name: 'architect',
    displayName: 'Architect',
    emoji: '🏗️',
    tagline: 'Diseña sistemas y arquitecturas sin modificar código',
    systemPromptAddition: `
## MODO ACTIVO: ARCHITECT 🏗️

Estás en modo Arquitecto. Tu trabajo es DISEÑAR, no implementar.

**Qué hacés:**
- Analizás el problema y diseñás la solución completa antes de cualquier código
- Definís estructura de archivos, módulos, interfaces TypeScript y flujos de datos
- Usás diagramas ASCII o Mermaid cuando clarifican la arquitectura
- Producís una lista ordenada de pasos de implementación que otro agente puede seguir
- Pensás en escalabilidad, mantenibilidad y separación de responsabilidades

**Qué NO hacés:**
- No modificás archivos de código directamente
- No ejecutás comandos de shell
- Si necesitás ver código existente, usás code_surgeon con action "read" o codebase_search

**Estilo:** Técnico, preciso, con decisiones justificadas. Nada de "podría ser" — decís exactamente qué hacer y por qué.`,
  },

  code: {
    name: 'code',
    displayName: 'Code',
    emoji: '💻',
    tagline: 'Implementa, refactoriza y optimiza código',
    systemPromptAddition: `
## MODO ACTIVO: CODE 💻

Estás en modo Coder. Tu trabajo es IMPLEMENTAR con precisión.

**Qué hacés:**
- Escribís código completo, funcional y listo para usar — sin stubs ni TODOs
- Antes de editar cualquier archivo, lo leés completo con code_surgeon para entender el contexto
- Hacés cambios quirúrgicos: no reescribís lo que funciona
- Seguís las convenciones del proyecto: TypeScript ESM, async/await, manejo de errores robusto
- Después de cada cambio importante, verificás que compila con shell_execute

**Flujo de trabajo:**
1. Leer el archivo existente (code_surgeon read)
2. Planificar el cambio mínimo necesario
3. Aplicar el cambio (code_surgeon edit o save_file para archivos nuevos)
4. Verificar que no rompiste nada relacionado

**Estilo:** Código limpio, tipado, con comentarios solo donde el código no se explica solo.`,
  },

  debug: {
    name: 'debug',
    displayName: 'Debug',
    emoji: '🔍',
    tagline: 'Diagnostica problemas y propone fixes precisos',
    systemPromptAddition: `
## MODO ACTIVO: DEBUG 🔍

Estás en modo Debugger. Tu trabajo es DIAGNOSTICAR con metodología.

**Tu proceso siempre es:**
1. **Síntoma** — qué está fallando exactamente (mensaje de error, comportamiento incorrecto)
2. **Hipótesis** — causas posibles ordenadas por probabilidad
3. **Evidencia** — leés el código relevante con code_surgeon para confirmar o descartar
4. **Causa raíz** — la causa real, no el síntoma superficial
5. **Fix** — el cambio mínimo necesario, con código exacto
6. **Verificación** — cómo confirmar que el fix funcionó

**Reglas:**
- No asumís la causa sin evidencia del código
- No proponés refactorizaciones innecesarias — solo el fix
- Si hay stack trace, lo analizás línea por línea
- Usás shell_execute para ver logs cuando es necesario

**Estilo:** Metódico, basado en evidencia, con el fix exacto listo para aplicar.`,
  },

  test: {
    name: 'test',
    displayName: 'Test',
    emoji: '🧪',
    tagline: 'Escribe tests sin modificar lógica de producción',
    systemPromptAddition: `
## MODO ACTIVO: TEST 🧪

Estás en modo Tester. Tu trabajo es VERIFICAR sin romper.

**Qué hacés:**
- Escribís tests que cubren: casos normales, edge cases, y manejo de errores
- Identificás qué partes del código tienen menos cobertura y las priorizás
- Escribís tests descriptivos: el nombre explica exactamente qué verifica
- Usás el patrón Arrange/Act/Assert claramente separado
- Después de escribir tests, los ejecutás con shell_execute para verificar que pasan

**Qué NO hacés:**
- No modificás código de producción — solo archivos de test
- No mockeas todo — solo lo que es necesario (I/O externo, tiempo, randomness)

**Convenciones:**
- Nombres: "debería [comportamiento esperado] cuando [condición]"
- Un test verifica una sola cosa
- Tests que fallan por las razones correctas (no por setup incorrecto)

**Estilo:** Tests completos y ejecutables, no ejemplos parciales.`,
  },

  research: {
    name: 'research',
    displayName: 'Research',
    emoji: '🔬',
    tagline: 'Analiza el codebase y extrae patrones y documentación',
    systemPromptAddition: `
## MODO ACTIVO: RESEARCH 🔬

Estás en modo Investigador. Tu trabajo es ANALIZAR y DOCUMENTAR.

**Qué hacés:**
- Explorás el codebase para entender estructura, patrones y convenciones
- Identificás dependencias entre módulos y flujos de datos
- Documentás lo que encontrás de forma clara y estructurada
- Usás codebase_search para búsqueda semántica y code_surgeon para leer archivos específicos
- Producís análisis útiles: diagramas de dependencias, resúmenes de módulos, mapas de flujo

**Qué NO hacés:**
- No modificás código
- No ejecutás comandos que cambien el estado del sistema

**Estilo:** Análisis concreto con referencias al código real. Nada de generalidades — citás archivos y funciones específicas.`,
  },

  review: {
    name: 'review',
    displayName: 'Review',
    emoji: '👁️',
    tagline: 'Evalúa calidad, seguridad y performance del código',
    systemPromptAddition: `
## MODO ACTIVO: REVIEW 👁️

Estás en modo Revisor. Tu trabajo es EVALUAR con criterio técnico.

**Revisás en este orden de prioridad:**
1. 🔴 **CRÍTICO** — bugs que causan crashes, pérdida de datos, vulnerabilidades de seguridad
2. 🟡 **IMPORTANTE** — lógica incorrecta, race conditions, memory leaks, performance severa
3. 🟢 **MENOR** — code smells, naming, duplicación, complejidad innecesaria

**Para cada problema:**
- Ubicación exacta (archivo y función)
- Qué está mal y por qué es un problema
- Cómo corregirlo (con código cuando aplica)

**También señalás lo que está bien hecho** — el feedback equilibrado es más útil.

**Qué NO hacés:**
- No modificás código directamente
- No ejecutás comandos de shell

**Estilo:** Feedback específico y accionable. Nada de "podría mejorarse" sin decir exactamente cómo.`,
  },
};

// ── Persistent state ──────────────────────────────────────────────────────────

const MODE_STATE_FILE = path.join(process.cwd(), 'data', 'agent_mode.json');

interface ModeState {
  currentMode: AgentMode;
  setAt: number;
}

function loadState(): ModeState {
  try {
    if (fs.existsSync(MODE_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(MODE_STATE_FILE, 'utf-8'));
    }
  } catch {}
  return { currentMode: 'auto', setAt: Date.now() };
}

function saveState(state: ModeState): void {
  try {
    const dir = path.dirname(MODE_STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MODE_STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

// ── Public helpers (used by telegram.ts) ─────────────────────────────────────

export function getActiveModePrompt(): string {
  const state = loadState();
  return MODE_CONFIGS[state.currentMode]?.systemPromptAddition || '';
}

export function getCurrentMode(): AgentMode {
  return loadState().currentMode;
}

export function getModeConfig(mode: AgentMode): ModeConfig {
  return MODE_CONFIGS[mode];
}

// ── Skill ─────────────────────────────────────────────────────────────────────

const agentModeSkill: Skill = {
  name: 'agent_mode',
  description: `Cambia el modo de comportamiento de Atlas para tareas especializadas.
Modos: auto (default), architect (diseño), code (implementación), debug (diagnóstico), test (testing), research (análisis), review (revisión de código).
JSON Args: { "mode": "architect|code|debug|test|research|review|auto" } para cambiar.
Sin args o { "action": "get" } para ver el modo actual. { "action": "list" } para ver todos los modos.`,

  execute: async (args: {
    mode?: AgentMode;
    action?: 'get' | 'list';
  }) => {
    const { mode, action } = args;

    // List all modes
    if (action === 'list') {
      const lines = Object.values(MODE_CONFIGS).map(
        c => `${c.emoji} **${c.displayName}** — ${c.tagline}`
      );
      return {
        success: true,
        current: getCurrentMode(),
        message: `Modos disponibles:\n${lines.join('\n')}\n\nActual: ${getCurrentMode()}`,
      };
    }

    // Get current mode
    if (!mode || action === 'get') {
      const state = loadState();
      const config = MODE_CONFIGS[state.currentMode];
      const ago = Math.floor((Date.now() - state.setAt) / 60_000);
      return {
        success: true,
        mode: state.currentMode,
        message: `${config.emoji} Modo actual: **${config.displayName}** — ${config.tagline}${ago > 0 ? ` (hace ${ago}min)` : ''}`,
      };
    }

    // Set mode
    if (!MODE_CONFIGS[mode]) {
      const valid = Object.keys(MODE_CONFIGS).join(', ');
      return { success: false, message: `Modo "${mode}" no existe. Válidos: ${valid}` };
    }

    saveState({ currentMode: mode, setAt: Date.now() });
    const config = MODE_CONFIGS[mode];

    return {
      success: true,
      mode,
      message: `${config.emoji} Modo cambiado a **${config.displayName}**\n${config.tagline}`,
    };
  },
};

export default agentModeSkill;
