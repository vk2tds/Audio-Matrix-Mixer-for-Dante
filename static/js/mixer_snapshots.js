let mixers = [];

async function loadMixers() {
  try {
    mixers = await api("GET", "/api/mixer/mixers");
  } catch {
    mixers = []; // daemon unreachable — action rows fall back to a bus1-8/Input1-8 guess below
  }
}

function formatUpdated(epochSeconds) {
  if (!epochSeconds) return "–";
  return new Date(epochSeconds * 1000).toLocaleString();
}

function mixerActionLabel(action) {
  const target = action.slot == null ? "output" : `input ${action.slot + 1}`;
  const parts = [`${action.bus_id} · ${target}`];
  if (action.level_db != null) parts.push(`${action.level_db > 0 ? "+" : ""}${action.level_db} dB`);
  if (action.muted != null) parts.push(action.muted ? "muted" : "unmuted");
  return parts.join(" — ");
}

// --- manual action-row builder (stopgap until Mixer Console exists) -------

function addActionRow(prefill) {
  const container = document.getElementById("snap-dialog-actions");
  const row = document.createElement("div");
  row.className = "save-dialog-row mixer-action-row";

  const busList = mixers.length > 0 ? mixers.map((b) => b.id) : Array.from({ length: 8 }, (_, i) => `bus${i + 1}`);

  const busInput = document.createElement("select");
  busInput.className = "mixer-action-bus";
  busInput.style.flex = "1";
  for (const busId of busList) {
    const opt = document.createElement("option");
    opt.value = busId;
    opt.textContent = busId;
    busInput.appendChild(opt);
  }
  busInput.value = (prefill && prefill.bus_id) || busList[0] || "bus1";

  const slotSelect = document.createElement("select");
  slotSelect.className = "mixer-action-slot";
  slotSelect.style.width = "110px";

  function slotCountFor(busId) {
    const bus = mixers.find((b) => b.id === busId);
    return bus ? bus.inputs.length : 8; // fall back to 8 when daemon unreachable
  }

  function rebuildSlotOptions(preserveSlot) {
    const slotCount = slotCountFor(busInput.value);
    slotSelect.innerHTML =
      `<option value="">Output</option>` +
      Array.from({ length: slotCount }, (_, i) => `<option value="${i}">Input ${i + 1}</option>`).join("");
    if (preserveSlot != null) slotSelect.value = String(preserveSlot);
  }

  rebuildSlotOptions(prefill && prefill.slot);
  busInput.addEventListener("change", () => rebuildSlotOptions());

  const levelInput = document.createElement("input");
  levelInput.type = "number";
  levelInput.step = "0.5";
  levelInput.placeholder = "dB (blank = don't touch)";
  levelInput.className = "mixer-action-level";
  levelInput.style.width = "160px";
  if (prefill && prefill.level_db != null) levelInput.value = prefill.level_db;

  const muteSelect = document.createElement("select");
  muteSelect.className = "mixer-action-mute";
  muteSelect.style.width = "130px";
  muteSelect.innerHTML = `<option value="">Mute: unchanged</option><option value="true">Mute</option><option value="false">Unmute</option>`;
  if (prefill && prefill.muted === true) muteSelect.value = "true";
  else if (prefill && prefill.muted === false) muteSelect.value = "false";

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.textContent = "×";
  removeBtn.addEventListener("click", () => row.remove());

  row.appendChild(busInput);
  row.appendChild(slotSelect);
  row.appendChild(levelInput);
  row.appendChild(muteSelect);
  row.appendChild(removeBtn);
  container.appendChild(row);
}

function collectActions() {
  const actions = [];
  document.querySelectorAll("#snap-dialog-actions .mixer-action-row").forEach((row) => {
    const busId = row.querySelector(".mixer-action-bus").value.trim();
    if (!busId) return;
    const slotRaw = row.querySelector(".mixer-action-slot").value;
    const levelRaw = row.querySelector(".mixer-action-level").value;
    const muteRaw = row.querySelector(".mixer-action-mute").value;
    const levelDb = levelRaw === "" ? null : Number(levelRaw);
    const muted = muteRaw === "" ? null : muteRaw === "true";
    if (levelDb == null && muted == null) return; // nothing actually set on this row
    actions.push({ bus_id: busId, slot: slotRaw === "" ? null : Number(slotRaw), level_db: levelDb, muted });
  });
  return actions;
}

