---
name: desktop-control
description: "Control de escritorio: mouse, teclado, ventanas, OCR, screenshots"
version: 1.0.0
author: atlas
license: MIT
platforms: [windows]
category: desktop
tags: [desktop, automation, pyautogui, ocr, screenshot]
when_to_use: "Usar cuando necesites interactuar con aplicaciones de escritorio: click, type, hotkey, launch apps, leer pantalla"
requires: [pyautogui, pygetwindow, Pillow, pytesseract]
known_issues: ["FAILSAFE activo — mover mouse a esquina (0,0) aborta", "Necesita tesseract-ocr instalado para OCR"]
---

# Desktop Control Skill

## When to Use
Cuando Atlas necesita controlar aplicaciones de escritorio en la PC de Marcelo.
Incluye: click, type, hotkeys, screenshots, OCR, window management, launch apps.

## Capabilities
- Mouse: click, double-click, right-click, drag, scroll
- Keyboard: type text, hotkeys (ctrl+c, alt+tab, etc.)
- Screen: screenshot, OCR (read text from screen)
- Windows: list, focus, resize, minimize, maximize
- Apps: launch any .exe or program

## Safety
- FAILSAFE=True: mover mouse a esquina superior izquierda aborta todo
- PAUSE=0.1s entre cada accion para estabilidad
