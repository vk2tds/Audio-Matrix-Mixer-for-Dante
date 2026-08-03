"""JSON-file-backed store for the preset control panel: a grid of
buttons, each referencing an existing routing preset, sized 1-3 cells
in each dimension. This only holds the LAYOUT — which preset sits
where, and how big. Whether a button is currently "lit" is tracked
client-side, not here.
"""

import json
import os
import threading

PANEL_PATH = os.environ.get("DANTE_WEB_PANEL_PATH", os.path.join(os.path.dirname(__file__), "panel.json"))

_lock = threading.Lock()

DEFAULT_PANEL = {"cols": 8, "rows": 4, "buttons": []}


def _load():
    if not os.path.exists(PANEL_PATH):
        return dict(DEFAULT_PANEL)
    with open(PANEL_PATH) as f:
        data = json.load(f)
    data.setdefault("cols", DEFAULT_PANEL["cols"])
    data.setdefault("rows", DEFAULT_PANEL["rows"])
    data.setdefault("buttons", [])
    return data


def _save(data):
    tmp_path = PANEL_PATH + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, PANEL_PATH)


def get_panel():
    with _lock:
        return _load()


def save_panel(cols, rows, buttons):
    with _lock:
        data = {"cols": cols, "rows": rows, "buttons": buttons}
        _save(data)
    return data
