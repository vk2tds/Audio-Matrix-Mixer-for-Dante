// Mixer panel: a grid of buttons. Four types now:
//   - snapshot: applies a saved mixer snapshot. press_mode controls the
//     interaction — "press" (default, one-shot, no reverse, see
//     MIXER_PANEL_SPEC.md §4), "toggle" (press to apply, press again to
//     deselect), or "momentary" (applied only while held). Toggle/momentary
//     buttons carry a deselect_action ("none" or "zero" — zero sets every
//     channel the snapshot touched a level_db on back to 0dB) and an
//     optional radio `group` — selecting one button in a group deselects
//     any other currently-selected member of the same group first.
//   - mute_input / mute_output: a live toggle on one bus's input slot or
//     output mute, reflecting real mixer state (not local-only, unlike
//     snapshot toggle state — see isMuteButtonLit).
//   - vu: a live VU meter for one channel or a stereo pair.
// Separate from the routing Panel's grid entirely — these buttons never
// touch Dante routing, and vice versa.
//
// Toggle/momentary "on" state for snapshot buttons is tracked locally per
// browser tab (pressedButtonIds), the same design the routing Panel already
// uses for its own press/reverse toggle — resets on reload, deliberately
// not derived from live state (unlike mute buttons, which always reflect
// the mixer engine's real mute flags since those can change from anywhere:
// the Console, another tab, etc).
//
// VU meter data comes from the mixer engine's real /meters SSE stream —
// see wireVuMeters() below.

let panelData = { cols: 8, rows: 4, buttons: [] };
let allSnapshots = [];
const snapshotDetailCache = new Map(); // snapshot_id -> full snapshot (with actions)
let editMode = false;
let editingButtonId = null;
let pendingAddCell = null;

// button id -> { fills: [el, ...] } populated fresh each renderGrid(), so
// the placeholder animation can update levels without a full re-render.
let vuElements = new Map();

// button id -> its DOM element, populated fresh each renderGrid() — used to
// toggle lit state on OTHER buttons (radio-group deselect, mute refresh)
// without a full re-render.
let buttonEls = new Map();

let pressedButtonIds = new Set(); // toggle/momentary snapshot buttons currently "on" (local, this tab)
let heldMomentary = null; // {btn} for whichever momentary button is currently held down, or null

function newId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function bestTextColor(hex) {
  const c = hex.replace("#", "");
  if (c.length !== 6) return "#fff";
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#111" : "#fff";
}

async function loadPanel() {
  panelData = await api("GET", "/api/mixer-panel");
  document.getElementById("mp-cols").value = panelData.cols;
  document.getElementById("mp-rows").value = panelData.rows;
}

async function loadSnapshots() {
  allSnapshots = await api("GET", "/api/mixer/snapshots");
}

async function persistPanel() {
  await api("POST", "/api/mixer-panel", { cols: panelData.cols, rows: panelData.rows, buttons: panelData.buttons });
}

function buildOccupancy() {
  const grid = Array.from({ length: panelData.rows }, () => Array(panelData.cols).fill(null));
  for (const btn of panelData.buttons) {
    for (let r = btn.row; r < btn.row + btn.h && r < panelData.rows; r++) {
      for (let c = btn.col; c < btn.col + btn.w && c < panelData.cols; c++) {
        grid[r][c] = btn.id;
      }
    }
  }
  return grid;
}

function fitsInGrid(row, col, w, h, ignoreId) {
  if (row + h > panelData.rows || col + w > panelData.cols) return false;
  for (const btn of panelData.buttons) {
    if (btn.id === ignoreId) continue;
    const overlapRows = row < btn.row + btn.h && row + h > btn.row;
    const overlapCols = col < btn.col + btn.w && col + w > btn.col;
    if (overlapRows && overlapCols) return false;
  }
  return true;
}

// --- rendering ------------------------------------------------------------

function iconMarkup(iconClass) {
  return iconClass ? `<i class="${iconClass}"></i>` : "";
}

function buildVuMeter(btn) {
  const vertical = btn.h >= btn.w;
  const wrap = document.createElement("div");
  wrap.className = "mp-vu-meter" + (vertical ? " vertical" : " horizontal");

  const fills = [];
  for (const channel of btn.channels) {
    const track = document.createElement("div");
    track.className = "mp-vu-track";
    const fill = document.createElement("div");
    fill.className = "mp-vu-fill";
    track.appendChild(fill);
    wrap.appendChild(track);
    fills.push(fill);
  }
  return { el: wrap, fills };
}

