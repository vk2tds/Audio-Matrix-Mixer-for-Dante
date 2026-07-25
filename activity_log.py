"""Capped, JSON-file-backed activity log.

Independent of the daemon's own (sometimes stale) state reporting — this
just records what Dante-web actually asked the daemon/CLI to do, and
whether that request came back as an error, so you have a ground truth
of "was this action even attempted" separate from what /devices reports.
"""

import json
import os
import threading
import time

ACTIVITY_PATH = os.environ.get(
    "DANTE_WEB_ACTIVITY_PATH", os.path.join(os.path.dirname(__file__), "activity.json")
)
MAX_ENTRIES = 500

_lock = threading.Lock()


def _load():
    if not os.path.exists(ACTIVITY_PATH):
        return []
    with open(ACTIVITY_PATH) as f:
        return json.load(f)


def _save(entries):
    tmp_path = ACTIVITY_PATH + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(entries, f, indent=2)
    os.replace(tmp_path, ACTIVITY_PATH)


def log_event(kind, detail=None, ok=True, error=None):
    with _lock:
        entries = _load()
        entries.append(
            {
                "timestamp": time.time(),
                "kind": kind,
                "detail": detail,
                "ok": ok,
                "error": error,
            }
        )
        entries = entries[-MAX_ENTRIES:]
        _save(entries)


def list_events(limit=300):
    with _lock:
        entries = _load()
    return list(reversed(entries[-limit:]))
