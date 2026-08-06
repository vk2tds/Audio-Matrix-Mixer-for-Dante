// Mixer panel: a grid of buttons, each either applying a saved mixer
// snapshot (press-to-apply only — no reverse, see MIXER_PANEL_SPEC.md §4)
// or showing a live VU meter for one channel or a stereo pair. Separate
// from the routing Panel's grid entirely — these buttons never touch Dante
// routing, and vice versa.
//
// VU meter data is currently a client-side placeholder (a fake random-walk
// level per channel) since DanteMixer doesn't have a running meters stream
// yet — see wireVuPlaceholder() below, clearly marked as the thing to swap
// for the real /api/mixer/meters SSE feed once DanteMixer exists.

let panelData = { cols: 8, rows: 4, buttons: [] };
let allSnapshots = [];
let editMode = false;
let editingButtonId = null;
let pendingAddCell = null;

// button id -> { fills: [el, ...] } populated fresh each renderGrid(), so
// the placeholder animation can update levels without a full re-render.
let vuElements = new Map();

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
    vuElements.set(btn.id, { fills });
  } else {
    const snapshot = allSnapshots.find((s) => s.id === btn.snapshot_id);
    const missing = !snapshot;

    el.className = "panel-button";
    if (missing) el.classList.add("panel-button-missing");

    const color = btn.color;
    if (color && !missing) {
      el.style.borderColor = color;
    }

    const label = btn.label || (snapshot ? snapshot.name : "(missing snapshot)");
    el.innerHTML = `${iconMarkup(btn.icon)}<span>${escapeHtml(label)}</span>`;

    if (!editMode && !missing) {
      el.addEventListener("click", () => pressSnapshotButton(btn, el));
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
  const grid = document.getElementById("mp-grid");
  grid.innerHTML = "";
  grid.style.gridTemplateColumns = `repeat(${panelData.cols}, minmax(70px, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${panelData.rows}, 70px)`;

  vuElements = new Map();
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

// --- VU placeholder (swap for real SSE data once DanteMixer exists) -------

function wireVuPlaceholder() {
  const phase = new Map(); // button id -> per-channel phase, for a smooth fake wander
  setInterval(() => {
    for (const [id, { fills }] of vuElements) {
      if (!phase.has(id)) phase.set(id, fills.map(() => Math.random() * Math.PI * 2));
      const phases = phase.get(id);
      fills.forEach((fill, i) => {
        phases[i] += 0.15 + Math.random() * 0.1;
        const level = Math.max(0, Math.min(100, 40 + Math.sin(phases[i]) * 35 + Math.random() * 10));
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
  }, 120);
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
  document.getElementById("mp-dialog-snapshot-row").style.display = type === "snapshot" ? "flex" : "none";
  document.getElementById("mp-dialog-vu-rows").style.display = type === "vu" ? "block" : "none";
  document.getElementById("mp-dialog-icon-row").style.display = type === "snapshot" ? "flex" : "none";
  syncVuChannelCount();
}

function syncVuChannelCount() {
  const stereo = document.getElementById("mp-dialog-vu-count").value === "2";
  document.getElementById("mp-dialog-vu-row2").style.display = stereo ? "flex" : "none";
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
  document.getElementById("mp-dialog-vu-count").value = "1";
  document.getElementById("mp-dialog-vu-bus1").value = "";
  document.getElementById("mp-dialog-vu-slot1").value = "";
  document.getElementById("mp-dialog-vu-bus2").value = "";
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

  if (btn.type === "vu") {
    const channels = btn.channels || [];
    document.getElementById("mp-dialog-vu-count").value = String(channels.length === 2 ? 2 : 1);
    document.getElementById("mp-dialog-vu-bus1").value = (channels[0] && channels[0].bus_id) || "";
    document.getElementById("mp-dialog-vu-slot1").value = channels[0] && channels[0].slot != null ? String(channels[0].slot) : "";
    document.getElementById("mp-dialog-vu-bus2").value = (channels[1] && channels[1].bus_id) || "";
    document.getElementById("mp-dialog-vu-slot2").value = channels[1] && channels[1].slot != null ? String(channels[1].slot) : "";
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
  } else {
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
  document.getElementById("mp-dialog-vu-count").addEventListener("change", syncVuChannelCount);
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

  try {
    await Promise.all([loadPanel(), loadSnapshots()]);
    renderGrid();
  } catch (err) {
    showToast(err.message, true);
  }

  wireVuPlaceholder();
});