function muteButtonLabel(btn) {
  if (btn.label) return btn.label;
  return btn.type === "mute_output" ? `Mute ${btn.bus_id} Out` : `Mute ${btn.bus_id} In${btn.slot + 1}`;
}

function isMuteButtonLit(btn) {
  const bus = mixerStates.find((b) => b.id === btn.bus_id);
  if (!bus) return false;
  if (btn.type === "mute_output") return Boolean(bus.output && bus.output.muted);
  const input = bus.inputs.find((i) => i.slot === btn.slot);
  return Boolean(input && input.muted);
}

function buildPanelButton(btn) {
  const el = document.createElement("div");
  el.style.gridColumn = `${btn.col + 1} / span ${btn.w}`;
  el.style.gridRow = `${btn.row + 1} / span ${btn.h}`;

  if (btn.type === "vu") {
    el.className = "panel-button panel-button-vu";
    const label = btn.label || "";
    const { el: meterEl, fills } = buildVuMeter(btn);
    el.appendChild(meterEl);
    if (label) {
      const labelEl = document.createElement("span");
      labelEl.className = "mp-vu-label";
      labelEl.textContent = label;
      el.appendChild(labelEl);
    }
    if (btn.color) el.style.borderColor = btn.color;
    vuElements.set(btn.id, { fills, channels: btn.channels || [] });
  } else if (btn.type === "mute_input" || btn.type === "mute_output") {
    el.className = "panel-button panel-button-mute";
    if (isMuteButtonLit(btn)) el.classList.add("panel-button-lit");
    if (btn.color) el.style.borderColor = btn.color;
    el.innerHTML = `${iconMarkup(btn.icon)}<span>${escapeHtml(muteButtonLabel(btn))}</span>`;
    if (!editMode) {
      el.addEventListener("click", () => pressMuteButton(btn, el));
    }
  } else {
    const snapshot = allSnapshots.find((s) => s.id === btn.snapshot_id);
    const missing = !snapshot;
    const pressMode = btn.press_mode || "press";

    el.className = "panel-button";
    if (missing) el.classList.add("panel-button-missing");
    if (pressMode !== "press" && pressedButtonIds.has(btn.id)) el.classList.add("panel-button-lit");

    const color = btn.color;
    if (color && !missing) {
      el.style.borderColor = color;
    }

    const label = btn.label || (snapshot ? snapshot.name : "(missing snapshot)");
    el.innerHTML = `${iconMarkup(btn.icon)}<span>${escapeHtml(label)}</span>`;

    if (!editMode && !missing) {
      if (pressMode === "momentary") {
        el.addEventListener("mousedown", () => pressMomentaryDown(btn, el));
        el.addEventListener("touchstart", (e) => {
          e.preventDefault();
          pressMomentaryDown(btn, el);
        });
      } else if (pressMode === "toggle") {
        el.addEventListener("click", () => pressToggleButton(btn, el));
      } else {
        el.addEventListener("click", () => pressSnapshotButton(btn, el));
      }
    }
  }

  if (editMode) {
    el.classList.add("panel-button-editing");
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", btn.id);
    });
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditDialog(btn);
    });
  }

  buttonEls.set(btn.id, el);
  return el;
}

async function moveButtonTo(id, row, col) {
  const btn = panelData.buttons.find((b) => b.id === id);
  if (!btn) return;
  if (btn.row === row && btn.col === col) return;
  if (!fitsInGrid(row, col, btn.w, btn.h, id)) {
    showToast("Won't fit there", true);
    return;
  }
  btn.row = row;
  btn.col = col;
  try {
    await persistPanel();
    renderGrid();
  } catch (err) {
    showToast(err.message, true);
  }
}

function buildEmptyCell(row, col) {
  const el = document.createElement("div");
  el.className = "panel-cell-empty";
  el.style.gridColumn = `${col + 1} / span 1`;
  el.style.gridRow = `${row + 1} / span 1`;
  el.textContent = "+";
  el.addEventListener("click", () => openAddDialog(row, col));
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.classList.add("panel-cell-drop-target");
  });
  el.addEventListener("dragleave", () => el.classList.remove("panel-cell-drop-target"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("panel-cell-drop-target");
    const id = e.dataTransfer.getData("text/plain");
    moveButtonTo(id, row, col);
  });
  return el;
}

