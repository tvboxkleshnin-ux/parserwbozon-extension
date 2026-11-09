const DEFAULT_API = "http://192.168.0.45:5000";

async function getApiBase() {
  const data = await chrome.storage.sync.get({ apiBase: DEFAULT_API });
  return (data.apiBase || DEFAULT_API).replace(/\/$/, "");
}

function formatAgo(ts) {
  if (!ts) return "ещё не было";
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec} с назад`;
  if (sec < 3600) return `${Math.round(sec / 60)} мин назад`;
  return `${Math.round(sec / 3600)} ч назад`;
}

async function refresh() {
  const status = document.getElementById("status");
  const count = document.getElementById("count");
  const interval = document.getElementById("interval");
  const lastCheck = document.getElementById("lastCheck");
  const apiBase = await getApiBase();
  document.getElementById("apiBase").value = apiBase;
  const local = await chrome.storage.local.get({ lastCheckAt: 0, lastCheckResult: null });
  const lr = local.lastCheckResult;
  lastCheck.textContent = lr
    ? `${formatAgo(local.lastCheckAt)} · ${lr.updated || 0} цен`
    : formatAgo(local.lastCheckAt);
  try {
    const res = await fetch(`${apiBase}/api/health`);
    const data = await res.json();
    if (!data.ok) throw new Error("bad");
    status.textContent = "Сервер работает · цены WB — через расширение";
    status.className = "ok";
    count.textContent = String(data.products_count ?? "—");
    interval.textContent = `${data.interval_minutes ?? "—"} мин`;
  } catch {
    status.textContent = "Сервер недоступен. Проверьте адрес и firewall NAS";
    status.className = "err";
    count.textContent = "—";
    interval.textContent = "—";
  }
}

document.getElementById("save").addEventListener("click", async () => {
  let apiBase = document.getElementById("apiBase").value.trim().replace(/\/$/, "");
  if (!apiBase) apiBase = DEFAULT_API;
  await chrome.storage.sync.set({ apiBase });
  await refresh();
});

document.getElementById("open").addEventListener("click", async () => {
  const apiBase = await getApiBase();
  chrome.tabs.create({ url: apiBase + "/" });
});

document.getElementById("checkNow").addEventListener("click", async () => {
  const btn = document.getElementById("checkNow");
  const status = document.getElementById("status");
  btn.disabled = true;
  btn.textContent = "Проверяю…";
  try {
    const r = await chrome.runtime.sendMessage({ type: "check_prices_now" });
    if (r?.ok) {
      status.textContent = `Обновлено: ${r.updated || 0}` + (r.changed ? `, изменилось: ${r.changed}` : "");
      status.className = "ok";
    } else {
      status.textContent = r?.message || "Ошибка проверки";
      status.className = "err";
    }
  } catch (e) {
    status.textContent = e.message || String(e);
    status.className = "err";
  }
  btn.disabled = false;
  btn.textContent = "Проверить цены сейчас";
  await refresh();
});

refresh();
