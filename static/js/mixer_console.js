const MIXER_SLOT_COUNT = 8;

let devices = [];
let mixers = [];
let currentBusId = null;
let latestMeters = { inputs: [], buses: [] };

// Matches the -60..0dB -> 0..100% convention already used on the netaudio
// Metering page (static/js/metering.js's levelToPercent), for visual
// consistency across the app even though this engine's own silence floor
// is -96dB.
function dbToPercent(db) {
  if (typeof db !== "number" || Number.isNaN(db)) return 0;
  const clamped = Math.max(-60, Math.min(0, db));
  return ((clamped + 60) / 60) * 100;
}

function meterDbFor(deviceUID, channel) {
  const meter = latestMeters.inputs.find((m) => m.deviceUID === deviceUID && m.channel === channel);
  return meter ? meter.peakDb : -96;
}

function updateVuBars() {
  const bus = currentBus();
  if (!bus) return;

  for (let slot = 0; slot < MIXER_SLOT_COUNT; slot++) {
    const fills = document.querySelectorAll(`#vu-slot-${slot} .bar-fill`);
    if (fills.length === 0) continue;
    const input = bus.inputs.find((i) => i.slot === slot);
    if (input && input.inputChannel) {
      fills[0].style.width = `${dbToPercent(meterDbFor(input.inputChannel.deviceUID, input.inputChannel.channel))}%`;
      if (fills[1]) {
        const rightDb =
          input.inputChannel.channel2 != null
            ? meterDbFor(input.inputChannel.deviceUID, input.inputChannel.channel2)
            : meterDbFor(input.inputChannel.deviceUID, input.inputChannel.channel);
        fills[1].style.width = `${dbToPercent(rightDb)}%`;
      }
    } else {
      fills.forEach((f) => (f.style.width = "0%"));
    }
  }

  const outEl = document.querySelector("#vu-output .bar-fill");
  if (outEl) {
    const meter = latestMeters.buses.find((b) => b.busId === bus.id);
    outEl.style.width = `${dbToPercent(meter ? meter.peakDb : -96)}%`;
  }
}

// Deliberately doesn't call /meters/stop on unload: the mixer engine's
// enabled flag is global, not per-connection, and the Mixer Panel page can
// independently be showing VU tiles at the same time — stopping here would
// silence its stream too. Once any page has asked for metering, it just
// stays on; the per-tick cost of nobody being connected to consume it is
// negligible (see MeteringState's doc comment in the engine).
function connectMeterStream() {
  api("POST", "/api/mixer/meters/start").catch(() => {});
  const source = new EventSource("/api/mixer/meters");
  source.addEventListener("message", (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    if (data.event !== "meter_levels") return;
    latestMeters = data;
    updateVuBars();
  });
  window.addEventListener("beforeunload", () => source.close());
}

function deviceByUID(uid) {
  return devices.find((d) => d.uid === uid);
}

function outputDevices() {
  return devices.filter((d) => d.hasOutput);
}

function inputDevices() {
  return devices.filter((d) => d.hasInput);
}

async function loadAll() {
  try {
    [devices, mixers] = await Promise.all([api("GET", "/api/mixer/devices"), api("GET", "/api/mixer/mixers")]);
  } catch (err) {
    document.getElementById("mixer-unreachable").style.display = "flex";
    document.getElementById("mixer-unreachable-msg").textContent = err.message;
    document.getElementById("bus-tabs").innerHTML = "";
    document.getElementById("bus-detail").style.display = "none";
    return;
  }
  document.getElementById("mixer-unreachable").style.display = "none";
  if (!currentBusId && mixers.length > 0) currentBusId = mixers[0].id;
  renderBusTabs();
  renderBusDetail();
  updateVuBars();
}

function renderBusTabs() {
  const container = document.getElementById("bus-tabs");
  container.innerHTML = "";
  for (const bus of mixers) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = bus.name === bus.id ? bus.id : `${bus.id} (${bus.name})`;
    if (bus.id === currentBusId) btn.className = "primary";
    btn.addEventListener("click", () => {
      currentBusId = bus.id;
      renderBusTabs();
      renderBusDetail();
      updateVuBars();
    });
    container.appendChild(btn);
  }
}

function currentBus() {
  return mixers.find((b) => b.id === currentBusId);
}

