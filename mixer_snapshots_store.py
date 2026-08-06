"""Simple JSON-file-backed store for mixer snapshots.

A snapshot is a named list of mixer actions (set a bus output's or a
specific input slot's level and/or mute). Snapshots are deltas, not
full-state captures: applying one only touches the parameters its actions
actually list — same principle as routing presets.
"""

import json
import os
import threading
import time
import uuid

SNAPSHOTS_PATH = os.environ.get(
    "DANTE_WEB_MIXER_SNAPSHOTS_PATH", os.path.join(os.path.dirname(__file__), "mixer_snapshots.json")
)

_lock = threading.Lock()


def _load():
    if not os.path.exists(SNAPSHOTS_PATH):
        return {}
    with open(SNAPSHOTS_PATH) as f:
        return json.load(f)


def _save(data):
    tmp_path = SNAPSHOTS_PATH + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, SNAPSHOTS_PATH)


def list_snapshots():
    with _lock:
        data = _load()
    snapshots = [
        {
            "id": sid,
            "name": s["name"],
            "created_at": s["created_at"],
            "updated_at": s["updated_at"],
            "action_count": len(s["actions"]),
        }
        for sid, s in data.items()
    ]
    snapshots.sort(key=lambda s: s["name"].lower())
    return snapshots


def get_snapshot(sid):
    with _lock:
        data = _load()
    snapshot = data.get(sid)
    if snapshot is None:
        return None
    return {"id": sid, **snapshot}


def save_snapshot(sid, name, actions):
    with _lock:
        data = _load()
        now = time.time()
        if sid and sid in data:
            data[sid]["name"] = name
            data[sid]["actions"] = actions
            data[sid]["updated_at"] = now
        else:
            sid = sid or str(uuid.uuid4())
            data[sid] = {
                "name": name,
                "actions": actions,
                "created_at": now,
                "updated_at": now,
            }
        _save(data)
    return sid


def delete_snapshot(sid):
    with _lock:
        data = _load()
        if sid in data:
            del data[sid]
            _save(data)
