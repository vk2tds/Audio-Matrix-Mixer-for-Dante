import logging
import os
import signal
import threading
import time

from flask import Flask, Response, jsonify, render_template, request

import activity_log
import designs_store
import mixer_client
import mixer_panel_store
import mixer_snapshots_store
import netaudio_cli
import netaudio_client as relay
import panel_store
import presets_store

app = Flask(__name__)
log = logging.getLogger("dante-web")

DAEMON_PIDFILE = os.path.join(os.path.dirname(__file__), "logs", "daemon.pid")

# Font Awesome Pro is a paid license and can't be redistributed, so this repo
# only ships Free (static/vendor/fontawesome-free/). If a licensed Pro kit has
# been dropped in locally (static/vendor/fontawesome-pro/ — gitignored, see
# README), use that instead for the full icon set. Checked once at startup;
# restart the app after adding/removing a Pro kit to pick up the change.
_STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
FONTAWESOME_PRO_AVAILABLE = os.path.exists(
    os.path.join(_STATIC_DIR, "vendor", "fontawesome-pro", "css", "all.min.css")
)


@app.context_processor
def inject_fontawesome():
    if FONTAWESOME_PRO_AVAILABLE:
        return {
            "fontawesome_css": "vendor/fontawesome-pro/css/all.min.css",
            "fontawesome_icons_js": "js/panel-icons-data-pro.js",
        }
    return {
        "fontawesome_css": "vendor/fontawesome-free/css/all.min.css",
        "fontawesome_icons_js": "js/panel-icons-data-free.js",
    }

HEALTH_CHECK_INTERVAL = 45  # seconds between passes
HEALTH_CHECK_SETTLE = 3  # seconds to let a refresh land before re-checking
AUTO_RESTART_COOLDOWN = 300  # don't auto-restart more than once per 5 minutes
_last_auto_restart = 0.0


def _restart_daemon_process(kind, reason):
    """Signal the daemon process run.sh is supervising; it notices the death
    and restarts it, the same path already exercised by an actual crash.
    Shared by the manual "Restart daemon" button and the auto-health-check.
    """
    try:
        with open(DAEMON_PIDFILE) as f:
            pid = int(f.read().strip())
    except (FileNotFoundError, ValueError):
        error = "No daemon pidfile found — this only works when running via run.sh."
        activity_log.log_event(kind, {"reason": reason}, ok=False, error=error)
        return False, error

    try:
        os.kill(pid, 0)
    except OSError:
        error = f"Daemon process {pid} isn't running (stale pidfile)."
        activity_log.log_event(kind, {"pid": pid, "reason": reason}, ok=False, error=error)
        return False, error

    try:
        os.kill(pid, signal.SIGTERM)
    except OSError as exc:
        activity_log.log_event(kind, {"pid": pid, "reason": reason}, ok=False, error=str(exc))
        return False, str(exc)

    activity_log.log_event(kind, {"pid": pid, "reason": reason}, ok=True, error=None)
    return True, f"Signaled daemon (pid {pid}) to stop — run.sh will restart it within ~5s."


def proxy(method, path, json_body=None):
    try:
        data, status = relay._request(method, path, json_body)
    except relay.RelayError as exc:
        if method == "POST":
            activity_log.log_event(path, json_body, ok=False, error=str(exc))
        return jsonify({"error": str(exc)}), 502

    if method == "POST":
        ok = status < 400
        error = None
        if not ok:
            error = data.get("error") if isinstance(data, dict) else str(data)
        activity_log.log_event(path, json_body, ok=ok, error=error)

    return jsonify(data), status


# --- Pages -----------------------------------------------------------------


@app.route("/")
def devices_page():
    return render_template("devices.html")


@app.route("/routing")
def routing_page():
    return render_template("routing.html")


@app.route("/connections")
def connections_page():
    return render_template("connections.html")


@app.route("/gain")
def gain_page():
    return render_template("gain.html")


@app.route("/metering")
def metering_page():
    return render_template("metering.html")


@app.route("/presets")
def presets_page():
    return render_template("presets.html")


@app.route("/config")
def config_page():
    return render_template("config.html")


@app.route("/flows")
def flows_page():
    return render_template("flows.html")


@app.route("/activity")
def activity_page():
    return render_template("activity.html")


@app.route("/design")
def design_page():
    return render_template("design.html")


@app.route("/panel")
def panel_page():
    return render_template("panel.html")


