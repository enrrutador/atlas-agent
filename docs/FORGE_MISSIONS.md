# Forge Missions — Motor de Misiones Autónomas

## Visión

Forge no es el cerebro que procesa cada mensaje. Es un **trabajador autónomo bajo demanda** que se activa solo cuando el usuario le confía una misión compleja y de ejecución prolongada. Mientras Forge investiga y razona (durante horas), el agente sigue conversando normalmente con el usuario, de forma totalmente independiente.

### Principios de diseño

1. **Bajo demanda**: Forge NO interviene en el flujo normal del chat. Solo actúa cuando se le da una misión.
2. **Independiente**: la ejecución de la misión no bloquea ni interfiere con las respuestas normales del agente.
3. **Master cognitivo**: cada idea atraviesa un ciclo de razonamiento profundo (10 pasos).
4. **Proactivo**: notifica al usuario por Telegram/CLI con cada idea completada.
5. **Pausa-control**: puede esperar respuesta del usuario ante ambigüedades.
6. **Resiliente**: persiste el progreso y se puede reanudar tras reinicios.
7. **Limitado**: una misión a la vez, con delays para no saturar rate limits.

## Arquitectura

```
src/forge/missions/
├── forge_llm.ts          # Cliente LLM ligero (retry, backoff, rate limits)
├── forge_runner.ts       # Núcleo: ciclo cognitivo de 10 pasos por idea
├── mission_manager.ts    # 1 misión a la vez, persistencia, reanudación, parsing de lenguaje natural
└── index.ts              # Exports públicos
```

```
User/Telegram/CLI
    │  texto natural ("forge, trabajá en 10 ideas sobre X")
    ▼
MissionManager.parseMissionRequest()  ── detecta intención de misión
    │  genera N variantes + criterios de evaluación (LLM)
    ▼
forgeRunner.executeMission()          ── lanza en background (no bloquea el chat)
    │  por cada idea:
    │     ▼
    │  ciclo cognitivo (10 pasos) ──► notifica "Idea k/N lista"
    │     si score bajo (<5) ──► pausa y espera respuesta del usuario
    ▼
dashboard / Telegram / CLI  ── notificaciones proactivas y control
```

## El Ciclo Cognitivo (10 pasos por idea)

Cada variante/idea de una misión pasa por estos pasos, cada uno una llamada LLM real:

| Paso | Nombre | Qué hace |
|------|--------|----------|
| 1 | **MARCO** | Define problema, target, restricciones, criterios de éxito |
| 2 | **HIPÓTESIS** | Genera 3-5 enfoques (incluye disruptivos/no obvios) |
| 3 | **INVESTIGAR** | web_search + web_scrape de múltiples fuentes (triangulación) |
| 4 | **CRITICAR** | Expone supuestos, contraargumentos, sesgos de fuentes |
| 5 | **ANALIZAR** | Second-order thinking: consecuencias a 3/6/12 meses, escalabilidad |
| 6 | **CUANTIFICAR** | Estima mercado, costos, tiempo, margen (con rango y razonamiento) |
| 7 | **EVALUAR** | Matriz pros/contras/riesgos/esfuerzo/retorno (puntuación 1-10) |
| 8 | **SINTETIZAR** | Idea accionable + primeros pasos + riesgos |
| 9 | **REGISTRAR** | Incógnitas abiertas / supuestos sin validar |
| 10 | **AUTO-REVISAR** | Relee, corrige huecos lógicos antes de entregar |

## Persistencia

- Cada misión se guarda en `data/missions/<mission_id>.json` (ignorado por git via `data/`).
- Contiene: goal, variantes, criterios, ideas completadas, índice actual, status.
- Permite **reanudar** una misión pausada/fallida tras reiniciar el proceso.

## Interfaz de usuario

### Detección en lenguaje natural
Frases que disparan una misión (sin necesitar comando):
- *"forge, trabajá en 10 variantes de cómo integrar una web a OpenAI"*
- *"activá forge y pensá toda la noche cómo gano plata con IA"*
- *"forge, investigá en background y avisame cuando tengas cada idea"*

El parsing (`MissionManager.parseMissionRequest`) detecta la intención y extrae:
- **goal**: la meta (resto del texto)
- **variants**: número de variantes (por defecto 10, rango 2-20)

### Comando explícito
- `/forge <descripción de la misión>` — lanzar misión
- `/forge status` — ver progreso
- `/forge cancel` o `/forge stop` — pausar (guarda progreso)
- `/forge resume` — retomar

### Notificaciones proactivas
- Inicio: *"🚀 Forge inició la misión: ..."*
- Por idea: *"✅ Idea 3/10: <título> (<score>/10)"* con resumen
- Pregunta: *"❓ Forge necesita tu respuesta: ..."* (si score < 5)
- Fin: resumen con top 3 y ranking de todas las ideas

### Respuesta a preguntas
Si Forge está esperando respuesta (`missionManager.isAwaitingAnswer()`), el siguiente mensaje del usuario **se entrega a Forge** en lugar de procesarse como consulta normal. Timeout por defecto 30 min (variable `FORGE_QUESTION_TIMEOUT_MS`); al vencer asume "sin respuesta" y sigue.

## Configuración (variables de entorno)

| Variable | Descripción | Default |
|----------|-------------|---------|
| `FORGE_QUESTION_TIMEOUT_MS` | Timeout de espera de respuesta del usuario | `1800000` (30 min) |
| `betweenIdeasDelay` | Delay entre ideas (hardcoded en `forge_runner.ts`, 5000ms) | `5000` |

## Integraciones

- **main.ts**: inicializa `forgeRunner.setLLMClient(config)` y `missionManager.setConfig(config)`.
- **Telegram** (`bot.ts`): detección de misiones, `/forge`, routing de respuestas, notificaciones.
- **CLI** (`cli.ts`): mismo comportamiento en terminal.
- **Dashboard** (`dashboard.ts`): vía `forge_autonomous.getActiveTaskCount()` / `listTasks()`, muestra la misión activa y su progreso.
- **forge_autonomous.ts**: cola de tareas async de bajo nivel; sus métricas reflectan el estado real de las misiones.

## Fases implementadas

1. ✅ Motor de misiones autónomas (ciclo cognitivo)
2. ✅ Persistencia, reanudación, 1 misión a la vez
3. ✅ Disparador coloquial + notificaciones proactivas + control
4. ✅ CLI + integración dashboard
5. ✅ Pausa/espera de respuesta del usuario
