function formatTimestamp(epochSeconds) {
  return new Date(epochSeconds * 1000).toLocaleString();
}

function formatDetail(detail) {
  if (detail === null || detail === undefined) return "";
  if (typeof detail === "string") return detail;
  try {
    return Object.entries(detail)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ");
  } catch {
    return JSON.stringify(detail);
  }
}

async function loadActivity() {
  const tbody = document.getElementById("activity-rows");
  tbody.innerHTML = '<tr><td class="empty" colspan="4">Loading…</td></tr>';

  let events;
  try {
    events = await api("GET", "/api/activity");
  } catch (err) {
    tbody.innerHTML = `<tr><td class="empty" colspan="4">${err.message}</td></tr>`;
    return;
  }

  if (events.length === 0) {
    tbody.innerHTML = '<tr><td class="empty" colspan="4">No activity recorded yet.</td></tr>';
    return;
  }

  tbody.innerHTML = "";
  for (const ev of events) {
    const tr = document.createElement("tr");

    const timeTd = document.createElement("td");
    timeTd.textContent = formatTimestamp(ev.timestamp);
    tr.appendChild(timeTd);

    const kindTd = document.createElement("td");
    kindTd.textContent = ev.kind;
    tr.appendChild(kindTd);

    const detailTd = document.createElement("td");
    detailTd.className = "activity-detail";
    detailTd.textContent = formatDetail(ev.detail);
    tr.appendChild(detailTd);

    const resultTd = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = "status-pill";
    const dot = document.createElement("span");
    dot.className = "dot " + (ev.ok ? "online" : "offline");
    pill.appendChild(dot);
    pill.appendChild(document.createTextNode(ev.ok ? "ok" : ev.error || "error"));
    resultTd.appendChild(pill);
    tr.appendChild(resultTd);

    tbody.appendChild(tr);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadActivity();
  document.getElementById("activity-reload-btn").addEventListener("click", loadActivity);
});
