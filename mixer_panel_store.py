"""JSON-file-backed store for the mixer button grid: a grid of buttons, each
either applying a saved mixer snapshot or displaying a live VU meter. This
only holds the LAYOUT — which button sits where, how big, and what it
references. Separate from panel_store.py (routing presets) — mixer buttons
never touch routing, routing buttons never touch mixer volumes.
"""

import json
import os
import threading

MIXER_PANEL_PATH = os.environ.get(
    "DANTE_WEB_MIXER_PANEL_PATH", os.path.join(os.path.dirname(__file__), "mixer_panel.json")
)

_lock = threading.Lock()

DEFAULT_PANEL = {"cols": 8, "rows": 4, "buttons": []}


def _load():
    if not os.path.exists(MIXER_PANEL_PATH):
        return dict(DEFAULT_PANEL)
    with open(MIXER_PANEL_PATH) as f:
        data = json.load(f)
    data.setdefault("cols", DEFAULT_PANEL["cols"])
    data.setdefault("rows", DEFAULT_PANEL["rows"])
    data.setdefault("buttons", [])
    return data


def _save(data):
    tmp_path = MIXER_PANEL_PATH + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, MIXER_PANEL_PATH)


def get_panel():
    with _lock:
        return _load()


def save_panel(cols, rows, buttons):
    with _lock:
        data = {"cols": cols, "rows": rows, "buttons": buttons}
        _save(data)
    return data
