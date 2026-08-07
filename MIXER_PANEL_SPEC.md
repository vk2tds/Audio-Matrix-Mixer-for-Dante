# Mixer GUI — spec (draft)

New Dante-web feature for controlling **DanteMixer** (the separate Swift
mixer app, see its `SPEC.md`) — live adjustment, saving mixer states as
buttons, and VU metering. Deliberately separate from the existing **Panel**
page, which is routing presets only. Mixer buttons never touch Dante
routing (subscribe/unsubscribe); Panel buttons never touch mixer volumes.
They can sit side by side, but are not the same grid or the same data.

## 1. Why three pages, not one

This mirrors a pattern already proven in this app for routing — Routing
(live matrix) → Presets (save/recall/combine) → Panel (buttons for
presets) — applied to mixer volumes instead of routing actions:

| Existing (routing) | New (mixer) | Purpose |
|---|---|---|
| Routing | **Mixer Console** | Live, hands-on adjustment |
| Presets | **Mixer Snapshots** | Save/recall/combine named states |
| Panel | **Mixer Panel** | Buttons that recall snapshots + VU tiles |

"Configure mixers live" = Mixer Console. "Save one or more mixers with
volumes to a button" + "combine buttons into a new button" = Mixer Snapshots
feeding Mixer Panel buttons, exactly like Presets feeding Panel buttons
today.

## 2. Relationship to DanteMixer

Dante-web proxies to DanteMixer's Web API (per the sibling
[RealTime-MacOS-Audio-Mixer](https://github.com/vk2tds/RealTime-MacOS-Audio-Mixer)
repo's `SPEC.md` §6-7) the same way it already proxies to `netaudio`'s
relay — a thin `mixer_client.py` mirroring `netaudio_client.py`. Until
DanteMixer actually has a running Web API, these pages should behave like
existing pages do when their daemon is unreachable (a clear "mixer daemon
unreachable" state, not an ambiguous error) — this app already has that
pattern built in, so the GUI work isn't blocked on DanteMixer being
finished.

## 3. Data model

**MixerSnapshot** (`mixer_snapshots.json`, mirrors `presets_store.py`):
```
id, name, created_at, updated_at
actions: [{bus_id, slot, level_db, muted}]
```
`slot` is `null` for the bus's own output, or `0-7` for a specific input
slot. `level_db` and `muted` are each independently nullable — a snapshot
only touches the parameters it actually lists, same principle as routing
presets ("applying a preset only touches the channels it lists").

**MixerButton** (`mixer_panel.json`, mirrors `panel_store.py`):
```
id, row, col, w, h, type ("snapshot" | "vu")

# type == "snapshot"
snapshot_id, label, icon, color   # reuses Panel's existing icon/color UI as-is

# type == "vu"
channels: [{bus_id, slot}]        # 1 entry = single channel, 2 = stereo pair
label, color
```
VU orientation is **not stored** — derived at render time from the button's
`w`/`h`: vertical if `h >= w` (square or taller-than-wide), horizontal
otherwise. Matches "vertical if square or higher than wide, else wide."

## 4. Reverse ("unclick") — RESOLVED: not in v1

Panel's routing-preset buttons press-to-apply, press-again-to-reverse.
**Confirmed: mixer snapshot buttons are press-to-apply only in v1** — no
unclick/reverse behavior. Revisit in v2. `/api/mixer-panel/press/<id>` needs
no "on" state to track, unlike `/api/panel/press/<pid>` — simpler than the
routing equivalent.

## 5. Backend routes (new)

| Route | Mirrors |
|---|---|
| `GET/POST /api/mixer/snapshots`, `/api/mixer/snapshots/<id>/apply` | `/api/presets` |
| `GET/POST /api/mixer-panel`, `POST /api/mixer-panel/press/<snapshot_id>` | `/api/panel` |
| `GET /api/mixer/console` (live bus/input state) | — |
| `PUT /api/mixer/console/...` (live level/mute changes) | — |
| `GET /api/mixer/meters` (SSE, proxies DanteMixer's `/meters/stream`) | `/api/events` |

## 6. Frontend reuse vs. new

**Reused as-is** from Panel: grid CSS/layout engine, drag-to-move, edit-mode
toggle, icon picker (Font Awesome, both tiers), color picker, add/edit
dialog shell.

**New**: the `vu` button type and its renderer (live SSE-driven bar/needle,
orientation-aware), the Mixer Console page (fader/mute grid for 8 buses × 8
inputs), Mixer Snapshots page (save/rename/delete/combine — combine reuses
the exact merge semantics already in Presets: check multiple, later-checked
wins on conflicts).

## 7. Nav

Three new top-level entries: **Mixer** (console), **Mixer Snapshots**,
**Mixer Panel** — placed together, visually grouped/separated from the
existing routing-focused nav items.

## 8. Suggested build order

1. Data stores + backend routes (`mixer_snapshots_store.py`,
   `mixer_panel_store.py`, routes) — testable via `curl` before any UI,
   same as every other feature in this app so far.
2. Mixer Panel grid + snapshot-type buttons (biggest visible chunk, reuses
   the most existing code).
3. Mixer Snapshots page (save/rename/delete/combine).
4. Mixer Console (live adjustment) — needs DanteMixer's real control API to
   be genuinely useful, so this is the piece most worth deferring until
   DanteMixer Milestone 1+ lands.
5. VU button type + SSE meter wiring — also needs DanteMixer's real
   `/meters/stream` to show real data, but the button/orientation UI can be
   built and tested with fake/static levels first.
