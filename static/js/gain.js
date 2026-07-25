function deviceKey(device) {
  return device.name || device.server_name;
}

function buildRow(device, numberRaw, channel, channelType) {
  const number = Number(numberRaw);
  const deviceType = channelType === "tx" ? "input" : "output";
  const label = channelType === "tx" ? "input" : "output";

  const row = document.createElement("div");
  row.className = "gain-row";

  const chanLabel = document.createElement("div");
  chanLabel.className = "chan-label";
  const name = document.createElement("div");
  name.textContent = channel.friendly_name || channel.name || `CH${number}`;
  const dev = document.createElement("div");
  dev.className = "device";
  dev.textContent = `${deviceLabel(device)} · ${label}`;
  chanLabel.appendChild(name);
  chanLabel.appendChild(dev);
  row.appendChild(chanLabel);

  const buttons = document.createElement("div");
  buttons.style.display = "flex";
  buttons.style.gap = "6px";
  for (let level = 1; level <= 5; level++) {
    const btn = document.createElement("button");
    btn.textContent = String(level);
    btn.addEventListener("click", async () => {
      buttons.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        await api("POST", "/api/set-gain", {
          device: deviceKey(device),
          channel_number: number,
          gain_level: level,
          device_type: deviceType,
        });
        buttons.querySelectorAll("button").forEach((b) => b.classList.remove("primary"));
        btn.classList.add("primary");
        showToast(`Set ${dev.textContent} · ${name.textContent} to level ${level}`);
      } catch (err) {
        showToast(err.message, true);
      } finally {
        buttons.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    });
    buttons.appendChild(btn);
  }
  row.appendChild(buttons);

  if (channel.volume !== undefined && channel.volume !== null) {
    const reported = document.createElement("span");
    reported.className = "unsupported";
    reported.textContent = `reported: ${channel.volume}`;
    row.appendChild(reported);
  }

  return row;
}

function renderGain(devices) {
  const list = document.getElementById("gain-list");
  const sorted = Object.values(devices).sort((a, b) => deviceLabel(a).localeCompare(deviceLabel(b)));

  const rows = [];
  for (const device of sorted) {
    const tx = (device.channels && device.channels.transmitters) || {};
    const rx = (device.channels && device.channels.receivers) || {};
    for (const number of Object.keys(tx).sort((a, b) => Number(a) - Number(b))) {
      rows.push(buildRow(device, number, tx[number] || {}, "tx"));
    }
    for (const number of Object.keys(rx).sort((a, b) => Number(a) - Number(b))) {
      rows.push(buildRow(device, number, rx[number] || {}, "rx"));
    }
  }

  if (rows.length === 0) {
    list.innerHTML = '<div class="empty">No channels found yet.</div>';
    return;
  }

  list.innerHTML = "";
  for (const row of rows) list.appendChild(row);
}

document.addEventListener("DOMContentLoaded", () => {
  DanteStore.subscribe(renderGain);
});
