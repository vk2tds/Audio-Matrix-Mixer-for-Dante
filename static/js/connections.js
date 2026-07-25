
function renderConnections(devices) {
  const tbody = document.getElementById("connections-rows");
  const rows = [];

  for (const rxDevice of Object.values(devices)) {
    for (const sub of rxDevice.subscriptions || []) {
      if (!sub.tx_device) continue;
      rows.push({ rxDevice, sub });
    }
  }

  rows.sort((a, b) => {
    const al = deviceLabel(a.rxDevice);
    const bl = deviceLabel(b.rxDevice);
    if (al !== bl) return al.localeCompare(bl);
    return String(a.sub.rx_channel).localeCompare(String(b.sub.rx_channel));
  });

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td class="empty" colspan="5">No active connections.</td></tr>';
    return;
  }

  tbody.innerHTML = "";
  for (const { rxDevice, sub } of rows) {
    const tr = document.createElement("tr");

    const rxTd = document.createElement("td");
    rxTd.textContent = deviceLabel(rxDevice);
    tr.appendChild(rxTd);

    const rxChTd = document.createElement("td");
    rxChTd.textContent = sub.rx_channel;
    tr.appendChild(rxChTd);

    const txTd = document.createElement("td");
    txTd.textContent = sub.tx_device;
    tr.appendChild(txTd);

    const txChTd = document.createElement("td");
    txChTd.textContent = sub.tx_channel;
    tr.appendChild(txChTd);

    const actionTd = document.createElement("td");
    const btn = document.createElement("button");
    btn.textContent = "Unsubscribe";
    btn.addEventListener("click", async () => {
      const rxNumber = findRxChannelNumber(rxDevice, sub.rx_channel);
      if (rxNumber === null) {
        showToast("Could not resolve receive channel number", true);
        return;
      }
      btn.disabled = true;
      try {
        await api("POST", "/api/unsubscribe", { rx_device: deviceKey(rxDevice), rx_channel: rxNumber });
        showToast(`Unsubscribed ${deviceLabel(rxDevice)} · ${sub.rx_channel}`);
      } catch (err) {
        showToast(err.message, true);
      } finally {
        btn.disabled = false;
      }
    });
    actionTd.appendChild(btn);
    tr.appendChild(actionTd);

    tbody.appendChild(tr);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  DanteStore.subscribe(renderConnections);
});
