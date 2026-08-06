"""Thin client for DanteMixer's local HTTP relay API.

Mirrors netaudio_client.py's shape deliberately. DanteMixer (see the sibling
DanteMixer repo) doesn't have a running Web API yet — calls here will fail
with a RelayError until it does, which callers surface the same way
netaudio_client.RelayError already is: a clear "daemon unreachable" state,
not a crash.
"""

import os
from urllib.parse import quote

import requests

RELAY_BASE_URL = os.environ.get("MIXER_RELAY_URL", "http://127.0.0.1:9100").rstrip("/")


class RelayError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def _request(method, path, json_body=None, timeout=5):
    url = f"{RELAY_BASE_URL}{path}"
    try:
        resp = requests.request(method, url, json=json_body, timeout=timeout)
    except requests.RequestException as exc:
        raise RelayError(f"could not reach mixer daemon at {RELAY_BASE_URL} ({exc})") from exc

    try:
        data = resp.json()
    except ValueError:
        data = {"error": "invalid response from mixer daemon"}

    return data, resp.status_code


def get_devices():
    return _request("GET", "/devices")


def refresh_devices():
    return _request("POST", "/devices/refresh")


def get_mixers():
    return _request("GET", "/mixers")


def get_mixer(mixer_id):
    return _request("GET", f"/mixers/{quote(mixer_id, safe='')}")


def set_bus_name(mixer_id, name):
    return _request("PUT", f"/mixers/{quote(mixer_id, safe='')}/name", {"name": name})


def set_input(mixer_id, slot, device_id, channel):
    return _request(
        "PUT",
        f"/mixers/{quote(mixer_id, safe='')}/inputs/{slot}",
        {"deviceId": device_id, "channel": channel},
    )


def clear_input(mixer_id, slot):
    return _request("DELETE", f"/mixers/{quote(mixer_id, safe='')}/inputs/{slot}")


def set_input_level(mixer_id, slot, level_db):
    return _request(
        "PUT", f"/mixers/{quote(mixer_id, safe='')}/inputs/{slot}/level", {"levelDb": level_db}
    )


def set_input_mute(mixer_id, slot, muted):
    return _request(
        "PUT", f"/mixers/{quote(mixer_id, safe='')}/inputs/{slot}/mute", {"muted": muted}
    )


def set_output_level(mixer_id, level_db):
    return _request("PUT", f"/mixers/{quote(mixer_id, safe='')}/output/level", {"levelDb": level_db})


def set_output_mute(mixer_id, muted):
    return _request("PUT", f"/mixers/{quote(mixer_id, safe='')}/output/mute", {"muted": muted})


def set_output_route(mixer_id, device_id, channels):
    return _request(
        "PUT",
        f"/mixers/{quote(mixer_id, safe='')}/output/route",
        {"deviceId": device_id, "channels": channels},
    )


def start_meters():
    return _request("POST", "/meters/start")


def stop_meters():
    return _request("POST", "/meters/stop")


def meters_stream():
    """Yield raw bytes from the mixer daemon's meter Server-Sent Events stream."""
    url = f"{RELAY_BASE_URL}/meters/stream"
    with requests.get(url, stream=True, timeout=(5, None)) as resp:
        resp.raise_for_status()
        for chunk in resp.iter_content(chunk_size=1024):
            if chunk:
                yield chunk