function renderGrid() {
  const grid = document.getElementById("mp-grid");
  grid.innerHTML = "";
  grid.style.gridTemplateColumns = `repeat(${panelData.cols}, minmax(70px, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${panelData.rows}, 70px)`;

  vuElements = new Map();
  buttonEls = new Map();
  const occupancy = buildOccupancy();

  for (const btn of panelData.buttons) {
    grid.appendChild(buildPanelButton(btn));
  }

  if (editMode) {
    for (let r = 0; r < panelData.rows; r++) {
      for (let c = 0; c < panelData.cols; c++) {
        if (!occupancy[r][c]) grid.appendChild(buildEmptyCell(r, c));
      }
    }
  }

  document.getElementById("mp-empty-hint").style.display = panelData.buttons.length === 0 && !editMode ? "block" : "none";
}

// --- press ------------------------------------------------------------

async function pressSnapshotButton(btn, el) {
  el.classList.add("panel-button-lit");
  try {
    const result = await api("POST", `/api/mixer-panel/press/${btn.snapshot_id}`, {});
    if (result.applied < result.total) {
      showToast(`${result.applied}/${result.total} operation(s) applied`, true);
    } else {
      showToast(`Applied "${btn.label || "snapshot"}"`);
    }
  } catch (err) {
    showToast(err.message, true);
  } finally {
    setTimeout(() => el.classList.remove("panel-button-lit"), 400);
  }
}

async function ensureSnapshotDetail(sid) {
  if (snapshotDetailCache.has(sid)) return snapshotDetailCache.get(sid);
  try {
    const detail = await api("GET", `/api/mixer/snapshots/${sid}`);
    snapshotDetailCache.set(sid, detail);
    return detail;
  } catch {
    return null;
  }
}

// On deselect (toggle pressed again, momentary released, or a radio-group
// sibling taking over): "zero" sets every channel the snapshot's actions
// touched a level_db on back to 0dB. Deliberately doesn't touch mute — the
// user's ask was specifically about volume, and mute already has its own
// dedicated button type.
async function applyDeselectAction(btn) {
  if ((btn.deselect_action || "none") !== "zero") return;
  const detail = await ensureSnapshotDetail(btn.snapshot_id);
  if (!detail) return;
  for (const action of detail.actions) {
    if (action.level_db == null) continue;
    const path =
      action.slot == null
        ? `/api/mixer/mixers/${action.bus_id}/output/level`
        : `/api/mixer/mixers/${action.bus_id}/inputs/${action.slot}/level`;
    try {
      await api("PUT", path, { levelDb: 0 });
    } catch (err) {
      showToast(err.message, true);
    }
  }
}

// Deselects every OTHER currently-selected member of btn's radio group
// (if any), applying each one's deselect_action — before btn itself gets
// selected/applied by the caller.
async function deselectGroupSiblings(btn) {
  if (!btn.group) return;
  for (const other of panelData.buttons) {
    if (other.id === btn.id || other.group !== btn.group || !pressedButtonIds.has(other.id)) continue;
    await applyDeselectAction(other);
    pressedButtonIds.delete(other.id);
    const otherEl = buttonEls.get(other.id);
    if (otherEl) otherEl.classList.remove("panel-button-lit");
  }
}

async function pressToggleButton(btn, el) {
  if (pressedButtonIds.has(btn.id)) {
    await applyDeselectAction(btn);
    pressedButtonIds.delete(btn.id);
    el.classList.remove("panel-button-lit");
    showToast(`Deselected "${btn.label || "button"}"`);
    return;
  }

  await deselectGroupSiblings(btn);
  try {
    const result = await api("POST", `/api/mixer-panel/press/${btn.snapshot_id}`, {});
    pressedButtonIds.add(btn.id);
    el.classList.add("panel-button-lit");
    showToast(
      result.applied < result.total
        ? `${result.applied}/${result.total} operation(s) applied`
        : `Applied "${btn.label || "snapshot"}"`,
      result.applied < result.total
    );
  } catch (err) {
    showToast(err.message, true);
  }
}

