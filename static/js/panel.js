// Preset control panel: a grid of buttons, each optionally pointing at a
// saved routing preset. Pressing a preset button applies its preset;
// pressing again reverses it. Label buttons are static text, not clickable.
//
// Two independent "lit" signals are combined when rendering a preset button:
//   - explicitly pressed (local, this browser tab's press/reverse toggles)
//   - rule-match (live): every one of the preset's actions currently holds
//     true against the live device/subscription state, whether or not
//     anyone pressed the button. Recomputed on every live device update.
// Pressed wins visually (full lit); an unpressed rule-match shows half-lit.

let panelData = { cols: 8, rows: 4, buttons: [] };
let allPresets = [];
const presetDetailCache = new Map(); // preset_id -> full preset (with actions)
let editMode = false;
const pressedPresetIds = new Set();
let ruleMatchedPresetIds = new Set();
let liveDevices = {};
let editingButtonId = null; // set when the dialog is editing, not adding
let pendingAddCell = null; // {row, col} when the dialog is adding

function newId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

async function loadPanel() {
  panelData = await api("GET", "/api/panel");
  document.getElementById("panel-cols").value = panelData.cols;
  document.getElementById("panel-rows").value = panelData.rows;
}

async function loadPresets() {
  allPresets = await api("GET", "/api/presets");
}

async function ensurePresetDetail(pid) {
  if (presetDetailCache.has(pid)) return presetDetailCache.get(pid);
  try {
    const detail = await api("GET", `/api/presets/${pid}`);
    presetDetailCache.set(pid, detail);
    return detail;
  } catch {
    return null;
  }
}