function renderBusDetail() {
  const bus = currentBus();
  const detail = document.getElementById("bus-detail");
  if (!bus) {
    detail.style.display = "none";
    return;
  }
  detail.style.display = "block";

  document.getElementById("bus-name-input").value = bus.name;

  const outSelect = document.getElementById("output-device-select");
  outSelect.innerHTML = "";
  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = "(default)";
  if (bus.output.device !== "(default)") defaultOpt.disabled = true; // no "clear route" API yet
  outSelect.appendChild(defaultOpt);
  for (const d of outputDevices()) {
    const opt = document.createElement("option");
    opt.value = d.name;
    opt.textContent = d.name;
    outSelect.appendChild(opt);
  }
  outSelect.value = bus.output.device === "(default)" ? "" : bus.output.device;

  document.getElementById("output-level-input").value = bus.output.levelDb;
  const outMuteBtn = document.getElementById("output-mute-btn");
  outMuteBtn.textContent = bus.output.muted ? "Unmute" : "Mute";
  outMuteBtn.className = bus.output.muted ? "" : "primary";

  const tbody = document.getElementById("slots-rows");
  tbody.innerHTML = "";
  for (let slot = 0; slot < MIXER_SLOT_COUNT; slot++) {
    const input = bus.inputs.find((i) => i.slot === slot) || { slot, inputChannel: null, levelDb: 0, muted: true };
    tbody.appendChild(renderSlotRow(bus.id, input));
  }
}

function populateChannelSelect(select, deviceUID, selectedChannel, { allowMono } = {}) {
  select.innerHTML = "";
  const device = deviceByUID(deviceUID);
  if (!device) {
    select.disabled = true;
    return;
  }
  select.disabled = false;
  if (allowMono) {
    const monoOpt = document.createElement("option");
    monoOpt.value = "";
    monoOpt.textContent = "(mono)";
    select.appendChild(monoOpt);
  }
  for (let ch = 0; ch < device.inputChannelCount; ch++) {
    const opt = document.createElement("option");
    opt.value = ch;
    opt.textContent = `Ch ${ch + 1}`;
    select.appendChild(opt);
  }
  select.value = selectedChannel != null ? selectedChannel : allowMono ? "" : 0;
}