let editingSnapshotId = null;

function openNewSnapshotDialog() {
  editingSnapshotId = null;
  document.getElementById("snap-dialog-hint").textContent = "New snapshot";
  document.getElementById("snap-dialog-name").value = "";
  document.getElementById("snap-dialog-actions").innerHTML = "";
  addActionRow();
  document.getElementById("snap-dialog").style.display = "block";
}

async function openEditSnapshotDialog(snapshotId) {
  let detail;
  try {
    detail = await api("GET", `/api/mixer/snapshots/${snapshotId}`);
  } catch (err) {
    showToast(err.message, true);
    return;
  }
  editingSnapshotId = snapshotId;
  document.getElementById("snap-dialog-hint").textContent = `Edit "${detail.name}"`;
  document.getElementById("snap-dialog-name").value = detail.name;
  document.getElementById("snap-dialog-actions").innerHTML = "";
  if (detail.actions.length === 0) addActionRow();
  else detail.actions.forEach((action) => addActionRow(action));
  document.getElementById("snap-dialog").style.display = "block";
}

function closeSnapDialog() {
  document.getElementById("snap-dialog").style.display = "none";
  editingSnapshotId = null;
}

async function saveNewSnapshot() {
  const name = document.getElementById("snap-dialog-name").value.trim();
  if (!name) {
    showToast("Name is required", true);
    return;
  }
  const actions = collectActions();
  if (actions.length === 0) {
    showToast("Add at least one action with a level and/or mute set", true);
    return;
  }
  const body = editingSnapshotId ? { id: editingSnapshotId, name, actions } : { name, actions };
  try {
    await api("POST", "/api/mixer/snapshots", body);
    showToast(editingSnapshotId ? `Updated "${name}"` : `Created "${name}"`);
    closeSnapDialog();
    loadSnapshots();
  } catch (err) {
    showToast(err.message, true);
  }
}

// --- combine ----------------------------------------------------------

const selectedOrder = [];

function updateCombineToolbar() {
  const toolbar = document.getElementById("combine-toolbar");
  const btn = document.getElementById("combine-btn");
  toolbar.style.display = selectedOrder.length > 0 ? "flex" : "none";
  btn.textContent = `Combine ${selectedOrder.length} selected into new snapshot…`;
  btn.disabled = selectedOrder.length < 2;
}

async function combineSelected() {
  if (selectedOrder.length < 2) return;
  const name = prompt("Name for the combined snapshot:", "");
  if (!name || !name.trim()) return;

  const merged = new Map();
  try {
    for (const id of selectedOrder) {
      const detail = await api("GET", `/api/mixer/snapshots/${id}`);
      for (const action of detail.actions) {
        merged.set(`${action.bus_id}|${action.slot}`, action);
      }
    }
    await api("POST", "/api/mixer/snapshots", { name: name.trim(), actions: [...merged.values()] });
    showToast(`Created "${name.trim()}" from ${selectedOrder.length} snapshots`);
  } catch (err) {
    showToast(err.message, true);
    return;
  }

  selectedOrder.length = 0;
  loadSnapshots();
}

// --- list / rows --------------------------------------------------------

