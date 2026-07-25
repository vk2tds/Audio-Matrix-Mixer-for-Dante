function formatUpdated(epochSeconds) {
  if (!epochSeconds) return "–";
  return new Date(epochSeconds * 1000).toLocaleString();
}

async function loadPresets() {
  const tbody = document.getElementById("presets-rows");
  let presets;
  try {
    presets = await api("GET", "/api/presets");
  } catch (err) {
    tbody.innerHTML = `<tr><td class="empty" colspan="4">${err.message}</td></tr>`;
    return;
  }

  if (presets.length === 0) {
    tbody.innerHTML = '<tr><td class="empty" colspan="4">No presets saved yet.</td></tr>';
    return;
  }

  tbody.innerHTML = "";
  for (const preset of presets) {
    const tr = document.createElement("tr");

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
  td.colSpan = 4;
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

document.addEventListener("DOMContentLoaded", loadPresets);