async function persistPanel() {
  await api("POST", "/api/panel", { cols: panelData.cols, rows: panelData.rows, buttons: panelData.buttons });
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

// --- live rule-matching -------------------------------------------------

function actionHoldsLive(action, devices) {
  const rxDevice = Object.values(devices).find((d) => (d.name || d.server_name) === action.rx_device);
  if (!rxDevice) return false;
  const sub = (rxDevice.subscriptions || []).find((s) => s.rx_channel === action.rx_channel_label);
  if (action.action === "add") {
    return Boolean(sub && sub.tx_device === action.tx_device && sub.tx_channel === action.tx_channel_label);
  }
  // "remove": the rules is met only if that crosspoint is genuinely disconnected.
  return !sub || !sub.tx_device;
}

function presetMeetsRules(preset, devices) {
  if (!preset || !preset.actions || preset.actions.length === 0) return false;
  return preset.actions.every((action) => actionHoldsLive(action, devices));
}

async function recomputeRuleMatches() {
  const presetIds = new Set(
    panelData.buttons.filter((b) => b.type !== "label" && b.preset_id).map((b) => b.preset_id)
  );
  await Promise.all([...presetIds].map(ensurePresetDetail));

  const matched = new Set();
  for (const pid of presetIds) {
    const preset = presetDetailCache.get(pid);
    if (preset && presetMeetsRules(preset, liveDevices)) matched.add(pid);
  }
  ruleMatchedPresetIds = matched;
  renderGrid();
}

// --- rendering ------------------------------------------------------------

function iconMarkup(iconClass) {
  return iconClass ? `<i class="${iconClass}"></i>` : "";
}

function buildPanelButton(btn) {
  const el = document.createElement("div");
  el.style.gridColumn = `${btn.col + 1} / span ${btn.w}`;
  el.style.gridRow = `${btn.row + 1} / span ${btn.h}`;

  if (btn.type === "label") {
    el.className = "panel-button panel-button-label";
    el.innerHTML = `${iconMarkup(btn.icon)}<span>${escapeHtml(btn.label || "")}</span>`;
    if (btn.color) {
      el.style.color = btn.color;
    }
  } else {
    const preset = presetDetailCache.get(btn.preset_id) || allPresets.find((p) => p.id === btn.preset_id);
    const missing = !preset;
    const pressed = pressedPresetIds.has(btn.preset_id);
    const ruleMatched = !pressed && ruleMatchedPresetIds.has(btn.preset_id);

    el.className = "panel-button";
    if (missing) el.classList.add("panel-button-missing");
    if (pressed) el.classList.add("panel-button-lit");
    if (ruleMatched) el.classList.add("panel-button-half-lit");

    const color = btn.color;
    if (color && !missing) {
      if (pressed) {
        el.style.background = color;
        el.style.borderColor = color;
        el.style.color = bestTextColor(color);
      } else if (ruleMatched) {
        el.style.background = colorMixWithPanel(color, 0.5);
        el.style.borderColor = color;
      } else {
        el.style.borderColor = color;
      }
    }

    const label = btn.label || (preset ? preset.name : "(missing preset)");
    el.innerHTML = `${iconMarkup(btn.icon)}<span>${escapeHtml(label)}</span>`;

    if (btn.readonly) {
      el.classList.add("panel-button-readonly");
      el.title = "Read-only — lights up automatically, not clickable";
    }

    if (!editMode && !missing && !btn.readonly) {
      el.addEventListener("click", () => pressPanelButton(btn));
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
  const grid = document.getElementById("panel-grid");
  grid.innerHTML = "";
  grid.style.gridTemplateColumns = `repeat(${panelData.cols}, minmax(70px, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${panelData.rows}, 70px)`;

  const occupancy = buildOccupancy();
  const rendered = new Set();

  for (const btn of panelData.buttons) {
    grid.appendChild(buildPanelButton(btn));
    rendered.add(btn.id);
  }

  if (editMode) {
    for (let r = 0; r < panelData.rows; r++) {
      for (let c = 0; c < panelData.cols; c++) {
        if (!occupancy[r][c]) grid.appendChild(buildEmptyCell(r, c));
      }
    }
  }

  document.getElementById("panel-empty-hint").style.display = panelData.buttons.length === 0 && !editMode ? "block" : "none";
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

function colorMixWithPanel(hex, ratio) {
  if (window.CSS && CSS.supports && CSS.supports("background", `color-mix(in srgb, ${hex} 50%, transparent)`)) {
    return `color-mix(in srgb, ${hex} ${Math.round(ratio * 100)}%, var(--panel-alt))`;
  }
  return hex;
}

// --- press / reverse --------------------------------------------------------

async function pressPanelButton(btn) {
  const turnOn = !pressedPresetIds.has(btn.preset_id);
  try {
    const result = await api("POST", `/api/panel/press/${btn.preset_id}`, { on: turnOn });
    if (turnOn) {
      pressedPresetIds.add(btn.preset_id);
    } else {
      pressedPresetIds.delete(btn.preset_id);
    }
    if (result.applied < result.total) {
      showToast(`${result.applied}/${result.total} action(s) applied`, true);
    }
    renderGrid();
  } catch (err) {
    showToast(err.message, true);
  }
}

// --- edit dialog --------------------------------------------------------

function populatePresetSelect() {
  const select = document.getElementById("panel-dialog-preset");
  select.innerHTML = allPresets.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
}

function setDialogIcon(iconClass) {
  document.getElementById("panel-dialog-icon-preview").innerHTML = iconMarkup(iconClass);
  document.getElementById("panel-dialog-icon-preview").dataset.icon = iconClass || "";
  const prefix = (iconClass || "").split(" ")[0];
  const style = Object.entries(FA_STYLE_PREFIX).find(([, p]) => p === prefix);
  if (style) document.getElementById("panel-icon-style").value = style[0];
}

function openAddDialog(row, col) {
  editingButtonId = null;
  pendingAddCell = { row, col };
  document.getElementById("panel-button-dialog-hint").textContent = "Add button";
  document.getElementById("panel-dialog-delete-btn").style.display = "none";
  document.getElementById("panel-dialog-type").value = "preset";
  document.getElementById("panel-dialog-text").value = "";
  document.getElementById("panel-dialog-w").value = "1";
  document.getElementById("panel-dialog-h").value = "1";
  document.getElementById("panel-dialog-color-enabled").checked = false;
  document.getElementById("panel-dialog-color").value = "#2563eb";
  document.getElementById("panel-dialog-readonly").checked = false;
  setDialogIcon(null);
  populatePresetSelect();
  syncDialogTypeVisibility();
  document.getElementById("panel-icon-picker-wrap").style.display = "none";
  document.getElementById("panel-button-dialog").style.display = "block";
}

function openEditDialog(btn) {
  editingButtonId = btn.id;
  pendingAddCell = null;
  document.getElementById("panel-button-dialog-hint").textContent = "Edit button";
  document.getElementById("panel-dialog-delete-btn").style.display = "inline-block";
  document.getElementById("panel-dialog-type").value = btn.type || "preset";
  populatePresetSelect();
  if (btn.type !== "label" && btn.preset_id) {
    document.getElementById("panel-dialog-preset").value = btn.preset_id;
  }
  document.getElementById("panel-dialog-text").value = btn.label || "";
  document.getElementById("panel-dialog-w").value = String(btn.w);
  document.getElementById("panel-dialog-h").value = String(btn.h);
  document.getElementById("panel-dialog-color-enabled").checked = Boolean(btn.color);
  document.getElementById("panel-dialog-color").value = btn.color || "#2563eb";
  document.getElementById("panel-dialog-readonly").checked = Boolean(btn.readonly);
  setDialogIcon(btn.icon);
  syncDialogTypeVisibility();
  document.getElementById("panel-icon-picker-wrap").style.display = "none";
  document.getElementById("panel-button-dialog").style.display = "block";
}

function closeDialog() {
  document.getElementById("panel-button-dialog").style.display = "none";
  document.getElementById("panel-icon-picker-wrap").style.display = "none";
  editingButtonId = null;
  pendingAddCell = null;
}

function syncDialogTypeVisibility() {
  const type = document.getElementById("panel-dialog-type").value;
  document.getElementById("panel-dialog-preset-row").style.display = type === "label" ? "none" : "flex";
  document.getElementById("panel-dialog-icon-row").style.display = type === "label" ? "none" : "flex";
  document.getElementById("panel-dialog-readonly-row").style.display = type === "label" ? "none" : "flex";
}

const ICON_PICKER_RENDER_CAP = 240;

function renderIconPicker() {
  const picker = document.getElementById("panel-icon-picker");
  const count = document.getElementById("panel-icon-picker-count");
  const style = document.getElementById("panel-icon-style").value;
  const query = document.getElementById("panel-icon-search").value.trim().toLowerCase();

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
      document.getElementById("panel-icon-picker-wrap").style.display = "none";
    });
  });

  count.textContent =
    matches.length > shown.length
      ? `Showing ${shown.length} of ${matches.length} — keep typing to narrow it down`
      : `${matches.length} icon${matches.length === 1 ? "" : "s"}`;
}

