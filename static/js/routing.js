const txCollapsed = new Set();
const rxCollapsed = new Set();
let txFilter = "";
let rxFilter = "";

function deviceKey(device) {
  return device.name || device.server_name;
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

async function toggleRoute(td, rx, tx, active) {
  td.classList.add("pending");
  try {
    if (active) {
      await api("POST", "/api/unsubscribe", { rx_device: deviceKey(rx.device), rx_channel: rx.number });
      showToast(`Unsubscribed ${deviceLabel(rx.device)} · ${rx.friendlyName}`);
    } else {
      await api("POST", "/api/subscribe", {
        rx_device: deviceKey(rx.device),
        rx_channel: rx.number,
        tx_channel: tx.name,
        tx_device: deviceKey(tx.device),
      });
      showToast(`Routed ${deviceLabel(tx.device)} · ${tx.friendlyName} → ${deviceLabel(rx.device)} · ${rx.friendlyName}`);
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

document.addEventListener("DOMContentLoaded", () => {
  const txInput = document.getElementById("filter-tx");
  const rxInput = document.getElementById("filter-rx");
  txInput.addEventListener("input", () => {
    txFilter = txInput.value;
    renderMatrix(DanteStore.getDevices());
  });
  rxInput.addEventListener("input", () => {
    rxFilter = rxInput.value;
    renderMatrix(DanteStore.getDevices());
  });

  DanteStore.subscribe(renderMatrix);
});
