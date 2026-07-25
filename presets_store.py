"""Simple JSON-file-backed store for routing presets.

A preset is a named list of routing actions (add/remove a single
subscription). Presets are deltas, not full-state snapshots: applying
one only touches the channels its actions mention, everything else on
the network is left alone.
"""

import json
import os
import threading
import time
import uuid

PRESETS_PATH = os.environ.get(
    "DANTE_WEB_PRESETS_PATH", os.path.join(os.path.dirname(__file__), "presets.json")
)

_lock = threading.Lock()


def _load():
    if not os.path.exists(PRESETS_PATH):
        return {}
    with open(PRESETS_PATH) as f:
        return json.load(f)


def _save(data):
    tmp_path = PRESETS_PATH + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, PRESETS_PATH)


def list_presets():
    with _lock:
        data = _load()
    presets = [
        {
            "id": pid,
            "name": p["name"],
            "created_at": p["created_at"],
            "updated_at": p["updated_at"],
            "action_count": len(p["actions"]),
        }
        for pid, p in data.items()
    ]
    presets.sort(key=lambda p: p["name"].lower())
    return presets


def get_preset(pid):
    with _lock:
        data = _load()
    preset = data.get(pid)
    if preset is None:
        return None
    return {"id": pid, **preset}


def save_preset(pid, name, actions):
    with _lock:
        data = _load()
        now = time.time()
        if pid and pid in data:
            data[pid]["name"] = name
            data[pid]["actions"] = actions
            data[pid]["updated_at"] = now
        else:
            pid = pid or str(uuid.uuid4())
            data[pid] = {
                "name": name,
                "actions": actions,
                "created_at": now,
                "updated_at": now,
            }
        _save(data)
    return pid


def delete_preset(pid):
    with _lock:
        data = _load()
        if pid in data:
            del data[pid]
            _save(data)