@app.route("/panel/display")
def panel_display_page():
    return render_template("panel.html", hide_chrome=True, display_only=True)


@app.route("/mixer-console")
def mixer_console_page():
    return render_template("mixer_console.html")


@app.route("/mixer-snapshots")
def mixer_snapshots_page():
    return render_template("mixer_snapshots.html")


@app.route("/mixer-panel")
def mixer_panel_page():
    return render_template("mixer_panel.html")


@app.route("/mixer-meters")
def mixer_meters_page():
    return render_template("mixer_meters.html")


# --- API proxy ---------------------------------------------------------


@app.route("/api/devices")
def api_devices():
    return proxy("GET", "/devices")


@app.route("/api/devices/<path:server_name>")
def api_device(server_name):
    return proxy("GET", f"/devices/{server_name}")


@app.route("/api/identify", methods=["POST"])
def api_identify():
    return proxy("POST", "/identify", request.get_json(force=True, silent=True) or {})


@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    return proxy("POST", "/refresh", request.get_json(force=True, silent=True) or {})


@app.route("/api/daemon/restart", methods=["POST"])
def api_restart_daemon():
    # Deliberately does NOT call `netaudio server restart` — that command
    # doesn't know about run.sh's supervision loop and will race it for
    # port 9000 (confirmed live: it left two daemons fighting over the
    # port and the supervisor stuck in a crash loop). Instead this signals
    # the exact process run.sh is tracking via its pidfile, and lets that
    # same loop notice the death and restart it, the same path already
    # exercised by an actual daemon crash.
    ok, message = _restart_daemon_process("daemon:restart", "manual")
    if not ok:
        return jsonify({"error": message}), 409
    return jsonify({"success": True, "message": message})


@app.route("/api/subscribe", methods=["POST"])
def api_subscribe():
    return proxy("POST", "/subscribe", request.get_json(force=True, silent=True) or {})


@app.route("/api/unsubscribe", methods=["POST"])
def api_unsubscribe():
    return proxy("POST", "/unsubscribe", request.get_json(force=True, silent=True) or {})


@app.route("/api/rename-device", methods=["POST"])
def api_rename_device():
    return proxy("POST", "/rename-device", request.get_json(force=True, silent=True) or {})


@app.route("/api/rename-channel", methods=["POST"])
def api_rename_channel():
    return proxy("POST", "/rename-channel", request.get_json(force=True, silent=True) or {})


@app.route("/api/set-gain", methods=["POST"])
def api_set_gain():
    return proxy("POST", "/set-gain", request.get_json(force=True, silent=True) or {})


@app.route("/api/set-latency", methods=["POST"])
def api_set_latency():
    return proxy("POST", "/set-latency", request.get_json(force=True, silent=True) or {})


@app.route("/api/set-sample-rate", methods=["POST"])
def api_set_sample_rate():
    return proxy("POST", "/set-sample-rate", request.get_json(force=True, silent=True) or {})


@app.route("/api/set-encoding", methods=["POST"])
def api_set_encoding():
    return proxy("POST", "/set-encoding", request.get_json(force=True, silent=True) or {})


@app.route("/api/set-aes67", methods=["POST"])
def api_set_aes67():
    return proxy("POST", "/set-aes67", request.get_json(force=True, silent=True) or {})


@app.route("/api/metering/status")
def api_metering_status():
    return proxy("GET", "/metering/status")


@app.route("/api/metering/snapshot/<path:device_name>")
def api_metering_snapshot(device_name):
    return proxy("GET", f"/metering/snapshot/{device_name}")


@app.route("/api/metering/start", methods=["POST"])
def api_metering_start():
    return proxy("POST", "/metering/start", request.get_json(force=True, silent=True) or {})


@app.route("/api/metering/stop", methods=["POST"])
def api_metering_stop():
    return proxy("POST", "/metering/stop", request.get_json(force=True, silent=True) or {})


@app.route("/api/presets")
def api_list_presets():
    return jsonify(presets_store.list_presets())


@app.route("/api/presets/<pid>")
def api_get_preset(pid):
    preset = presets_store.get_preset(pid)
    if preset is None:
        return jsonify({"error": "preset not found"}), 404
    return jsonify(preset)


@app.route("/api/presets", methods=["POST"])
def api_save_preset():
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    actions = body.get("actions")
    if not isinstance(actions, list) or not actions:
        return jsonify({"error": "actions must be a non-empty list"}), 400
    pid = body.get("id")
    pid = presets_store.save_preset(pid, name, actions)
    return jsonify({"success": True, "id": pid})


