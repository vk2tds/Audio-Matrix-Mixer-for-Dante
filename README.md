# Dante-web

A web-based control surface for Dante audio devices, built on top of
[network-audio-controller](https://github.com/chris-ritsen/network-audio-controller)
(the `netaudio` Python package). `netaudio` discovers Dante devices via mDNS
and runs a small local daemon; this app is a Flask frontend that talks to
that daemon and gives you a browser UI for:

- **Devices** — list of discovered Dante devices, online status, identify
- **Routing** — a TX × RX matrix to subscribe/unsubscribe audio routes
- **Gain** — per-channel input/output gain (1–5), where supported
- **Metering** — live per-channel levels, where supported

Not every Dante device supports every feature (gain and metering in
particular vary by manufacturer/firmware) — the UI degrades gracefully when
a device doesn't report or accept a given control.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Running

Start the netaudio daemon (discovers devices via mDNS and exposes a local
HTTP relay on `127.0.0.1:9000` — no authentication, so keep it off untrusted
networks):

```bash
netaudio server start
```

Then start the web app:

```bash
python dante_web_app.py
```

Open http://localhost:5051 (override with the `PORT` environment variable)

The app expects the daemon's relay at `http://127.0.0.1:9000` by default;
override with the `NETAUDIO_RELAY_URL` environment variable if it's running
elsewhere.

## Architecture

- `dante_web_app.py` — Flask app: serves the pages and proxies API calls (including
  the `/events` Server-Sent Events stream) to the netaudio daemon's relay.
- `netaudio_client.py` — thin HTTP client for the daemon's relay API.
- `templates/`, `static/` — server-rendered pages with vanilla JS. Each page
  subscribes to a shared live device store (`static/js/common.js`) that's
  kept in sync via the SSE stream, so device status, routing state, etc.
  update in real time without polling (metering is polled explicitly once
  started, since it's opt-in per device).