// Only one momentary button can be genuinely "held" at a time (one mouse),
// so a single global release listener is enough — and it's the safety net
// that keeps a button from getting stuck lit if the mouseup/touchend ends
// up somewhere other than the button itself (e.g. the user drags off it
// before releasing).
async function pressMomentaryDown(btn, el) {
  if (heldMomentary) return;
  heldMomentary = { btn, el };
  await deselectGroupSiblings(btn);
  pressedButtonIds.add(btn.id);
  el.classList.add("panel-button-lit");
  try {
    await api("POST", `/api/mixer-panel/press/${btn.snapshot_id}`, {});
  } catch (err) {
    showToast(err.message, true);
  }
}

async function releaseMomentary() {
  if (!heldMomentary) return;
  const { btn, el } = heldMomentary;
  heldMomentary = null;
  pressedButtonIds.delete(btn.id);
  el.classList.remove("panel-button-lit");
  await applyDeselectAction(btn);
}

async function pressMuteButton(btn, el) {
  const currentlyMuted = isMuteButtonLit(btn);
  const path =
    btn.type === "mute_output"
      ? `/api/mixer/mixers/${btn.bus_id}/output/mute`
      : `/api/mixer/mixers/${btn.bus_id}/inputs/${btn.slot}/mute`;
  try {
    await api("PUT", path, { muted: !currentlyMuted });
    showToast(`${muteButtonLabel(btn)} ${currentlyMuted ? "unmuted" : "muted"}`);
    await refreshMixerStates();
  } catch (err) {
    showToast(err.message, true);
  }
}

// Keeps mute-button lit state (and VU tiles' channel resolution) current
// with live mixer state, which can change from anywhere — the Console,
// another browser tab, this same page's own mute presses. Called on a
// timer, not just after this page's own mutations.
async function refreshMixerStates() {
  try {
    mixerStates = await api("GET", "/api/mixer/mixers");
  } catch {
    return;
  }
  for (const btn of panelData.buttons) {
    if (btn.type !== "mute_input" && btn.type !== "mute_output") continue;
    const el = buttonEls.get(btn.id);
    if (el) el.classList.toggle("panel-button-lit", isMuteButtonLit(btn));
  }
}

// --- VU meters: live SSE data from the mixer engine ------------------------

let mixerStates = [];
let latestMeters = { inputs: [], buses: [] };

// Matches metering.js's -60..0dB -> 0..100% convention.
function dbToPercent(db) {
  if (typeof db !== "number" || Number.isNaN(db)) return 0;
  const clamped = Math.max(-60, Math.min(0, db));
  return ((clamped + 60) / 60) * 100;
}

function levelForChannel(channel) {
  if (channel.slot == null) {
    const bus = latestMeters.buses.find((b) => b.busId === channel.bus_id);
    return bus ? bus.peakDb : -96;
  }
  const bus = mixerStates.find((b) => b.id === channel.bus_id);
  const input = bus && bus.inputs.find((i) => i.slot === channel.slot);
  if (!input || !input.inputChannel) return -96;
  const meter = latestMeters.inputs.find(
    (m) => m.deviceUID === input.inputChannel.deviceUID && m.channel === input.inputChannel.channel
  );
  return meter ? meter.peakDb : -96;
}

function updateVuTiles() {
  for (const { fills, channels } of vuElements.values()) {
    fills.forEach((fill, i) => {
      const channel = channels[i];
      if (!channel) return;
      const level = dbToPercent(levelForChannel(channel));
      const vertical = fill.parentElement.parentElement.classList.contains("vertical");
      if (vertical) {
        fill.style.height = `${level}%`;
        fill.style.width = "100%";
      } else {
        fill.style.width = `${level}%`;
        fill.style.height = "100%";
      }
    });
  }
}

// Doesn't call /meters/stop on unload — see mixer_console.js's
// connectMeterStream for why (global enabled flag, other pages may still
// want it).
async function wireVuMeters() {
  try {
    mixerStates = await api("GET", "/api/mixer/mixers");
  } catch {
    mixerStates = [];
  }
  api("POST", "/api/mixer/meters/start").catch(() => {});
  const source = new EventSource("/api/mixer/meters");
  source.addEventListener("message", (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    if (data.event !== "meter_levels") return;
    latestMeters = data;
    updateVuTiles();
  });
}

// --- edit dialog --------------------------------------------------------

function populateSnapshotSelect() {
  const select = document.getElementById("mp-dialog-snapshot");
  select.innerHTML = allSnapshots.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
}

