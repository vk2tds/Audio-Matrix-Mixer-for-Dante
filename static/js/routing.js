const txCollapsed = new Set();
const rxCollapsed = new Set();
let txFilter = "";
let rxFilter = "";

// Recording: "live" applies every click for real as it happens; "plan" only
// ever touches this local bookkeeping, never the network. Either way,
// recordedActions is the list that gets saved as a preset. recordingBaseline
// remembers what a row's real subscription was before it was first touched
// this session, so a click that returns a row to that state can be told
// apart from a genuine change.
let recording = false;
let recordingMode = null; // "live" | "plan" | null
const recordingBaseline = new Map(); // rowKey -> {device,name,friendlyName,deviceLabelText} | null
const recordedActions = [];

function rowKey(rxDeviceKeyStr, rxNumber) {
  return `${rxDeviceKeyStr}|${rxNumber}`;
}

function getActiveSubForRow(rxDevice, rxChannelName) {
  const sub = (rxDevice.subscriptions || []).find((s) => s.rx_channel === rxChannelName && s.tx_device);
  if (!sub) return null;
  return {
    device: sub.tx_device,
    name: sub.tx_channel,
    friendlyName: sub.tx_channel,
    deviceLabelText: sub.tx_device,
  };
}

function findRowAction(rk) {
  return recordedActions.find((a) => rowKey(a.rx_device, a.rx_channel) === rk);
}

function setRowAction(rk, action) {
  const idx = recordedActions.findIndex((a) => rowKey(a.rx_device, a.rx_channel) === rk);
  if (idx !== -1) recordedActions.splice(idx, 1);
  recordedActions.push(action);
  renderRecordPanel();
}

function clearRowAction(rk) {
  const idx = recordedActions.findIndex((a) => rowKey(a.rx_device, a.rx_channel) === rk);
  if (idx !== -1) recordedActions.splice(idx, 1);
  renderRecordPanel();
}

// The row's current state as far as recording is concerned: an in-progress
// action, or the remembered baseline if the row's been touched and clicked
// back to it, or (row untouched) whatever the live data actually says.
function getEffectiveActive(rx) {
  const rk = rowKey(deviceKey(rx.device), rx.number);
  if (recording) {
    const action = findRowAction(rk);
    if (action) {
      return action.action === "add"
        ? {
            device: action.tx_device,
            name: action.tx_channel,
            friendlyName: action.tx_channel_label,
            deviceLabelText: action.tx_device_label,
          }
        : null;
    }
    if (recordingBaseline.has(rk)) {
      return recordingBaseline.get(rk);
    }
  }
  return getActiveSubForRow(rx.device, rx.name);
}

function buildGroups(devices, kind) {
  const groups = [];
  const sorted = Object.values(devices).sort((a, b) => deviceLabel(a).localeCompare(deviceLabel(b)));
  for (const device of sorted) {
    const channels = (device.channels && device.channels[kind]) || {};
    const numbers = Object.keys(channels).sort((a, b) => Number(a) - Number(b));
    if (numbers.length === 0) continue;
    const chanList = numbers.map((n) => {
      const c = channels[n] || {};
      return { number: Number(n), name: c.name, friendlyName: c.friendly_name || c.name || n };
    });
    groups.push({ device, channels: chanList });
  }
  return groups;
}

function filterGroups(groups, filterText) {
  const f = filterText.trim().toLowerCase();
  if (!f) return groups;
  const out = [];
  for (const g of groups) {
    const devMatches = deviceLabel(g.device).toLowerCase().includes(f);
    const channels = devMatches ? g.channels : g.channels.filter((c) => c.friendlyName.toLowerCase().includes(f));
    if (channels.length > 0) out.push({ device: g.device, channels });
  }
  return out;
}

function buildTxColumns(txGroups) {
  const cols = [];
  for (const g of txGroups) {
    const key = deviceKey(g.device);
    const collapsed = txCollapsed.has(key);
    cols.push({ device: g.device, isLabel: true, collapsed, channel: null });
    if (!collapsed) {
      for (const ch of g.channels) cols.push({ device: g.device, isLabel: false, collapsed: false, channel: ch });
    }
  }
  return cols;
}

