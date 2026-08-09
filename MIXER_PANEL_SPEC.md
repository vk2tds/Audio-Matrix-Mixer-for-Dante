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
   same as every other feature in this app so far. **Done.**
2. Mixer Panel grid + snapshot-type buttons (biggest visible chunk, reuses
   the most existing code). **Done.**
3. Mixer Snapshots page (save/rename/delete/combine). **Done** — plus
   editing an existing snapshot in place (not in the original spec, added
   2026-08-07 once real usage surfaced the need), and a bus-id dropdown
   (bus1-bus8) instead of free text, after a real user snapshot targeted a
   typo'd bus id ("ABC") that could never have applied.
4. Mixer Console (live adjustment) — **done, 2026-08-07**, once DanteMixer's
   real control API existed (SPEC.md §6 fully implemented — see the sibling
   repo's STATUS.md milestones 3/5). New page `/mixer-console`: per-bus tabs,
   assign a real input device+channel to a slot, route the bus's output to
   a device, adjust every level/mute — all direct pass-through to the
   engine via new `/api/mixer/mixers/...` routes in `dante_web_app.py`
   (`_mixer_console_call` mirrors the existing generic `proxy()` helper's
   activity-logging pattern, just against `mixer_client` instead of the
   netaudio relay).
5. VU button type + SSE meter wiring — **done, 2026-08-07**, once
   DanteMixer's real `/meters/stream` existed (see its STATUS.md milestone
   4). Both the Mixer Console's inline VU bars and the Mixer Panel's VU
   tiles (`buildVuMeter`) now read real `peakDb` from the SSE stream instead
   of the placeholder fake random-walk animation (`wireVuPlaceholder`,
   removed). `/api/mixer/meters/start` and `/stop` proxy routes added
   alongside the SSE stream proxy that already existed.
