#!/usr/bin/env python3
"""Desktop Control — Interactuar con apps de escritorio via PyAutoGUI"""

import json
import sys
import os
import subprocess
from pathlib import Path

try:
    import pyautogui
    pyautogui.FAILSAFE = True
    pyautogui.PAUSE = 0.1
    HAS_PYAUTOGUI = True
except ImportError:
    HAS_PYAUTOGUI = False

try:
    import pygetwindow as gw
    HAS_PYGETWINDOW = True
except ImportError:
    HAS_PYGETWINDOW = False

try:
    from PIL import Image
    import pytesseract
    HAS_OCR = True
except ImportError:
    HAS_OCR = False

SCREENSHOT_DIR = os.path.join(
    os.environ.get("ATLAS_HOME", str(Path(__file__).parent.parent.parent.parent)),
    "data", "screenshots"
)


def click(params: dict) -> dict:
    if not HAS_PYAUTOGUI:
        return {"error": "pyautogui not installed"}
    x, y = params.get("x", 0), params.get("y", 0)
    button = params.get("button", "left")
    clicks = params.get("clicks", 1)
    pyautogui.click(x=x, y=y, button=button, clicks=clicks)
    return {"status": "ok", "action": "click", "x": x, "y": y}


def type_text(params: dict) -> dict:
    if not HAS_PYAUTOGUI:
        return {"error": "pyautogui not installed"}
    text = params.get("text", "")
    interval = params.get("interval", 0.02)
    pyautogui.typewrite(text, interval=interval)
    return {"status": "ok", "action": "type", "chars": len(text)}


def hotkey(params: dict) -> dict:
    if not HAS_PYAUTOGUI:
        return {"error": "pyautogui not installed"}
    keys = params.get("keys", [])
    pyautogui.hotkey(*keys)
    return {"status": "ok", "action": "hotkey", "keys": keys}


def screenshot(params: dict) -> dict:
    if not HAS_PYAUTOGUI:
        return {"error": "pyautogui not installed"}
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    save_path = params.get("save_path", os.path.join(SCREENSHOT_DIR, f"desktop_{int(__import__('time').time())}.png"))
    region = params.get("region")
    if region:
        img = pyautogui.screenshot(region=(region["x"], region["y"], region["width"], region["height"]))
    else:
        img = pyautogui.screenshot()
    img.save(save_path)
    return {"status": "ok", "action": "screenshot", "path": save_path}


def launch(params: dict) -> dict:
    app = params.get("app", "")
    subprocess.Popen(app, shell=True)
    return {"status": "ok", "action": "launch", "app": app}


def list_windows(params: dict) -> dict:
    if not HAS_PYGETWINDOW:
        return {"error": "pygetwindow not installed"}
    windows = gw.getAllTitles()
    return {"windows": [w for w in windows if w]}


def focus_window(params: dict) -> dict:
    if not HAS_PYGETWINDOW:
        return {"error": "pygetwindow not installed"}
    title = params.get("title", "")
    wins = gw.getWindowsWithTitle(title)
    if wins:
        wins[0].activate()
        return {"status": "ok"}
    return {"error": f"Window '{title}' not found"}


def ocr(params: dict) -> dict:
    if not HAS_OCR:
        return {"error": "pytesseract or Pillow not installed"}
    img_path = params.get("image_path", "")
    if not img_path or not os.path.exists(img_path):
        return {"error": f"Image not found: {img_path}"}
    text = pytesseract.image_to_string(Image.open(img_path))
    return {"text": text.strip()}


def scroll(params: dict) -> dict:
    if not HAS_PYAUTOGUI:
        return {"error": "pyautogui not installed"}
    amount = params.get("amount", 3)
    direction = params.get("direction", "down")
    scrolls = -amount if direction == "up" else amount
    pyautogui.scroll(scrolls)
    return {"status": "ok", "action": "scroll"}


def drag(params: dict) -> dict:
    if not HAS_PYAUTOGUI:
        return {"error": "pyautogui not installed"}
    from_x, from_y = params.get("from_x", 0), params.get("from_y", 0)
    to_x, to_y = params.get("to_x", 0), params.get("to_y", 0)
    duration = params.get("duration", 0.5)
    pyautogui.drag(to_x - from_x, to_y - from_y, duration=duration)
    return {"status": "ok", "action": "drag"}


if __name__ == "__main__":
    input_data = json.loads(sys.stdin.read())
    action = input_data.get("action", "screenshot")

    actions = {
        "click": click,
        "type": type_text,
        "hotkey": hotkey,
        "screenshot": screenshot,
        "launch": launch,
        "list_windows": list_windows,
        "focus_window": focus_window,
        "ocr": ocr,
        "scroll": scroll,
        "drag": drag,
    }

    handler = actions.get(action)
    if handler:
        result = handler(input_data)
    else:
        result = {"error": f"Unknown action: {action}. Available: {list(actions.keys())}"}

    print(json.dumps(result))
