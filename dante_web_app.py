import logging
import os

from flask import Flask, Response, jsonify, render_template, request

import netaudio_client as relay

app = Flask(__name__)
log = logging.getLogger("dante-web")


def proxy(method, path, json_body=None):
    try:
        data, status = relay._request(method, path, json_body)
    except relay.RelayError as exc:
        return jsonify({"error": str(exc)}), 502
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
