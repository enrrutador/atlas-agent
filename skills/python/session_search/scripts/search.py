#!/usr/bin/env python3
"""Session Search — Buscar en sesiones anteriores via FTS5"""

import json
import sys
import sqlite3
import os
from pathlib import Path

ATLAS_HOME = os.environ.get("ATLAS_HOME", str(Path(__file__).parent.parent.parent.parent))
DB_PATH = os.path.join(ATLAS_HOME, "data", "atlas.db")


def search(query: str, limit: int = 5) -> dict:
    if not os.path.exists(DB_PATH):
        return {"error": f"Database not found at {DB_PATH}"}

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    try:
        cursor = conn.execute("""
            SELECT content, session_id, timestamp, rank
            FROM messages_fts
            WHERE messages_fts MATCH ?
            ORDER BY rank
            LIMIT ?
        """, (query, limit))
        results = [dict(row) for row in cursor.fetchall()]
        return {"results": results, "count": len(results)}
    except sqlite3.OperationalError as e:
        if "no such table" in str(e):
            return search_fallback(conn, query, limit)
        return {"error": str(e)}
    finally:
        conn.close()


def search_fallback(conn: sqlite3.Connection, query: str, limit: int) -> dict:
    try:
        cursor = conn.execute("""
            SELECT content, role, timestamp
            FROM messages
            WHERE content LIKE ?
            ORDER BY timestamp DESC
            LIMIT ?
        """, (f"%{query}%", limit))
        results = [dict(row) for row in cursor.fetchall()]
        return {"results": results, "count": len(results), "fallback": True}
    except sqlite3.OperationalError:
        return {"error": "No messages table found. Sessions DB may not be initialized yet."}


if __name__ == "__main__":
    input_data = json.loads(sys.stdin.read())
    query = input_data.get("query", input_data.get("q", ""))
    limit = input_data.get("limit", 5)
    result = search(query, limit)
    print(json.dumps(result))
