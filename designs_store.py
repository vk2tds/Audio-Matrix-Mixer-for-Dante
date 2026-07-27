"""JSON-file-backed store for design-mode designs.

A design is a self-contained virtual Dante network: its own devices and
channels (which may or may not exist in reality — imported from live
devices, or made up entirely for planning purposes), a set of base
connections between them, and named presets (alternate connection
layouts, using the same add/remove action schema as the real routing
presets). None of this touches real hardware until you explicitly apply
it.
"""

import json
import os
import threading
import time
import uuid

DESIGNS_PATH = os.environ.get(
    "DANTE_WEB_DESIGNS_PATH", os.path.join(os.path.dirname(__file__), "designs.json")
)

_lock = threading.Lock()


def _load():
    if not os.path.exists(DESIGNS_PATH):
        return {}
    with open(DESIGNS_PATH) as f:
        return json.load(f)


def _save(data):
    tmp_path = DESIGNS_PATH + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, DESIGNS_PATH)


def list_designs():
    with _lock:
        data = _load()
    designs = [
        {
            "id": did,
            "name": d["name"],
            "created_at": d["created_at"],
            "updated_at": d["updated_at"],
            "device_count": len(d.get("devices") or {}),
            "connection_count": len(d.get("connections") or []),
            "preset_count": len(d.get("presets") or {}),
        }
        for did, d in data.items()
    ]
    designs.sort(key=lambda d: d["name"].lower())
    return designs


def get_design(did):
    with _lock:
        data = _load()
    design = data.get(did)
    if design is None:
        return None
    return {"id": did, **design}


def save_design(did, name, devices, connections, presets):
    with _lock:
        data = _load()
        now = time.time()
        if did and did in data:
            data[did]["name"] = name
            data[did]["devices"] = devices
            data[did]["connections"] = connections
            data[did]["presets"] = presets
            data[did]["updated_at"] = now
        else:
            did = did or str(uuid.uuid4())
            data[did] = {
                "name": name,
                "devices": devices,
                "connections": connections,
                "presets": presets,
                "created_at": now,
                "updated_at": now,
            }
        _save(data)
    return did


def delete_design(did):
    with _lock:
        data = _load()
        if did in data:
            del data[did]
            _save(data)