function renderSlotRow(busId, input) {
  const tr = document.createElement("tr");

  const slotTd = document.createElement("td");
  slotTd.textContent = `Input ${input.slot + 1}`;
  tr.appendChild(slotTd);

  const deviceTd = document.createElement("td");
  const deviceSelect = document.createElement("select");
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "(none)";
  deviceSelect.appendChild(noneOpt);
  for (const d of inputDevices()) {
    const opt = document.createElement("option");
    opt.value = d.uid;
    opt.textContent = d.name;
    deviceSelect.appendChild(opt);
  }
  deviceSelect.value = (input.inputChannel && input.inputChannel.deviceUID) || "";
  deviceTd.appendChild(deviceSelect);
  tr.appendChild(deviceTd);

  const channelTd = document.createElement("td");
  const channelSelect = document.createElement("select");
  populateChannelSelect(
    channelSelect,
    input.inputChannel && input.inputChannel.deviceUID,
    input.inputChannel && input.inputChannel.channel
  );
  channelTd.appendChild(channelSelect);
  tr.appendChild(channelTd);

  const channel2Td = document.createElement("td");
  const channel2Select = document.createElement("select");
  populateChannelSelect(
    channel2Select,
    input.inputChannel && input.inputChannel.deviceUID,
    input.inputChannel && input.inputChannel.channel2,
    { allowMono: true }
  );
  channel2Td.appendChild(channel2Select);
  tr.appendChild(channel2Td);

  async function applyAssignment(label) {
    if (!deviceSelect.value) return;
    const channel2Raw = channel2Select.value;
    try {
      await api("PUT", `/api/mixer/mixers/${busId}/inputs/${input.slot}`, {
        deviceUID: deviceSelect.value,
        channel: Number(channelSelect.value),
        channel2: channel2Raw === "" ? null : Number(channel2Raw),
      });
      showToast(label);
      loadAll();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  deviceSelect.addEventListener("change", async () => {
    if (!deviceSelect.value) {
      populateChannelSelect(channelSelect, null, null);
      populateChannelSelect(channel2Select, null, null, { allowMono: true });
      try {
        await api("DELETE", `/api/mixer/mixers/${busId}/inputs/${input.slot}`);
        showToast(`Cleared input ${input.slot + 1}`);
        loadAll();
      } catch (err) {
        showToast(err.message, true);
      }
      return;
    }
    populateChannelSelect(channelSelect, deviceSelect.value, 0);
    populateChannelSelect(channel2Select, deviceSelect.value, null, { allowMono: true });
    await applyAssignment(`Assigned ${deviceByUID(deviceSelect.value).name} ch 1 (mono) to input ${input.slot + 1}`);
  });

  channelSelect.addEventListener("change", () => applyAssignment(`Input ${input.slot + 1} left channel updated`));
  channel2Select.addEventListener("change", () =>
    applyAssignment(
      channel2Select.value === "" ? `Input ${input.slot + 1} set to mono` : `Input ${input.slot + 1} now stereo`
    )
  );

  const levelTd = document.createElement("td");
  const levelInput = document.createElement("input");
  levelInput.type = "number";
  levelInput.step = "0.5";
  levelInput.style.width = "80px";
  levelInput.value = input.levelDb;
  levelInput.addEventListener("change", async () => {
    try {
      await api("PUT", `/api/mixer/mixers/${busId}/inputs/${input.slot}/level`, { levelDb: Number(levelInput.value) });
      showToast(`Input ${input.slot + 1} level set to ${levelInput.value} dB`);
    } catch (err) {
      showToast(err.message, true);
    }
  });
  levelTd.appendChild(levelInput);
  tr.appendChild(levelTd);

  const muteTd = document.createElement("td");
  const muteBtn = document.createElement("button");
  muteBtn.type = "button";
  muteBtn.textContent = input.muted ? "Unmute" : "Mute";
  muteBtn.className = input.muted ? "" : "primary";
  muteBtn.addEventListener("click", async () => {
    const newMuted = !input.muted;
    try {
      await api("PUT", `/api/mixer/mixers/${busId}/inputs/${input.slot}/mute`, { muted: newMuted });
      showToast(`Input ${input.slot + 1} ${newMuted ? "muted" : "unmuted"}`);
      loadAll();
    } catch (err) {
      showToast(err.message, true);
    }
  });
  muteTd.appendChild(muteBtn);
  tr.appendChild(muteTd);

  const vuTd = document.createElement("td");
  const vuBar = document.createElement("div");
  vuBar.className = "vu-bar";
  vuBar.id = `vu-slot-${input.slot}`;
  const subBarCount = input.inputChannel && input.inputChannel.channel2 != null ? 2 : 1;
  for (let i = 0; i < subBarCount; i++) {
    const track = document.createElement("div");
    track.className = "vu-bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    track.appendChild(fill);
    vuBar.appendChild(track);
  }
  vuTd.appendChild(vuBar);
  tr.appendChild(vuTd);

  return tr;
}

function wireBusControls() {
  document.getElementById("bus-name-save-btn").addEventListener("click", async () => {
    const bus = currentBus();
    if (!bus) return;
    const name = document.getElementById("bus-name-input").value.trim();
    if (!name) return;
    try {
      await api("PUT", `/api/mixer/mixers/${bus.id}/name`, { name });
      showToast(`Renamed to "${name}"`);
      loadAll();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById("output-device-select").addEventListener("change", async (e) => {
    const bus = currentBus();
    if (!bus || !e.target.value) return;
    try {
      await api("PUT", `/api/mixer/mixers/${bus.id}/output/route`, { device: e.target.value });
      showToast(`${bus.id} output routed to "${e.target.value}"`);
      loadAll();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById("output-level-input").addEventListener("change", async (e) => {
    const bus = currentBus();
    if (!bus) return;
    try {
      await api("PUT", `/api/mixer/mixers/${bus.id}/output/level`, { levelDb: Number(e.target.value) });
      showToast(`${bus.id} output level set to ${e.target.value} dB`);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById("output-mute-btn").addEventListener("click", async () => {
    const bus = currentBus();
    if (!bus) return;
    const newMuted = !bus.output.muted;
    try {
      await api("PUT", `/api/mixer/mixers/${bus.id}/output/mute`, { muted: newMuted });
      showToast(`${bus.id} output ${newMuted ? "muted" : "unmuted"}`);
      loadAll();
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  wireBusControls();
  loadAll();
  connectMeterStream();
});
