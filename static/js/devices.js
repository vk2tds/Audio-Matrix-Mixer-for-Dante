function fmtLatency(ms) {
  if (ms === null || ms === undefined) return "–";
  return `${ms} ms`;
}

function renderDevices(devices) {
  const tbody = document.getElementById("device-rows");
  const entries = Object.values(devices).sort((a, b) => deviceLabel(a).localeCompare(deviceLabel(b)));

  if (entries.length === 0) {
    tbody.innerHTML = '<tr><td class="empty" colspan="8">No devices discovered yet.</td></tr>';
    return;
  }

  tbody.innerHTML = "";
  for (const device of entries) {
    const tr = document.createElement("tr");

    const statusTd = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = "status-pill";
    const dot = document.createElement("span");
    dot.className = "dot " + (device.online ? "online" : "offline");
    pill.appendChild(dot);
    pill.appendChild(document.createTextNode(device.online ? "online" : "offline"));
    statusTd.appendChild(pill);
    tr.appendChild(statusTd);

    const nameTd = document.createElement("td");
    nameTd.textContent = deviceLabel(device);
    tr.appendChild(nameTd);

    const modelTd = document.createElement("td");
    modelTd.textContent = [device.manufacturer, device.dante_model || device.board_name].filter(Boolean).join(" / ") || "–";
    tr.appendChild(modelTd);

    const addrTd = document.createElement("td");
    addrTd.textContent = device.ipv4 || "–";
    tr.appendChild(addrTd);

    const countsTd = document.createElement("td");
    countsTd.textContent = `${device.tx_count ?? 0} / ${device.rx_count ?? 0}`;
    tr.appendChild(countsTd);

    const rateTd = document.createElement("td");
    rateTd.textContent = device.sample_rate ? `${device.sample_rate} Hz` : "–";
    tr.appendChild(rateTd);

    const latencyTd = document.createElement("td");
    latencyTd.textContent = fmtLatency(device.latency);
    tr.appendChild(latencyTd);

    const actionTd = document.createElement("td");
    const btn = document.createElement("button");
    btn.textContent = "Identify";
    btn.disabled = !device.online;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api("POST", "/api/identify", { device: device.server_name });
        showToast(`Identify sent to ${deviceLabel(device)}`);
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
  DanteStore.subscribe(renderDevices);

  const restartBtn = document.getElementById("restart-daemon-btn");
  if (restartBtn) {
    restartBtn.addEventListener("click", async () => {
      restartBtn.disabled = true;
      try {
        const result = await api("POST", "/api/daemon/restart", {});
        showToast(result.message || "Daemon restart requested");
      } catch (err) {
        showToast(err.message, true);
      } finally {
        restartBtn.disabled = false;
      }
    });
  }
});
