"""JSON-file-backed store for the mixer button grid: a grid of buttons, each
either applying a saved mixer snapshot or displaying a live VU meter. This
only holds the LAYOUT — which button sits where, how big, and what it
references. Separate from panel_store.py (routing presets) — mixer buttons
never touch routing, routing buttons never touch mixer volumes.
"""

import json
import os
import threading
import uuid

MIXER_PANEL_PATH = os.environ.get(
    "DANTE_WEB_MIXER_PANEL_PATH", os.path.join(os.path.dirname(__file__), "mixer_panel.json")
)

_lock = threading.Lock()

DEFAULT_PANEL = {"cols": 8, "rows": 4, "buttons": [], "radio_groups": []}


def _migrate_legacy_groups(data):
    """Any button['group'] string that isn't a known radio_groups[].id gets a
    synthesized entry (id = name = the string) so old free-text groups keep
    working with no manual migration step — see MIXER_PANEL_SPEC.md §10.
    """
    existing_ids = {g["id"] for g in data["radio_groups"]}
    changed = False
    for btn in data["buttons"]:
        group = btn.get("group")
        if group and group not in existing_ids:
            data["radio_groups"].append({"id": group, "name": group})
            existing_ids.add(group)
            changed = True
    if changed:
        _save(data)


def _load():
    if not os.path.exists(MIXER_PANEL_PATH):
        return dict(DEFAULT_PANEL)
    with open(MIXER_PANEL_PATH) as f:
        data = json.load(f)
    data.setdefault("cols", DEFAULT_PANEL["cols"])
    data.setdefault("rows", DEFAULT_PANEL["rows"])
    data.setdefault("buttons", [])
    data.setdefault("radio_groups", [])
    _migrate_legacy_groups(data)
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
        existing = _load()
        data = {"cols": cols, "rows": rows, "buttons": buttons, "radio_groups": existing["radio_groups"]}
        _save(data)
    return data


def list_radio_groups():
    with _lock:
        return _load()["radio_groups"]


def create_radio_group(name):
    with _lock:
        data = _load()
        group = {"id": str(uuid.uuid4()), "name": name}
        data["radio_groups"].append(group)
        _save(data)
        return group


def rename_radio_group(group_id, name):
    with _lock:
        data = _load()
        group = next((g for g in data["radio_groups"] if g["id"] == group_id), None)
        if group is None:
            return None
        group["name"] = name
        _save(data)
        return group


def delete_radio_group(group_id):
    """Deletes the group and clears button['group'] on any button that
    referenced it — no dangling references left behind (MIXER_PANEL_SPEC.md
    §10).
    """
    with _lock:
        data = _load()
        data["radio_groups"] = [g for g in data["radio_groups"] if g["id"] != group_id]
        for btn in data["buttons"]:
            if btn.get("group") == group_id:
                btn["group"] = None
        _save(data)
        return data
