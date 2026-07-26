# Dante-web — Development Session History

A narrative record of the Claude Code session that built this project, kept for
future reference (context on *why* things are the way they are, not just *what*
they are). Reconstructed from the conversation, not a raw transcript.

## Project kickoff

Darryl asked for a web-based Dante audio interface, using
[network-audio-controller](https://github.com/chris-ritsen/network-audio-controller)
(the `netaudio` Python package) as the backend interface to Dante. The
`Dante-web` repo existed but was empty (just a README).

Research turned up that `netaudio` ships a daemon with a local HTTP+JSON relay
API (default `127.0.0.1:9000`, no auth) — routes for device listing,
subscriptions/routing, gain, latency/sample-rate, identify, rename, metering
(including a `GET /events` SSE stream). That meant a real backend, not just a
CLI to shell out to.

Clarifying questions settled the shape of v1:
- **Stack:** Python Flask (matches Darryl's other project's style, and can
  manage the netaudio daemon since it's also Python).
- **Scope:** Device list, routing matrix, gain control, live metering.
- **Testing:** Real Dante hardware available (Blustream `DA11AEN`/`DA11ADE`
  HDMI-to-Dante extenders, non-Audinate; plus the Mac's own Dante Virtual
  Soundcard, "Mini-Garage").

## Initial build

Installed `netaudio` into a venv, started the daemon (`netaudio server start`),
and confirmed it discovered all 4 devices via `curl` against the relay before
writing any app code.

Built the first version of the Flask app:
- `netaudio_client.py` — thin HTTP client for the relay.
- `dante_web_app.py` — Flask routes proxying to the relay, including streaming
  `/api/events` (SSE) through to the browser.
- `templates/` + `static/` — server-rendered pages, vanilla JS, a shared
  `DanteStore` in `common.js` that stays in sync via the SSE stream.
- Pages: **Devices**, **Routing** (click-to-subscribe matrix), **Gain**,
  **Metering**.

Verified end-to-end against the real daemon and hardware via curl and the
Browser pane (screenshots of the dark-themed UI, live device list, routing
matrix, gain controls).

## Port conflict detour

Darryl's other project (`MacLoggerDX_Awards`) was already running on port
5050, which collided with Dante-web's browser-preview tooling. This took a
few wrong turns — moving *both* projects' launch configs to port 5051 by
mistake caused the preview tool to launch the wrong app entirely — before
landing on: Dante-web moved to port 5051 (`PORT` env var, default preserved),
`MacLoggerDX_Awards` stayed on 5050 untouched (it had been running
continuously since July 15, not something to disturb).

## The routing bug and the hardware-reliability rabbit hole

Clicking a routing matrix cell threw `build_command add_subscriptions:
invalid command json`. Root cause: JS object keys are always strings, so
`rx_channel` was being sent as `"1"` instead of the integer `1` the daemon's
native command builder required. Fixed by coercing to `Number()` at the point
channel lists were built.

That fix led to a longer investigation, because the *first* live test after
fixing it showed the Blustream units' routing had seemingly been corrupted —
cross-wired and pointing at wrong sources. Chased this through several
hypotheses across multiple messages:
1. Confirmed via direct API reads that the subscriptions really had changed
   from their original state.
2. Restored the correct pairing via the (now-fixed) subscribe endpoint —
   `{success: true}` came back, but a follow-up `/refresh` showed the state
   **still** wrong, and different again a few minutes later.
3. Found `device did not respond` warnings in the daemon log — specifically
   and only for the two Blustream *receiver* units, never the transmitter or
   the Mac's own virtual soundcard.
4. Tried turning off Wi-Fi (in case the Mac being multi-homed was routing
   control traffic out the wrong interface) — no change.
5. Darryl power-cycled both units — no change, identical failure signature.
6. Darryl mentioned he might have been clicking in the UI at the same time —
   a plausible confound, so a clean isolated retest was done. Still didn't
   stick.

At that point Darryl opened the *real* Dante Controller and reported: clicks
in Dante-web were reflected in Dante Controller and vice versa, and audio was
audibly routing correctly. So the actual Dante network state was fine all
along — what we'd been chasing was staleness in the **daemon's own read-back**
of subscription state, not a real routing failure. Lesson carried forward for
the rest of the project: trust Dante Controller (or a forced `/refresh`) over
a single snapshot from the daemon if the two ever disagree.

## Connections tab and matrix redesign

Two feature requests followed naturally from that investigation:
- **Connections tab** — a flat, live list of every active subscription
  across all devices, with unsubscribe, so the true state is always one
  click away instead of having to read a routing matrix.
- **Collapsible, filterable routing matrix**, matching Dante Controller's
  own layout (filter boxes for transmitters/receivers, per-device
  collapse/expand).

Building the matrix redesign took a few rounds of visual iteration and two
real CSS/layout bugs, each diagnosed properly rather than guessed at:
- Column group headers were rotated to match the channel labels beneath them
  (per Darryl's ask), then given their *own* dedicated narrow column instead
  of overlapping the channel columns via `colspan` (also per Darryl's ask,
  comparing against a Dante Controller screenshot).
- **Bug:** after giving headers their own column, expanding a device put all
  the group-header cells before all the channel cells instead of interleaved
  — a genuine `<table>` layout bug (the header row needed placeholder cells
  to stay column-aligned with the row below it), not a data bug.
- **Bug:** collapsing all transmitter groups made everything render pushed
  hard to the right with a large blank gap on the left. Traced (via
  `getBoundingClientRect` measurements in the live page, not guessing) to a
  leftover generic `table { width: 100%; }` rule leaking into the matrix and
  forcing it to fill the container, with all the slack dumped into the empty
  corner cell. Fixed by scoping the matrix table to `width: auto`.

Both fixes were verified live in the Browser pane before moving on, and the
whole batch was committed and pushed to `vk2tds/Dante-web`.

## Light/dark theme

Darryl wanted light mode as the default with a dark-mode toggle (not the
dark-only theme originally built). Split the CSS variables into a default
`:root` (light) and `:root[data-theme="dark"]` override, added a sun/moon
toggle button in the top bar, persisted the choice in `localStorage`, and used
an inline `<head>` script to apply the stored theme before first paint (no
flash of the wrong theme). Verified both themes render correctly, including
the routing matrix.

## First feature round: presets, device config, refresh, mobile

Asked "anything I should add?" and proposed a short list; Darryl said yes to
all but access control (explicitly not needed), with specific requirements
for presets:

- **Routing presets** — a preset is a list of add/remove *deltas*, not a
  full-state snapshot, so applying one only touches the channels it mentions.
  Two ways to build one from the Routing page: turn on "Record changes for a
  preset" and just make the changes you want (captured as you click), or
  "Save current matrix as preset…" to capture everything active right now as
  a set of adds. Either can save as new or update an existing preset.
  `presets_store.py` is a small JSON-file-backed store; the Presets page lists,
  views, applies, renames, and deletes them.
- **Device config page** — rename device/channel, latency, sample rate,
  encoding, AES67, reusing relay routes that had already been proxied but had
  no UI. Deliberately loads once rather than live-subscribing to the SSE
  store, so an in-progress edit can't be wiped out by an unrelated live
  update elsewhere on the network.
- **Manual refresh button** on Devices/Connections. Building this
  immediately paid off: it surfaced that the daemon's mDNS discovery had
  actually stalled (a `Can't assign requested address` socket error in the
  log from hours earlier, likely a network interface change) — devices
  showed offline with stale timestamps and the button's own `/refresh` call
  couldn't fix it. Restarting the daemon process did.
- **Mobile-friendly compact view** — the wide matrix doesn't work on a
  phone, so under 700px width the Routing page automatically swaps to one
  dropdown per receive channel instead.

All four verified in the Browser pane (including resizing to a mobile
viewport) and pushed.

## Encoding bug and the multicast question

Darryl caught that the Config page's "Encoding (bit)" dropdown looked wrong.
Investigation found the CLI's actual valid values (`16, 24, 32`) were right,
but the real bug was that the encoding field is `null` for all four devices
(they don't report it) and the `<select>` was silently defaulting to its
first option as if that were a real reading. Fixed to show an honest
"— unknown —" placeholder instead.

Darryl then asked whether multicast flow control was possible. First answer
was wrong (missed a separate code path); re-checking found `netaudio flow
list/create/delete` genuinely exists (`dante/flows.py`), but the **daemon's
relay API doesn't expose it at all** — only the CLI does, and the CLI redoes
mDNS discovery from scratch on every invocation. Darryl chose to build it
anyway via CLI subprocess (with the latency tradeoff accepted), and asked for
a reminder in about a week to write a GitHub issue requesting the daemon
relay add the missing endpoints.

- `netaudio_cli.py` wraps `netaudio flow list/create/delete` with a 20s
  timeout so a hung call can't hang the Flask server.
- New **Flows** page: per-transmit-device flow list (loaded on demand),
  create form, delete.
- Live testing found `create` reports success without the flow reliably
  appearing in a subsequent `list` on this hardware — the UI says so plainly
  rather than pretending it worked.
- A one-time scheduled reminder was created (via a Claude routine) for
  2026-08-01 to draft — not auto-post — the GitHub issue text for review.

## Second feature round: run.sh, activity log, notifications, restart button

Asked again "anything else?"; top recommendation was a daemon watchdog, but
Darryl asked to start with a single script to run everything, then move to
the rest.

- **`run.sh`** — starts the daemon (`netaudio server run`, in the
  foreground — deliberately not `server start`, which self-detaches and
  can't be tracked by a supervising script) and the Flask app together,
  restarts the daemon automatically if it dies, cleans up both on Ctrl-C.
  Verified live: `kill -9`'d the daemon mid-run, the loop caught it within
  5 seconds and all 4 devices came back, with the Flask app undisturbed the
  whole time.
- **Activity log** — every POST action Dante-web sends (subscribe, gain,
  rename, config changes, identify, preset applies, flow create/delete) is
  logged with success/error to a capped JSON file, independent of whatever
  the daemon's own `/devices` happens to be reporting at the time. New
  **Activity** page shows it reverse-chronological.
- **Offline-transition toasts** — any page now toasts when a device's
  online status flips, tracked client-side in `common.js` by diffing against
  the previous snapshot (the very first snapshot after a page load only sets
  the baseline, so it doesn't spuriously toast for a device that was already
  offline when the page loaded).
- **Manual "Restart daemon" button** — building this caught a real, live
  bug: `netaudio server restart` doesn't know about `run.sh`'s supervision
  loop, and the two fought over port 9000 (one daemon stuck unable to bind,
  the other crash-looping every 5 seconds trying to restart its own copy).
  Fixed by *not* using that CLI command at all — `run.sh` now writes its
  tracked daemon PID to `logs/daemon.pid`, and the button just sends that
  exact process a `SIGTERM`, letting the same supervision loop already
  proven to handle crashes restart it. Verified clean: PID changed with no
  port conflict, all devices rediscovered, Flask app never interrupted. Only
  works when running via `run.sh`; a clear error otherwise.

Also brought `README.md` fully up to date in this round — it hadn't been
touched since the original scaffold and was missing everything from
Connections onward.

## Working notes for whoever reads this next

- The Blustream/HDCVT-based hardware has **partial Dante protocol support**:
  routing and gain work, but control-plane read-backs (subscription state,
  encoding, flow listing) can be stale or simply absent. When in doubt, check
  Dante Controller directly rather than trusting a single API read.
- Mini-Garage (the Mac's own Dante Virtual Soundcard) has a recurring
  self-mDNS flakiness independent of everything else — it drops offline and
  comes back on its own periodically. Not a Dante-web bug.
- The relay has zero authentication and binds `0.0.0.0` — fine on a trusted
  home network, not something to expose further without adding auth first
  (deliberately out of scope so far, per Darryl: "no need for basic access
  control").
- The `netaudio flow` multicast feature is CLI-backed and slower/less
  reliable than everything else in the app by design — see the Flows page's
  own caveat text, and the scheduled reminder about upstreaming a proper
  `/flow` relay endpoint.