function findSubscription(rxDevice, rxChannelName, txDeviceName, txChannelName) {
  const subs = rxDevice.subscriptions || [];
  return subs.find(
    (s) => s.rx_channel === rxChannelName && s.tx_device === txDeviceName && s.tx_channel === txChannelName
  );
}

// The one place that actually changes anything (or, in plan mode,
// deliberately doesn't). Shared by the matrix and the compact/mobile view
// so neither can bypass recording's rules.
async function applyDesiredForRow(rx, desired) {
  if (!recording) {
    if (desired === null) {
      await api("POST", "/api/unsubscribe", { rx_device: deviceKey(rx.device), rx_channel: rx.number });
      showToast(`Unsubscribed ${deviceLabel(rx.device)} · ${rx.friendlyName}`);
    } else {
      await api("POST", "/api/subscribe", {
        rx_device: deviceKey(rx.device),
        rx_channel: rx.number,
        tx_channel: desired.name,
        tx_device: desired.device,
      });
      showToast(`Routed ${desired.deviceLabelText} · ${desired.friendlyName} → ${deviceLabel(rx.device)} · ${rx.friendlyName}`);
    }
    return;
  }

  const rk = rowKey(deviceKey(rx.device), rx.number);
  if (!recordingBaseline.has(rk)) {
    recordingBaseline.set(rk, getEffectiveActive(rx));
  }
  const baseline = recordingBaseline.get(rk);

  const matchesBaseline =
    (desired === null && baseline === null) ||
    Boolean(desired && baseline && desired.device === baseline.device && desired.name === baseline.name);

  if (recordingMode === "live") {
    if (desired === null) {
      await api("POST", "/api/unsubscribe", { rx_device: deviceKey(rx.device), rx_channel: rx.number });
    } else {
      await api("POST", "/api/subscribe", {
        rx_device: deviceKey(rx.device),
        rx_channel: rx.number,
        tx_channel: desired.name,
        tx_device: desired.device,
      });
    }
  }

  if (matchesBaseline) {
    clearRowAction(rk);
  } else if (desired === null) {
    setRowAction(rk, {
      action: "remove",
      rx_device: deviceKey(rx.device),
      rx_device_label: deviceLabel(rx.device),
      rx_channel: rx.number,
      rx_channel_label: rx.friendlyName,
      tx_device: baseline.device,
      tx_device_label: baseline.deviceLabelText,
      tx_channel: baseline.name,
      tx_channel_label: baseline.friendlyName,
    });
  } else {
    setRowAction(rk, {
      action: "add",
      rx_device: deviceKey(rx.device),
      rx_device_label: deviceLabel(rx.device),
      rx_channel: rx.number,
      rx_channel_label: rx.friendlyName,
      tx_device: desired.device,
      tx_device_label: desired.deviceLabelText,
      tx_channel: desired.name,
      tx_channel_label: desired.friendlyName,
    });
  }
}

async function onCellClick(td, rx, tx) {
  const activeNow = getEffectiveActive(rx);
  const clickedIsActive = Boolean(activeNow && activeNow.device === deviceKey(tx.device) && activeNow.name === tx.name);
  const desired = clickedIsActive
    ? null
    : {
        device: deviceKey(tx.device),
        name: tx.name,
        friendlyName: tx.friendlyName,
        deviceLabelText: deviceLabel(tx.device),
      };

  td.classList.add("pending");
  try {
    await applyDesiredForRow(rx, desired);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    td.classList.remove("pending");
  }

  renderMatrix(DanteStore.getDevices());
  renderCompactView(DanteStore.getDevices());
}

