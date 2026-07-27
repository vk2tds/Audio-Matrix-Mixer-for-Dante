let currentDesign = null; // {id, name, devices, connections, presets}

// Recording: build up a delta (add/remove per channel) as you click the
// matrix, same model as the real routing page, so a design can end up with
// multiple named presets instead of only ever snapshotting the whole
// matrix. Design mode has no "live" concept of its own — every click
// (recording or not) just updates currentDesign.connections directly and
// persists — recording only ADDITIONALLY tracks which rows changed and
// their pre-recording baseline, purely for building a nameable delta.
let designRecording = false;
const designRecordingBaseline = new Map(); // "rxId|rxNum" -> {device,name} | null
const designRecordedActions = [];

function designRowKey(rxId, rxNum) {
  return `${rxId}|${rxNum}`;
}

function findDesignRowAction(rk) {
  return designRecordedActions.find((a) => designRowKey(a.rx_device, a.rx_channel) === rk);
}

function setDesignRowAction(rk, action) {
  const idx = designRecordedActions.findIndex((a) => designRowKey(a.rx_device, a.rx_channel) === rk);
  if (idx !== -1) designRecordedActions.splice(idx, 1);
  designRecordedActions.push(action);
  renderDesignRecordPanel();
}

function clearDesignRowAction(rk) {
  const idx = designRecordedActions.findIndex((a) => designRowKey(a.rx_device, a.rx_channel) === rk);
  if (idx !== -1) designRecordedActions.splice(idx, 1);
  renderDesignRecordPanel();
}

function newId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function loadDesignsList(selectId) {
  const select = document.getElementById("design-select");
  let designs;
  try {
    designs = await api("GET", "/api/designs");
  } catch (err) {
    showToast(err.message, true);
    return;
  }
  select.innerHTML = '<option value="">— select a design —</option>';
  for (const d of designs) {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = `${d.name} (${d.device_count} devices, ${d.connection_count} connections)`;
    select.appendChild(opt);
  }
  if (selectId) select.value = selectId;
}

async function selectDesign(id) {
  const editor = document.getElementById("design-editor");
  if (!id) {
    currentDesign = null;
    editor.style.display = "none";
    return;
  }
  try {
    currentDesign = await api("GET", `/api/designs/${id}`);
  } catch (err) {
    showToast(err.message, true);
    return;
  }
  editor.style.display = "block";
  renderAll();
}

