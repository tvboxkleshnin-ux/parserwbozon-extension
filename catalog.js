(() => {
  const PANEL_ID = "pwbo-catalog-panel";

  function isWbHost() {
    return /wildberries\.(ru|by|kz)$/i.test(location.hostname);
  }

  function isWbSearch() {
    const path = (location.pathname || "").toLowerCase();
    const q = (location.search || "").toLowerCase();
    return (
      /search\.aspx/i.test(path)
      || /\/search(\/|$)/i.test(path)
      || /[?&]search=/i.test(q)
    );
  }

  function isWbBrand() {
    return /\/brands\//i.test(location.pathname || "");
  }

  function brandSlug() {
    const m = (location.pathname || "").match(/\/brands\/([^/?#]+)/i);
    if (!m) return "";
    try {
      return decodeURIComponent(m[1]).replace(/[-_+]/g, " ").trim();
    } catch {
      return m[1].replace(/[-_+]/g, " ").trim();
    }
  }

  function isWbSeller() {
    return /\/seller\//i.test(location.pathname || "");
  }

  function sellerSlug() {
    const m = (location.pathname || "").match(/\/seller\/([^/?#]+)/i);
    if (!m) return "";
    try {
      return decodeURIComponent(m[1]).replace(/[-_+]/g, " ").trim();
    } catch {
      return m[1].replace(/[-_+]/g, " ").trim();
    }
  }

  function isWbOtherSellers() {
    return /\/catalog\/\d+\/other-sellers/i.test(location.pathname || "");
  }

  function otherSellersNm() {
    const m = (location.pathname || "").match(/\/catalog\/(\d+)\/other-sellers/i);
    return m ? m[1] : "";
  }

  function isWbListing() {
    if (!isWbHost()) return false;
    if (/\/catalog\/\d+\/detail/i.test(location.pathname)) return false;
    if (isWbOtherSellers()) return true;
    if (isWbSearch()) return true;
    if (isWbBrand()) return true;
    if (isWbSeller()) return true;
    if (/\/catalog\//i.test(location.pathname)) return true;
    return false;
  }

  function searchQuery() {
    try {
      const q = new URLSearchParams(location.search).get("search");
      return (q || "").replace(/\+/g, " ").trim();
    } catch {
      return "";
    }
  }

  function listingKind() {
    if (isWbOtherSellers()) return "other_sellers";
    if (isWbSeller()) return "seller";
    if (isWbBrand()) return "brand";
    if (isWbSearch()) return "search";
    return "catalog";
  }

  function nmFromHref(href) {
    const s = String(href || "");
    let m = s.match(/\/catalog\/(\d+)\/detail/i);
    if (m) return m[1];
    m = s.match(/\/catalog\/(\d+)(?:\/?(?:[?#]|$))/i);
    if (m && m[1] !== "0") return m[1];
    return "";
  }

  async function api(path, options = {}) {
    const body =
      options.body != null && typeof options.body !== "string"
        ? JSON.stringify(options.body)
        : options.body;
    const res = await chrome.runtime.sendMessage({
      type: "api",
      path,
      options: {
        method: options.method || "GET",
        body,
      },
    });
    if (!res || !res.ok) {
      const msg = res?.data?.message || res?.data?.error || "Сервер недоступен";
      throw new Error(msg);
    }
    return res.data;
  }

  function formatPrice(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return `${Math.round(n).toLocaleString("ru-RU")} ₽`;
  }

  function parsePrice(text) {
    const digits = String(text || "").replace(/[^\d]/g, "");
    if (!digits) return null;
    const n = Number(digits);
    return n > 0 && n < 1e8 ? n : null;
  }

  function parseStock(text) {
    if (!text) return null;
    const t = String(text).replace(/\u00a0/g, " ");
    const m = t.match(/остал[оа]сь\s*([\d\s]{1,20})/i) || t.match(/остаток[^\d]*([\d\s]{1,20})/i);
    if (!m) return null;
    const parts = String(m[1]).match(/\d+/g) || [];
    const nums = parts.map(Number).filter((n) => Number.isFinite(n) && n > 0 && n <= 5000);
    if (!nums.length) return null;
    if (nums.length === 1) return nums[0] <= 9999 ? nums[0] : null;
    const sum = nums.reduce((a, b) => a + b, 0);
    return sum > 0 && sum <= 20000 ? sum : null;
  }

  const CHINA_RE =
    /из[- ]?китая|с китая|со склада в китае|склад в китае|доставка из китая|из-за рубежа|from china|china warehouse/i;

  function looksFromChina(text) {
    return CHINA_RE.test(String(text || ""));
  }

  function readSortLabel() {
    const sels = [
      ".dropdown-filter__btn",
      "[class*='sort'] button",
      "[class*='sorting'] button",
      ".sorter button",
      "button[class*='dropdown']",
    ];
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (/популяр|дешев|дорог|рейтинг|нов|скидк|актуаль/i.test(t) && t.length < 40) {
          return t;
        }
      }
    }
    return "";
  }

  let extraById = new Map();
  let extraNm = "";

  function addCard(byId, id, patch) {
    if (!id) return;
    const prev = byId.get(id) || extraById.get(id) || {};
    byId.set(id, {
      productId: id,
      name: patch.name || prev.name || `WB ${id}`,
      price: patch.price != null ? patch.price : prev.price,
      stock: patch.stock != null ? patch.stock : prev.stock,
      url: `https://www.wildberries.ru/catalog/${id}/detail.aspx`,
      from_china: patch.from_china != null ? !!patch.from_china : !!prev.from_china,
    });
  }

  function extractCards() {
    const byId = new Map();

    const cards = document.querySelectorAll(
      [
        "article.product-card",
        ".product-card",
        "[data-nm-id]",
        "[data-popup-nm-id]",
        "[class*='product-card']",
        "[class*='productCard']",
        ".j-card-item",
        ".goods-card",
      ].join(", ")
    );

    for (const card of cards) {
      let id =
        card.getAttribute("data-nm-id")
        || card.getAttribute("data-popup-nm-id")
        || card.getAttribute("data-card-nm-id")
        || "";
      if (!id) {
        const a = card.querySelector(
          'a[href*="/catalog/"], a[href*="/detail.aspx"]'
        );
        id = nmFromHref(a?.getAttribute("href") || a?.href || "");
      }
      if (!id) continue;

      const name =
        (
          card.querySelector(
            ".product-card__name, .goods-name, [class*='productName'], [class*='goods-name']"
          )?.textContent
          || card.querySelector("img[alt]")?.getAttribute("alt")
          || ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120);

      const priceEl =
        card.querySelector(
          ".price__lower-price, .price-block__wallet-price, .price-block__final-price, ins.price__lower-price, [class*='priceBlockWallet'], [class*='priceBlockFinal'], [class*='lowerPrice']"
        ) || card.querySelector("[class*='price']");
      const price = parsePrice(priceEl?.textContent || "")
        || parsePrice((card.innerText || "").split("\n").slice(0, 8).join(" "));

      addCard(byId, id, {
        name,
        price,
        stock: parseStock(card.innerText || ""),
        from_china: looksFromChina(card.innerText || ""),
      });
    }

    // всегда добираем по ссылкам (поиск WB часто рендерит иначе)
    for (const a of document.querySelectorAll('a[href*="/catalog/"]')) {
      const id = nmFromHref(a.getAttribute("href") || a.href || "");
      if (!id) continue;
      const root =
        a.closest("article, .product-card, [class*='product-card'], [class*='productCard'], li, .j-card-item")
        || a.parentElement
        || a;
      const name =
        (root.querySelector?.(".product-card__name, .goods-name")?.textContent
          || a.getAttribute("aria-label")
          || a.textContent
          || root.querySelector?.("img[alt]")?.getAttribute("alt")
          || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120);
      const price =
        parsePrice(root.querySelector?.(".price__lower-price, ins, [class*='price']")?.textContent || "")
        || parsePrice((root.innerText || "").slice(0, 500));
      addCard(byId, id, {
        name: name || undefined,
        price,
        stock: parseStock(root.innerText || ""),
        from_china: looksFromChina(root.innerText || ""),
      });
    }

    for (const [id, extra] of extraById) {
      addCard(byId, id, extra);
    }

    return [...byId.values()];
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <button class="pwbo-close" type="button" title="Скрыть">×</button>
      <div class="pwbo-title">PARSERWBOZON · выдача</div>
      <div class="pwbo-name"></div>
      <div class="pwbo-meta"></div>
      <div class="pwbo-stats"></div>
      <button class="pwbo-btn" type="button">Добавить видимые в мониторинг</button>
      <div class="pwbo-status"></div>
    `;
    document.documentElement.appendChild(panel);
    panel.querySelector(".pwbo-close").addEventListener("click", () => {
      panel.dataset.closed = "1";
      panel.remove();
    });
    return panel;
  }

  function summarize(items) {
    const withPrice = items.filter((x) => x.price != null).sort((a, b) => a.price - b.price);
    return {
      count: items.length,
      priced: withPrice.length,
      cheapest: withPrice[0] || null,
      stockKnown: items.filter((x) => x.stock != null).length,
      sort: readSortLabel(),
    };
  }

  async function refreshPanel() {
    if (!isWbListing()) {
      document.getElementById(PANEL_ID)?.remove();
      return;
    }
    if (document.getElementById(PANEL_ID)?.dataset.closed === "1") return;

    const items = extractCards();
    const s = summarize(items);
    const panel = ensurePanel();
    const kind = listingKind();
    const q = searchQuery();
    const brand = brandSlug();
    const kindLabel =
      kind === "other_sellers"
        ? "других продавцов"
        : kind === "seller"
        ? "продавца"
        : kind === "brand"
          ? "бренда"
          : kind === "search"
            ? "поиска"
            : "каталога";
    const sourceByKind = {
      other_sellers: "wb_other_sellers",
      seller: "wb_seller",
      brand: "wb_brand",
      search: "wb_search",
      catalog: "wb_catalog",
    };

    panel.querySelector(".pwbo-title").textContent =
      kind === "other_sellers"
        ? "PARSERWBOZON · другие продавцы"
        : kind === "seller"
        ? "PARSERWBOZON · продавец"
        : kind === "brand"
          ? "PARSERWBOZON · бренд"
          : kind === "search"
            ? "PARSERWBOZON · поиск"
            : "PARSERWBOZON · каталог";

    const nameEl = panel.querySelector(".pwbo-name");
    const metaEl = panel.querySelector(".pwbo-meta");
    const statsEl = panel.querySelector(".pwbo-stats");
    const btn = panel.querySelector(".pwbo-btn");
    const status = panel.querySelector(".pwbo-status");

    if (kind === "other_sellers") {
      nameEl.textContent = document.title.replace(/\s+/g, " ").trim().slice(0, 80)
        || `Варианты ${otherSellersNm()}`;
    } else if (kind === "seller") {
      const s = sellerSlug();
      nameEl.textContent = s
        ? `Продавец: ${s}`
        : (document.title.replace(/\s+/g, " ").trim().slice(0, 80) || "Продавец WB");
    } else if (kind === "brand") {
      nameEl.textContent = brand
        ? `Бренд: ${brand}`
        : (document.title.replace(/\s+/g, " ").trim().slice(0, 80) || "Бренд WB");
    } else if (kind === "search" && q) {
      nameEl.textContent = `Поиск: ${q}`;
    } else {
      nameEl.textContent = document.title.replace(/\s+/g, " ").trim().slice(0, 80) || "Выдача WB";
    }

    metaEl.textContent = s.sort
      ? `Сортировка: ${s.sort}`
      : "Прокрутите выдачу — подгрузятся карточки";

    statsEl.textContent = s.cheapest
      ? `Видимо: ${s.count} · с ценой: ${s.priced} · мин ${formatPrice(s.cheapest.price)}`
      : `Видимо: ${s.count} карточек`;

    btn.disabled = !items.length;
    btn.textContent = items.length
      ? kind === "other_sellers"
        ? `Добавить ${items.length} вариантов (ниже всех, без Китая)`
        : `Добавить ${items.length} из ${kindLabel} (алерт ≥10%)`
      : "Нет карточек — прокрутите страницу";

    btn.onclick = async () => {
      const current = extractCards();
      if (!current.length) {
        status.textContent = "Нет товаров";
        status.className = "pwbo-status err";
        return;
      }
      btn.disabled = true;
      status.textContent = `Добавляю ${current.length}…`;
      status.className = "pwbo-status";
      try {
        const res = await api("/api/add", {
          method: "POST",
          body: {
            alert_mode: "catalog",
            source: sourceByKind[kind] || "wb_catalog",
            catalog_url: location.href.split("#")[0],
            brand: kind === "brand" ? brand : undefined,
            seller: kind === "seller" ? sellerSlug() : undefined,
            match_nm: kind === "other_sellers" ? otherSellersNm() : undefined,
            items: current.map((x) => ({
              url: x.url,
              name: x.name,
              price: x.price,
              stock: x.stock,
              from_china: !!x.from_china,
            })),
          },
        });
        const added = Number(res.added || 0);
        const already = Number(res.already || 0);
        status.textContent =
          res.message
          || (already && !added
            ? `Уже в мониторинге: ${already}`
            : `Готово: +${added}`);
        status.className =
          !res.ok || (Number(res.failed || 0) > 0 && !added && !already)
            ? "pwbo-status err"
            : "pwbo-status ok";
      } catch (e) {
        status.textContent = e.message || "Ошибка";
        status.className = "pwbo-status err";
      } finally {
        btn.disabled = false;
      }
    };

    if (!items.length) {
      status.textContent = "Прокрутите ленту — подгрузка карточек";
      status.className = "pwbo-status";
    } else {
      status.textContent =
        kind === "other_sellers"
          ? "Все варианты · уведомление, если цена ниже всех локальных (Китай не в пороге)"
          : kind === "brand" || kind === "seller"
          ? `${kind === "seller" ? "Продавец" : "Бренд"}: уведомление только при падении ≥10%`
          : "Режим каталога: уведомление только при падении ≥10%";
      status.className = "pwbo-status ok";
    }
  }

  async function ensureOtherSellersApi() {
    if (!isWbOtherSellers()) return;
    const nm = otherSellersNm();
    if (!nm || extraNm === nm) return;
    extraNm = nm;
    extraById = new Map();
    try {
      const res = await chrome.runtime.sendMessage({ type: "wb_other_sellers", nm });
      for (const it of res?.items || []) {
        if (it?.productId) extraById.set(String(it.productId), it);
      }
      lastKey = "";
      refreshPanel();
    } catch {
      extraNm = "";
    }
  }

  let lastKey = "";
  function tick() {
    if (!isWbListing()) {
      document.getElementById(PANEL_ID)?.remove();
      lastKey = "";
      return;
    }
    ensureOtherSellersApi();
    const items = extractCards();
    const key = `${location.pathname}${location.search}|${items.length}|${items
      .slice(0, 8)
      .map((x) => x.productId)
      .join(",")}`;
    if (key !== lastKey) {
      lastKey = key;
      refreshPanel();
    }
  }

  function watchSpaNavigation() {
    let href = location.href;
    const fire = () => {
      if (location.href === href) {
        tick();
        return;
      }
      href = location.href;
      lastKey = "";
      extraNm = "";
      extraById = new Map();
      document.getElementById(PANEL_ID)?.remove();
      tick();
    };
    const wrap = (method) => {
      const orig = history[method];
      if (typeof orig !== "function") return;
      history[method] = function (...args) {
        const ret = orig.apply(this, args);
        queueMicrotask(fire);
        return ret;
      };
    };
    wrap("pushState");
    wrap("replaceState");
    window.addEventListener("popstate", fire);
    window.addEventListener("hashchange", fire);
  }

  watchSpaNavigation();
  tick();
  setInterval(tick, 1200);
})();
