let currentDesign = null; // {id, name, devices, connections, presets}

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

async function toggleDesignConnection(rxId, rxNum, txId, txNum, isActive) {
  currentDesign.connections = currentDesign.connections.filter(
    (c) => !(c.rx_device === rxId && String(c.rx_channel) === String(rxNum))
  );
  if (!isActive) {
    currentDesign.connections.push({ rx_device: rxId, rx_channel: rxNum, tx_device: txId, tx_channel: txNum });
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

      for (const tg of txGroups) {
        for (const tch of tg.channels) {
          const td = document.createElement("td");
          const conn = findDesignConnection(g.id, ch.number, tg.id, tch.number);
          const active = Boolean(conn);
          td.classList.toggle("active", active);
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

function renderPresetsTable() {
  const tbody = document.getElementById("design-presets-rows");
  tbody.innerHTML = "";
  const presetIds = Object.keys(currentDesign.presets || {});
  if (presetIds.length === 0) {
    tbody.innerHTML = '<tr><td class="empty" colspan="3">No presets saved yet.</td></tr>';
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

    const actionsTd = document.createElement("td");
    actionsTd.style.display = "flex";
    actionsTd.style.gap = "6px";

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

async function saveDesignConnectionsAsPreset() {
  if (currentDesign.connections.length === 0) {
    showToast("No connections to save", true);
    return;
  }
  const name = prompt("Name for this preset:");
  if (!name || !name.trim()) return;

  const id = newId();
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
  currentDesign.presets[id] = { name: name.trim(), actions };
  await persistDesign();
  renderAll();
  showToast(`Saved preset "${name.trim()}"`);
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
});
