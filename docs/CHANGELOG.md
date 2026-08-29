# Atlas Agent — Changelog

## [4.1.0] — 2026-08-29

### Forge Missions — Motor de Misiones Autónomas

Forge ahora es un trabajador autónomo bajo demanda. Se activa solo cuando el usuario le confía una misión compleja y de ejecución prolongada, y trabaja en background sin interferir con el chat normal.

#### Nuevos módulos (`src/forge/missions/`)

- **forge_llm.ts**: cliente LLM ligero con retry, backoff y manejo de rate limits.
- **forge_runner.ts**: núcleo del motor. Ejecuta un ciclo cognitivo de 10 pasos por cada idea (MARCO → HIPÓTESIS → INVESTIGAR → CRITICAR → ANALIZAR → CUANTIFICAR → EVALUAR → SINTETIZAR → REGISTRAR → AUTO-REVISAR), con investigación real vía `webTool` (search + scrape).
- **mission_manager.ts**: una misión a la vez, persistencia y reanudación, parsing de lenguaje natural, mecanismo de pausa/espera de respuesta del usuario.

#### Funcionalidades

- **Disparador coloquial**: frases como *"forge, trabajá en 10 variantes de X"* detectadas en Telegram y CLI (no requiere comando).
- **Comando `/forge`**: lanzar (`/forge <meta>`), status, cancel, resume.
- **Notificaciones proactivas** por idea completada + resumen final con ranking.
- **Pausa-control**: si una idea tiene score bajo, Forge pregunta y espera; timeout configurable (`FORGE_QUESTION_TIMEOUT_MS`, default 30 min).
- **Persistencia**: `data/missions/<id>.json` (ignorado por git) con reanudación tras reinicio.
- **Independencia del chat**: la misión corre en background; el agente sigue respondiendo normalmente.

#### Integraciones

- `main.ts`: inicializa forgeRunner y missionManager con la config.
- `interfaces/telegram/bot.ts`: detección de misiones, `/forge`, routing de respuestas a Forge.
- `interfaces/cli.ts`: mismo comportamiento.
- `forge/core/forge_autonomous.ts`: sus métricas (`getActiveTaskCount`, `listTasks`) ahora reflejan el estado real de las misiones activas; visible en el dashboard.

## [4.0.0] — 2026-06-03

### Architecture Rebuild (Nuclear)

Complete restructure from monolithic Windows-only agent to modular cross-platform architecture.

#### New Modules

- **common/**: types.ts, logger.ts (EventEmitter for TUI), errors.ts, utils.ts
- **memory/**: atlas_db.ts (SQLite via sql.js WASM), memory_store.ts, session_db.ts, qmd_memory.ts, rag.ts, context_manager.ts
- **shield/**: trust_ladder.ts (5 levels), trust_gate.ts (Brain↔Forge gate), tool_guardian.ts, monitor.ts (error tracking + Telegram alerts)
- **arms/**: tools/ (browser, search, terminal, downloader, file_manager), bridge/ (Python bridge JSON-RPC), credentials/ (secure storage)
- **brain/**: skills.ts, task_handler.ts, task_planner.ts, scheduler.ts, message_queue.ts, context_compressor.ts, idle_builder.ts
- **forge/**: core/ (forge_gate, forge_decision, forge_context, forge_reasoner, forge_autonomous), memory/, proposals/, skills/auto_generator.ts
- **interfaces/**: telegram/bot.ts, tui/logs_panel.ts, cli.ts, dashboard.ts

#### Key Decisions

- Forge = neurona maestra: when Brain can't decide, Forge intervenes
- sql.js over better-sqlite3 (WASM, no native deps)
- Python Bridge: JSON-RPC over stdin/stdout (cross-platform)
- Trust Gate: hot gate between Brain and Forge with failure tracking
- Nuclear rebuild instead of file-by-file migration

#### Cross-Platform

- macOS: python3, pyobjc
- Linux: python3, wmctrl/xdotool
- Windows: python, pygetwindow

#### Removed

- All .cmd/.bat scripts
- All compiled .js/.d.ts/.map artifacts from src/
- Old OpenClaw/Hermes naming → Atlas terminology
- node_modules/ (needs fresh npm install)
- Old test files, vision scripts, build artifacts

#### Backup

- Pre-restructure backup: atlas_backup_v2.tar.gz
- Git commit: "BACKUP: Estado antes de reestructuracion total v3.0"

## [3.0.0] — Previous version (Windows-only, monolithic)
