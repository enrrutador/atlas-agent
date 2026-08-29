---
name: cron-jobs
description: "Tareas programadas y recurrentes — ejecutar skills o comandos en horarios especificos"
version: 1.0.0
author: atlas
license: MIT
platforms: [windows, linux, macos]
category: automation
tags: [cron, scheduler, recurring, automation, tasks]
when_to_use: "Usar cuando Marcelo quiere tareas automaticas: 'cada dia a las 9 chequea X', 'cada hora publica en fansly', etc."
known_issues: ["El scheduler se resetea al reiniciar Atlas — los jobs se guardan en disco pero hay que recargarlos"]
---

# Cron Jobs Skill

## When to Use
Cuando Marcelo quiere tareas programadas o recurrentes:
- "cada dia a las 9am chequea mis mensajes de fansly"
- "cada hora public algo en twitter"
- "a las 10pm apaga la PC"
- "cada lunes limpia los archivos temporales"

## Procedure
1. Parsear la programacion (frecuencia, horario, tarea)
2. Registrar el job en el scheduler de Atlas
3. Guardar el job en disco para persistencia
4. Ejecutar la tarea cuando se cumpla el schedule
