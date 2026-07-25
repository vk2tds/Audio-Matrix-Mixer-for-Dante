const activePolls = new Map(); // server_name -> interval id

function deviceKey(device) {
  return device.name || device.server_name;
}

function levelToPercent(level) {
  if (typeof level !== "number" || Number.isNaN(level)) return 0;
  const clamped = Math.max(-60, Math.min(0, level));
  return ((clamped + 60) / 60) * 100;
}

function renderChannels(container, section, title, channels) {
  const wrap = document.createElement("section");
  wrap.className = section;
  const h4 = document.createElement("h4");
  h4.textContent = title;
  wrap.appendChild(h4);

  const grid = document.createElement("div");
  grid.className = "meter-channels";

  const entries = Object.entries(channels || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "unsupported";
    empty.textContent = "no channels";
    grid.appendChild(empty);
  }

  for (const [number, info] of entries) {
    const cell = document.createElement("div");
    cell.className = "meter-channel";

    const label = document.createElement("div");
    label.className = "label";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = info.name || `CH${number}`;
    const valSpan = document.createElement("span");
    valSpan.textContent = typeof info.level === "number" ? info.level.toFixed(1) : "–";
    label.appendChild(nameSpan);
    label.appendChild(valSpan);
    cell.appendChild(label);

    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${levelToPercent(info.level)}%`;
    track.appendChild(fill);
    cell.appendChild(track);

    grid.appendChild(cell);
  }

  wrap.appendChild(grid);
  container.appendChild(wrap);
}

async function pollSnapshot(serverName, channelsEl) {
  try {
    const snap = await api("GET", `/api/metering/snapshot/${encodeURIComponent(serverName)}`);
    channelsEl.innerHTML = "";
    renderChannels(channelsEl, "tx", "Transmit", snap.tx);
    renderChannels(channelsEl, "rx", "Receive", snap.rx);
  } catch (err) {
    channelsEl.innerHTML = `<div class="unsupported">${err.message}</div>`;
  }
}

async function toggleMetering(device, btn, channelsEl) {
  const serverName = device.server_name;
  const isActive = activePolls.has(serverName);

  btn.disabled = true;
  try {
    if (isActive) {
      clearInterval(activePolls.get(serverName));
      activePolls.delete(serverName);
      await api("POST", "/api/metering/stop", { device: deviceKey(device) });
      btn.textContent = "Start metering";
      btn.classList.remove("primary");
      channelsEl.innerHTML = "";
    } else {
      await api("POST", "/api/metering/start", { device: deviceKey(device) });
      btn.textContent = "Stop metering";
      btn.classList.add("primary");
      pollSnapshot(serverName, channelsEl);
      const id = setInterval(() => pollSnapshot(serverName, channelsEl), 500);
      activePolls.set(serverName, id);
    }
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

function renderMeterList(devices) {
  const list = document.getElementById("meter-list");
  const sorted = Object.values(devices).sort((a, b) => deviceLabel(a).localeCompare(deviceLabel(b)));

  if (sorted.length === 0) {
    list.innerHTML = '<div class="empty">No devices discovered yet.</div>';
    return;
  }

  const existingServerNames = new Set(sorted.map((d) => d.server_name));
  for (const serverName of Array.from(activePolls.keys())) {
    if (!existingServerNames.has(serverName)) {
      clearInterval(activePolls.get(serverName));
      activePolls.delete(serverName);
    }
  }

  list.innerHTML = "";
  for (const device of sorted) {
    const card = document.createElement("div");
    card.className = "meter-device";

    const head = document.createElement("div");
    head.className = "head";
    const h3 = document.createElement("h3");
    h3.textContent = deviceLabel(device);
    const btn = document.createElement("button");
    const isActive = activePolls.has(device.server_name);
    btn.textContent = isActive ? "Stop metering" : "Start metering";
    if (isActive) btn.classList.add("primary");
    btn.disabled = !device.online;

    const channelsEl = document.createElement("div");
    btn.addEventListener("click", () => toggleMetering(device, btn, channelsEl));

    head.appendChild(h3);
    head.appendChild(btn);
    card.appendChild(head);
    card.appendChild(channelsEl);

    if (isActive) {
      pollSnapshot(device.server_name, channelsEl);
    }

    list.appendChild(card);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  DanteStore.subscribe(renderMeterList);
  window.addEventListener("beforeunload", () => {
    for (const id of activePolls.values()) clearInterval(id);
  });
});