@app.route("/api/presets/<pid>", methods=["DELETE"])
def api_delete_preset(pid):
    presets_store.delete_preset(pid)
    return jsonify({"success": True})


@app.route("/api/presets/<pid>/apply", methods=["POST"])
def api_apply_preset(pid):
    preset = presets_store.get_preset(pid)
    if preset is None:
        return jsonify({"error": "preset not found"}), 404

    results = []
    for action in preset["actions"]:
        try:
            if action["action"] == "add":
                data, status = relay.subscribe(
                    action["rx_device"], action["rx_channel"], action["tx_channel"], action["tx_device"]
                )
            else:
                data, status = relay.unsubscribe(action["rx_device"], action["rx_channel"])
            results.append({**action, "ok": status < 400, "response": data})
        except relay.RelayError as exc:
            results.append({**action, "ok": False, "response": {"error": str(exc)}})

    applied = sum(1 for r in results if r["ok"])
    activity_log.log_event(
        "preset:apply",
        {"preset_id": pid, "preset_name": preset["name"], "applied": applied, "total": len(results)},
        ok=applied == len(results),
        error=None if applied == len(results) else f"{len(results) - applied} action(s) failed",
    )
    return jsonify({"success": True, "applied": applied, "total": len(results), "results": results})


# --- Preset panel ------------------------------------------------------------
# A grid of buttons, each pointing at an existing preset. Pressing a button
# applies the preset (same semantics as /apply); pressing it again reverses
# it — "add" actions get unsubscribed, "remove" actions get resubscribed to
# whatever baseline they recorded at the time (nothing to do if there wasn't
# one). Lit/pressed state itself is tracked client-side, not here — this
# only stores the grid layout.


@app.route("/api/panel")
def api_get_panel():
    return jsonify(panel_store.get_panel())


@app.route("/api/panel", methods=["POST"])
def api_save_panel():
    body = request.get_json(force=True, silent=True) or {}
    try:
        cols = int(body.get("cols") or 8)
        rows = int(body.get("rows") or 4)
    except (TypeError, ValueError):
        return jsonify({"error": "cols and rows must be integers"}), 400
    buttons = body.get("buttons")
    if not isinstance(buttons, list):
        return jsonify({"error": "buttons must be a list"}), 400
    data = panel_store.save_panel(cols, rows, buttons)
    return jsonify({"success": True, **data})


@app.route("/api/panel/press/<pid>", methods=["POST"])
def api_panel_press(pid):
    body = request.get_json(force=True, silent=True) or {}
    turn_on = bool(body.get("on", True))

    preset = presets_store.get_preset(pid)
    if preset is None:
        return jsonify({"error": "preset not found"}), 404

    results = []
    for action in preset["actions"]:
        try:
            if turn_on:
                if action["action"] == "add":
                    data, status = relay.subscribe(
                        action["rx_device"], action["rx_channel"], action["tx_channel"], action["tx_device"]
                    )
                else:
                    data, status = relay.unsubscribe(action["rx_device"], action["rx_channel"])
            else:
                if action["action"] == "add":
                    data, status = relay.unsubscribe(action["rx_device"], action["rx_channel"])
                elif action.get("tx_device"):
                    data, status = relay.subscribe(
                        action["rx_device"], action["rx_channel"], action["tx_channel"], action["tx_device"]
                    )
                else:
                    data, status = {"success": True, "note": "nothing to reverse"}, 200
            results.append({**action, "ok": status < 400, "response": data})
        except relay.RelayError as exc:
            results.append({**action, "ok": False, "response": {"error": str(exc)}})

    applied = sum(1 for r in results if r["ok"])
    activity_log.log_event(
        "panel:press",
        {"preset_id": pid, "preset_name": preset["name"], "on": turn_on, "applied": applied, "total": len(results)},
        ok=applied == len(results),
        error=None if applied == len(results) else f"{len(results) - applied} action(s) failed",
    )
    return jsonify({"success": True, "applied": applied, "total": len(results), "results": results})


# --- Mixer (DanteMixer relay) -------------------------------------------------
# Proxies to a separate DanteMixer daemon the same way the routes above proxy
# to netaudio — see mixer_client.py. DanteMixer may not have a running Web
# API yet; calls below surface that as a normal 502 "could not reach mixer
# daemon" error, the same graceful-unreachable pattern used everywhere else.
#
# A snapshot's actions are {bus_id, slot, level_db, muted} — slot is null for
# a bus's own output, 0-7 for a specific input. level_db/muted are each
# independently nullable: applying only touches parameters actually listed,
# same principle as routing presets. Unlike routing preset buttons, mixer
# snapshot buttons do not reverse on a second press (v1 — see
# MIXER_PANEL_SPEC.md §4).


