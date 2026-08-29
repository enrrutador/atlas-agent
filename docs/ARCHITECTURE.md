# Atlas Agent v4.0 — Architecture

## Overview

Atlas is a modular AI agent built around three core pillars:

- **Brain** — Executor: handles simple tasks, runs skills, schedules work
- **Forge** — Decision engine (neurona maestra): when Brain can't decide, Forge intervenes
- **Shield** — Trust & safety: validates all operations, enforces autonomy levels

```
User → Interface → Brain → (simple?) → Arms (execute)
                         → (complex?) → TrustGate → Forge → decide
                                                  ↗ proceed  → Brain executes
                                                  ↗ forge    → Forge reasons
                                                  ↗ autonomous → runs independently
                                                  ↗ propose  → needs user approval
```

## Module Structure

```
src/
├── main.ts                    # Entry point, initializes all modules
├── common/                    # Shared utilities
│   ├── types.ts               # Global interfaces (TrustLevel, Skill, Message, etc.)
│   ├── logger.ts              # Logger singleton with EventEmitter for TUI
│   ├── errors.ts              # Custom error classes
│   └── utils.ts               # generateId, hashString, delay, etc.
├── memory/                    # Persistence layer
│   ├── atlas_db.ts            # SQLite via sql.js (WASM, no native deps)
│   ├── memory_store.ts        # CRUD on memories table
│   ├── session_db.ts          # Chat session persistence (30-day prune)
│   ├── qmd_memory.ts          # Daily markdown logs + vector index
│   ├── rag.ts                 # Codebase indexing into memory
│   └── context_manager.ts     # Conversation context compression
├── shield/                    # Trust & safety
│   ├── trust_ladder.ts        # 5 autonomy levels
│   ├── trust_gate.ts          # Hot gate Brain↔Forge
│   ├── tool_guardian.ts       # Tool access control per trust level
│   └── monitor.ts             # Error tracking + admin alerts
├── arms/                      # Action layer (tools & bridges)
│   ├── tools/                 # Browser, Search, Terminal, Downloader, FileManager
│   ├── bridge/                # Python bridge (JSON-RPC over stdin/stdout)
│   └── credentials/           # Secure credential storage
├── brain/                     # Executor layer
│   ├── skills.ts              # Skill registry & execution
│   ├── task_handler.ts        # Processes user requests
│   ├── task_planner.ts        # Multi-step plan creation & execution
│   ├── scheduler.ts           # Time-based task scheduling
│   ├── message_queue.ts       # Priority-based async message processing
│   ├── context_compressor.ts  # Token-aware context reduction
│   └── idle_builder.ts        # Autonomous task generation when idle
├── forge/                     # Decision engine (neurona maestra)
│   ├── core/
│   │   ├── forge_gate.ts      # Entry point for escalated tasks
│   │   ├── forge_decision.ts  # Core reasoning (LLM + heuristic fallback)
│   │   ├── forge_context.ts   # Context assembly for reasoning
│   │   ├── forge_reasoner.ts  # Chain-of-thought reasoning
│   │   └── forge_autonomous.ts # Autonomous execution mode
│   ├── memory/
│   │   └── forge_memory.ts    # Stores past decisions, patterns, proposals
│   ├── missions/
│   │   ├── forge_llm.ts       # Lightweight LLM client (retry/backoff)
│   │   ├── forge_runner.ts    # Cognitive cycle executor (10 steps/idea)
│   │   ├── mission_manager.ts # 1 mission at a time, persistence, pause/resume
│   │   └── index.ts           # Public exports
│   ├── proposals/
│   │   └── proposal_manager.ts # Proposal lifecycle (pending→approved/rejected)
│   └── skills/
│       └── auto_generator.ts  # Auto-creates skills to fill capability gaps
└── interfaces/                # User interaction
    ├── telegram/bot.ts        # Telegram bot interface
    ├── tui/logs_panel.ts      # Real-time log viewer with filtering
    ├── cli.ts                 # Direct terminal CLI
    └── dashboard.ts           # System health overview
```

## Trust Levels

| Level | Name | Behavior |
|-------|------|----------|
| 1 | Cautious | Ask before everything |
| 2 | Safe | Execute safe ops, ask on risky |
| 3 | Trusted | Execute most, report after (DEFAULT) |
| 4 | Autonomous | Full autonomy, periodic check-ins |
| 5 | Night Shift | Create own tasks, no check-ins |

## Forge Decision Flow

1. **Brain** receives user request
2. **TrustGate** evaluates complexity → simple tasks stay in Brain
3. Complex tasks escalate to **ForgeGate**
4. **ForgeDecision** analyzes (LLM or heuristic)
5. Output: `proceed` | `forge` | `autonomous` | `propose`
6. If `propose` → user must approve via `/approve` command

## Cross-Platform Support

- **macOS**: `python3`, pyobjc (replaces pygetwindow)
- **Linux**: `python3`, wmctrl/xdotool
- **Windows**: `python`, pygetwindow
- **SQLite**: sql.js (WASM) — no native compilation needed
- **Bridge**: JSON-RPC over stdin/stdout — works everywhere

## Data Flow

```
interfaces/ → brain/task_handler → trust_gate.evaluate()
  ├─ decision=proceed → brain/skills.execute()
  └─ decision=forge   → forge/forge_gate.process()
                          ├─ forge_decision.decide()
                          ├─ forge_reasoner.reason()
                          └─ result → back to interface
```

## Requirements

- Node.js >= 18
- Python 3.x (optional, for desktop automation bridge)
- npm dependencies: axios, dotenv, sql.js, node-telegram-bot-api
- Optional: playwright (for browser tool)