async function loadSnapshots() {
  const tbody = document.getElementById("snapshots-rows");
  let snapshots;
  try {
    snapshots = await api("GET", "/api/mixer/snapshots");
  } catch (err) {
    tbody.innerHTML = `<tr><td class="empty" colspan="5">${err.message}</td></tr>`;
    return;
  }

  updateCombineToolbar();

  if (snapshots.length === 0) {
    tbody.innerHTML = '<tr><td class="empty" colspan="5">No snapshots saved yet.</td></tr>';
    return;
  }

  tbody.innerHTML = "";
  for (const snapshot of snapshots) {
    const tr = document.createElement("tr");

    const checkTd = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedOrder.includes(snapshot.id);
    checkbox.addEventListener("change", () => {
      const idx = selectedOrder.indexOf(snapshot.id);
      if (checkbox.checked) {
        if (idx === -1) selectedOrder.push(snapshot.id);
      } else if (idx !== -1) {
        selectedOrder.splice(idx, 1);
      }
      updateCombineToolbar();
    });
    checkTd.appendChild(checkbox);
    tr.appendChild(checkTd);

    const nameTd = document.createElement("td");
    nameTd.textContent = snapshot.name;
    tr.appendChild(nameTd);

    const countTd = document.createElement("td");
    countTd.textContent = `${snapshot.action_count} action${snapshot.action_count === 1 ? "" : "s"}`;
    tr.appendChild(countTd);

    const updatedTd = document.createElement("td");
    updatedTd.textContent = formatUpdated(snapshot.updated_at);
    tr.appendChild(updatedTd);

    const actionsTd = document.createElement("td");
    actionsTd.style.display = "flex";
    actionsTd.style.gap = "6px";

    const viewBtn = document.createElement("button");
    viewBtn.textContent = "View";
    viewBtn.addEventListener("click", () => toggleDetail(tr, snapshot.id));
    actionsTd.appendChild(viewBtn);

    const applyBtn = document.createElement("button");
    applyBtn.textContent = "Apply";
    applyBtn.className = "primary";
    applyBtn.addEventListener("click", async () => {
      applyBtn.disabled = true;
      try {
        const result = await api("POST", `/api/mixer/snapshots/${snapshot.id}/apply`);
        const failed = result.total - result.applied;
        showToast(
          failed === 0
            ? `Applied "${snapshot.name}" (${result.applied}/${result.total})`
            : `Applied "${snapshot.name}" with ${failed} failure(s) (${result.applied}/${result.total})`,
          failed > 0
        );
      } catch (err) {
        showToast(err.message, true);
      } finally {
        applyBtn.disabled = false;
      }
    });
    actionsTd.appendChild(applyBtn);

    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => openEditSnapshotDialog(snapshot.id));
    actionsTd.appendChild(editBtn);

    const renameBtn = document.createElement("button");
    renameBtn.textContent = "Rename";
    renameBtn.addEventListener("click", async () => {
      const newName = prompt("Rename snapshot", snapshot.name);
      if (!newName || newName.trim() === "" || newName === snapshot.name) return;
      try {
        const detail = await api("GET", `/api/mixer/snapshots/${snapshot.id}`);
        await api("POST", "/api/mixer/snapshots", { id: snapshot.id, name: newName.trim(), actions: detail.actions });
        showToast(`Renamed to "${newName.trim()}"`);
        loadSnapshots();
      } catch (err) {
        showToast(err.message, true);
      }
    });
    actionsTd.appendChild(renameBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Delete snapshot "${snapshot.name}"?`)) return;
      try {
        await api("DELETE", `/api/mixer/snapshots/${snapshot.id}`);
        showToast(`Deleted "${snapshot.name}"`);
        loadSnapshots();
      } catch (err) {
        showToast(err.message, true);
      }
    });
    actionsTd.appendChild(deleteBtn);

    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  }
}

async function toggleDetail(afterRow, snapshotId) {
  const next = afterRow.nextElementSibling;
  if (next && next.classList.contains("preset-detail-row")) {
    next.remove();
    return;
  }
  document.querySelectorAll(".preset-detail-row").forEach((el) => el.remove());

  let detail;
  try {
    detail = await api("GET", `/api/mixer/snapshots/${snapshotId}`);
  } catch (err) {
    showToast(err.message, true);
    return;
  }

  const tr = document.createElement("tr");
  tr.className = "preset-detail-row";
  const td = document.createElement("td");
  td.colSpan = 5;
  const list = document.createElement("ul");
  list.className = "preset-action-list";
  for (const action of detail.actions) {
    const li = document.createElement("li");
    li.textContent = mixerActionLabel(action);
    list.appendChild(li);
  }
  td.appendChild(list);
  tr.appendChild(td);
  afterRow.parentNode.insertBefore(tr, afterRow.nextSibling);
}

document.addEventListener("DOMContentLoaded", () => {
  loadMixers();
  loadSnapshots();
  document.getElementById("combine-btn").addEventListener("click", combineSelected);
  document.getElementById("combine-clear-btn").addEventListener("click", () => {
    selectedOrder.length = 0;
    loadSnapshots();
  });
  document.getElementById("new-snapshot-btn").addEventListener("click", openNewSnapshotDialog);
  document.getElementById("snap-dialog-add-action-btn").addEventListener("click", () => addActionRow());
  document.getElementById("snap-dialog-save-btn").addEventListener("click", saveNewSnapshot);
  document.getElementById("snap-dialog-cancel-btn").addEventListener("click", closeSnapDialog);
});