def _mixer_snapshot_operations(actions):
    """Flatten a snapshot's actions (each may set level and/or mute) into
    individual relay operations, one per actual relay call — mirrors how
    routing preset actions map 1:1 to subscribe/unsubscribe calls."""
    ops = []
    for action in actions:
        bus_id = action["bus_id"]
        slot = action.get("slot")
        if action.get("level_db") is not None:
            ops.append({"bus_id": bus_id, "slot": slot, "kind": "level", "value": action["level_db"]})
        if action.get("muted") is not None:
            ops.append({"bus_id": bus_id, "slot": slot, "kind": "mute", "value": action["muted"]})
    return ops


def _apply_mixer_operation(op):
    if op["kind"] == "level":
        if op["slot"] is None:
            return mixer_client.set_output_level(op["bus_id"], op["value"])
        return mixer_client.set_input_level(op["bus_id"], op["slot"], op["value"])
    if op["slot"] is None:
        return mixer_client.set_output_mute(op["bus_id"], op["value"])
    return mixer_client.set_input_mute(op["bus_id"], op["slot"], op["value"])


def _apply_mixer_snapshot(snapshot, activity_kind):
    ops = _mixer_snapshot_operations(snapshot["actions"])
    results = []
    for op in ops:
        try:
            data, status = _apply_mixer_operation(op)
            results.append({**op, "ok": status < 400, "response": data})
        except mixer_client.RelayError as exc:
            results.append({**op, "ok": False, "response": {"error": str(exc)}})

    applied = sum(1 for r in results if r["ok"])
    activity_log.log_event(
        activity_kind,
        {
            "snapshot_id": snapshot["id"],
            "snapshot_name": snapshot["name"],
            "applied": applied,
            "total": len(results),
        },
        ok=applied == len(results),
        error=None if applied == len(results) else f"{len(results) - applied} operation(s) failed",
    )
    return jsonify({"success": True, "applied": applied, "total": len(results), "results": results})


@app.route("/api/mixer/devices")
def api_mixer_devices():
    try:
        data, status = mixer_client.get_devices()
    except mixer_client.RelayError as exc:
        return jsonify({"error": str(exc)}), 502
    return jsonify(data), status


@app.route("/api/mixer/mixers")
def api_mixer_mixers():
    try:
        data, status = mixer_client.get_mixers()
    except mixer_client.RelayError as exc:
        return jsonify({"error": str(exc)}), 502
    return jsonify(data), status


def _mixer_console_call(kind, detail, fn, *args):
    """Live Mixer Console mutations — direct pass-through to the mixer
    engine (assign/clear an input slot, set a level/mute, route a bus's
    output), logged the same way the generic netaudio `proxy()` helper logs
    routing mutations, just against mixer_client instead of the relay."""
    try:
        data, status = fn(*args)
    except mixer_client.RelayError as exc:
        activity_log.log_event(kind, detail, ok=False, error=str(exc))
        return jsonify({"error": str(exc)}), 502
    ok = status < 400
    error = None if ok else (data.get("error") if isinstance(data, dict) else str(data))
    activity_log.log_event(kind, detail, ok=ok, error=error)
    return jsonify(data), status


@app.route("/api/mixer/mixers/<mixer_id>/name", methods=["PUT"])
def api_mixer_set_name(mixer_id):
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    return _mixer_console_call(
        "mixer:name", {"bus_id": mixer_id, "name": name}, mixer_client.set_bus_name, mixer_id, name
    )


@app.route("/api/mixer/mixers/<mixer_id>/inputs/<int:slot>", methods=["PUT"])
def api_mixer_assign_input(mixer_id, slot):
    body = request.get_json(force=True, silent=True) or {}
    device_uid = body.get("deviceUID")
    channel = body.get("channel")
    channel2 = body.get("channel2")
    if not device_uid or channel is None:
        return jsonify({"error": "deviceUID and channel are required"}), 400
    return _mixer_console_call(
        "mixer:input_assign",
        {"bus_id": mixer_id, "slot": slot, "deviceUID": device_uid, "channel": channel, "channel2": channel2},
        mixer_client.set_input,
        mixer_id,
        slot,
        device_uid,
        channel,
        channel2,
    )