async function saveDialogButton() {
  const type = document.getElementById("panel-dialog-type").value;
  const w = Number(document.getElementById("panel-dialog-w").value);
  const h = Number(document.getElementById("panel-dialog-h").value);
  const text = document.getElementById("panel-dialog-text").value.trim();
  const colorEnabled = document.getElementById("panel-dialog-color-enabled").checked;
  const color = colorEnabled ? document.getElementById("panel-dialog-color").value : null;
  const icon = type === "label" ? null : (document.getElementById("panel-dialog-icon-preview").dataset.icon || null);
  const readonly = type === "label" ? false : document.getElementById("panel-dialog-readonly").checked;

  if (type === "label" && !text) {
    showToast("Label buttons need text", true);
    return;
  }

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

  const btn = {
    id: editingButtonId || newId(),
    type,
    preset_id: type === "label" ? null : document.getElementById("panel-dialog-preset").value,
    row,
    col,
    w,
    h,
    label: text || null,
    icon,
    color,
    readonly,
  };

  if (type !== "label" && !btn.preset_id) {
    showToast("Choose a preset", true);
    return;
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
    if (btn.type !== "label") await ensurePresetDetail(btn.preset_id);
    renderGrid();
    recomputeRuleMatches();
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
  const cols = Number(document.getElementById("panel-cols").value) || panelData.cols;
  const rows = Number(document.getElementById("panel-rows").value) || panelData.rows;

  const clipped = panelData.buttons.some((b) => b.row + b.h > rows || b.col + b.w > cols);
  if (clipped) {
    showToast("Can't shrink the grid — it would cut off existing buttons", true);
    document.getElementById("panel-cols").value = panelData.cols;
    document.getElementById("panel-rows").value = panelData.rows;
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
  document.getElementById("panel-edit-toggle-btn").textContent = editMode ? "Done editing" : "Edit layout";
  document.getElementById("panel-edit-toggle-btn").classList.toggle("primary", editMode);
  renderGrid();
}

// --- init -----------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  renderIconPicker();

  document.getElementById("panel-dialog-type").addEventListener("change", syncDialogTypeVisibility);
  document.getElementById("panel-dialog-icon-pick-btn").addEventListener("click", () => {
    const wrap = document.getElementById("panel-icon-picker-wrap");
    const opening = wrap.style.display === "none";
    wrap.style.display = opening ? "block" : "none";
    if (opening) renderIconPicker();
  });
  document.getElementById("panel-icon-search").addEventListener("input", renderIconPicker);
  document.getElementById("panel-icon-style").addEventListener("change", renderIconPicker);
  document.getElementById("panel-dialog-icon-clear-btn").addEventListener("click", () => setDialogIcon(null));
  document.getElementById("panel-dialog-save-btn").addEventListener("click", saveDialogButton);
  document.getElementById("panel-dialog-delete-btn").addEventListener("click", deleteDialogButton);
  document.getElementById("panel-dialog-cancel-btn").addEventListener("click", closeDialog);
  document.getElementById("panel-resize-btn").addEventListener("click", resizeGrid);
  document.getElementById("panel-edit-toggle-btn").addEventListener("click", toggleEditMode);

  try {
    await Promise.all([loadPanel(), loadPresets()]);
    await Promise.all(
      panelData.buttons.filter((b) => b.type !== "label" && b.preset_id).map((b) => ensurePresetDetail(b.preset_id))
    );
    renderGrid();
  } catch (err) {
    showToast(err.message, true);
  }

  DanteStore.subscribe((devices) => {
    liveDevices = devices;
    recomputeRuleMatches();
  });
});
