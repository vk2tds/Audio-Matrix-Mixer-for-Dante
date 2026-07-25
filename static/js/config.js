function buildRow(labelText, inputEl, onSave) {
  const row = document.createElement("div");
  row.className = "config-row";

  const label = document.createElement("label");
  label.textContent = labelText;
  row.appendChild(label);
  row.appendChild(inputEl);

  const btn = document.createElement("button");
  btn.textContent = "Save";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await onSave(inputEl.value.trim());
      showToast(`Saved ${labelText.toLowerCase()}`);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });
  row.appendChild(btn);

  return row;
}

function buildTextRow(labelText, value, onSave) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value || "";
  return buildRow(labelText, input, onSave);
}

function buildNumberRow(labelText, value, onSave) {
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  if (value !== null && value !== undefined) input.value = value;
  return buildRow(labelText, input, onSave);
}

function buildSelectRow(labelText, currentValue, options, onSave) {
  const select = document.createElement("select");
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt;
    o.textContent = opt;
    if (currentValue !== null && currentValue !== undefined && Number(currentValue) === Number(opt)) {
      o.selected = true;
    }
    select.appendChild(o);
  }
  return buildRow(labelText, select, onSave);
}

function buildToggleRow(labelText, checked, onChange) {
  const row = document.createElement("div");
  row.className = "config-row";

  const label = document.createElement("label");
  label.textContent = labelText;
  row.appendChild(label);

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = Boolean(checked);
  input.addEventListener("change", async () => {
    input.disabled = true;
    try {
      await onChange(input.checked);
      showToast(`${labelText} ${input.checked ? "enabled" : "disabled"}`);
    } catch (err) {
      input.checked = !input.checked;
      showToast(err.message, true);
    } finally {
      input.disabled = false;
    }
  });
  row.appendChild(input);

  return row;
}

function buildChannelsSection(device) {
  const details = document.createElement("details");
  details.className = "config-channels";
  const summary = document.createElement("summary");
  summary.textContent = "Channels";
  details.appendChild(summary);

  const tx = (device.channels && device.channels.transmitters) || {};
  const rx = (device.channels && device.channels.receivers) || {};

  for (const [type, chans] of [["tx", tx], ["rx", rx]]) {
    const numbers = Object.keys(chans).sort((a, b) => Number(a) - Number(b));
    for (const num of numbers) {
      const chan = chans[num] || {};
      const row = buildTextRow(`${type.toUpperCase()} CH${num}`, chan.friendly_name || chan.name, async (value) => {
        await api("POST", "/api/rename-channel", {
          device: deviceKey(device),
          channel_type: type,
          channel_number: Number(num),
          name: value,
        });
      });
      details.appendChild(row);
    }
  }

  return details;
}

function buildDeviceCard(device) {
  const card = document.createElement("div");
  card.className = "config-card";

  const header = document.createElement("div");
  header.className = "config-card-header";
  const h3 = document.createElement("h3");
  h3.textContent = deviceLabel(device);
  header.appendChild(h3);
  const status = document.createElement("span");
  status.className = "status-pill";
  const dot = document.createElement("span");
  dot.className = "dot " + (device.online ? "online" : "offline");
  status.appendChild(dot);
  status.appendChild(document.createTextNode(device.online ? "online" : "offline"));
  header.appendChild(status);
  card.appendChild(header);

  card.appendChild(
    buildTextRow("Device name", device.name || device.server_name, async (value) => {
      await api("POST", "/api/rename-device", { device: deviceKey(device), name: value });
    })
  );

  card.appendChild(
    buildNumberRow("Latency (ms)", device.latency, async (value) => {
      await api("POST", "/api/set-latency", { device: deviceKey(device), latency: Number(value) });
    })
  );

  card.appendChild(
    buildSelectRow("Sample rate (Hz)", device.sample_rate, [44100, 48000, 88200, 96000], async (value) => {
      await api("POST", "/api/set-sample-rate", { device: deviceKey(device), sample_rate: Number(value) });
    })
  );

  card.appendChild(
    buildSelectRow("Encoding (bit)", null, [16, 24, 32], async (value) => {
      await api("POST", "/api/set-encoding", { device: deviceKey(device), encoding: Number(value) });
    })
  );

  card.appendChild(
    buildToggleRow("AES67", device.aes67_current, async (checked) => {
      await api("POST", "/api/set-aes67", { device: deviceKey(device), enabled: checked });
    })
  );

  card.appendChild(buildChannelsSection(device));

  return card;
}

function renderConfig(devices) {
  const list = document.getElementById("config-list");
  const sorted = Object.values(devices).sort((a, b) => deviceLabel(a).localeCompare(deviceLabel(b)));

  if (sorted.length === 0) {
    list.innerHTML = '<div class="empty">No devices discovered yet.</div>';
    return;
  }

  list.innerHTML = "";
  for (const device of sorted) list.appendChild(buildDeviceCard(device));
}

async function loadConfig() {
  const list = document.getElementById("config-list");
  try {
    const devices = await api("GET", "/api/devices");
    renderConfig(devices);
  } catch (err) {
    list.innerHTML = `<div class="empty">${err.message}</div>`;
  }
}

// Loaded once (not live-subscribed): rebuilding these forms on every SSE
// update would blow away whatever the user is mid-typing. Use "Reload" to
// pull fresh values from the daemon.
document.addEventListener("DOMContentLoaded", () => {
  loadConfig();
  const reloadBtn = document.getElementById("config-reload-btn");
  if (reloadBtn) reloadBtn.addEventListener("click", loadConfig);
});
