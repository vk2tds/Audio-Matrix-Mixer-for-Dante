const txCollapsed = new Set();
const rxCollapsed = new Set();
let txFilter = "";
let rxFilter = "";
let recording = false;
const recordedActions = [];

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

function buildAction(actionType, rx, tx) {
  return {
    action: actionType,
    rx_device: deviceKey(rx.device),
    rx_device_label: deviceLabel(rx.device),
    rx_channel: rx.number,
    rx_channel_label: rx.friendlyName,
    tx_device: tx ? deviceKey(tx.device) : null,
    tx_device_label: tx ? deviceLabel(tx.device) : null,
    tx_channel: tx ? tx.name : null,
    tx_channel_label: tx ? tx.friendlyName : null,
  };
}

function addRecordedAction(action) {
  const idx = recordedActions.findIndex(
    (a) => a.rx_device === action.rx_device && a.rx_channel === action.rx_channel
  );
  if (idx !== -1) recordedActions.splice(idx, 1);
  recordedActions.push(action);
  renderRecordPanel();
}

async function toggleRoute(td, rx, tx, active) {
  td.classList.add("pending");
  try {
    if (active) {
      await api("POST", "/api/unsubscribe", { rx_device: deviceKey(rx.device), rx_channel: rx.number });
      showToast(`Unsubscribed ${deviceLabel(rx.device)} · ${rx.friendlyName}`);
      if (recording) addRecordedAction(buildAction("remove", rx, tx));
    } else {
      await api("POST", "/api/subscribe", {
        rx_device: deviceKey(rx.device),
        rx_channel: rx.number,
        tx_channel: tx.name,
        tx_device: deviceKey(tx.device),
      });
      showToast(`Routed ${deviceLabel(tx.device)} · ${tx.friendlyName} → ${deviceLabel(rx.device)} · ${rx.friendlyName}`);
      if (recording) addRecordedAction(buildAction("add", rx, tx));
    }
  } catch (err) {
    showToast(err.message, true);
  } finally {
    td.classList.remove("pending");
  }
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

      for (const col of txColumns) {
        const td = document.createElement("td");
        if (col.isLabel) {
          td.className = "disabled";
          tr.appendChild(td);
          continue;
        }
        const sub = findSubscription(g.device, ch.name, deviceKey(col.device), col.channel.name);
        const active = Boolean(sub);
        td.classList.toggle("active", active);
        td.title = `${deviceLabel(col.device)} ${col.channel.friendlyName} → ${deviceLabel(g.device)} ${ch.friendlyName}`;
        const rx = { device: g.device, number: ch.number, name: ch.name, friendlyName: ch.friendlyName };
        const tx = { device: col.device, name: col.channel.name, friendlyName: col.channel.friendlyName };
        td.addEventListener("click", () => toggleRoute(td, rx, tx, active));
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
  try {
    if (select.value === "") {
      await api("POST", "/api/unsubscribe", { rx_device: deviceKey(rx.device), rx_channel: rx.number });
      showToast(`Unsubscribed ${deviceLabel(rx.device)} · ${rx.friendlyName}`);
    } else {
      const [txDeviceKeyVal, txChannelName] = select.value.split("|");
      await api("POST", "/api/subscribe", {
        rx_device: deviceKey(rx.device),
        rx_channel: rx.number,
        tx_channel: txChannelName,
        tx_device: txDeviceKeyVal,
      });
      showToast(`Routed → ${deviceLabel(rx.device)} · ${rx.friendlyName}`);
    }
  } catch (err) {
    showToast(err.message, true);
  } finally {
    select.disabled = false;
  }
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
      const currentSub = (g.device.subscriptions || []).find((s) => s.rx_channel === ch.name);

      const row = document.createElement("div");
      row.className = "compact-row";
      const label = document.createElement("label");
      label.textContent = ch.friendlyName;
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
          if (currentSub && currentSub.tx_device === deviceKey(txg.device) && currentSub.tx_channel === txch.name) {
            opt.selected = true;
          }
          optgroup.appendChild(opt);
        }
        select.appendChild(optgroup);
      }

      const rx = { device: g.device, number: ch.number, name: ch.name, friendlyName: ch.friendlyName };
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
    removeBtn.addEventListener("click", () => {
      const idx = recordedActions.indexOf(action);
      if (idx !== -1) recordedActions.splice(idx, 1);
      renderRecordPanel();
    });
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

  const recordToggle = document.getElementById("record-toggle");
  recordToggle.addEventListener("click", () => {
    recording = !recording;
    recordToggle.textContent = recording ? "Stop recording" : "Record changes for a preset";
    recordToggle.classList.toggle("primary", recording);
  });

  document.getElementById("record-discard-btn").addEventListener("click", () => {
    recordedActions.length = 0;
    renderRecordPanel();
  });

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
        renderRecordPanel();
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });
});