function setDialogIcon(iconClass) {
  document.getElementById("mp-dialog-icon-preview").innerHTML = iconMarkup(iconClass);
  document.getElementById("mp-dialog-icon-preview").dataset.icon = iconClass || "";
  const prefix = (iconClass || "").split(" ")[0];
  const style = Object.entries(FA_STYLE_PREFIX).find(([, p]) => p === prefix);
  if (style) document.getElementById("mp-icon-style").value = style[0];
}

function syncDialogTypeVisibility() {
  const type = document.getElementById("mp-dialog-type").value;
  const isMute = type === "mute_input" || type === "mute_output";
  document.getElementById("mp-dialog-snapshot-row").style.display = type === "snapshot" ? "flex" : "none";
  document.getElementById("mp-dialog-press-rows").style.display = type === "snapshot" ? "block" : "none";
  document.getElementById("mp-dialog-vu-rows").style.display = type === "vu" ? "block" : "none";
  document.getElementById("mp-dialog-mute-rows").style.display = isMute ? "block" : "none";
  document.getElementById("mp-dialog-mute-slot-row").style.display = type === "mute_input" ? "flex" : "none";
  document.getElementById("mp-dialog-icon-row").style.display = type === "snapshot" ? "flex" : "none";
  syncVuChannelCount();
  syncPressModeVisibility();
}

function syncPressModeVisibility() {
  const mode = document.getElementById("mp-dialog-press-mode").value;
  document.getElementById("mp-dialog-deselect-row").style.display = mode === "press" ? "none" : "flex";
  document.getElementById("mp-dialog-group-row").style.display = mode === "toggle" ? "flex" : "none";
}

function syncVuChannelCount() {
  const stereo = document.getElementById("mp-dialog-vu-count").value === "2";
  document.getElementById("mp-dialog-vu-row2").style.display = stereo ? "flex" : "none";
}

// --- dialog bus/slot dropdowns: populated from live mixerStates so they
// track whatever bus/slot count the engine is actually running (see
// RealTime-MacOS-Audio-Mixer's DANTEMIXER_BUS_COUNT/DANTEMIXER_SLOT_COUNT),
// not a hardcoded bus1-8/Input1-8 list. Falls back to a bus1-8 guess only
// if the daemon is unreachable (mixerStates still empty).

function busListForDialogs() {
  return mixerStates.length > 0 ? mixerStates.map((b) => b.id) : Array.from({ length: 8 }, (_, i) => `bus${i + 1}`);
}

function slotCountForBus(busId) {
  const bus = mixerStates.find((b) => b.id === busId);
  return bus ? bus.inputs.length : 8;
}

function populateBusSelect(select) {
  select.innerHTML = busListForDialogs()
    .map((id) => `<option value="${id}">${id}</option>`)
    .join("");
}

function populateSlotSelect(select, busId, { includeOutput } = {}) {
  const slotCount = slotCountForBus(busId);
  const outputOpt = includeOutput ? `<option value="">Output</option>` : "";
  select.innerHTML =
    outputOpt + Array.from({ length: slotCount }, (_, i) => `<option value="${i}">Input ${i + 1}</option>`).join("");
}

function wireDialogBusSlotDependency(busSelectId, slotSelectId, { includeOutput } = {}) {
  const busSelect = document.getElementById(busSelectId);
  const slotSelect = document.getElementById(slotSelectId);
  busSelect.addEventListener("change", () => populateSlotSelect(slotSelect, busSelect.value, { includeOutput }));
}

function openAddDialog(row, col) {
  editingButtonId = null;
  pendingAddCell = { row, col };
  document.getElementById("mp-dialog-hint").textContent = "Add button";
  document.getElementById("mp-dialog-delete-btn").style.display = "none";
  document.getElementById("mp-dialog-type").value = "snapshot";
  document.getElementById("mp-dialog-text").value = "";
  document.getElementById("mp-dialog-w").value = "1";
  document.getElementById("mp-dialog-h").value = "1";
  document.getElementById("mp-dialog-color-enabled").checked = false;
  document.getElementById("mp-dialog-color").value = "#2563eb";
  document.getElementById("mp-dialog-press-mode").value = "press";
  document.getElementById("mp-dialog-deselect").value = "none";
  document.getElementById("mp-dialog-group").value = "";

  const firstBus = busListForDialogs()[0] || "bus1";
  populateBusSelect(document.getElementById("mp-dialog-mute-bus"));
  document.getElementById("mp-dialog-mute-bus").value = firstBus;
  populateSlotSelect(document.getElementById("mp-dialog-mute-slot"), firstBus);
  document.getElementById("mp-dialog-mute-slot").value = "0";

  document.getElementById("mp-dialog-vu-count").value = "1";
  populateBusSelect(document.getElementById("mp-dialog-vu-bus1"));
  document.getElementById("mp-dialog-vu-bus1").value = firstBus;
  populateSlotSelect(document.getElementById("mp-dialog-vu-slot1"), firstBus, { includeOutput: true });
  document.getElementById("mp-dialog-vu-slot1").value = "";
  populateBusSelect(document.getElementById("mp-dialog-vu-bus2"));
  document.getElementById("mp-dialog-vu-bus2").value = firstBus;
  populateSlotSelect(document.getElementById("mp-dialog-vu-slot2"), firstBus, { includeOutput: true });
  document.getElementById("mp-dialog-vu-slot2").value = "";
  setDialogIcon(null);
  populateSnapshotSelect();
  syncDialogTypeVisibility();
  document.getElementById("mp-icon-picker-wrap").style.display = "none";
  document.getElementById("mp-dialog").style.display = "block";
}

