#!/usr/bin/env python3
"""Cron Jobs — Tareas programadas y recurrentes"""

import json
import sys
import os
import time
import threading
from pathlib import Path
from datetime import datetime, timedelta

ATLAS_HOME = os.environ.get("ATLAS_HOME", str(Path(__file__).parent.parent.parent.parent))
CRON_FILE = os.path.join(ATLAS_HOME, "data", "cron_jobs.json")
SCREENSHOT_DIR = os.path.join(ATLAS_HOME, "data", "screenshots")


def load_jobs() -> list:
    if os.path.exists(CRON_FILE):
        with open(CRON_FILE, "r", encoding="utf-8") as f:
            return json.loads(f.read())
    return []


def save_jobs(jobs: list):
    os.makedirs(os.path.dirname(CRON_FILE), exist_ok=True)
    with open(CRON_FILE, "w", encoding="utf-8") as f:
        f.write(json.dumps(jobs, indent=2))


def add_job(params: dict) -> dict:
    jobs = load_jobs()
    job = {
        "id": f"cron_{int(time.time())}",
        "name": params.get("name", "unnamed"),
        "schedule": params.get("schedule", ""),
        "task": params.get("task", ""),
        "action": params.get("action", ""),
        "enabled": True,
        "created_at": datetime.now().isoformat(),
        "last_run": None,
        "next_run": None,
        "run_count": 0,
    }
    jobs.append(job)
    save_jobs(jobs)
    return {"status": "ok", "job": job}


def list_jobs(params: dict) -> dict:
    jobs = load_jobs()
    return {"jobs": jobs, "count": len(jobs)}


def remove_job(params: dict) -> dict:
    job_id = params.get("id", "")
    jobs = load_jobs()
    original = len(jobs)
    jobs = [j for j in jobs if j.get("id") != job_id]
    save_jobs(jobs)
    removed = len(jobs) < original
    return {"status": "ok" if removed else "not_found", "id": job_id}


def toggle_job(params: dict) -> dict:
    job_id = params.get("id", "")
    jobs = load_jobs()
    for j in jobs:
        if j.get("id") == job_id:
            j["enabled"] = not j.get("enabled", True)
            save_jobs(jobs)
            return {"status": "ok", "enabled": j["enabled"], "id": job_id}
    return {"status": "not_found", "id": job_id}


def run_job(params: dict) -> dict:
    job_id = params.get("id", "")
    jobs = load_jobs()
    for j in jobs:
        if j.get("id") == job_id:
            j["last_run"] = datetime.now().isoformat()
            j["run_count"] = j.get("run_count", 0) + 1
            save_jobs(jobs)
            return {"status": "executed", "task": j.get("task", ""), "id": job_id}
    return {"status": "not_found", "id": job_id}


if __name__ == "__main__":
    input_data = json.loads(sys.stdin.read())
    action = input_data.get("action", "list")

    actions = {
        "add": add_job,
        "list": list_jobs,
        "remove": remove_job,
        "toggle": toggle_job,
        "run": run_job,
    }

    handler = actions.get(action, list_jobs)
    result = handler(input_data)
    print(json.dumps(result))
