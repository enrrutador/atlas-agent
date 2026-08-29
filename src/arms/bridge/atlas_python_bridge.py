#!/usr/bin/env python3
"""
Atlas Python Bridge Server v2.0
Persistent Python process that executes skills via JSON-RPC over stdin/stdout.

Communication:
  - Atlas Core spawns this process as a child
  - Core writes JSON-RPC requests to stdin
  - Bridge reads from stdin, executes, writes responses to stdout
  - Errors go to stderr (not stdout, to avoid protocol contamination)

Methods:
  - skill.execute    → Run a skill by name with args
  - skill.list       → List all available Python skills
  - skill.install    → Install a skill from URL
  - skill.health     → Health check
  - desktop.*        → Desktop automation commands (PyAutoGUI)
  - credential.*     → Credential manager commands
"""

import sys
import json
import os
import subprocess
import importlib
import traceback
from pathlib import Path
from datetime import datetime

SKILLS_DIR = Path(__file__).parent / "skills" / "python"
ATLAS_HOME = Path(__file__).parent

skills_registry = {}
request_id_counter = 0


def log_stderr(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    sys.stderr.write(f"[{ts}] [BRIDGE] {msg}\n")
    sys.stderr.flush()


def send_response(request_id, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": request_id}
    if error:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def send_notification(method: str, params: dict = None):
    msg = {"jsonrpc": "2.0", "method": method}
    if params:
        msg["params"] = params
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def load_skills_registry():
    global skills_registry
    skills_registry = {}

    if not SKILLS_DIR.exists():
        log_stderr(f"Skills dir not found: {SKILLS_DIR}")
        return

    for skill_dir in SKILLS_DIR.iterdir():
        if not skill_dir.is_dir():
            continue
        skill_md = skill_dir / "SKILL.md"
        if skill_md.exists():
            try:
                meta = parse_skill_md(skill_md)
                skills_registry[skill_dir.name] = {
                    "path": str(skill_dir),
                    "meta": meta,
                }
                log_stderr(f"Registered skill: {skill_dir.name}")
            except Exception as e:
                log_stderr(f"Error parsing {skill_dir.name}/SKILL.md: {e}")


def parse_skill_md(skill_md_path: Path) -> dict:
    content = skill_md_path.read_text(encoding="utf-8")
    meta = {}

    if content.startswith("---"):
        end = content.find("---", 3)
        if end != -1:
            frontmatter = content[3:end].strip()
            for line in frontmatter.split("\n"):
                if ":" in line:
                    key, _, val = line.partition(":")
                    meta[key.strip()] = val.strip()

    meta["description_full"] = content
    return meta


def handle_request(request: dict) -> dict:
    method = request.get("method", "")
    params = request.get("params", {})
    req_id = request.get("id")

    try:
        if method == "skill.execute":
            return execute_skill(params)
        elif method == "skill.list":
            return list_skills(params)
        elif method == "skill.install":
            return install_skill(params)
        elif method == "skill.health":
            return health_check(params)
        elif method == "desktop.click":
            return desktop_click(params)
        elif method == "desktop.type":
            return desktop_type(params)
        elif method == "desktop.hotkey":
            return desktop_hotkey(params)
        elif method == "desktop.screenshot":
            return desktop_screenshot(params)
        elif method == "desktop.launch":
            return desktop_launch(params)
        elif method == "desktop.window_list":
            return window_list(params)
        elif method == "desktop.window_focus":
            return window_focus(params)
        elif method == "desktop.scroll":
            return desktop_scroll(params)
        elif method == "desktop.ocr":
            return desktop_ocr(params)
        elif method == "credential.save":
            return credential_save(params)
        elif method == "credential.get":
            return credential_get(params)
        elif method == "credential.list":
            return credential_list(params)
        else:
            return {"error": {"code": -32601, "message": f"Method not found: {method}"}}
    except Exception as e:
        log_stderr(f"Error handling {method}: {traceback.format_exc()}")
        return {"error": {"code": -32000, "message": str(e)}}


def execute_skill(params: dict) -> dict:
    name = params.get("name", "")
    skill_info = skills_registry.get(name)

    if not skill_info:
        available = list(skills_registry.keys())
        return {"error": {"code": -32001, "message": f"Skill '{name}' not found. Available: {available}"}}

    skill_dir = Path(skill_info["path"])
    scripts_dir = skill_dir / "scripts"

    if not scripts_dir.exists():
        return {"error": {"code": -32002, "message": f"No scripts dir in skill '{name}'"}}

    scripts = list(scripts_dir.glob("*.py"))
    if not scripts:
        return {"error": {"code": -32003, "message": f"No Python scripts in skill '{name}'"}}

    main_script = scripts[0]

    env = {
        **os.environ,
        "ATLAS_SKILL_DIR": str(skill_dir),
        "ATLAS_SESSION_ID": params.get("session_id", "unknown"),
        "ATLAS_HOME": str(ATLAS_HOME),
    }

    args_json = json.dumps(params.get("args", {}))

    try:
        result = subprocess.run(
            [sys.executable, str(main_script)],
            input=args_json,
            capture_output=True,
            text=True,
            timeout=params.get("timeout", 120),
            env=env,
            cwd=str(skill_dir),
        )

        output = result.stdout.strip()
        error_output = result.stderr.strip()

        if result.returncode != 0:
            return {"error": {"code": -32004, "message": error_output or f"Script exited with code {result.returncode}"}}

        try:
            parsed = json.loads(output)
            return {"result": parsed}
        except json.JSONDecodeError:
            return {"result": {"output": output}}

    except subprocess.TimeoutExpired:
        return {"error": {"code": -32005, "message": f"Skill '{name}' timed out"}}
    except Exception as e:
        return {"error": {"code": -32006, "message": str(e)}}


def list_skills(params: dict) -> dict:
    skills = []
    for name, info in skills_registry.items():
        meta = info.get("meta", {})
        skills.append({
            "name": name,
            "description": meta.get("description", ""),
            "version": meta.get("version", "1.0.0"),
            "category": meta.get("category", "general"),
        })
    return {"result": {"skills": skills, "count": len(skills)}}


def install_skill(params: dict) -> dict:
    url = params.get("url", "")
    name = params.get("name", "")
    if not url:
        return {"error": {"code": -32010, "message": "URL required"}}
    if not name:
        name = url.rstrip("/").split("/")[-1]

    dest = SKILLS_DIR / name
    if dest.exists():
        return {"error": {"code": -32011, "message": f"Skill '{name}' already exists"}}

    try:
        subprocess.run(["git", "clone", "--depth", "1", url, str(dest)], capture_output=True, text=True, timeout=60)
        load_skills_registry()
        return {"result": {"name": name, "installed": True}}
    except Exception as e:
        return {"error": {"code": -32012, "message": str(e)}}


def health_check(params: dict) -> dict:
    return {"result": {
        "status": "ok",
        "pid": os.getpid(),
        "skills_loaded": len(skills_registry),
        "skills_dir": str(SKILLS_DIR),
        "python_version": sys.version,
        "uptime_since": datetime.now().isoformat(),
    }}


# ── Desktop Automation (lazy import) ──────────────────────────

def _get_pyautogui():
    try:
        import pyautogui
        pyautogui.FAILSAFE = True
        pyautogui.PAUSE = 0.1
        return pyautogui
    except ImportError:
        raise RuntimeError("pyautogui not installed. Run: pip install pyautogui")


def desktop_click(params: dict) -> dict:
    pya = _get_pyautogui()
    x, y = params.get("x", 0), params.get("y", 0)
    button = params.get("button", "left")
    clicks = params.get("clicks", 1)
    pya.click(x=x, y=y, button=button, clicks=clicks)
    return {"result": {"status": "ok", "x": x, "y": y}}


def desktop_type(params: dict) -> dict:
    pya = _get_pyautogui()
    text = params.get("text", "")
    interval = params.get("interval", 0.02)
    pya.typewrite(text, interval=interval)
    return {"result": {"status": "ok"}}


def desktop_hotkey(params: dict) -> dict:
    pya = _get_pyautogui()
    keys = params.get("keys", [])
    pya.hotkey(*keys)
    return {"result": {"status": "ok"}}


def desktop_screenshot(params: dict) -> dict:
    pya = _get_pyautogui()
    region = params.get("region")
    save_path = params.get("save_path", str(ATLAS_HOME / "data" / "screenshots" / "desktop_screenshot.png"))
    os.makedirs(os.path.dirname(save_path), exist_ok=True)
    if region:
        img = pya.screenshot(region=(region["x"], region["y"], region["width"], region["height"]))
    else:
        img = pya.screenshot()
    img.save(save_path)
    return {"result": {"status": "ok", "path": save_path}}


def desktop_launch(params: dict) -> dict:
    app = params.get("app", "")
    subprocess.Popen(app, shell=True)
    return {"result": {"status": "ok"}}


def window_list(params: dict) -> dict:
    try:
        import pygetwindow as gw
        windows = gw.getAllTitles()
        return {"result": {"windows": [w for w in windows if w]}}
    except ImportError:
        return {"error": {"code": -32020, "message": "pygetwindow not installed. Run: pip install pygetwindow"}}


def window_focus(params: dict) -> dict:
    try:
        import pygetwindow as gw
        title = params.get("title", "")
        wins = gw.getWindowsWithTitle(title)
        if wins:
            wins[0].activate()
            return {"result": {"status": "ok"}}
        return {"error": {"code": -32021, "message": f"Window '{title}' not found"}}
    except ImportError:
        return {"error": {"code": -32020, "message": "pygetwindow not installed"}}


def desktop_scroll(params: dict) -> dict:
    pya = _get_pyautogui()
    amount = params.get("amount", 3)
    direction = params.get("direction", "down")
    scrolls = -amount if direction == "up" else amount
    pya.scroll(scrolls)
    return {"result": {"status": "ok"}}


def desktop_ocr(params: dict) -> dict:
    try:
        import pytesseract
        from PIL import Image
        img_path = params.get("image_path", str(ATLAS_HOME / "data" / "screenshots" / "desktop_screenshot.png"))
        text = pytesseract.image_to_string(Image.open(img_path))
        return {"result": {"text": text.strip()}}
    except ImportError:
        return {"error": {"code": -32022, "message": "pytesseract not installed. Run: pip install pytesseract Pillow"}}


# ── Credential Manager (basic encrypted store) ────────────────

CREDENTIALS_FILE = ATLAS_HOME / "data" / "credentials.json"


def _load_credentials() -> dict:
    if CREDENTIALS_FILE.exists():
        return json.loads(CREDENTIALS_FILE.read_text(encoding="utf-8"))
    return {}


def _save_credentials(data: dict):
    CREDENTIALS_FILE.parent.mkdir(parents=True, exist_ok=True)
    CREDENTIALS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")


def credential_save(params: dict) -> dict:
    site = params.get("site", "")
    creds = {
        "username": params.get("username", ""),
        "password": params.get("password", ""),
        "extra": params.get("extra", {}),
        "updated_at": datetime.now().isoformat(),
    }
    data = _load_credentials()
    data[site] = creds
    _save_credentials(data)
    log_stderr(f"Credential saved for: {site}")
    return {"result": {"status": "ok", "site": site}}


def credential_get(params: dict) -> dict:
    site = params.get("site", "")
    data = _load_credentials()
    if site in data:
        return {"result": {"site": site, **data[site]}}
    return {"error": {"code": -32030, "message": f"No credentials for '{site}'"}}


def credential_list(params: dict) -> dict:
    data = _load_credentials()
    sites = list(data.keys())
    return {"result": {"sites": sites, "count": len(sites)}}


# ── Main Loop ─────────────────────────────────────────────────

def main():
    log_stderr("Atlas Python Bridge v2.0 starting...")
    log_stderr(f"Skills dir: {SKILLS_DIR}")
    log_stderr(f"Atlas home: {ATLAS_HOME}")

    load_skills_registry()
    log_stderr(f"Loaded {len(skills_registry)} skills")

    send_notification("bridge.ready", {"skills": len(skills_registry), "pid": os.getpid()})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
            req_id = request.get("id")
            result = handle_request(request)
            send_response(req_id, result.get("result"), result.get("error"))
        except json.JSONDecodeError:
            log_stderr(f"Invalid JSON: {line[:100]}")
        except Exception as e:
            log_stderr(f"Fatal error: {traceback.format_exc()}")
            send_response(None, error={"code": -32603, "message": "Internal error"})

    log_stderr("Bridge shutting down (stdin closed)")


if __name__ == "__main__":
    main()