@app.route("/api/mixer/mixers/<mixer_id>/inputs/<int:slot>", methods=["DELETE"])
def api_mixer_clear_input(mixer_id, slot):
    return _mixer_console_call(
        "mixer:input_clear", {"bus_id": mixer_id, "slot": slot}, mixer_client.clear_input, mixer_id, slot
    )


@app.route("/api/mixer/mixers/<mixer_id>/inputs/<int:slot>/level", methods=["PUT"])
def api_mixer_set_input_level(mixer_id, slot):
    body = request.get_json(force=True, silent=True) or {}
    level_db = body.get("levelDb")
    if level_db is None:
        return jsonify({"error": "levelDb is required"}), 400
    return _mixer_console_call(
        "mixer:input_level",
        {"bus_id": mixer_id, "slot": slot, "levelDb": level_db},
        mixer_client.set_input_level,
        mixer_id,
        slot,
        level_db,
    )


@app.route("/api/mixer/mixers/<mixer_id>/inputs/<int:slot>/mute", methods=["PUT"])
def api_mixer_set_input_mute(mixer_id, slot):
    body = request.get_json(force=True, silent=True) or {}
    muted = body.get("muted")
    if muted is None:
        return jsonify({"error": "muted is required"}), 400
    return _mixer_console_call(
        "mixer:input_mute",
        {"bus_id": mixer_id, "slot": slot, "muted": muted},
        mixer_client.set_input_mute,
        mixer_id,
        slot,
        muted,
    )


@app.route("/api/mixer/mixers/<mixer_id>/output/level", methods=["PUT"])
def api_mixer_set_output_level(mixer_id):
    body = request.get_json(force=True, silent=True) or {}
    level_db = body.get("levelDb")
    if level_db is None:
        return jsonify({"error": "levelDb is required"}), 400
    return _mixer_console_call(
        "mixer:output_level", {"bus_id": mixer_id, "levelDb": level_db}, mixer_client.set_output_level, mixer_id, level_db
    )


@app.route("/api/mixer/mixers/<mixer_id>/output/mute", methods=["PUT"])
def api_mixer_set_output_mute(mixer_id):
    body = request.get_json(force=True, silent=True) or {}
    muted = body.get("muted")
    if muted is None:
        return jsonify({"error": "muted is required"}), 400
    return _mixer_console_call(
        "mixer:output_mute", {"bus_id": mixer_id, "muted": muted}, mixer_client.set_output_mute, mixer_id, muted
    )


@app.route("/api/mixer/mixers/<mixer_id>/output/route", methods=["PUT"])
def api_mixer_set_output_route(mixer_id):
    body = request.get_json(force=True, silent=True) or {}
    device_name = (body.get("device") or "").strip()
    if not device_name:
        return jsonify({"error": "device is required"}), 400
    return _mixer_console_call(
        "mixer:output_route", {"bus_id": mixer_id, "device": device_name}, mixer_client.set_output_route, mixer_id, device_name
    )


@app.route("/api/mixer/snapshots")
def api_list_mixer_snapshots():
    return jsonify(mixer_snapshots_store.list_snapshots())


@app.route("/api/mixer/snapshots/<sid>")
def api_get_mixer_snapshot(sid):
    snapshot = mixer_snapshots_store.get_snapshot(sid)
    if snapshot is None:
        return jsonify({"error": "snapshot not found"}), 404
    return jsonify(snapshot)


@app.route("/api/mixer/snapshots", methods=["POST"])
def api_save_mixer_snapshot():
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    actions = body.get("actions")
    if not isinstance(actions, list) or not actions:
        return jsonify({"error": "actions must be a non-empty list"}), 400
    sid = body.get("id")
    sid = mixer_snapshots_store.save_snapshot(sid, name, actions)
    return jsonify({"success": True, "id": sid})


@app.route("/api/mixer/snapshots/<sid>", methods=["DELETE"])
def api_delete_mixer_snapshot(sid):
    mixer_snapshots_store.delete_snapshot(sid)
    return jsonify({"success": True})


@app.route("/api/mixer/snapshots/<sid>/apply", methods=["POST"])
def api_apply_mixer_snapshot(sid):
    snapshot = mixer_snapshots_store.get_snapshot(sid)
    if snapshot is None:
        return jsonify({"error": "snapshot not found"}), 404
    return _apply_mixer_snapshot(snapshot, "mixer_snapshot:apply")


