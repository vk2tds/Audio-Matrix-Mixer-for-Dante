// Mixer Meters: every physical input channel currently in use by any bus,
// plus every bus's output, all on one page. Unlike the Mixer Panel's VU
// tiles (which reference a specific {bus_id, slot} and have to resolve
// which physical channel that slot currently points to), this page just
// renders the mixer engine's /meters SSE payload directly — its `inputs`
// array is already deduplicated per physical channel (SPEC.md §7), and
// `buses` always has all 8 entries regardless of activity.

let mixers = []; // for bus display names
const inputCards = new Map(); // "deviceUID|channel" -> {el, valSpan, fill}
const busCards = new Map(); // busId -> {el, valSpan, fill}

// Matches metering.js's -60..0dB -> 0..100% convention, used everywhere
// else in this app's VU bars.
function dbToPercent(db) {
  if (typeof db !== "number" || Number.isNaN(db)) return 0;
  const clamped = Math.max(-60, Math.min(0, db));
  return ((clamped + 60) / 60) * 100;
}

function busLabel(busId) {
  const bus = mixers.find((b) => b.id === busId);
  return bus && bus.name && bus.name !== busId ? `${busId} (${bus.name})` : busId;
}

function buildMeterCard(label) {
  const card = document.createElement("div");
  card.className = "meter-channel";

  const labelRow = document.createElement("div");
  labelRow.className = "label";
  const nameSpan = document.createElement("span");
  nameSpan.textContent = label;
  const valSpan = document.createElement("span");
  valSpan.textContent = "–";
  labelRow.appendChild(nameSpan);
  labelRow.appendChild(valSpan);

  const track = document.createElement("div");
  track.className = "bar-track";
  const fill = document.createElement("div");
  fill.className = "bar-fill";
  track.appendChild(fill);

  card.appendChild(labelRow);
  card.appendChild(track);
  return { el: card, valSpan, fill };
}

function updateCard(card, db) {
  card.valSpan.textContent = typeof db === "number" ? `${db.toFixed(1)} dB` : "–";
  card.fill.style.width = `${dbToPercent(db)}%`;
}

function renderBusSkeleton() {
  const container = document.getElementById("mm-buses");
  container.innerHTML = "";
  busCards.clear();
  for (const bus of mixers) {
    const card = buildMeterCard(busLabel(bus.id));
    busCards.set(bus.id, card);
    container.appendChild(card.el);
  }
}

function applyMeters(data) {
  const inputsContainer = document.getElementById("mm-inputs");
  const seenInputKeys = new Set();

  for (const input of data.inputs) {
    const key = `${input.deviceUID}|${input.channel}`;
    seenInputKeys.add(key);
    let card = inputCards.get(key);
    if (!card) {
      card = buildMeterCard(`${input.deviceName} Ch${input.channel + 1}`);
      inputCards.set(key, card);
      inputsContainer.appendChild(card.el);
      const empty = inputsContainer.querySelector(".empty");
      if (empty) empty.remove();
    }
    updateCard(card, input.peakDb);
  }

  // Rare in practice (CaptureBridge instances persist for the mixer
  // engine's lifetime once created — see its STATUS.md), but handle a
  // channel disappearing gracefully rather than assume it can't happen.
  for (const [key, card] of inputCards) {
    if (!seenInputKeys.has(key)) {
      card.el.remove();
      inputCards.delete(key);
    }
  }
  if (inputCards.size === 0 && !inputsContainer.querySelector(".empty")) {
    inputsContainer.innerHTML =
      '<div class="empty">No input channels in use yet — assign one on the <a href="/mixer-console">Mixer</a> page.</div>';
  }

  for (const bus of data.buses) {
    const card = busCards.get(bus.busId);
    if (card) updateCard(card, bus.peakDb);
  }
}

// Doesn't call /meters/stop on unload — see mixer_console.js's
// connectMeterStream for why (global enabled flag, other pages may still
// want it).
async function connectMeterStream() {
  try {
    mixers = await api("GET", "/api/mixer/mixers");
    renderBusSkeleton();
    document.getElementById("mixer-meters-unreachable").style.display = "none";
  } catch (err) {
    document.getElementById("mixer-meters-unreachable").style.display = "flex";
    document.getElementById("mixer-meters-unreachable-msg").textContent = err.message;
    return;
  }

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
    applyMeters(data);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  connectMeterStream();
});
