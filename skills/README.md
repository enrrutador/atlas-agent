# Antigravity Skills - Documentación Completa

## Overview

Este directorio contiene las 9 skills implementadas según el documento de implementación de Antigravity.

## Estructura

```
skills/
├── README.md                     # Este archivo
├── browser_agent.ts              # Fase 1 - Navegador avanzado
├── code_executor.ts              # Fase 1 - Ejecutor de código
├── mermaid_renderer.ts           # Fase 1 - Renderizado de diagramas
├── debugger.ts                   # Fase 2 - Debugging Node.js
├── workflow_engine.ts            # Fase 3 - Motor de workflows
├── rule_engine.ts                # Fase 3 - Motor de reglas de seguridad
├── dev_container.ts              # Fase 4 - Docker DevContainers
├── remote_ssh.ts                 # Fase 4 - Conexiones SSH
└── remote_wsl.ts                 # Fase 4 - Windows Subsystem for Linux
```

## Uso

Todas las skills se cargan automáticamente al iniciar Atlas mediante el sistema de hot-reload en `src/core/skills.ts`.

### Ejemplos de uso:

#### code_executor
```json
{
  "language": "javascript",
  "code": "console.log('Hello World')",
  "timeout": 30000
}
```

#### workflow_engine
```json
{
  "action": "run",
  "workflow": "download_images",
  "variables": { "outputDir": "./downloads" }
}
```

#### rule_engine
```json
{
  "action": "validate",
  "actionName": "delete",
  "args": { "path": ".env" },
  "trustLevel": 3
}
```

#### debugger
```json
{
  "action": "start",
  "script": "app.js",
  "autoOpenDevTools": true
}
```

#### dev_container
```json
{
  "action": "open",
  "projectPath": "./my-project",
  "rebuild": false
}
```

#### remote_ssh
```json
{
  "action": "connect",
  "host": "server.example.com",
  "username": "user",
  "port": 22
}
```

#### remote_wsl
```json
{
  "action": "exec",
  "distribution": "Ubuntu",
  "command": "ls -la"
}
```

## Dependencias

```bash
# Ya instaladas:
npm install uuid vm2 zod @mermaid-js/mermaid-cli
```

## Tests

```bash
node test/skills/test_antigravity_skills.js
```

## Workflows de Ejemplo

Ver: `../workspace/workflows/`

## Reglas de Seguridad

Ver: `../workspace/rules/`

## Estado

✅ **Implementación Completa** - Todas las 4 fases de Antigravity implementadas
