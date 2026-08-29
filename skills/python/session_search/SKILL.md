---
name: session-search
description: "Buscar en sesiones anteriores de Atlas"
version: 1.0.0
author: atlas
license: MIT
platforms: [windows, linux, macos]
category: memory
tags: [memory, search, sessions, fts5]
when_to_use: "Usar cuando el usuario referencia algo dicho en conversaciones anteriores o necesita info de charlas previas"
known_issues: []
---

# Session Search Skill

## When to Use
Cuando Marcelo dice "hablamos ayer de eso" o referencia informacion de charlas previas.

## Procedure
1. Parsear la query del usuario
2. Buscar en sessions.db via FTS5
3. Ordenar por relevancia y recencia
4. Devolver los resultados mas relevantes