// Explicitly record "remove whatever's on this channel" — click the row's
// label (not a specific cell) while recording. Unlike clicking a cell,
// this always records a remove, even when the row shows no connection
// right now: useful when this preset is meant to clear a channel that
// only ends up occupied because of a *different* preset applied with it.
// Click the label again to undo it.
async function toggleRowRemoval(rx) {
  if (!recording) return;

  const rk = rowKey(deviceKey(rx.device), rx.number);
  const existing = findRowAction(rk);

  if (existing && existing.action === "remove") {
    clearRowAction(rk);
    renderMatrix(DanteStore.getDevices());
    renderCompactView(DanteStore.getDevices());
    return;
  }

  if (!recordingBaseline.has(rk)) {
    recordingBaseline.set(rk, getEffectiveActive(rx));
  }
  const baseline = recordingBaseline.get(rk);

  try {
    if (recordingMode === "live") {
      await api("POST", "/api/unsubscribe", { rx_device: deviceKey(rx.device), rx_channel: rx.number });
    }
  } catch (err) {
    showToast(err.message, true);
  }

  setRowAction(rk, {
    action: "remove",
    rx_device: deviceKey(rx.device),
    rx_device_label: deviceLabel(rx.device),
    rx_channel: rx.number,
    rx_channel_label: rx.friendlyName,
    tx_device: baseline ? baseline.device : null,
    tx_device_label: baseline ? baseline.deviceLabelText : null,
    tx_channel: baseline ? baseline.name : null,
    tx_channel_label: baseline ? baseline.friendlyName : null,
  });

  renderMatrix(DanteStore.getDevices());
  renderCompactView(DanteStore.getDevices());
}