function openEditDialog(btn) {
  editingButtonId = btn.id;
  pendingAddCell = null;
  document.getElementById("mp-dialog-hint").textContent = "Edit button";
  document.getElementById("mp-dialog-delete-btn").style.display = "inline-block";
  document.getElementById("mp-dialog-type").value = btn.type || "snapshot";
  populateSnapshotSelect();
  if (btn.type === "snapshot" && btn.snapshot_id) {
    document.getElementById("mp-dialog-snapshot").value = btn.snapshot_id;
  }
  document.getElementById("mp-dialog-text").value = btn.label || "";
  document.getElementById("mp-dialog-w").value = String(btn.w);
  document.getElementById("mp-dialog-h").value = String(btn.h);
  document.getElementById("mp-dialog-color-enabled").checked = Boolean(btn.color);
  document.getElementById("mp-dialog-color").value = btn.color || "#2563eb";
  setDialogIcon(btn.icon);

  document.getElementById("mp-dialog-press-mode").value = btn.press_mode || "press";
  document.getElementById("mp-dialog-deselect").value = btn.deselect_action || "none";
  document.getElementById("mp-dialog-group").value = btn.group || "";

  if (btn.type === "vu") {
    const channels = btn.channels || [];
    const bus1 = (channels[0] && channels[0].bus_id) || busListForDialogs()[0] || "bus1";
    const bus2 = (channels[1] && channels[1].bus_id) || bus1;
    document.getElementById("mp-dialog-vu-count").value = String(channels.length === 2 ? 2 : 1);
    populateBusSelect(document.getElementById("mp-dialog-vu-bus1"));
    document.getElementById("mp-dialog-vu-bus1").value = bus1;
    populateSlotSelect(document.getElementById("mp-dialog-vu-slot1"), bus1, { includeOutput: true });
    document.getElementById("mp-dialog-vu-slot1").value = channels[0] && channels[0].slot != null ? String(channels[0].slot) : "";
    populateBusSelect(document.getElementById("mp-dialog-vu-bus2"));
    document.getElementById("mp-dialog-vu-bus2").value = bus2;
    populateSlotSelect(document.getElementById("mp-dialog-vu-slot2"), bus2, { includeOutput: true });
    document.getElementById("mp-dialog-vu-slot2").value = channels[1] && channels[1].slot != null ? String(channels[1].slot) : "";
  }

  if (btn.type === "mute_input" || btn.type === "mute_output") {
    const busId = btn.bus_id || busListForDialogs()[0] || "bus1";
    populateBusSelect(document.getElementById("mp-dialog-mute-bus"));
    document.getElementById("mp-dialog-mute-bus").value = busId;
    populateSlotSelect(document.getElementById("mp-dialog-mute-slot"), busId);
    document.getElementById("mp-dialog-mute-slot").value = btn.slot != null ? String(btn.slot) : "0";
  }

  syncDialogTypeVisibility();
  document.getElementById("mp-icon-picker-wrap").style.display = "none";
  document.getElementById("mp-dialog").style.display = "block";
}

function closeDialog() {
  document.getElementById("mp-dialog").style.display = "none";
  document.getElementById("mp-icon-picker-wrap").style.display = "none";
  editingButtonId = null;
  pendingAddCell = null;
}

const ICON_PICKER_RENDER_CAP = 240;

