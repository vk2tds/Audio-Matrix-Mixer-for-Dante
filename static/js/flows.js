function buildTxChannelList(device) {
  const tx = (device.channels && device.channels.transmitters) || {};
  return Object.keys(tx)
    .sort((a, b) => Number(a) - Number(b))
    .map((num) => ({
      number: Number(num),
      friendlyName: (tx[num] && (tx[num].friendly_name || tx[num].name)) || num,
    }));
}

function renderFlowTable(container, flows) {
  container.innerHTML = "";

  if (!Array.isArray(flows) || flows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "unsupported";
    empty.textContent = "No TX flows configured.";
    container.appendChild(empty);
    return;
  }

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Slot", "Type", "Channels", "Sample rate", "Encoding", ""]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const flow of flows) {
    const slot = flow.flow_number ?? flow.slot;
    const tr = document.createElement("tr");

    const cells = [
      slot,
      flow.flow_type ?? "",
      (flow.channels || []).join(", "),
      flow.sample_rate ?? "",
      flow.encoding ?? "",
    ];
    for (const value of cells) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    }

    const actionTd = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => {
      const card = container.closest(".config-card");
      deleteFlow(card, slot, delBtn);
    });
    actionTd.appendChild(delBtn);
    tr.appendChild(actionTd);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

async function loadFlows(card) {
  const deviceKeyVal = card.dataset.deviceKey;
  const container = card.querySelector(".flow-table-container");
  container.innerHTML = '<div class="unsupported">Loading… (this can take several seconds)</div>';
  try {
    const flows = await api("GET", `/api/flows/${encodeURIComponent(deviceKeyVal)}`);
    renderFlowTable(container, flows);
  } catch (err) {
    container.innerHTML = "";
    const errEl = document.createElement("div");
    errEl.className = "unsupported";
    errEl.textContent = err.message;
    container.appendChild(errEl);
  }
}

async function deleteFlow(card, slot, btn) {
  const deviceKeyVal = card.dataset.deviceKey;
  btn.disabled = true;
  try {
    await api("DELETE", `/api/flows/${encodeURIComponent(deviceKeyVal)}/${slot}`);
    showToast(`Deleted flow slot ${slot}`);
    await loadFlows(card);
  } catch (err) {
    showToast(err.message, true);
    btn.disabled = false;
  }
}

async function createFlow(card) {
  const deviceKeyVal = card.dataset.deviceKey;
  const slotInput = card.querySelector(".flow-slot-input");
  const checked = [...card.querySelectorAll(".flow-channel-check:checked")].map((c) => c.value);
  const createBtn = card.querySelector(".flow-create-btn");

  const slot = parseInt(slotInput.value, 10);
  if (!slot || slot < 1 || slot > 32) {
    showToast("Slot must be between 1 and 32", true);
    return;
  }
  if (checked.length === 0) {
    showToast("Select at least one channel", true);
    return;
  }

  createBtn.disabled = true;
  try {
    await api("POST", `/api/flows/${encodeURIComponent(deviceKeyVal)}`, {
      slot,
      channels: checked.map(Number),
    });
    showToast(`Requested flow slot ${slot} — verify with "Load flows"`);
    await loadFlows(card);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    createBtn.disabled = false;
  }
}

function buildFlowDeviceCard(device) {
  const card = document.createElement("div");
  card.className = "config-card";
  card.dataset.deviceKey = deviceKey(device);

  const header = document.createElement("div");
  header.className = "config-card-header";
  const h3 = document.createElement("h3");
  h3.textContent = deviceLabel(device);
  header.appendChild(h3);
  const loadBtn = document.createElement("button");
  loadBtn.textContent = "Load flows";
  loadBtn.addEventListener("click", () => loadFlows(card));
  header.appendChild(loadBtn);
  card.appendChild(header);

  const tableContainer = document.createElement("div");
  tableContainer.className = "flow-table-container";
  const notLoaded = document.createElement("div");
  notLoaded.className = "unsupported";
  notLoaded.textContent = "Not loaded yet.";
  tableContainer.appendChild(notLoaded);
  card.appendChild(tableContainer);

  const createRow = document.createElement("div");
  createRow.className = "flow-create-row";

  const slotLabel = document.createElement("label");
  slotLabel.textContent = "New flow — slot";
  createRow.appendChild(slotLabel);

  const slotInput = document.createElement("input");
  slotInput.type = "number";
  slotInput.min = "1";
  slotInput.max = "32";
  slotInput.value = "17";
  slotInput.className = "flow-slot-input";
  createRow.appendChild(slotInput);

  const channelsWrap = document.createElement("div");
  channelsWrap.className = "flow-channels";
  for (const ch of buildTxChannelList(device)) {
    const label = document.createElement("label");
    label.className = "flow-channel-label";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "flow-channel-check";
    check.value = ch.number;
    label.appendChild(check);
    label.appendChild(document.createTextNode(" " + ch.friendlyName));
    channelsWrap.appendChild(label);
  }
  createRow.appendChild(channelsWrap);

  const createBtn = document.createElement("button");
  createBtn.textContent = "Create flow";
  createBtn.className = "primary flow-create-btn";
  createBtn.addEventListener("click", () => createFlow(card));
  createRow.appendChild(createBtn);

  card.appendChild(createRow);

  return card;
}

async function loadFlowsPage() {
  const container = document.getElementById("flows-devices");
  let devices;
  try {
    devices = await api("GET", "/api/devices");
  } catch (err) {
    container.innerHTML = `<div class="empty">${err.message}</div>`;
    return;
  }

  const txDevices = Object.values(devices)
    .filter((d) => d.channels && d.channels.transmitters && Object.keys(d.channels.transmitters).length > 0)
    .sort((a, b) => deviceLabel(a).localeCompare(deviceLabel(b)));

  if (txDevices.length === 0) {
    container.innerHTML = '<div class="empty">No transmit-capable devices found.</div>';
    return;
  }

  container.innerHTML = "";
  for (const device of txDevices) container.appendChild(buildFlowDeviceCard(device));
}

document.addEventListener("DOMContentLoaded", loadFlowsPage);
