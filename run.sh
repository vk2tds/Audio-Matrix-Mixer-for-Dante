#!/usr/bin/env bash
# Starts the netaudio daemon and the Dante-web Flask app together, and
# restarts the daemon automatically if it dies. Ctrl-C stops both.

set -uo pipefail
cd "$(dirname "$0")"

VENV_PYTHON="./.venv/bin/python"
VENV_NETAUDIO="./.venv/bin/netaudio"

if [ ! -x "$VENV_PYTHON" ]; then
  echo "No .venv found here. Set it up first:" >&2
  echo "  python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt" >&2
  exit 1
fi

mkdir -p logs
DAEMON_LOG="logs/netaudio-daemon.log"
APP_LOG="logs/dante-web.log"

DAEMON_PID=""
APP_PID=""

cleanup() {
  echo
  echo "Stopping..."
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null
  wait 2>/dev/null
  exit 0
}
trap cleanup INT TERM

start_daemon() {
  "$VENV_NETAUDIO" server run >>"$DAEMON_LOG" 2>&1 &
  DAEMON_PID=$!
  echo "netaudio daemon started (pid $DAEMON_PID) — log: $DAEMON_LOG"
}

start_daemon

"$VENV_PYTHON" dante_web_app.py >>"$APP_LOG" 2>&1 &
APP_PID=$!
echo "Dante-web started (pid $APP_PID) — log: $APP_LOG"
echo "Open http://localhost:${PORT:-5051}"
echo "Press Ctrl-C to stop both."

while true; do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "Dante-web exited unexpectedly — check $APP_LOG" >&2
    cleanup
  fi
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "$(date '+%Y-%m-%d %H:%M:%S'): netaudio daemon exited, restarting..." | tee -a "$DAEMON_LOG"
    start_daemon
  fi
  sleep 5
done