@app.route("/api/mixer-panel")
def api_get_mixer_panel():
    return jsonify(mixer_panel_store.get_panel())


@app.route("/api/mixer-panel", methods=["POST"])
def api_save_mixer_panel():
    body = request.get_json(force=True, silent=True) or {}
    try:
        cols = int(body.get("cols") or 8)
        rows = int(body.get("rows") or 4)
    except (TypeError, ValueError):
        return jsonify({"error": "cols and rows must be integers"}), 400
    buttons = body.get("buttons")
    if not isinstance(buttons, list):
        return jsonify({"error": "buttons must be a list"}), 400
    data = mixer_panel_store.save_panel(cols, rows, buttons)
    return jsonify({"success": True, **data})


@app.route("/api/mixer-panel/press/<sid>", methods=["POST"])
def api_mixer_panel_press(sid):
    snapshot = mixer_snapshots_store.get_snapshot(sid)
    if snapshot is None:
        return jsonify({"error": "snapshot not found"}), 404
    return _apply_mixer_snapshot(snapshot, "mixer_panel:press")


@app.route("/api/mixer-panel/radio-groups")
def api_list_radio_groups():
    return jsonify(mixer_panel_store.list_radio_groups())


@app.route("/api/mixer-panel/radio-groups", methods=["POST"])
def api_create_radio_group():
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    return jsonify(mixer_panel_store.create_radio_group(name))


@app.route("/api/mixer-panel/radio-groups/<gid>", methods=["PUT"])
def api_rename_radio_group(gid):
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    group = mixer_panel_store.rename_radio_group(gid, name)
    if group is None:
        return jsonify({"error": "group not found"}), 404
    return jsonify(group)


@app.route("/api/mixer-panel/radio-groups/<gid>", methods=["DELETE"])
def api_delete_radio_group(gid):
    data = mixer_panel_store.delete_radio_group(gid)
    return jsonify({"success": True, **data})


@app.route("/api/mixer/meters/start", methods=["POST"])
def api_mixer_meters_start():
    try:
        data, status = mixer_client.start_meters()
    except mixer_client.RelayError as exc:
        return jsonify({"error": str(exc)}), 502
    return jsonify(data), status


@app.route("/api/mixer/meters/stop", methods=["POST"])
def api_mixer_meters_stop():
    try:
        data, status = mixer_client.stop_meters()
    except mixer_client.RelayError as exc:
        return jsonify({"error": str(exc)}), 502
    return jsonify(data), status


@app.route("/api/mixer/meters")
def api_mixer_meters():
    def generate():
        try:
            for chunk in mixer_client.meters_stream():
                yield chunk
        except mixer_client.RelayError as exc:
            payload = f'data: {{"event": "relay_unavailable", "error": {str(exc)!r}}}\n\n'
            yield payload.encode()
        except GeneratorExit:
            raise
        except Exception as exc:
            log.debug("mixer meters stream ended: %s", exc)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --- Design mode ------------------------------------------------------------
# Designs are virtual: their own devices/channels (which may or may not exist
# for real), a base connection list, and named presets. Nothing touches real
# hardware until /apply, which resolves each design device to a live one by
# name (or by the server_name it was imported from) and only acts on
# connections that fully resolve.


@app.route("/api/designs")
def api_list_designs():
    return jsonify(designs_store.list_designs())


@app.route("/api/designs/<did>")
def api_get_design(did):
    design = designs_store.get_design(did)
    if design is None:
        return jsonify({"error": "design not found"}), 404
    return jsonify(design)


@app.route("/api/designs", methods=["POST"])
def api_save_design():
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    did = designs_store.save_design(
        body.get("id"),
        name,
        body.get("devices") or {},
        body.get("connections") or [],
        body.get("presets") or {},
    )
    return jsonify({"success": True, "id": did})


@app.route("/api/designs/<did>", methods=["DELETE"])
def api_delete_design(did):
    designs_store.delete_design(did)
    return jsonify({"success": True})


def _resolve_live_device(design_device, live_by_name, live_by_server):
    if not design_device:
        return None
    imported_from = design_device.get("imported_from")
    if imported_from and imported_from in live_by_server:
        return live_by_server[imported_from]
    name = (design_device.get("name") or "").strip().lower()
    return live_by_name.get(name)


def _resolve_channel_name(live_device, channel_type, channel_number):
    channels = (live_device.get("channels") or {}).get(channel_type) or {}
    chan = channels.get(str(channel_number))
    if not chan:
        return None
    return chan.get("name")