async function restoreBaselineViaApi(action) {
  if (recordingMode !== "live") return;
  const rk = rowKey(action.rx_device, action.rx_channel);
  const baseline = recordingBaseline.get(rk);
  try {
    if (!baseline) {
      await api("POST", "/api/unsubscribe", { rx_device: action.rx_device, rx_channel: action.rx_channel });
    } else {
      await api("POST", "/api/subscribe", {
        rx_device: action.rx_device,
        rx_channel: action.rx_channel,
        tx_channel: baseline.name,
        tx_device: baseline.device,
      });
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

async function revertSingleAction(action) {
  await restoreBaselineViaApi(action);
  const idx = recordedActions.indexOf(action);
  if (idx !== -1) recordedActions.splice(idx, 1);
  renderRecordPanel();
  renderMatrix(DanteStore.getDevices());
  renderCompactView(DanteStore.getDevices());
}

async function discardAllRecorded() {
  const actionsToRevert = recordedActions.slice();
  for (const action of actionsToRevert) {
    await restoreBaselineViaApi(action);
  }
  recordedActions.length = 0;
  recordingBaseline.clear();
  renderRecordPanel();
  renderMatrix(DanteStore.getDevices());
  renderCompactView(DanteStore.getDevices());
}

function makeToggle(collapsed) {
  const span = document.createElement("span");
  span.className = "collapse-toggle";
  span.textContent = collapsed ? "+" : "−";
  return span;
}

function renderMatrix(devices) {
  const wrap = document.getElementById("matrix-wrap");

  const txGroups = filterGroups(buildGroups(devices, "transmitters"), txFilter);
  const rxGroups = filterGroups(buildGroups(devices, "receivers"), rxFilter);

  if (txGroups.length === 0 || rxGroups.length === 0) {
    wrap.innerHTML = '<div class="empty">No matching transmit/receive channels.</div>';
    return;
  }

  const txColumns = buildTxColumns(txGroups);

  const table = document.createElement("table");
  table.className = "matrix";

  // --- header ---
  const thead = document.createElement("thead");
  const row1 = document.createElement("tr");
  const corner = document.createElement("th");
  corner.rowSpan = 2;
  corner.className = "corner";
  row1.appendChild(corner);

  const row2 = document.createElement("tr");

  for (const g of txGroups) {
    const key = deviceKey(g.device);
    const collapsed = txCollapsed.has(key);

    const th = document.createElement("th");
    th.className = "group-col";
    th.rowSpan = 2;
    const rotLabel = document.createElement("span");
    rotLabel.className = "rot";
    rotLabel.appendChild(makeToggle(collapsed));
    rotLabel.appendChild(document.createTextNode(" " + deviceLabel(g.device)));
    th.appendChild(rotLabel);
    th.addEventListener("click", () => {
      collapsed ? txCollapsed.delete(key) : txCollapsed.add(key);
      renderMatrix(DanteStore.getDevices());
    });
    row1.appendChild(th);

    if (!collapsed) {
      for (const ch of g.channels) {
        const spacer = document.createElement("th");
        spacer.className = "group-col-spacer";
        row1.appendChild(spacer);

        const cth = document.createElement("th");
        const rot = document.createElement("span");
        rot.className = "rot";
        rot.textContent = ch.friendlyName;
        cth.appendChild(rot);
        row2.appendChild(cth);
      }
    }
  }

  thead.appendChild(row1);
  thead.appendChild(row2);
  table.appendChild(thead);

  // --- body ---
  const tbody = document.createElement("tbody");

  for (const g of rxGroups) {
    const key = deviceKey(g.device);
    const collapsed = rxCollapsed.has(key);

    const groupTr = document.createElement("tr");
    groupTr.className = "group-row";
    const groupTh = document.createElement("th");
    groupTh.colSpan = 1 + txColumns.length;
    groupTh.appendChild(makeToggle(collapsed));
    groupTh.appendChild(document.createTextNode(" " + deviceLabel(g.device)));
    groupTh.addEventListener("click", () => {
      collapsed ? rxCollapsed.delete(key) : rxCollapsed.add(key);
      renderMatrix(DanteStore.getDevices());
    });
    groupTr.appendChild(groupTh);
    tbody.appendChild(groupTr);

    if (collapsed) continue;

    for (const ch of g.channels) {
      const tr = document.createElement("tr");
      const rowTh = document.createElement("th");
      rowTh.textContent = ch.friendlyName;
      tr.appendChild(rowTh);

      const rx = { device: g.device, number: ch.number, name: ch.name, friendlyName: ch.friendlyName };
      const rk = rowKey(deviceKey(rx.device), rx.number);
      const rowAction = recording ? findRowAction(rk) : undefined;
      const effectiveActive = recording && !rowAction ? getEffectiveActive(rx) : null;

      if (rowAction && rowAction.action === "remove") {
        rowTh.classList.add("recording-remove-row");
      }
      if (recording) {
        rowTh.classList.add("row-removable");
        rowTh.title = "Click to mark this channel for removal, even if nothing's connected here right now";
        rowTh.addEventListener("click", () => toggleRowRemoval(rx));
      }

      for (const col of txColumns) {
        const td = document.createElement("td");
        if (col.isLabel) {
          td.className = "disabled";
          tr.appendChild(td);
          continue;
        }

        const tx = { device: col.device, name: col.channel.name, friendlyName: col.channel.friendlyName };
        const txKeyStr = deviceKey(tx.device);

        if (rowAction) {
          if (rowAction.tx_device === txKeyStr && rowAction.tx_channel === tx.name) {
            td.classList.add(rowAction.action === "add" ? "recording-add" : "recording-remove");
          }
        } else if (effectiveActive) {
          td.classList.toggle("active", effectiveActive.device === txKeyStr && effectiveActive.name === tx.name);
        } else {
          const sub = findSubscription(g.device, ch.name, txKeyStr, tx.name);
          td.classList.toggle("active", Boolean(sub));
        }

        td.title = `${deviceLabel(col.device)} ${col.channel.friendlyName} → ${deviceLabel(g.device)} ${ch.friendlyName}`;
        td.addEventListener("click", () => onCellClick(td, rx, tx));
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  table.appendChild(tbody);

  wrap.innerHTML = "";
  wrap.appendChild(table);
}

// --- compact (mobile) view: one dropdown per receive channel ---------

async function onCompactChange(select, rx) {
  select.disabled = true;

  let desired = null;
  if (select.value !== "") {
    const [device, name] = select.value.split("|");
    const opt = select.options[select.selectedIndex];
    desired = { device, name, friendlyName: opt ? opt.textContent : name, deviceLabelText: device };
  }

  try {
    await applyDesiredForRow(rx, desired);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    select.disabled = false;
  }

  renderMatrix(DanteStore.getDevices());
  renderCompactView(DanteStore.getDevices());
}

function renderCompactView(devices) {
  const container = document.getElementById("compact-view");
  if (!container) return;

  const rxGroups = filterGroups(buildGroups(devices, "receivers"), rxFilter);
  const txGroups = filterGroups(buildGroups(devices, "transmitters"), txFilter);

  if (rxGroups.length === 0) {
    container.innerHTML = '<div class="empty">No receive channels found.</div>';
    return;
  }

  container.innerHTML = "";
  for (const g of rxGroups) {
    const section = document.createElement("div");
    section.className = "compact-device";
    const h3 = document.createElement("h3");
    h3.textContent = deviceLabel(g.device);
    section.appendChild(h3);

    for (const ch of g.channels) {
      const rx = { device: g.device, number: ch.number, name: ch.name, friendlyName: ch.friendlyName };
      const rk = rowKey(deviceKey(rx.device), rx.number);
      const rowAction = recording ? findRowAction(rk) : undefined;
      const effective = rowAction
        ? rowAction.action === "add"
          ? { device: rowAction.tx_device, name: rowAction.tx_channel }
          : null
        : getEffectiveActive(rx);

      const row = document.createElement("div");
      row.className = "compact-row";
      const label = document.createElement("label");
      label.textContent = ch.friendlyName;
      if (rowAction) {
        label.classList.add(rowAction.action === "add" ? "recording-add-text" : "recording-remove-text");
      }
      row.appendChild(label);

      const select = document.createElement("select");
      const noneOpt = document.createElement("option");
      noneOpt.value = "";
      noneOpt.textContent = "— none —";
      select.appendChild(noneOpt);

      for (const txg of txGroups) {
        const optgroup = document.createElement("optgroup");
        optgroup.label = deviceLabel(txg.device);
        for (const txch of txg.channels) {
          const opt = document.createElement("option");
          opt.value = `${deviceKey(txg.device)}|${txch.name}`;
          opt.textContent = txch.friendlyName;
          if (effective && effective.device === deviceKey(txg.device) && effective.name === txch.name) {
            opt.selected = true;
          }
          optgroup.appendChild(opt);
        }
        select.appendChild(optgroup);
      }

      select.addEventListener("change", () => onCompactChange(select, rx));
      row.appendChild(select);
      section.appendChild(row);
    }
    container.appendChild(section);
  }
}

// --- presets: record delta / capture full matrix ---------------------

function renderRecordPanel() {
  const panel = document.getElementById("record-panel");
  const list = document.getElementById("record-list");
  panel.style.display = recordedActions.length > 0 ? "block" : "none";
  list.innerHTML = "";
  for (const action of recordedActions) {
    const li = document.createElement("li");
    li.className = action.action === "add" ? "add" : "remove";

    const label = document.createElement("span");
    label.textContent = actionLabel(action);
    li.appendChild(label);

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "×";
    removeBtn.title = "Remove from recording";
    removeBtn.addEventListener("click", () => revertSingleAction(action));
    li.appendChild(removeBtn);

    list.appendChild(li);
  }
}

function captureFullMatrixActions(devices) {
  const actions = [];
  for (const rxDevice of Object.values(devices)) {
    for (const sub of rxDevice.subscriptions || []) {
      if (!sub.tx_device) continue;
      const rxChannel = findRxChannelNumber(rxDevice, sub.rx_channel);
      if (rxChannel === null) continue;
      actions.push({
        action: "add",
        rx_device: deviceKey(rxDevice),
        rx_device_label: deviceLabel(rxDevice),
        rx_channel: rxChannel,
        rx_channel_label: sub.rx_channel,
        tx_device: sub.tx_device,
        tx_device_label: sub.tx_device,
        tx_channel: sub.tx_channel,
        tx_channel_label: sub.tx_channel,
      });
    }
  }
  return actions;
}

let saveDialogActions = [];
let saveDialogPresets = [];
let saveDialogSource = null;

async function openSaveDialog(actions, source) {
  if (actions.length === 0) {
    showToast("Nothing to save", true);
    return;
  }
  saveDialogActions = actions;
  saveDialogSource = source;

  const dialog = document.getElementById("save-dialog");
  const hint = document.getElementById("save-dialog-hint");
  const select = document.getElementById("save-dialog-existing");
  const nameInput = document.getElementById("save-dialog-name");

  hint.textContent = `Save preset (${actions.length} action${actions.length === 1 ? "" : "s"})`;
  nameInput.value = "";

  select.innerHTML = '<option value="">— new preset —</option>';
  try {
    saveDialogPresets = await api("GET", "/api/presets");
    for (const preset of saveDialogPresets) {
      const opt = document.createElement("option");
      opt.value = preset.id;
      opt.textContent = preset.name;
      select.appendChild(opt);
    }
  } catch (err) {
    showToast(err.message, true);
  }

  dialog.style.display = "block";
  nameInput.focus();
}

function closeSaveDialog() {
  document.getElementById("save-dialog").style.display = "none";
  saveDialogActions = [];
  saveDialogSource = null;
}

document.addEventListener("DOMContentLoaded", () => {
  const txInput = document.getElementById("filter-tx");
  const rxInput = document.getElementById("filter-rx");
  const renderAll = (devices) => {
    renderMatrix(devices);
    renderCompactView(devices);
  };

  txInput.addEventListener("input", () => {
    txFilter = txInput.value;
    renderAll(DanteStore.getDevices());
  });
  rxInput.addEventListener("input", () => {
    rxFilter = rxInput.value;
    renderAll(DanteStore.getDevices());
  });

  DanteStore.subscribe(renderAll);

  const liveBtn = document.getElementById("record-live-btn");
  const planBtn = document.getElementById("record-plan-btn");

  function setRecordingMode(mode) {
    if (recordingMode === mode) {
      // turning off the currently active mode - keep the list around to review/save
      recording = false;
      recordingMode = null;
    } else {
      // starting fresh, whether from off or switching from the other mode
      recording = true;
      recordingMode = mode;
      recordedActions.length = 0;
      recordingBaseline.clear();
      renderRecordPanel();
    }
    liveBtn.classList.toggle("primary", recordingMode === "live");
    planBtn.classList.toggle("primary", recordingMode === "plan");
    renderAll(DanteStore.getDevices());
  }

  liveBtn.addEventListener("click", () => setRecordingMode("live"));
  planBtn.addEventListener("click", () => setRecordingMode("plan"));

  document.getElementById("record-discard-btn").addEventListener("click", discardAllRecorded);

  document.getElementById("record-save-btn").addEventListener("click", () => {
    openSaveDialog(recordedActions.slice(), "record");
  });

  document.getElementById("save-matrix-btn").addEventListener("click", () => {
    openSaveDialog(captureFullMatrixActions(DanteStore.getDevices()), "matrix");
  });

  document.getElementById("save-dialog-existing").addEventListener("change", (e) => {
    const preset = saveDialogPresets.find((p) => p.id === e.target.value);
    document.getElementById("save-dialog-name").value = preset ? preset.name : "";
  });

  document.getElementById("save-dialog-cancel-btn").addEventListener("click", closeSaveDialog);

  document.getElementById("save-dialog-save-btn").addEventListener("click", async () => {
    const name = document.getElementById("save-dialog-name").value.trim();
    if (!name) {
      showToast("Name is required", true);
      return;
    }
    const id = document.getElementById("save-dialog-existing").value || undefined;
    try {
      await api("POST", "/api/presets", { id, name, actions: saveDialogActions });
      showToast(`Saved preset "${name}"`);
      const wasRecording = saveDialogSource === "record";
      closeSaveDialog();
      if (wasRecording) {
        recordedActions.length = 0;
        recordingBaseline.clear();
        renderRecordPanel();
        renderAll(DanteStore.getDevices());
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });
});