function populateIconStyleSelect() {
  const available = new Set();
  for (const icon of FA_ICONS) {
    for (const s of icon.s) available.add(s);
  }
  const order = ["solid", "regular", "light", "duotone", "brands"];
  const styles = order.filter((s) => available.has(s));
  const select = document.getElementById("mp-icon-style");
  select.innerHTML = styles.map((s) => `<option value="${s}">${FA_STYLE_LABELS[s]}</option>`).join("");
}

function renderIconPicker() {
  const picker = document.getElementById("mp-icon-picker");
  const count = document.getElementById("mp-icon-picker-count");
  const style = document.getElementById("mp-icon-style").value;
  const query = document.getElementById("mp-icon-search").value.trim().toLowerCase();

  const matches = FA_ICONS.filter((icon) => {
    if (!icon.s.includes(style)) return false;
    if (!query) return true;
    if (icon.n.includes(query) || icon.l.toLowerCase().includes(query)) return true;
    return icon.t.some((term) => String(term).toLowerCase().includes(query));
  });

  const shown = matches.slice(0, ICON_PICKER_RENDER_CAP);
  picker.innerHTML = shown
    .map((icon) => {
      const cls = faIconClass(style, icon.n);
      return `<button type="button" class="panel-icon-choice" data-icon="${cls}" title="${escapeHtml(icon.l)}"><i class="${cls}"></i></button>`;
    })
    .join("");
  picker.querySelectorAll(".panel-icon-choice").forEach((el) => {
    el.addEventListener("click", () => {
      setDialogIcon(el.dataset.icon);
      document.getElementById("mp-icon-picker-wrap").style.display = "none";
    });
  });

  count.textContent =
    matches.length > shown.length
      ? `Showing ${shown.length} of ${matches.length} — keep typing to narrow it down`
      : `${matches.length} icon${matches.length === 1 ? "" : "s"}`;
}

async function saveDialogButton() {
  const type = document.getElementById("mp-dialog-type").value;
  const w = Number(document.getElementById("mp-dialog-w").value);
  const h = Number(document.getElementById("mp-dialog-h").value);
  const text = document.getElementById("mp-dialog-text").value.trim();
  const colorEnabled = document.getElementById("mp-dialog-color-enabled").checked;
  const color = colorEnabled ? document.getElementById("mp-dialog-color").value : null;
  const icon = type === "snapshot" ? (document.getElementById("mp-dialog-icon-preview").dataset.icon || null) : null;

  let row, col;
  if (editingButtonId) {
    const existing = panelData.buttons.find((b) => b.id === editingButtonId);
    row = existing.row;
    col = existing.col;
  } else {
    row = pendingAddCell.row;
    col = pendingAddCell.col;
  }

  if (!fitsInGrid(row, col, w, h, editingButtonId)) {
    showToast("Button doesn't fit here at that size", true);
    return;
  }

  const btn = { id: editingButtonId || newId(), type, row, col, w, h, label: text || null, color };

  if (type === "snapshot") {
    btn.snapshot_id = document.getElementById("mp-dialog-snapshot").value;
    btn.icon = icon;
    if (!btn.snapshot_id) {
      showToast("Choose a snapshot", true);
      return;
    }
    btn.press_mode = document.getElementById("mp-dialog-press-mode").value;
    btn.deselect_action = btn.press_mode === "press" ? "none" : document.getElementById("mp-dialog-deselect").value;
    const group = document.getElementById("mp-dialog-group").value.trim();
    btn.group = btn.press_mode === "toggle" && group ? group : null;
  } else if (type === "vu") {
    const stereo = document.getElementById("mp-dialog-vu-count").value === "2";
    const bus1 = document.getElementById("mp-dialog-vu-bus1").value.trim();
    const slot1Raw = document.getElementById("mp-dialog-vu-slot1").value;
    if (!bus1) {
      showToast("Enter a bus id for channel 1", true);
      return;
    }
    const channels = [{ bus_id: bus1, slot: slot1Raw === "" ? null : Number(slot1Raw) }];
    if (stereo) {
      const bus2 = document.getElementById("mp-dialog-vu-bus2").value.trim();
      const slot2Raw = document.getElementById("mp-dialog-vu-slot2").value;
      if (!bus2) {
        showToast("Enter a bus id for channel 2, or switch to single channel", true);
        return;
      }
      channels.push({ bus_id: bus2, slot: slot2Raw === "" ? null : Number(slot2Raw) });
    }
    btn.channels = channels;
  } else if (type === "mute_input" || type === "mute_output") {
    btn.bus_id = document.getElementById("mp-dialog-mute-bus").value;
    if (type === "mute_input") {
      btn.slot = Number(document.getElementById("mp-dialog-mute-slot").value);
    }
  }

  if (editingButtonId) {
    const idx = panelData.buttons.findIndex((b) => b.id === editingButtonId);
    panelData.buttons[idx] = btn;
  } else {
    panelData.buttons.push(btn);
  }

  try {
    await persistPanel();
    closeDialog();
    renderGrid();
  } catch (err) {
    showToast(err.message, true);
  }
}

