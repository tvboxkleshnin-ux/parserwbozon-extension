(() => {
  const PANEL_ID = "pwbo-pepper-panel";
  const MARKET_RE =
    /https?:\/\/(?:www\.)?(?:wildberries\.(?:ru|by|kz)[^\s"'<>]*|ozon\.(?:ru|by|kz)[^\s"'<>]*|market\.yandex\.ru[^\s"'<>]*)/gi;

  function isPepperDeal() {
    const h = (location.hostname || "").toLowerCase();
    if (!/(^|\.)pepper\.ru$/.test(h)) return false;
    return /\/deals\//i.test(location.pathname);
  }

  function api(path, options = {}) {
    const body =
      options.body != null && typeof options.body !== "string"
        ? JSON.stringify(options.body)
        : options.body;
    return chrome.runtime.sendMessage({
      type: "api",
      path,
      options: {
        method: options.method || "GET",
        body,
      },
    }).then((res) => {
      if (!res || !res.ok) {
        const msg = res?.data?.message || res?.data?.error || "Сервер недоступен";
        throw new Error(msg);
      }
      return res.data;
    });
  }

  function formatPrice(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return `${Math.round(n).toLocaleString("ru-RU")} ₽`;
  }

  function marketplaceLabel(url) {
    const u = (url || "").toLowerCase();
    if (u.includes("wildberries")) return "WB";
    if (u.includes("ozon")) return "Ozon";
    if (u.includes("yandex")) return "Я.Маркет";
    return "?";
  }

  function normalizeCandidate(raw) {
    try {
      const u = new URL(raw.replace(/&amp;/g, "&"));
      const host = u.hostname.toLowerCase();
      if (host.includes("wildberries.")) {
        const m = u.pathname.match(/\/catalog\/(\d+)\/detail/i);
        if (m) return `https://www.wildberries.ru/catalog/${m[1]}/detail.aspx`;
      }
      if (host.includes("ozon.")) {
        const m = u.pathname.match(/\/product\/([^/?#]+)/i);
        if (m) return `https://www.ozon.ru/product/${m[1].replace(/\/$/, "")}/`;
      }
      if (host.includes("market.yandex.")) {
        const m = u.pathname.match(/\/product(?:--[^/]+)?\/(\d+)/i)
          || u.pathname.match(/\/card\/[^/]+\/(\d+)/i);
        if (m) return `https://market.yandex.ru/product/${m[1]}`;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function collectUrlsFromText(text) {
    const found = new Set();
    if (!text) return found;
    let m;
    const re = new RegExp(MARKET_RE.source, "gi");
    while ((m = re.exec(text)) !== null) {
      const n = normalizeCandidate(m[0]);
      if (n) found.add(n);
    }
    return found;
  }

  function parsePriceFromText(text) {
    if (!text) return null;
    const cleaned = text.replace(/\u00a0/g, " ").replace(/\s+/g, " ");
    const patterns = [
      /(\d[\d\s]{0,12})\s*(?:₽|руб\.?)/i,
      /(?:цена|сейчас|за)\s*(\d[\d\s]{0,12})/i,
    ];
    for (const p of patterns) {
      const m = cleaned.match(p);
      if (!m) continue;
      const n = Number(String(m[1]).replace(/\s/g, ""));
      if (n > 0 && n < 1e8) return n;
    }
    const digits = cleaned.replace(/[^\d]/g, "");
    if (digits.length >= 2 && digits.length <= 8) {
      const n = Number(digits);
      if (n > 0) return n;
    }
    return null;
  }

  function extractPepperDeal() {
    const title =
      (document.querySelector("h1")?.textContent || "").trim()
      || document.querySelector('meta[property="og:title"]')?.content
      || document.title
      || "Сделка Pepper";

    let price = null;
    let original = null;

    const priceSelectors = [
      '[data-t="threadPrice"]',
      ".threadItemCard-price",
      ".thread-price",
      ".cept-tp",
      '[class*="threadPrice"]',
      '[class*="ThreadPrice"]',
      '[class*="dealPrice"]',
      'span[class*="price"]',
    ];
    for (const sel of priceSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const n = parsePriceFromText(el.textContent || "");
        if (n != null) {
          price = n;
          break;
        }
      }
      if (price != null) break;
    }

    if (price == null) {
      const metaPrice =
        document.querySelector('meta[property="product:price:amount"]')?.content
        || document.querySelector('meta[property="og:price:amount"]')?.content;
      if (metaPrice) price = parsePriceFromText(metaPrice);
    }

    // старая цена рядом
    for (const el of document.querySelectorAll(
      '[class*="nextBestPrice"], [class*="listPrice"], [class*="oldPrice"], del, s'
    )) {
      const n = parsePriceFromText(el.textContent || "");
      if (n != null && (price == null || n > price)) {
        original = n;
        break;
      }
    }

    if (price == null) {
      // fallback: крупный блок в шапке сделки
      const h1 = document.querySelector("h1");
      const root = h1?.closest("article, main, [class*='thread'], [class*='deal']") || document.body;
      const chunk = (root?.innerText || "").slice(0, 2500);
      price = parsePriceFromText(chunk);
    }

    const urls = new Set();
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href || a.getAttribute("href") || "";
      for (const u of collectUrlsFromText(href)) urls.add(u);
      const dataUrl = a.getAttribute("data-href") || a.getAttribute("data-url") || "";
      for (const u of collectUrlsFromText(dataUrl)) urls.add(u);
    }
    for (const el of document.querySelectorAll("[data-href], [data-url], [data-link], [data-target-url]")) {
      const v =
        el.getAttribute("data-href")
        || el.getAttribute("data-url")
        || el.getAttribute("data-link")
        || el.getAttribute("data-target-url")
        || "";
      for (const u of collectUrlsFromText(v)) urls.add(u);
    }
    // JSON / HTML на случай скрытых ссылок в скриптах и разметке
    for (const u of collectUrlsFromText(document.documentElement.innerHTML)) urls.add(u);

    return {
      title: String(title).replace(/\s+/g, " ").trim().slice(0, 160),
      price,
      original_price: original,
      pepper_url: location.href.split("#")[0],
      offers: [...urls],
    };
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <button class="pwbo-close" type="button" title="Скрыть">×</button>
      <div class="pwbo-title">PARSERWBOZON · Pepper</div>
      <div class="pwbo-name"></div>
      <div class="pwbo-meta"></div>
      <div class="pwbo-offers"></div>
      <button class="pwbo-btn" type="button">Добавить в трекер</button>
      <div class="pwbo-status"></div>
    `;
    document.documentElement.appendChild(panel);
    panel.querySelector(".pwbo-close").addEventListener("click", () => {
      panel.dataset.closed = "1";
      panel.remove();
    });
    return panel;
  }

  function renderOffers(box, offers) {
    if (!offers.length) {
      box.innerHTML = `<div class="pwbo-empty">Нет прямых ссылок WB/Ozon/Я.Маркет на странице. Откройте «Перейти к предложению» и добавьте с карточки магазина.</div>`;
      return;
    }
    box.innerHTML = offers
      .map(
        (url, i) => `
      <label class="pwbo-offer">
        <input type="checkbox" data-i="${i}" checked />
        <span class="pwbo-badge">${marketplaceLabel(url)}</span>
        <span class="pwbo-offer-url" title="${url}">${url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 42)}</span>
      </label>`
      )
      .join("");
  }

  async function refreshPanel() {
    if (!isPepperDeal()) {
      document.getElementById(PANEL_ID)?.remove();
      return;
    }
    if (document.getElementById(PANEL_ID)?.dataset.closed === "1") return;

    const deal = extractPepperDeal();
    const panel = ensurePanel();
    const nameEl = panel.querySelector(".pwbo-name");
    const metaEl = panel.querySelector(".pwbo-meta");
    const offersEl = panel.querySelector(".pwbo-offers");
    const btn = panel.querySelector(".pwbo-btn");
    const status = panel.querySelector(".pwbo-status");

    nameEl.textContent = deal.title;
    metaEl.textContent = deal.price != null
      ? `Цена Pepper: ${formatPrice(deal.price)}${deal.original_price ? ` (было ${formatPrice(deal.original_price)})` : ""} · ссылок: ${deal.offers.length}`
      : `Цена Pepper не найдена · ссылок: ${deal.offers.length}`;

    renderOffers(offersEl, deal.offers);

    btn.disabled = !deal.offers.length || deal.price == null;
    btn.textContent = deal.offers.length
      ? `Добавить ${deal.offers.length} с baseline Pepper`
      : "Нет ссылок для добавления";

    if (deal.price == null && deal.offers.length) {
      status.textContent = "Найдены ссылки, но цену Pepper не распознал — проверьте карточку";
      status.className = "pwbo-status err";
      btn.disabled = false;
      btn.textContent = `Добавить ${deal.offers.length} без baseline`;
    } else if (!deal.offers.length) {
      status.textContent = "Жду появления ссылок магазинов…";
      status.className = "pwbo-status";
    } else {
      status.textContent = "Готово к импорту";
      status.className = "pwbo-status ok";
    }

    btn.onclick = async () => {
      const checked = [...offersEl.querySelectorAll("input[type=checkbox]:checked")]
        .map((el) => deal.offers[Number(el.dataset.i)])
        .filter(Boolean);
      if (!checked.length) {
        status.textContent = "Выберите хотя бы одну ссылку";
        status.className = "pwbo-status err";
        return;
      }
      btn.disabled = true;
      status.textContent = "Добавляю…";
      status.className = "pwbo-status";
      try {
        const res = await api("/api/add", {
          method: "POST",
          body: {
            urls: checked,
            name: deal.title,
            price: deal.price,
            original_price: deal.original_price,
            source: "pepper",
            pepper_url: deal.pepper_url,
          },
        });
        status.textContent = res.message || "Добавлено";
        status.className = "pwbo-status ok";
      } catch (e) {
        status.textContent = e.message || "Ошибка";
        status.className = "pwbo-status err";
      } finally {
        btn.disabled = false;
      }
    };
  }

  let lastKey = "";
  function tick() {
    if (!isPepperDeal()) {
      document.getElementById(PANEL_ID)?.remove();
      lastKey = "";
      return;
    }
    const deal = extractPepperDeal();
    const key = `${location.pathname}|${deal.price}|${deal.offers.join(",")}|${deal.title.slice(0, 40)}`;
    if (key !== lastKey) {
      lastKey = key;
      refreshPanel();
    }
  }

  tick();
  setInterval(tick, 2000);
  // динамическая подгрузка офферов
  const mo = new MutationObserver(() => {
    if (isPepperDeal()) tick();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
