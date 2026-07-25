"""Thin wrapper around the `netaudio` CLI for functionality the daemon's
HTTP relay doesn't expose yet (TX multicast flow management).

Unlike netaudio_client.py (which talks to the always-running daemon over
HTTP and is fast), every call here spawns `netaudio`, which does its own
mDNS discovery from scratch. Expect multi-second latency, and expect it
to occasionally time out or silently no-op against hardware with partial
Dante protocol support.
"""

import json
import os
import subprocess

NETAUDIO_BIN = os.environ.get("NETAUDIO_BIN", "netaudio")
CLI_TIMEOUT = float(os.environ.get("NETAUDIO_CLI_TIMEOUT", "20"))


class CliError(Exception):
    pass


def _run(args):
    try:
        result = subprocess.run(
            [NETAUDIO_BIN, *args],
            capture_output=True,
            text=True,
            timeout=CLI_TIMEOUT,
        )
    except subprocess.TimeoutExpired as exc:
        raise CliError(
            f"netaudio CLI timed out after {CLI_TIMEOUT:g}s (device may not have responded)"
        ) from exc
    except FileNotFoundError as exc:
        raise CliError("netaudio CLI not found on PATH") from exc
    return result


def _fail(result, fallback):
    message = (result.stderr or result.stdout or fallback).strip()
    raise CliError(message)


def list_flows(device_name):
    result = _run(["-j", "flow", "list", device_name])
    if result.returncode != 0:
        _fail(result, "flow list failed")

    text = (result.stdout or "").strip()
    if not text or text == "No TX flows configured.":
        return []

    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise CliError(f"unexpected output from netaudio flow list: {text[:200]}") from exc


def create_flow(device_name, slot, channels):
    channel_str = ",".join(str(c) for c in channels)
    result = _run(["flow", "create", device_name, "--slot", str(slot), "--channels", channel_str])
    if result.returncode != 0:
        _fail(result, "flow create failed")
    return True


def delete_flow(device_name, slot):
    result = _run(["flow", "delete", device_name, "--slot", str(slot)])
    if result.returncode != 0:
        _fail(result, "flow delete failed")
    return True
