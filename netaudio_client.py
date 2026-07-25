"""Thin client for the netaudio daemon's local HTTP relay API.

The relay is provided by the `netaudio` package (network-audio-controller,
https://github.com/chris-ritsen/network-audio-controller). Start it with
`netaudio server start`; by default it listens on http://127.0.0.1:9000
and requires no authentication.
"""

import os
from urllib.parse import quote

import requests

RELAY_BASE_URL = os.environ.get("NETAUDIO_RELAY_URL", "http://127.0.0.1:9000").rstrip("/")


class RelayError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def _request(method, path, json_body=None, timeout=5):
    url = f"{RELAY_BASE_URL}{path}"
    try:
        resp = requests.request(method, url, json=json_body, timeout=timeout)
    except requests.RequestException as exc:
        raise RelayError(
            f"could not reach netaudio daemon at {RELAY_BASE_URL} ({exc})"
        ) from exc

    try:
        data = resp.json()
    except ValueError:
        data = {"error": "invalid response from netaudio daemon"}

    return data, resp.status_code


def get_devices():
    return _request("GET", "/devices")


def get_device(server_name):
    return _request("GET", f"/devices/{quote(server_name, safe='')}")


def identify(device):
    return _request("POST", "/identify", {"device": device})


def refresh(device=None):
    body = {"device": device} if device else {}
    return _request("POST", "/refresh", body)


def subscribe(rx_device, rx_channel, tx_channel, tx_device):
    return _request(
        "POST",
        "/subscribe",
        {
            "rx_device": rx_device,
            "rx_channel": rx_channel,
            "tx_channel": tx_channel,
            "tx_device": tx_device,
        },
    )


def unsubscribe(rx_device, rx_channel):
    return _request(
        "POST", "/unsubscribe", {"rx_device": rx_device, "rx_channel": rx_channel}
    )


def rename_device(device, name):
    return _request("POST", "/rename-device", {"device": device, "name": name})


def rename_channel(device, channel_type, channel_number, name):
    return _request(
        "POST",
        "/rename-channel",
        {
            "device": device,
            "channel_type": channel_type,
            "channel_number": channel_number,
            "name": name,
        },
    )


def set_gain(device, channel_number, gain_level, device_type=""):
    return _request(
        "POST",
        "/set-gain",
        {
            "device": device,
            "channel_number": channel_number,
            "gain_level": gain_level,
            "device_type": device_type,
        },
    )


def set_latency(device, latency):
    return _request("POST", "/set-latency", {"device": device, "latency": latency})


def set_sample_rate(device, sample_rate):
    return _request(
        "POST", "/set-sample-rate", {"device": device, "sample_rate": sample_rate}
    )


def set_encoding(device, encoding):
    return _request("POST", "/set-encoding", {"device": device, "encoding": encoding})


def set_aes67(device, enabled):
    return _request("POST", "/set-aes67", {"device": device, "enabled": enabled})


def metering_status():
    return _request("GET", "/metering/status")


def metering_snapshot(device_name):
    return _request("GET", f"/metering/snapshot/{quote(device_name, safe='')}")


def metering_start(device, client_id="dante-web"):
    return _request(
        "POST", "/metering/start", {"device": device, "client_id": client_id}
    )


def metering_stop(device, client_id="dante-web"):
    return _request(
        "POST", "/metering/stop", {"device": device, "client_id": client_id}
    )


def events_stream():
    """Yield raw bytes from the daemon's Server-Sent Events stream."""
    url = f"{RELAY_BASE_URL}/events"
    with requests.get(url, stream=True, timeout=(5, None)) as resp:
        resp.raise_for_status()
        for chunk in resp.iter_content(chunk_size=1024):
            if chunk:
                yield chunk
