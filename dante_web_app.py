import logging
import os
import signal

from flask import Flask, Response, jsonify, render_template, request

import activity_log
import designs_store
import netaudio_cli
import netaudio_client as relay
import panel_store
import presets_store

app = Flask(__name__)
log = logging.getLogger("dante-web")

DAEMON_PIDFILE = os.path.join(os.path.dirname(__file__), "logs", "daemon.pid")


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
    try:
        with open(DAEMON_PIDFILE) as f:
            pid = int(f.read().strip())
    except (FileNotFoundError, ValueError):
        error = "No daemon pidfile found — this only works when running via run.sh."
        activity_log.log_event("daemon:restart", None, ok=False, error=error)
        return jsonify({"error": error}), 409

    try:
        os.kill(pid, 0)
    except OSError:
        error = f"Daemon process {pid} isn't running (stale pidfile)."
        activity_log.log_event("daemon:restart", {"pid": pid}, ok=False, error=error)
        return jsonify({"error": error}), 409

    try:
        os.kill(pid, signal.SIGTERM)
    except OSError as exc:
        activity_log.log_event("daemon:restart", {"pid": pid}, ok=False, error=str(exc))
        return jsonify({"error": str(exc)}), 500

    activity_log.log_event("daemon:restart", {"pid": pid}, ok=True)
    return jsonify({"success": True, "message": f"Signaled daemon (pid {pid}) to stop — run.sh will restart it within ~5s."})


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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5051))
    app.run(host="0.0.0.0", port=port, debug=True, threaded=True)