def _live_device_key(live_device):
    return live_device.get("server_name") or live_device.get("name")


def _apply_design_actions(design, actions):
    live_devices, status = relay.get_devices()
    if status >= 400 or not isinstance(live_devices, dict):
        return None, "could not read live devices from the daemon"

    live_by_name = {}
    live_by_server = {}
    for server_name, dev in live_devices.items():
        live_by_server[server_name] = dev
        if dev.get("name"):
            live_by_name[dev["name"].strip().lower()] = dev

    devices = design.get("devices") or {}
    results = []

    for action in actions:
        rx_design = devices.get(action.get("rx_device"))
        tx_design = devices.get(action.get("tx_device")) if action.get("tx_device") else None
        rx_live = _resolve_live_device(rx_design, live_by_name, live_by_server)
        tx_live = _resolve_live_device(tx_design, live_by_name, live_by_server) if tx_design else None

        entry = {
            "action": action.get("action", "add"),
            "rx_device_label": (rx_design or {}).get("name", action.get("rx_device")),
            "rx_channel": action.get("rx_channel"),
            "tx_device_label": (tx_design or {}).get("name") if tx_design else None,
            "tx_channel": action.get("tx_channel"),
        }

        if not rx_design or not rx_live:
            entry.update(ok=False, error="receive device not found on the live network")
            results.append(entry)
            continue

        rx_channel_name = _resolve_channel_name(rx_live, "receivers", action.get("rx_channel"))
        if not rx_channel_name:
            entry.update(ok=False, error="receive channel not found on the live device")
            results.append(entry)
            continue

        if action.get("action") == "remove" or not tx_design:
            try:
                data, resp_status = relay.unsubscribe(_live_device_key(rx_live), action.get("rx_channel"))
                entry.update(ok=resp_status < 400, error=None if resp_status < 400 else data.get("error"))
            except relay.RelayError as exc:
                entry.update(ok=False, error=str(exc))
            results.append(entry)
            continue

        if not tx_live:
            entry.update(ok=False, error="transmit device not found on the live network")
            results.append(entry)
            continue

        tx_channel_name = _resolve_channel_name(tx_live, "transmitters", action.get("tx_channel"))
        if not tx_channel_name:
            entry.update(ok=False, error="transmit channel not found on the live device")
            results.append(entry)
            continue

        try:
            data, resp_status = relay.subscribe(
                _live_device_key(rx_live), action.get("rx_channel"), tx_channel_name, _live_device_key(tx_live)
            )
            entry.update(ok=resp_status < 400, error=None if resp_status < 400 else data.get("error"))
        except relay.RelayError as exc:
            entry.update(ok=False, error=str(exc))
        results.append(entry)

    return results, None


@app.route("/api/designs/<did>/apply", methods=["POST"])
def api_apply_design(did):
    design = designs_store.get_design(did)
    if design is None:
        return jsonify({"error": "design not found"}), 404

    body = request.get_json(force=True, silent=True) or {}
    preset_id = body.get("preset_id")

    if preset_id:
        preset = (design.get("presets") or {}).get(preset_id)
        if preset is None:
            return jsonify({"error": "design preset not found"}), 404
        actions = preset["actions"]
        source_label = f"design '{design['name']}' preset '{preset['name']}'"
    else:
        actions = [{**c, "action": "add"} for c in design.get("connections") or []]
        source_label = f"design '{design['name']}' base connections"

    results, error = _apply_design_actions(design, actions)
    if error:
        activity_log.log_event("design:apply", {"design_id": did, "source": source_label}, ok=False, error=error)
        return jsonify({"error": error}), 502

    applied = sum(1 for r in results if r["ok"])
    activity_log.log_event(
        "design:apply",
        {"design_id": did, "source": source_label, "applied": applied, "total": len(results)},
        ok=applied == len(results),
        error=None if applied == len(results) else f"{len(results) - applied} action(s) failed or unresolved",
    )
    return jsonify({"success": True, "applied": applied, "total": len(results), "results": results})


# --- TX multicast flows (CLI-backed, not the daemon relay) -----------------
# The relay has no /flow endpoint, so these shell out to `netaudio flow`
# directly. Slower and less reliable than everything above.


@app.route("/api/flows/<path:device_name>")
def api_list_flows(device_name):
    try:
        flows = netaudio_cli.list_flows(device_name)
    except netaudio_cli.CliError as exc:
        return jsonify({"error": str(exc)}), 502
    return jsonify(flows)