async function persistDesign() {
  try {
    const result = await api("POST", "/api/designs", {
      id: currentDesign.id,
      name: currentDesign.name,
      devices: currentDesign.devices,
      connections: currentDesign.connections,
      presets: currentDesign.presets,
    });
    currentDesign.id = result.id;
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderAll() {
  renderDevicesList();
  renderMatrix();
  renderPresetsTable();
  renderDesignRecordPanel();
}

// --- devices -----------------------------------------------------------

function renderDevicesList() {
  const container = document.getElementById("design-devices-list");
  container.innerHTML = "";
  const deviceIds = Object.keys(currentDesign.devices).sort((a, b) =>
    currentDesign.devices[a].name.localeCompare(currentDesign.devices[b].name)
  );

  if (deviceIds.length === 0) {
    container.innerHTML = '<div class="empty">No devices yet. Add one, or import from live.</div>';
    return;
  }

  for (const devId of deviceIds) {
    const dev = currentDesign.devices[devId];
    const card = document.createElement("div");
    card.className = "config-card";

    const header = document.createElement("div");
    header.className = "config-card-header";
    const h3 = document.createElement("h3");
    h3.textContent = dev.name + (dev.imported_from ? " (imported)" : "");
    header.appendChild(h3);
    const renameDevBtn = document.createElement("button");
    renameDevBtn.textContent = "Rename";
    renameDevBtn.addEventListener("click", () => renameDesignDevice(devId));
    header.appendChild(renameDevBtn);
    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete device";
    delBtn.addEventListener("click", () => deleteDesignDevice(devId));
    header.appendChild(delBtn);
    card.appendChild(header);

    for (const type of ["transmitters", "receivers"]) {
      const section = document.createElement("div");
      section.className = "design-channel-section";
      const label = document.createElement("div");
      label.className = "hint";
      label.textContent = type === "transmitters" ? "Transmit channels" : "Receive channels";
      section.appendChild(label);

      const numbers = Object.keys(dev.channels[type] || {}).sort((a, b) => Number(a) - Number(b));
      for (const num of numbers) {
        const row = document.createElement("div");
        row.className = "config-row";
        const l = document.createElement("label");
        l.textContent = `CH${num}`;
        row.appendChild(l);
        const nameSpan = document.createElement("span");
        nameSpan.textContent = dev.channels[type][num].name;
        row.appendChild(nameSpan);
        const renameBtn = document.createElement("button");
        renameBtn.textContent = "Rename";
        renameBtn.addEventListener("click", () => renameDesignChannel(devId, type, num));
        row.appendChild(renameBtn);
        const rmBtn = document.createElement("button");
        rmBtn.textContent = "×";
        rmBtn.addEventListener("click", () => deleteDesignChannel(devId, type, num));
        row.appendChild(rmBtn);
        section.appendChild(row);
      }

      const addRow = document.createElement("div");
      addRow.className = "config-row";
      const numInput = document.createElement("input");
      numInput.type = "number";
      numInput.min = "1";
      numInput.placeholder = "#";
      numInput.style.maxWidth = "60px";
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.placeholder = "Channel name";
      const addBtn = document.createElement("button");
      addBtn.textContent = "Add";
      addBtn.addEventListener("click", () => {
        const num = parseInt(numInput.value, 10);
        const name = nameInput.value.trim();
        if (!num || !name) {
          showToast("Channel number and name are required", true);
          return;
        }
        addDesignChannel(devId, type, num, name);
      });
      addRow.appendChild(numInput);
      addRow.appendChild(nameInput);
      addRow.appendChild(addBtn);
      section.appendChild(addRow);

      card.appendChild(section);
    }

    container.appendChild(card);
  }
}

async function addDesignDeviceManual() {
  const name = prompt("New device name:");
  if (!name || !name.trim()) return;
  const id = newId();
  currentDesign.devices[id] = { name: name.trim(), channels: { transmitters: {}, receivers: {} } };
  await persistDesign();
  renderAll();
}

async function renameDesignDevice(devId) {
  const current = currentDesign.devices[devId].name;
  const name = prompt("Rename device:", current);
  if (!name || !name.trim() || name === current) return;
  currentDesign.devices[devId].name = name.trim();
  await persistDesign();
  renderAll();
}

async function deleteDesignDevice(devId) {
  if (!confirm(`Delete device "${currentDesign.devices[devId].name}" from this design?`)) return;
  delete currentDesign.devices[devId];
  currentDesign.connections = currentDesign.connections.filter(
    (c) => c.rx_device !== devId && c.tx_device !== devId
  );
  await persistDesign();
  renderAll();
}

async function addDesignChannel(devId, type, num, name) {
  currentDesign.devices[devId].channels[type][num] = { name };
  await persistDesign();
  renderAll();
}

async function renameDesignChannel(devId, type, num) {
  const current = currentDesign.devices[devId].channels[type][num].name;
  const name = prompt("Rename channel:", current);
  if (!name || !name.trim() || name === current) return;
  currentDesign.devices[devId].channels[type][num].name = name.trim();
  await persistDesign();
  renderAll();
}

async function deleteDesignChannel(devId, type, num) {
  delete currentDesign.devices[devId].channels[type][num];
  currentDesign.connections = currentDesign.connections.filter((c) => {
    if (type === "receivers" && c.rx_device === devId && String(c.rx_channel) === String(num)) return false;
    if (type === "transmitters" && c.tx_device === devId && String(c.tx_channel) === String(num)) return false;
    return true;
  });
  await persistDesign();
  renderAll();
}

// --- import from live ----------------------------------------------------

function buildImportChannels(chans) {
  const out = {};
  for (const [num, chan] of Object.entries(chans || {})) {
    out[num] = { name: chan.friendly_name || chan.name || num };
  }
  return out;
}

async function openImportPicker() {
  const picker = document.getElementById("import-picker");
  const list = document.getElementById("import-picker-list");
  let liveDevices;
  try {
    liveDevices = await api("GET", "/api/devices");
  } catch (err) {
    showToast(err.message, true);
    return;
  }

  const alreadyImported = new Set(
    Object.values(currentDesign.devices).map((d) => d.imported_from).filter(Boolean)
  );

  list.innerHTML = "";
  const entries = Object.entries(liveDevices).sort((a, b) => deviceLabel(a[1]).localeCompare(deviceLabel(b[1])));
  for (const [serverName, dev] of entries) {
    const row = document.createElement("label");
    row.className = "flow-channel-label";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.value = serverName;
    if (alreadyImported.has(serverName)) check.disabled = true;
    row.appendChild(check);
    row.appendChild(
      document.createTextNode(` ${deviceLabel(dev)}${alreadyImported.has(serverName) ? " (already imported)" : ""}`)
    );
    list.appendChild(row);
    list.appendChild(document.createElement("br"));
  }

  picker.dataset.liveDevices = JSON.stringify(liveDevices);
  picker.style.display = "block";
}

async function confirmImport() {
  const picker = document.getElementById("import-picker");
  const liveDevices = JSON.parse(picker.dataset.liveDevices || "{}");
  const checked = [...picker.querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value);

  for (const serverName of checked) {
    const dev = liveDevices[serverName];
    const id = newId();
    currentDesign.devices[id] = {
      name: deviceLabel(dev),
      manufacturer: dev.manufacturer || null,
      imported_from: serverName,
      channels: {
        transmitters: buildImportChannels(dev.channels && dev.channels.transmitters),
        receivers: buildImportChannels(dev.channels && dev.channels.receivers),
      },
    };
  }

  await persistDesign();
  picker.style.display = "none";
  renderAll();
  showToast(`Imported ${checked.length} device(s)`);
}

// --- matrix ---------------------------------------------------------------

function buildDesignGroups(kind) {
  const groups = [];
  const ids = Object.keys(currentDesign.devices).sort((a, b) =>
    currentDesign.devices[a].name.localeCompare(currentDesign.devices[b].name)
  );
  for (const id of ids) {
    const dev = currentDesign.devices[id];
    const numbers = Object.keys(dev.channels[kind] || {}).sort((a, b) => Number(a) - Number(b));
    if (numbers.length === 0) continue;
    groups.push({
      id,
      name: dev.name,
      channels: numbers.map((n) => ({ number: Number(n), name: dev.channels[kind][n].name })),
    });
  }
  return groups;
}

function findDesignConnection(rxId, rxNum, txId, txNum) {
  return currentDesign.connections.find(
    (c) =>
      c.rx_device === rxId &&
      String(c.rx_channel) === String(rxNum) &&
      c.tx_device === txId &&
      String(c.tx_channel) === String(txNum)
  );
}

function setDesignConnection(rxId, rxNum, txId, txNum) {
  currentDesign.connections = currentDesign.connections.filter(
    (c) => !(c.rx_device === rxId && String(c.rx_channel) === String(rxNum))
  );
  if (txId !== null && txId !== undefined) {
    currentDesign.connections.push({ rx_device: rxId, rx_channel: rxNum, tx_device: txId, tx_channel: txNum });
  }
}

async function toggleDesignConnection(rxId, rxNum, txId, txNum, isActive) {
  if (!designRecording) {
    setDesignConnection(rxId, rxNum, isActive ? null : txId, isActive ? null : txNum);
    await persistDesign();
    renderMatrix();
    return;
  }

  // Recording: each cell cycles blank -> green -> red -> blank as you click
  // it repeatedly, same model as the real routing page. The one exception
  // is the very first click on a row's already-connected cell, which goes
  // straight to red (skipping green) since there's nothing to "add".
  const rk = designRowKey(rxId, rxNum);
  if (!designRecordingBaseline.has(rk)) {
    const existingConn = currentDesign.connections.find(
      (c) => c.rx_device === rxId && String(c.rx_channel) === String(rxNum)
    );
    designRecordingBaseline.set(rk, existingConn ? { device: existingConn.tx_device, name: existingConn.tx_channel } : null);
  }
  const baseline = designRecordingBaseline.get(rk);
  const existingAction = findDesignRowAction(rk);
  const clickedMatchesExisting = Boolean(
    existingAction && existingAction.tx_device === txId && String(existingAction.tx_channel) === String(txNum)
  );
  const clickedIsBaseline = Boolean(baseline && baseline.device === txId && String(baseline.name) === String(txNum));

  let nextAction; // "add" | "remove" | null (null clears back to blank)
  if (clickedMatchesExisting) {
    nextAction = existingAction.action === "add" ? "remove" : null;
  } else if (!existingAction && clickedIsBaseline) {
    nextAction = "remove";
  } else {
    nextAction = "add";
  }

  if (nextAction === "add") {
    setDesignConnection(rxId, rxNum, txId, txNum);
  } else if (nextAction === "remove") {
    setDesignConnection(rxId, rxNum, null, null);
  } else if (baseline) {
    setDesignConnection(rxId, rxNum, baseline.device, baseline.name);
  } else {
    setDesignConnection(rxId, rxNum, null, null);
  }

  if (nextAction === null) {
    clearDesignRowAction(rk);
  } else {
    const rxDev = currentDesign.devices[rxId];
    const txDev = currentDesign.devices[txId];
    const rxChan = rxDev.channels.receivers[rxNum];
    const txChan = txDev ? txDev.channels.transmitters[txNum] : null;
    setDesignRowAction(rk, {
      action: nextAction,
      rx_device: rxId,
      rx_device_label: rxDev.name,
      rx_channel: rxNum,
      rx_channel_label: rxChan ? rxChan.name : rxNum,
      tx_device: txId,
      tx_device_label: txDev ? txDev.name : null,
      tx_channel: txNum,
      tx_channel_label: txChan ? txChan.name : null,
    });
  }

  await persistDesign();
  renderMatrix();
}

function renderMatrix() {
  const wrap = document.getElementById("design-matrix-wrap");
  const txGroups = buildDesignGroups("transmitters");
  const rxGroups = buildDesignGroups("receivers");

  if (txGroups.length === 0 || rxGroups.length === 0) {
    wrap.innerHTML = '<div class="empty">Add at least one transmit channel and one receive channel to see the matrix.</div>';
    return;
  }

  const totalTxChannels = txGroups.reduce((sum, g) => sum + g.channels.length, 0);

  const table = document.createElement("table");
  table.className = "matrix";

  const thead = document.createElement("thead");
  const row1 = document.createElement("tr");
  const corner = document.createElement("th");
  corner.className = "corner";
  corner.rowSpan = 2;
  row1.appendChild(corner);
  const row2 = document.createElement("tr");

  for (const g of txGroups) {
    const th = document.createElement("th");
    th.className = "group-col-span";
    th.colSpan = g.channels.length;
    th.textContent = g.name;
    row1.appendChild(th);
    for (const ch of g.channels) {
      const cth = document.createElement("th");
      const rot = document.createElement("span");
      rot.className = "rot";
      rot.textContent = ch.name;
      cth.appendChild(rot);
      row2.appendChild(cth);
    }
  }
  thead.appendChild(row1);
  thead.appendChild(row2);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const g of rxGroups) {
    const groupTr = document.createElement("tr");
    groupTr.className = "group-row";
    const groupTh = document.createElement("th");
    groupTh.colSpan = 1 + totalTxChannels;
    groupTh.textContent = g.name;
    groupTr.appendChild(groupTh);
    tbody.appendChild(groupTr);

    for (const ch of g.channels) {
      const tr = document.createElement("tr");
      const rowTh = document.createElement("th");
      rowTh.textContent = ch.name;
      tr.appendChild(rowTh);

      const rk = designRowKey(g.id, ch.number);
      const rowAction = designRecording ? findDesignRowAction(rk) : undefined;

      for (const tg of txGroups) {
        for (const tch of tg.channels) {
          const td = document.createElement("td");
          const conn = findDesignConnection(g.id, ch.number, tg.id, tch.number);
          const active = Boolean(conn);
          if (rowAction) {
            if (rowAction.tx_device === tg.id && String(rowAction.tx_channel) === String(tch.number)) {
              td.classList.add(rowAction.action === "add" ? "recording-add" : "recording-remove");
            }
          } else {
            td.classList.toggle("active", active);
          }
          td.title = `${tg.name} ${tch.name} → ${g.name} ${ch.name}`;
          td.addEventListener("click", () => toggleDesignConnection(g.id, ch.number, tg.id, tch.number, active));
          tr.appendChild(td);
        }
      }
      tbody.appendChild(tr);
    }
  }
  table.appendChild(tbody);

  wrap.innerHTML = "";
  wrap.appendChild(table);
}

// --- design-scoped presets --------------------------------------------------

function formatDesignTimestamp(epochSeconds) {
  if (!epochSeconds) return "–";
  return new Date(epochSeconds * 1000).toLocaleString();
}

function renderPresetsTable() {
  const tbody = document.getElementById("design-presets-rows");
  tbody.innerHTML = "";
  const presetIds = Object.keys(currentDesign.presets || {});
  if (presetIds.length === 0) {
    tbody.innerHTML = '<tr><td class="empty" colspan="4">No presets saved yet.</td></tr>';
    return;
  }
  for (const pid of presetIds) {
    const preset = currentDesign.presets[pid];
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.textContent = preset.name;
    tr.appendChild(nameTd);

    const countTd = document.createElement("td");
    countTd.textContent = `${preset.actions.length} action(s)`;
    tr.appendChild(countTd);

    const updatedTd = document.createElement("td");
    updatedTd.textContent = formatDesignTimestamp(preset.updated_at);
    tr.appendChild(updatedTd);

    const actionsTd = document.createElement("td");
    actionsTd.style.display = "flex";
    actionsTd.style.gap = "6px";
    actionsTd.style.flexWrap = "wrap";

    const viewBtn = document.createElement("button");
    viewBtn.textContent = "View";
    viewBtn.addEventListener("click", () => toggleDesignPresetDetail(tr, pid));
    actionsTd.appendChild(viewBtn);

    const loadBtn = document.createElement("button");
    loadBtn.textContent = "Load into design";
    loadBtn.addEventListener("click", async () => {
      currentDesign.connections = preset.actions
        .filter((a) => a.action === "add")
        .map((a) => ({
          rx_device: a.rx_device,
          rx_channel: a.rx_channel,
          tx_device: a.tx_device,
          tx_channel: a.tx_channel,
        }));
      await persistDesign();
      renderAll();
      showToast(`Loaded "${preset.name}" into the design`);
    });
    actionsTd.appendChild(loadBtn);

    const applyLiveBtn = document.createElement("button");
    applyLiveBtn.textContent = "Apply to live…";
    applyLiveBtn.className = "primary";
    applyLiveBtn.addEventListener("click", () => applyDesignToLive(pid));
    actionsTd.appendChild(applyLiveBtn);

    const renameBtn = document.createElement("button");
    renameBtn.textContent = "Rename";
    renameBtn.addEventListener("click", async () => {
      const newName = prompt("Rename preset:", preset.name);
      if (!newName || !newName.trim() || newName === preset.name) return;
      preset.name = newName.trim();
      preset.updated_at = Date.now() / 1000;
      await persistDesign();
      renderAll();
    });
    actionsTd.appendChild(renameBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Delete preset "${preset.name}"?`)) return;
      delete currentDesign.presets[pid];
      await persistDesign();
      renderAll();
    });
    actionsTd.appendChild(deleteBtn);

    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  }
}

function toggleDesignPresetDetail(afterRow, pid) {
  const next = afterRow.nextElementSibling;
  if (next && next.classList.contains("preset-detail-row")) {
    next.remove();
    return;
  }
  document.querySelectorAll(".preset-detail-row").forEach((el) => el.remove());

  const preset = currentDesign.presets[pid];
  const tr = document.createElement("tr");
  tr.className = "preset-detail-row";
  const td = document.createElement("td");
  td.colSpan = 4;
  const list = document.createElement("ul");
  list.className = "preset-action-list";
  for (const action of preset.actions) {
    const li = document.createElement("li");
    li.className = action.action === "add" ? "add" : "remove";
    li.textContent = actionLabel(action);
    list.appendChild(li);
  }
  td.appendChild(list);
  tr.appendChild(td);
  afterRow.parentNode.insertBefore(tr, afterRow.nextSibling);
}

// --- recording panel + shared save dialog -----------------------------------

function renderDesignRecordPanel() {
  const panel = document.getElementById("design-record-panel");
  const list = document.getElementById("design-record-list");
  panel.style.display = designRecordedActions.length > 0 ? "block" : "none";
  list.innerHTML = "";
  for (const action of designRecordedActions) {
    const li = document.createElement("li");
    li.className = action.action === "add" ? "add" : "remove";

    const label = document.createElement("span");
    label.textContent = actionLabel(action);
    li.appendChild(label);

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "×";
    removeBtn.title = "Remove from recording";
    removeBtn.addEventListener("click", () => {
      const idx = designRecordedActions.indexOf(action);
      if (idx !== -1) designRecordedActions.splice(idx, 1);
      renderDesignRecordPanel();
    });
    li.appendChild(removeBtn);

    list.appendChild(li);
  }
}

let designSaveDialogActions = [];
let designSaveDialogIsRecording = false;

function openDesignSaveDialog(actions, isRecording) {
  if (actions.length === 0) {
    showToast("Nothing to save", true);
    return;
  }
  designSaveDialogActions = actions;
  designSaveDialogIsRecording = isRecording;

  const dialog = document.getElementById("design-save-dialog");
  const hint = document.getElementById("design-save-dialog-hint");
  const select = document.getElementById("design-save-dialog-existing");
  const nameInput = document.getElementById("design-save-dialog-name");

  hint.textContent = `Save preset (${actions.length} action${actions.length === 1 ? "" : "s"})`;
  nameInput.value = "";

  select.innerHTML = '<option value="">— new preset —</option>';
  for (const [pid, preset] of Object.entries(currentDesign.presets || {})) {
    const opt = document.createElement("option");
    opt.value = pid;
    opt.textContent = preset.name;
    select.appendChild(opt);
  }

  dialog.style.display = "block";
  nameInput.focus();
}

function closeDesignSaveDialog() {
  document.getElementById("design-save-dialog").style.display = "none";
  designSaveDialogActions = [];
}

async function saveDesignConnectionsAsPreset() {
  if (currentDesign.connections.length === 0) {
    showToast("No connections to save", true);
    return;
  }
  const actions = currentDesign.connections.map((c) => {
    const rxDev = currentDesign.devices[c.rx_device];
    const txDev = currentDesign.devices[c.tx_device];
    const rxChan = rxDev.channels.receivers[c.rx_channel];
    const txChan = txDev.channels.transmitters[c.tx_channel];
    return {
      action: "add",
      rx_device: c.rx_device,
      rx_device_label: rxDev.name,
      rx_channel: c.rx_channel,
      rx_channel_label: rxChan ? rxChan.name : c.rx_channel,
      tx_device: c.tx_device,
      tx_device_label: txDev.name,
      tx_channel: c.tx_channel,
      tx_channel_label: txChan ? txChan.name : c.tx_channel,
    };
  });
  openDesignSaveDialog(actions, false);
}

// --- apply to live ---------------------------------------------------------

async function applyDesignToLive(presetId) {
  const label = presetId ? currentDesign.presets[presetId].name : "base connections";
  if (!confirm(`Apply "${label}" to the real network now? This will actually change routing on your live devices.`)) {
    return;
  }
  try {
    const body = presetId ? { preset_id: presetId } : {};
    const result = await api("POST", `/api/designs/${currentDesign.id}/apply`, body);
    const failed = result.total - result.applied;
    showToast(
      failed === 0
        ? `Applied "${label}" (${result.applied}/${result.total})`
        : `Applied "${label}" with ${failed} failure/skip (${result.applied}/${result.total})`,
      failed > 0
    );
  } catch (err) {
    showToast(err.message, true);
  }
}

// --- export / import ---------------------------------------------------------

function exportCurrentDesign() {
  if (!currentDesign) return;
  const data = JSON.stringify(
    {
      name: currentDesign.name,
      devices: currentDesign.devices,
      connections: currentDesign.connections,
      presets: currentDesign.presets,
    },
    null,
    2
  );
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${currentDesign.name.replace(/[^a-z0-9_-]+/gi, "_")}.design.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importDesignFromFile(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch {
      showToast("Invalid JSON file", true);
      return;
    }
    const name = prompt("Name for imported design:", data.name || "Imported design");
    if (!name || !name.trim()) return;
    try {
      const result = await api("POST", "/api/designs", {
        name: name.trim(),
        devices: data.devices || {},
        connections: data.connections || [],
        presets: data.presets || {},
      });
      await loadDesignsList(result.id);
      await selectDesign(result.id);
      showToast(`Imported "${name.trim()}"`);
    } catch (err) {
      showToast(err.message, true);
    }
  };
  reader.readAsText(file);
}

// --- design CRUD -----------------------------------------------------------

async function createNewDesign() {
  const name = prompt("New design name:");
  if (!name || !name.trim()) return;
  try {
    const result = await api("POST", "/api/designs", {
      name: name.trim(),
      devices: {},
      connections: [],
      presets: {},
    });
    await loadDesignsList(result.id);
    await selectDesign(result.id);
  } catch (err) {
    showToast(err.message, true);
  }
}

async function renameCurrentDesign() {
  if (!currentDesign) return;
  const name = prompt("Rename design:", currentDesign.name);
  if (!name || !name.trim() || name === currentDesign.name) return;
  currentDesign.name = name.trim();
  await persistDesign();
  await loadDesignsList(currentDesign.id);
}

async function deleteCurrentDesign() {
  if (!currentDesign) return;
  if (!confirm(`Delete design "${currentDesign.name}"? This cannot be undone.`)) return;
  await api("DELETE", `/api/designs/${currentDesign.id}`);
  currentDesign = null;
  document.getElementById("design-editor").style.display = "none";
  await loadDesignsList();
}

document.addEventListener("DOMContentLoaded", () => {
  loadDesignsList();

  document.getElementById("design-select").addEventListener("change", (e) => selectDesign(e.target.value));
  document.getElementById("design-new-btn").addEventListener("click", createNewDesign);
  document.getElementById("design-rename-btn").addEventListener("click", renameCurrentDesign);
  document.getElementById("design-delete-btn").addEventListener("click", deleteCurrentDesign);

  document.getElementById("add-device-btn").addEventListener("click", addDesignDeviceManual);
  document.getElementById("import-live-btn").addEventListener("click", openImportPicker);
  document.getElementById("import-picker-confirm-btn").addEventListener("click", confirmImport);
  document.getElementById("import-picker-cancel-btn").addEventListener("click", () => {
    document.getElementById("import-picker").style.display = "none";
  });

  document.getElementById("apply-base-btn").addEventListener("click", () => applyDesignToLive(null));
  document.getElementById("save-design-preset-btn").addEventListener("click", saveDesignConnectionsAsPreset);

  const recordToggleBtn = document.getElementById("design-record-toggle-btn");
  recordToggleBtn.addEventListener("click", () => {
    designRecording = !designRecording;
    recordToggleBtn.textContent = designRecording ? "Stop recording" : "Record changes for a preset";
    recordToggleBtn.classList.toggle("primary", designRecording);
    if (designRecording) {
      designRecordedActions.length = 0;
      designRecordingBaseline.clear();
      renderDesignRecordPanel();
    }
    renderMatrix();
  });

  document.getElementById("design-record-save-btn").addEventListener("click", () => {
    openDesignSaveDialog(designRecordedActions.slice(), true);
  });

  document.getElementById("design-record-discard-btn").addEventListener("click", async () => {
    for (const [rk, baseline] of designRecordingBaseline.entries()) {
      const sep = rk.indexOf("|");
      const rxId = rk.slice(0, sep);
      const rxNum = rk.slice(sep + 1);
      if (baseline) {
        setDesignConnection(rxId, rxNum, baseline.device, baseline.name);
      } else {
        setDesignConnection(rxId, rxNum, null, null);
      }
    }
    designRecordedActions.length = 0;
    designRecordingBaseline.clear();
    await persistDesign();
    renderAll();
  });

  document.getElementById("design-save-dialog-existing").addEventListener("change", (e) => {
    const preset = currentDesign.presets[e.target.value];
    document.getElementById("design-save-dialog-name").value = preset ? preset.name : "";
  });

  document.getElementById("design-save-dialog-cancel-btn").addEventListener("click", closeDesignSaveDialog);

  document.getElementById("design-save-dialog-save-btn").addEventListener("click", async () => {
    const name = document.getElementById("design-save-dialog-name").value.trim();
    if (!name) {
      showToast("Name is required", true);
      return;
    }
    const pid = document.getElementById("design-save-dialog-existing").value || newId();
    const now = Date.now() / 1000;
    const existing = currentDesign.presets[pid];
    currentDesign.presets[pid] = {
      name,
      actions: designSaveDialogActions,
      created_at: existing ? existing.created_at : now,
      updated_at: now,
    };
    try {
      await persistDesign();
    } catch (err) {
      showToast(err.message, true);
      return;
    }
    showToast(`Saved preset "${name}"`);
    const wasRecording = designSaveDialogIsRecording;
    closeDesignSaveDialog();
    if (wasRecording) {
      designRecordedActions.length = 0;
      designRecordingBaseline.clear();
    }
    renderAll();
  });

  document.getElementById("design-export-btn").addEventListener("click", exportCurrentDesign);
  document.getElementById("design-import-btn").addEventListener("click", () => {
    document.getElementById("design-import-input").click();
  });
  document.getElementById("design-import-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) importDesignFromFile(file);
    e.target.value = "";
  });
});
