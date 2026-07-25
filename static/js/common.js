const DanteStore = (() => {
  let devices = {};
  const listeners = new Set();

  function notify() {
    for (const fn of listeners) fn(devices);
  }

  function seed() {
    fetch("/api/devices")
      .then((resp) => (resp.ok ? resp.json() : null))
      .then((data) => {
        if (data && Object.keys(devices).length === 0) {
          devices = data;
          notify();
        }
      })
      .catch(() => {});
  }

  function connect() {
    seed();
    const es = new EventSource("/api/events");

    es.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }

      switch (msg.event) {
        case "snapshot":
          devices = msg.devices || {};
          notify();
          break;
        case "device_discovered":
        case "device_updated":
          if (msg.server_name && msg.device) {
            devices = { ...devices, [msg.server_name]: msg.device };
            notify();
          }
          break;
        case "device_removed":
          if (msg.server_name && msg.server_name in devices) {
            devices = { ...devices };
            delete devices[msg.server_name];
            notify();
          }
          break;
        case "meter_values":
          window.dispatchEvent(new CustomEvent("dante:meter", { detail: msg }));
          break;
        case "subscription_pending":
          window.dispatchEvent(new CustomEvent("dante:subscription-pending", { detail: msg }));
          break;
        case "relay_unavailable":
          window.dispatchEvent(new CustomEvent("dante:relay-unavailable", { detail: msg }));
          break;
      }
    };

    es.onopen = () => {
      window.dispatchEvent(new CustomEvent("dante:connection", { detail: { connected: true } }));
    };

    es.onerror = () => {
      window.dispatchEvent(new CustomEvent("dante:connection", { detail: { connected: false } }));
    };

    return es;
  }

  function subscribe(fn) {
    listeners.add(fn);
    fn(devices);
    return () => listeners.delete(fn);
  }

  function getDevices() {
    return devices;
  }

  return { connect, subscribe, getDevices };
})();

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(path, opts);
  let data = null;
  try {
    data = await resp.json();
  } catch {
    /* no body */
  }
  if (!resp.ok || (data && data.error)) {
    const message = (data && data.error) || `Request failed (${resp.status})`;
    throw new Error(message);
  }
  return data;
}

function deviceLabel(device) {
  return device.name || device.server_name || "";
}

function deviceKey(device) {
  return device.name || device.server_name;
}

function findRxChannelNumber(rxDevice, rxChannelName) {
  const receivers = (rxDevice.channels && rxDevice.channels.receivers) || {};
  for (const [num, ch] of Object.entries(receivers)) {
    if (ch.name === rxChannelName) return Number(num);
  }
  return null;
}

function actionLabel(action) {
  if (action.action === "add") {
    return `+ ${action.tx_device_label || action.tx_device} · ${action.tx_channel_label || action.tx_channel} → ${action.rx_device_label || action.rx_device} · ${action.rx_channel_label || action.rx_channel}`;
  }
  return `− ${action.rx_device_label || action.rx_device} · ${action.rx_channel_label || action.rx_channel}`;
}

function showToast(message, isError) {
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isError ? 5000 : 2800);
}

document.addEventListener("DOMContentLoaded", () => {
  DanteStore.connect();

  const dot = document.getElementById("conn-dot");
  const label = document.getElementById("conn-label");
  if (dot) {
    window.addEventListener("dante:connection", (e) => {
      dot.classList.toggle("online", e.detail.connected);
      dot.classList.toggle("offline", !e.detail.connected);
      if (label) label.textContent = e.detail.connected ? "connected" : "reconnecting…";
    });
    window.addEventListener("dante:relay-unavailable", (e) => {
      dot.classList.remove("online");
      dot.classList.add("offline");
      if (label) label.textContent = "daemon unreachable";
      showToast(e.detail.error || "netaudio daemon unreachable", true);
    });
  }

  document.querySelectorAll("nav.tabs a").forEach((a) => {
    if (a.getAttribute("href") === window.location.pathname) {
      a.classList.add("active");
    }
  });

  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      try {
        await api("POST", "/api/refresh", {});
        showToast("Refreshed from daemon");
      } catch (err) {
        showToast(err.message, true);
      } finally {
        refreshBtn.disabled = false;
      }
    });
  }

  const themeToggle = document.getElementById("theme-toggle");
  if (themeToggle) {
    const setIcon = (theme) => {
      themeToggle.textContent = theme === "dark" ? "☀️" : "🌙";
    };
    setIcon(document.documentElement.getAttribute("data-theme") || "light");
    themeToggle.addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("dante-web-theme", next);
      setIcon(next);
    });
  }
});