@app.route("/api/flows/<path:device_name>", methods=["POST"])
def api_create_flow(device_name):
    body = request.get_json(force=True, silent=True) or {}
    slot = body.get("slot")
    channels = body.get("channels")
    if not slot or not channels:
        return jsonify({"error": "slot and channels are required"}), 400
    detail = {"device": device_name, "slot": slot, "channels": channels}
    try:
        netaudio_cli.create_flow(device_name, slot, channels)
    except netaudio_cli.CliError as exc:
        activity_log.log_event("flow:create", detail, ok=False, error=str(exc))
        return jsonify({"error": str(exc)}), 502
    activity_log.log_event("flow:create", detail, ok=True)
    return jsonify({"success": True})


@app.route("/api/flows/<path:device_name>/<int:slot>", methods=["DELETE"])
def api_delete_flow(device_name, slot):
    detail = {"device": device_name, "slot": slot}
    try:
        netaudio_cli.delete_flow(device_name, slot)
    except netaudio_cli.CliError as exc:
        activity_log.log_event("flow:delete", detail, ok=False, error=str(exc))
        return jsonify({"error": str(exc)}), 502
    activity_log.log_event("flow:delete", detail, ok=True)
    return jsonify({"success": True})


@app.route("/api/activity")
def api_activity():
    return jsonify(activity_log.list_events())


@app.route("/api/events")
def api_events():
    def generate():
        try:
            for chunk in relay.events_stream():
                yield chunk
        except relay.RelayError as exc:
            payload = f'data: {{"event": "relay_unavailable", "error": {str(exc)!r}}}\n\n'
            yield payload.encode()
        except GeneratorExit:
            raise
        except Exception as exc:  # daemon dropped connection, client nav'd away, etc.
            log.debug("events stream ended: %s", exc)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --- Background health check ------------------------------------------
#
# Observed live: a device can sit "online" with an empty channels dict
# (0 receivers, 0 transmitters) until someone happens to click Refresh —
# the daemon has it, but hasn't backfilled its channel detail yet. Most of
# the time nobody's watching this app, so nobody notices to click Refresh.
# This loop watches for that shape, tries a plain refresh first, and only
# escalates to a full daemon restart if the refresh alone didn't clear it
# (mirrors the online-flag issue also seen after unplug/replug, where only
# a restart's fresh mDNS discovery brought a device back).


def _device_looks_incomplete(device):
    if not isinstance(device, dict) or not device.get("online"):
        return False
    channels = device.get("channels") or {}
    return not (channels.get("receivers") or {}) and not (channels.get("transmitters") or {})


def _health_check_once():
    global _last_auto_restart

    devices, status = relay.get_devices(timeout=8)
    if status >= 400 or not isinstance(devices, dict):
        return
    stale = [name for name, d in devices.items() if _device_looks_incomplete(d)]
    if not stale:
        return

    log.warning("Health check: incomplete channel data for %s — refreshing", stale)
    try:
        relay.refresh(timeout=15)
    except relay.RelayError as exc:
        log.warning("Health check: refresh failed: %s", exc)
        return

    time.sleep(HEALTH_CHECK_SETTLE)
    devices, status = relay.get_devices(timeout=8)
    if status >= 400 or not isinstance(devices, dict):
        return
    still_stale = [name for name, d in devices.items() if _device_looks_incomplete(d)]
    if not still_stale:
        return

    if time.time() - _last_auto_restart < AUTO_RESTART_COOLDOWN:
        log.warning("Health check: still incomplete for %s, but a restart happened recently — waiting", still_stale)
        return

    log.warning("Health check: still incomplete for %s after refresh — restarting daemon", still_stale)
    _last_auto_restart = time.time()
    _restart_daemon_process("daemon:auto-restart", f"incomplete channel data: {', '.join(still_stale)}")


def _health_monitor_loop():
    while True:
        time.sleep(HEALTH_CHECK_INTERVAL)
        try:
            _health_check_once()
        except relay.RelayError as exc:
            log.debug("Health check couldn't reach daemon: %s", exc)
        except Exception:
            log.exception("Device health monitor failed")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5051))
    # Guard against Werkzeug's debug-mode reloader spawning this twice —
    # only the actual worker process (not its watcher parent) sets this.
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        threading.Thread(target=_health_monitor_loop, daemon=True).start()
    app.run(host="0.0.0.0", port=port, debug=True, threaded=True)
