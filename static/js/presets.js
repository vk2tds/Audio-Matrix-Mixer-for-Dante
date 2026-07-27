function formatUpdated(epochSeconds) {
  if (!epochSeconds) return "–";
  return new Date(epochSeconds * 1000).toLocaleString();
}

async function exportAllPresets() {
  let list;
  try {
    list = await api("GET", "/api/presets");
  } catch (err) {
    showToast(err.message, true);
    return;
  }
  if (list.length === 0) {
    showToast("No presets to export", true);
    return;
  }
  const full = [];
  for (const p of list) {
    try {
      const detail = await api("GET", `/api/presets/${p.id}`);
      full.push({ name: detail.name, actions: detail.actions });
    } catch (err) {
      showToast(err.message, true);
    }
  }
  const blob = new Blob([JSON.stringify(full, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "dante-web-presets.json";
  a.click();
  URL.revokeObjectURL(url);
}

function importPresetsFromFile(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch {
      showToast("Invalid JSON file", true);
      return;
    }
    const items = Array.isArray(data) ? data : [data];
    let count = 0;
    for (const item of items) {
      if (!item || !item.name || !item.actions) continue;
      try {
        await api("POST", "/api/presets", { name: item.name, actions: item.actions });
        count++;
      } catch (err) {
        showToast(err.message, true);
      }
    }
    showToast(`Imported ${count} preset(s)`);
    loadPresets();
  };
  reader.readAsText(file);
}

// Order matters: when combining, a later-selected preset's action for a
// given channel overrides an earlier one's, same as applying them in that
// order would. Tracked separately from checkbox DOM state so re-checking
// a box always sends it to the back of the queue.
const selectedOrder = [];

function updateCombineToolbar() {
  const toolbar = document.getElementById("combine-toolbar");
  const btn = document.getElementById("combine-btn");
  toolbar.style.display = selectedOrder.length > 0 ? "flex" : "none";
  btn.textContent = `Combine ${selectedOrder.length} selected into new preset…`;
  btn.disabled = selectedOrder.length < 2;
}

async function combineSelected() {
  if (selectedOrder.length < 2) return;
  const name = prompt("Name for the combined preset:", "");
  if (!name || !name.trim()) return;

  const merged = new Map();
  try {
    for (const id of selectedOrder) {
      const detail = await api("GET", `/api/presets/${id}`);
      for (const action of detail.actions) {
        merged.set(`${action.rx_device}|${action.rx_channel}`, action);
      }
    }
    await api("POST", "/api/presets", { name: name.trim(), actions: [...merged.values()] });
    showToast(`Created "${name.trim()}" from ${selectedOrder.length} presets`);
  } catch (err) {
    showToast(err.message, true);
    return;
  }

  selectedOrder.length = 0;
  loadPresets();
}

async function loadPresets() {
  const tbody = document.getElementById("presets-rows");
  let presets;
  try {
    presets = await api("GET", "/api/presets");
  } catch (err) {
    tbody.innerHTML = `<tr><td class="empty" colspan="5">${err.message}</td></tr>`;
    return;
  }

  updateCombineToolbar();

  if (presets.length === 0) {
    tbody.innerHTML = '<tr><td class="empty" colspan="5">No presets saved yet.</td></tr>';
    return;
  }

  tbody.innerHTML = "";
  for (const preset of presets) {
    const tr = document.createElement("tr");

    const checkTd = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedOrder.includes(preset.id);
    checkbox.addEventListener("change", () => {
      const idx = selectedOrder.indexOf(preset.id);
      if (checkbox.checked) {
        if (idx === -1) selectedOrder.push(preset.id);
      } else if (idx !== -1) {
        selectedOrder.splice(idx, 1);
      }
      updateCombineToolbar();
    });
    checkTd.appendChild(checkbox);
    tr.appendChild(checkTd);

    const nameTd = document.createElement("td");
    nameTd.textContent = preset.name;
    tr.appendChild(nameTd);

    const countTd = document.createElement("td");
    countTd.textContent = `${preset.action_count} action${preset.action_count === 1 ? "" : "s"}`;
    tr.appendChild(countTd);

    const updatedTd = document.createElement("td");
    updatedTd.textContent = formatUpdated(preset.updated_at);
    tr.appendChild(updatedTd);

    const actionsTd = document.createElement("td");
    actionsTd.style.display = "flex";
    actionsTd.style.gap = "6px";

    const viewBtn = document.createElement("button");
    viewBtn.textContent = "View";
    viewBtn.addEventListener("click", () => toggleDetail(tr, preset.id));
    actionsTd.appendChild(viewBtn);

    const applyBtn = document.createElement("button");
    applyBtn.textContent = "Apply";
    applyBtn.className = "primary";
    applyBtn.addEventListener("click", async () => {
      applyBtn.disabled = true;
      try {
        const result = await api("POST", `/api/presets/${preset.id}/apply`);
        const failed = result.total - result.applied;
        showToast(
          failed === 0
            ? `Applied "${preset.name}" (${result.applied}/${result.total})`
            : `Applied "${preset.name}" with ${failed} failure(s) (${result.applied}/${result.total})`,
          failed > 0
        );
      } catch (err) {
        showToast(err.message, true);
      } finally {
        applyBtn.disabled = false;
      }
    });
    actionsTd.appendChild(applyBtn);

    const renameBtn = document.createElement("button");
    renameBtn.textContent = "Rename";
    renameBtn.addEventListener("click", async () => {
      const newName = prompt("Rename preset", preset.name);
      if (!newName || newName.trim() === "" || newName === preset.name) return;
      try {
        const detail = await api("GET", `/api/presets/${preset.id}`);
        await api("POST", "/api/presets", { id: preset.id, name: newName.trim(), actions: detail.actions });
        showToast(`Renamed to "${newName.trim()}"`);
        loadPresets();
      } catch (err) {
        showToast(err.message, true);
      }
    });
    actionsTd.appendChild(renameBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Delete preset "${preset.name}"?`)) return;
      try {
        await api("DELETE", `/api/presets/${preset.id}`);
        showToast(`Deleted "${preset.name}"`);
        loadPresets();
      } catch (err) {
        showToast(err.message, true);
      }
    });
    actionsTd.appendChild(deleteBtn);

    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  }
}

async function toggleDetail(afterRow, presetId) {
  const next = afterRow.nextElementSibling;
  if (next && next.classList.contains("preset-detail-row")) {
    next.remove();
    return;
  }
  document.querySelectorAll(".preset-detail-row").forEach((el) => el.remove());

  let detail;
  try {
    detail = await api("GET", `/api/presets/${presetId}`);
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
    li.className = action.action === "add" ? "add" : "remove";
    li.textContent = actionLabel(action);
    list.appendChild(li);
  }
  td.appendChild(list);
  tr.appendChild(td);
  afterRow.parentNode.insertBefore(tr, afterRow.nextSibling);
}

document.addEventListener("DOMContentLoaded", () => {
  loadPresets();
  document.getElementById("combine-btn").addEventListener("click", combineSelected);
  document.getElementById("combine-clear-btn").addEventListener("click", () => {
    selectedOrder.length = 0;
    loadPresets();
  });

  document.getElementById("export-presets-btn").addEventListener("click", exportAllPresets);
  document.getElementById("import-presets-btn").addEventListener("click", () => {
    document.getElementById("import-presets-input").click();
  });
  document.getElementById("import-presets-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) importPresetsFromFile(file);
    e.target.value = "";
  });
});
