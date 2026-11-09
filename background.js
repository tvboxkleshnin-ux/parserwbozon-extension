const DEFAULT_API = "http://192.168.0.45:5000";
const ALARM_NAME = "pwbo_price_check";
const CHECK_MINUTES = 15;
const WB_BATCH = 20;

async function getApiBase() {
  const data = await chrome.storage.sync.get({ apiBase: DEFAULT_API });
  return (data.apiBase || DEFAULT_API).replace(/\/$/, "");
}

function humanizeNetworkError(message, apiBase) {
  const m = String(message || "").toLowerCase();
  if (
    !m
    || m === "failed to fetch"
    || m.includes("networkerror")
    || m.includes("network error")
    || m.includes("err_connection")
  ) {
    return `Сервер недоступен (${apiBase || DEFAULT_API}). Нужен UI на NAS :5000 (app.py). Парсер может быть на ноутбуке — это нормально. Проверьте URL в popup.`;
  }
  return message;
}

async function api(path, options = {}) {
  const API = await getApiBase();
  const res = await fetch(`${API}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body != null ? options.body : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok || data.ok === true, status: res.status, data };
}

const OPEN_ALARM = "pwbo_open_queue";

function scheduleAlarm() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_MINUTES });
  // автооткрытие вкладок отключено (спамило); при необходимости вернуть OPEN_ALARM
  chrome.alarms.clear(OPEN_ALARM);
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    runPriceCheck().catch(() => {});
  }
  // OPEN_ALARM намеренно не обрабатываем
});

async function drainOpenQueue() {
  return;
}
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === "api") {
    (async () => {
      try {
        sendResponse(await api(msg.path || "/", msg.options || {}));
      } catch (e) {
        const API = await getApiBase();
        sendResponse({
          ok: false,
          status: 0,
          data: {
            ok: false,
            message: humanizeNetworkError(
              e.message ||
                "Сервер недоступен. Проверьте URL в popup и что app.py запущен на NAS",
              API
            ),
          },
        });
      }
    })();
    return true;
  }

  if (msg.type === "check_prices_now") {
    runPriceCheck()
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, message: e.message || String(e) }));
    return true;
  }

  if (msg.type === "wb_other_sellers") {
    fetchWbOtherSellers(msg.nm, msg.name)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, items: [], message: e.message || String(e) }));
    return true;
  }

  return false;
});

async function syncWbCookies() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: ".wildberries.ru" });
    if (!cookies.length) return { ok: false, message: "нет cookies WB" };
    const text = cookies.map((c) => `${c.name}=${c.value}`).join("\n");
    return api("/api/cookies", {
      method: "POST",
      body: JSON.stringify({ cookies: text }),
    });
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
}

function priceFromProduct(p) {
  let bestCurrent = null;
  let bestOriginal = null;
  if (p.salePriceU != null || p.priceU != null) {
    bestCurrent = (p.salePriceU ?? p.priceU) / 100;
    if (p.salePriceU != null && p.priceU != null && p.salePriceU < p.priceU) {
      bestOriginal = p.priceU / 100;
    }
  } else {
    for (const size of p.sizes || []) {
      const pr = size.price || {};
      const product = pr.product;
      const basic = pr.basic;
      if (product == null && basic == null) continue;
      const cur = (product ?? basic) / 100;
      const orig =
        product != null && basic != null && basic > product ? basic / 100 : null;
      if (bestCurrent == null || cur < bestCurrent) {
        bestCurrent = cur;
        bestOriginal = orig;
      }
    }
  }
  if (bestCurrent == null) return null;
  let discount = 0;
  if (bestOriginal && bestOriginal > bestCurrent) {
    discount = Math.round((1 - bestCurrent / bestOriginal) * 100);
  }
  return {
    price: Math.round(bestCurrent * 100) / 100,
    original_price:
      bestOriginal != null ? Math.round(bestOriginal * 100) / 100 : null,
    discount_percent: discount,
    name: p.name || "",
  };
}

async function fetchWbBatch(nms) {
  const dests = ["-1257786", "-1029256", "-1216601", "-1221148"];
  const found = new Map();
  const pending = new Set(nms.map(String));
  for (const dest of dests) {
    if (!pending.size) break;
    const list = [...pending].join(";");
    const url =
      `https://card.wb.ru/cards/v4/detail?appType=1&curr=rub&dest=${dest}&nm=${list}&spp=30`;
    try {
      const res = await fetch(url, {
        credentials: "omit",
        headers: {
          Accept: "application/json",
          "Accept-Language": "ru-RU,ru;q=0.9",
          Referer: "https://www.wildberries.ru/",
        },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const products = data?.products || data?.data?.products || [];
      for (const p of products) {
        const id = String(p.id);
        if (!pending.has(id)) continue;
        const price = priceFromProduct(p);
        if (!price) continue;
        found.set(id, price);
        pending.delete(id);
      }
    } catch {
      /* next dest */
    }
  }
  return found;
}

async function fetchWbJson(url) {
  const res = await fetch(url, {
    credentials: "omit",
    headers: {
      Accept: "application/json",
      "Accept-Language": "ru-RU,ru;q=0.9",
      Referer: "https://www.wildberries.ru/",
    },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

function maxWbDeliveryHours(p) {
  let best = 0;
  for (const sz of p?.sizes || []) {
    best = Math.max(best, Number(sz.time1) || 0, Number(sz.time2) || 0);
    for (const st of sz.stocks || []) {
      best = Math.max(best, Number(st.time1) || 0, Number(st.time2) || 0);
    }
  }
  return best;
}

const WB_CHINA_RE =
  /из[- ]?китая|с китая|со склада в китае|склад в китае|доставка из китая|отправк\w* из китая|из-за рубежа|from china|china warehouse/i;

function isWbFromChina(p, name, supplier) {
  const text = [name, supplier, p?.name, p?.supplier, p?.entity]
    .filter(Boolean)
    .join(" ");
  if (text && WB_CHINA_RE.test(text)) return true;
  if (text && /[\u4e00-\u9fff]/.test(text)) return true;
  return maxWbDeliveryHours(p) >= 360;
}

function itemFromWbProduct(p) {
  if (!p?.id) return null;
  const price = priceFromProduct(p);
  if (!price) return null;
  const id = String(p.id);
  return {
    productId: id,
    name: (p.name || "").slice(0, 120),
    price: price.price,
    original_price: price.original_price,
    url: `https://www.wildberries.ru/catalog/${id}/detail.aspx`,
    supplierId: p.supplierId || null,
    matchId: p.matchId || null,
    from_china: isWbFromChina(p, p.name, p.supplier),
  };
}

async function fetchWbOtherSellers(nm, nameHint) {
  const id0 = String(nm || "").replace(/\D/g, "");
  if (!id0) return { ok: false, items: [], message: "нет артикула" };

  let card = null;
  for (const dest of ["-1257786", "-1029256", "-1216601"]) {
    const data = await fetchWbJson(
      `https://card.wb.ru/cards/v4/detail?appType=1&curr=rub&dest=${dest}&nm=${id0}&spp=30`
    );
    const products = data?.products || data?.data?.products || [];
    if (products[0]) {
      card = products[0];
      break;
    }
  }

  const found = new Map();
  const self = card ? itemFromWbProduct(card) : null;
  if (self) found.set(self.productId, self);

  const matchId = card?.matchId;
  const name = String(nameHint || card?.name || "").trim() || id0;
  if (!matchId) {
    return { ok: true, items: [...found.values()], matchId: null };
  }

  for (const ver of ["v18", "v14", "v13"]) {
    let gotPage = false;
    for (let page = 1; page <= 5; page++) {
      const params = new URLSearchParams({
        appType: "1",
        curr: "rub",
        dest: "-1257786",
        resultset: "catalog",
        sort: "popular",
        spp: "30",
        lang: "ru",
        locale: "ru",
        page: String(page),
        query: name,
        matchId: String(matchId),
      });
      const data = await fetchWbJson(
        `https://search.wb.ru/exactmatch/ru/common/${ver}/search?${params}`
      );
      if (!data) break;
      const products = data?.data?.products || data?.products || [];
      if (!products.length) break;
      gotPage = true;
      for (const p of products) {
        if (p.matchId != null && String(p.matchId) !== String(matchId)) continue;
        const it = itemFromWbProduct(p);
        if (it) found.set(it.productId, it);
      }
      if (products.length < 30) break;
    }
    if (gotPage) break;
  }

  return { ok: true, items: [...found.values()], matchId };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchOzonPrice(url) {
  try {
    const res = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ru-RU,ru;q=0.9",
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    let price = null;
    let original = null;
    let name = "";
    for (const key of ["cardPrice", "currentPrice", "price", "salePrice", "finalPrice"]) {
      const m = html.match(new RegExp(`"${key}"\\s*:\\s*"?(\\d+(?:\\.\\d+)?)"?`));
      if (m) {
        const n = Number(m[1]);
        if (n > 10 && n < 1e8) {
          price = n > 1e6 ? Math.round(n / 100) : Math.round(n);
          break;
        }
      }
    }
    for (const key of ["originalPrice", "oldPrice", "basePrice"]) {
      const m = html.match(new RegExp(`"${key}"\\s*:\\s*"?(\\d+(?:\\.\\d+)?)"?`));
      if (m) {
        const n = Number(m[1]);
        if (n > 10) {
          original = n > 1e6 ? Math.round(n / 100) : Math.round(n);
          break;
        }
      }
    }
    const nm = html.match(/"title"\s*:\s*"((?:[^"\\\\]|\\\\.)*)"/);
    if (nm) {
      try {
        name = JSON.parse(`"${nm[1]}"`).slice(0, 160);
      } catch {
        name = nm[1].slice(0, 160);
      }
    }
    if (price == null) {
      const m = html.match(/(\d[\d\s\u00a0\u202f]{2,})\s*₽/);
      if (m) price = Number(String(m[1]).replace(/[^\d]/g, "")) || null;
    }
    if (price == null || price <= 0) return null;
    let discount = 0;
    if (original && original > price) {
      discount = Math.round((1 - price / original) * 100);
    }
    return {
      price,
      original_price: original && original > price ? original : null,
      discount_percent: discount,
      name,
    };
  } catch {
    return null;
  }
}

async function fetchAliExpressPrice(url) {
  try {
    const res = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ru-RU,ru;q=0.9",
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (!html || html.length < 2000) return null;
    let price = null;
    let original = null;
    let name = "";
    const metaPrice =
      html.match(/property="og:price:amount"\s+content="([^"]+)"/i)
      || html.match(/itemprop="price"\s+content="([^"]+)"/i);
    if (metaPrice) {
      const n = Number(String(metaPrice[1]).replace(/[^\d.]/g, "").replace(",", "."));
      if (n > 0) price = n;
    }
    for (const key of ["actSkuCalPrice", "formatedActivityPrice", "precisePrice", "targetSalePrice"]) {
      if (price != null) break;
      const m = html.match(new RegExp(`"${key}"\\s*:\\s*"?([\\d.,\\s]+)"?`));
      if (m) {
        const n = Number(String(m[1]).replace(/[^\d.]/g, "").replace(",", "."));
        if (n > 0 && n < 1e8) price = n;
      }
    }
    const mSku = html.match(/"skuAmount"\s*:\s*\{\s*"value"\s*:\s*([\d.]+)/);
    if (price == null && mSku) {
      const n = Number(mSku[1]);
      if (n > 0) price = n;
    }
    const title =
      html.match(/property="og:title"\s+content="([^"]+)"/i)
      || html.match(/<title>([^<]+)<\/title>/i);
    if (title) name = title[1].replace(/\s*[-|].*$/, "").slice(0, 160);
    if (price == null || price <= 0) return null;
    const shipsFromRu =
      /со склада в рф|склад[ае]?\s+в\s+рф|склад[ае]?\s+в\s+россии|доставк\w*\s+из\s+(рф|россии)|отправк\w*\s+из\s+(рф|россии)|ships?\s*from\s*russia|russian warehouse|локальн\w+\s+склад/i.test(
        html.slice(0, 120000)
      ) || /"shipFrom(?:Country)?(?:Code)?"\s*:\s*"RU"/i.test(html)
      || /"storeCountry(?:Code)?"\s*:\s*"RU"/i.test(html);
    return {
      price: Math.round(price * 100) / 100,
      original_price: original,
      discount_percent: 0,
      name,
      ships_from_ru: shipsFromRu,
    };
  } catch {
    return null;
  }
}

async function runPriceCheck() {
  await syncWbCookies();
  const wl = await api("/api/watchlist");
  if (!wl.ok) {
    return { ok: false, message: wl.data?.message || "watchlist failed", updated: 0 };
  }
  const all = wl.data?.items || [];
  const wbItems = all.filter((it) => it.platform === "wildberries" && it.nm);
  const ozonItems = all.filter((it) => it.platform === "ozon");
  const aeItems = all.filter((it) => it.platform === "aliexpress");

  const reports = [];
  const byNm = new Map();
  for (const it of wbItems) {
    const nm = String(it.nm);
    if (!byNm.has(nm)) byNm.set(nm, []);
    byNm.get(nm).push(it);
  }
  const nmList = [...byNm.keys()];
  for (const batch of chunk(nmList, WB_BATCH)) {
    const prices = await fetchWbBatch(batch);
    for (const nm of batch) {
      const price = prices.get(nm);
      if (!price) continue;
      for (const it of byNm.get(nm) || []) {
        reports.push({
          url: it.url,
          name: price.name || it.name || "",
          price: price.price,
          original_price: price.original_price,
          discount_percent: price.discount_percent,
          source: "extension_wb",
        });
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  for (const it of ozonItems) {
    const price = await fetchOzonPrice(it.url);
    if (!price) continue;
    reports.push({
      url: it.url,
      name: price.name || it.name || "",
      price: price.price,
      original_price: price.original_price,
      discount_percent: price.discount_percent,
      source: "extension_ozon",
    });
    await new Promise((r) => setTimeout(r, 700));
  }

  for (const it of aeItems) {
    const price = await fetchAliExpressPrice(it.url);
    if (!price) continue;
    reports.push({
      url: it.url,
      name: price.name || it.name || "",
      price: price.price,
      original_price: price.original_price,
      discount_percent: price.discount_percent,
      source: "extension_ae",
      ships_from_ru: !!price.ships_from_ru,
    });
    await new Promise((r) => setTimeout(r, 700));
  }

  let updated = 0;
  let changed = 0;
  if (!reports.length) {
    const result = {
      ok: true,
      updated: 0,
      changed: 0,
      message: `Нет цен (WB ${wbItems.length}, Ozon ${ozonItems.length}, AE ${aeItems.length})`,
    };
    await chrome.storage.local.set({ lastCheckAt: Date.now(), lastCheckResult: result });
    return result;
  }
  for (const part of chunk(reports, 80)) {
    const rep = await api("/api/report", {
      method: "POST",
      body: JSON.stringify({ items: part }),
    });
    if (rep.ok) {
      updated += rep.data?.updated || 0;
      changed += rep.data?.changed || 0;
    }
  }
  const result = {
    ok: true,
    updated,
    changed,
    message: `обновлено ${updated} (WB ${wbItems.length} / Ozon ${ozonItems.length} / AE ${aeItems.length})`,
  };
  await chrome.storage.local.set({
    lastCheckAt: Date.now(),
    lastCheckResult: result,
  });
  return result;
}

scheduleAlarm();