6. Stereo slots — **done, 2026-08-09**, matching the engine's stereo
   upgrade (see the sibling repo's STATUS.md). Mixer Console's input rows
   gained a "Right (blank = mono)" channel selector next to the existing
   one (now labeled "Left/Mono"); the per-slot VU bar renders 1 sub-bar
   for a mono slot or 2 stacked sub-bars for a true stereo one. The Mixer
   Panel's VU tile `channels` mechanism (up to 2 independent `{bus_id,
   slot}` references per tile) is unchanged and still only shows each
   referenced slot's left/primary channel — showing a single slot's real
   L+R pair on one Panel tile isn't wired up yet, tracked as a follow-up
   if it turns out to matter in practice.
7. Button-model redesign — **done, 2026-08-09**. Two new button types
   (`mute_input`, `mute_output` — live toggles on a bus slot's or output's
   mute, always reflecting real mixer state, not local memory) plus three
   new fields on `snapshot` buttons: `press_mode` (`press` unchanged
   default, `toggle`, or `momentary`), `deselect_action` (`none` or
   `zero` — resets every channel the snapshot set a level on back to
   0dB), and `group` (a plain string — buttons sharing one are mutually
   exclusive, selecting one deselects any other currently-selected
   member first). Toggle/momentary "on" state is tracked locally per
   browser tab, the same pattern the routing Panel already uses for its
   own press/reverse toggle. No backend changes needed — mute toggling
   and the zero-deselect action both reuse the existing Mixer Console
   routes directly. Richer design-time named radio groups (vs. this
   simple per-button group-ID version) explicitly deferred to a later
   pass.
8. Mixer Meters (VU overview) — **done, 2026-08-09**. New `/mixer-meters`
   page shows every physical input channel currently in use by any bus,
   plus all 8 bus outputs, on one page — no per-slot resolution needed
   at all, since the engine's `/meters` SSE `inputs` array is already
   deduplicated per physical channel and `buses` always has all 8
   entries. Reuses the netaudio Metering page's `.meter-channel` card
   styling for visual consistency.

9. Dynamic bus/slot dropdowns — **done, 2026-08-09**, once the sibling
   engine repo made bus/slot count runtime-configurable
   (`DANTEMIXER_BUS_COUNT`/`DANTEMIXER_SLOT_COUNT`, see its STATUS.md).
   Mixer Console, Mixer Snapshots' action-row builder, and Mixer Panel's
   VU/Mute dialogs all previously hardcoded bus1-8/Input1-8 option lists
   (item 3's bus-id dropdown fix included) — all three now derive their
   dropdowns from live fetched mixer state, with the slot dropdown
   rebuilding whenever the selected bus changes (slot count can differ
   per bus). Falls back to a bus1-8 guess only if the daemon is
   unreachable, matching the existing degradation pattern used elsewhere.

## 10. Named radio groups — **done, 2026-08-09**

Item 7's radio groups originally shipped as a plain string `group` field
on each button — buttons sharing a non-empty value were mutually
exclusive, with no separate concept to manage. This section was the
design for a richer version; kept below (mostly) as written, now with
notes on what was actually built vs. adjusted along the way.

**What's missing today**: a group only exists implicitly, as whatever
string happens to appear on two or more buttons. There's no name, no
list of a group's members to review, no rename, no way to see "which
buttons are in this group" without opening each one's edit dialog and
checking its `group` field. Typos silently create a new group instead of
joining an existing one (the same class of problem the bus-id free-text
field had before it became a dropdown — see item 3's fix and its
motivating incident).

**Proposed data model** — a `radio_groups` array alongside `buttons` in
`mixer_panel.json`:
```
{
  "cols": 8, "rows": 4,
  "buttons": [...],           # unchanged shape, but "group" becomes a
                               # radio_groups[].id reference, not a free
                               # string
  "radio_groups": [
    {"id": "<uuid>", "name": "Scene select"}
  ]
}
```
Migration for existing data: any button with a non-empty legacy `group`
string that doesn't match a `radio_groups[].id` gets a synthesized entry
(`id` = the string itself, `name` = the string) created on first load —
existing panels keep working with no manual migration step, they just
get an unnamed-in-the-UI-sense group that displays its old string as the
name until renamed.

**UI — built as designed, with one deliberate simplification**:
- A "Manage groups" button next to "Manage snapshots" in the Mixer Panel
  page's toolbar opens an in-page dialog (`#mp-groups-dialog`, same
  `.panel`/`save-dialog-row` shell used elsewhere on this page) listing
  each group by name with its member count and Rename/Delete actions,
  plus an "Add group" row at the top. This is a lighter-weight modal
  than Mixer Snapshots' full list page — groups only need name + member
  count + rename/delete, not combine/detail-view/checkboxes, so a modal
  covers the same functional ground (list, rename, delete, see member
  count) without a new route/template. Rename/delete use `prompt()`/
  `confirm()`, matching the existing pattern in `mixer_snapshots.js`.
- The button edit dialog's "Radio group" field is a `<select>`
  (`populateGroupSelect` in `mixer_panel.js`) populated from
  `panelData.radio_groups`, plus "None" and a "+ New group…" option that
  prompts for a name, POSTs it, and auto-selects the new group — same fix
  pattern as the bus-id dropdown.
- Deleting a group clears `group` back to null on every button that
  referenced it, server-side in `mixer_panel_store.delete_radio_group`
  (not relying on the client to re-save the button list) — verified live:
  deleting a group with a real member button left that button's `group`
  field `null` in the persisted `mixer_panel.json` immediately.

**What doesn't change**: `deselectGroupSiblings`'s actual logic (iterate
`panelData.buttons`, find others with the same group value, apply their
`deselect_action`) — that mechanism was already correct and doesn't care
whether `group` holds a free string or a `radio_groups[].id`; only the
*authoring* experience (naming, listing, avoiding typos) improved.

**Migration**: `mixer_panel_store._migrate_legacy_groups` runs on every
load — any button's legacy free-string `group` that isn't a known
`radio_groups[].id` gets a synthesized `{id: group, name: group}` entry,
persisted immediately so it shows up in "Manage groups" from then on. No
manual migration step, and idempotent (a no-op once every group has a
real entry).