async function deleteDialogButton() {
  if (!editingButtonId) return;
  panelData.buttons = panelData.buttons.filter((b) => b.id !== editingButtonId);
  try {
    await persistPanel();
    closeDialog();
    renderGrid();
  } catch (err) {
    showToast(err.message, true);
  }
}

// --- resize / edit toggle -----------------------------------------------

async function resizeGrid() {
  const cols = Number(document.getElementById("mp-cols").value) || panelData.cols;
  const rows = Number(document.getElementById("mp-rows").value) || panelData.rows;

  const clipped = panelData.buttons.some((b) => b.row + b.h > rows || b.col + b.w > cols);
  if (clipped) {
    showToast("Can't shrink the grid — it would cut off existing buttons", true);
    document.getElementById("mp-cols").value = panelData.cols;
    document.getElementById("mp-rows").value = panelData.rows;
    return;
  }

  panelData.cols = cols;
  panelData.rows = rows;
  try {
    await persistPanel();
    renderGrid();
  } catch (err) {
    showToast(err.message, true);
  }
}

function toggleEditMode() {
  editMode = !editMode;
  document.getElementById("mp-edit-toggle-btn").textContent = editMode ? "Done editing" : "Edit layout";
  document.getElementById("mp-edit-toggle-btn").classList.toggle("primary", editMode);
  if (!editMode) closeDialog();
  renderGrid();
}

// --- init -----------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  populateIconStyleSelect();
  renderIconPicker();

  document.getElementById("mp-dialog-type").addEventListener("change", syncDialogTypeVisibility);
  document.getElementById("mp-dialog-press-mode").addEventListener("change", syncPressModeVisibility);
  document.getElementById("mp-dialog-vu-count").addEventListener("change", syncVuChannelCount);
  wireDialogBusSlotDependency("mp-dialog-mute-bus", "mp-dialog-mute-slot");
  wireDialogBusSlotDependency("mp-dialog-vu-bus1", "mp-dialog-vu-slot1", { includeOutput: true });
  wireDialogBusSlotDependency("mp-dialog-vu-bus2", "mp-dialog-vu-slot2", { includeOutput: true });
  document.getElementById("mp-dialog-icon-pick-btn").addEventListener("click", () => {
    const wrap = document.getElementById("mp-icon-picker-wrap");
    const opening = wrap.style.display === "none";
    wrap.style.display = opening ? "block" : "none";
    if (opening) renderIconPicker();
  });
  document.getElementById("mp-icon-search").addEventListener("input", renderIconPicker);
  document.getElementById("mp-icon-style").addEventListener("change", renderIconPicker);
  document.getElementById("mp-dialog-icon-clear-btn").addEventListener("click", () => setDialogIcon(null));
  document.getElementById("mp-dialog-save-btn").addEventListener("click", saveDialogButton);
  document.getElementById("mp-dialog-delete-btn").addEventListener("click", deleteDialogButton);
  document.getElementById("mp-dialog-cancel-btn").addEventListener("click", closeDialog);
  document.getElementById("mp-resize-btn").addEventListener("click", resizeGrid);
  document.getElementById("mp-edit-toggle-btn").addEventListener("click", toggleEditMode);

  // Global safety net for momentary buttons — see pressMomentaryDown/
  // releaseMomentary: catches the release even if the mouse/touch ends up
  // somewhere other than the button itself.
  document.addEventListener("mouseup", releaseMomentary);
  document.addEventListener("touchend", releaseMomentary);

  try {
    await Promise.all([loadPanel(), loadSnapshots()]);
    renderGrid();
  } catch (err) {
    showToast(err.message, true);
  }

  wireVuMeters();
  refreshMixerStates();
  setInterval(refreshMixerStates, 2000);
});
