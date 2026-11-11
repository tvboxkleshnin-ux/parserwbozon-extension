(() => {
  const PANEL_ID = "pwbo-panel";
  const autoAdded = new Set();

  function isWbProduct() {
    return /wildberries\.(ru|by|kz)$/i.test(location.hostname)
      && /\/catalog\/\d+\/detail/i.test(location.pathname);
  }

  function isOzonProduct() {
    return /ozon\.(ru|by|kz|com)$/i.test(location.hostname)
      && /\/product\//i.test(location.pathname);
  }

  function isYandexProduct() {
    const h = (location.hostname || "").toLowerCase();
    if (!/(^|\.)market\.yandex\.(ru|by|kz)$/.test(h)) return false;
    return /\/product(?:--[^/]+)?\/\d+/i.test(location.pathname)
      || /\/card\/[^/]+\/\d+/i.test(location.pathname);
  }

  function extractWb() {
    const m = location.pathname.match(/\/catalog\/(\d+)\/detail/i);
    const productId = m ? m[1] : "";
    const titleEl =
      document.querySelector('[class*="productHeader"] h1, [class*="productHeader"] h2') ||
      document.querySelector('[class*="productImtName"]') ||
      document.querySelector("h1");
    let title = (titleEl?.textContent || "").trim();
    if (!title) {
      title = document.querySelector('[class*="productLineImg"] img[alt]')?.getAttribute("alt") || "";
    }
    const priceEl =
      document.querySelector(".price-block__wallet-price") ||
      document.querySelector(".price-block__final-price") ||
      document.querySelector('[class*="priceBlockWalletPrice"]') ||
      document.querySelector('[class*="priceBlockFinalPrice"]') ||
      document.querySelector("span.price-block__final-price");
    const priceText = (priceEl?.textContent || "").replace(/[^\d]/g, "");
    return {
      platform: "wildberries",
      productId,
      title: title.slice(0, 120),
      price: priceText ? Number(priceText) : null,
      url: `https://www.wildberries.ru/catalog/${productId}/detail.aspx`,
    };
  }

  function nmFromHref(href) {
    const s = String(href || "");
    let m = s.match(/\/catalog\/(\d+)\/detail/i);
    if (m) return m[1];
    m = s.match(/\/catalog\/(\d+)(?:\/?(?:[?#]|$))/i);
    if (m && m[1] !== "0") return m[1];
    return "";
  }

  function extractWbSellerLinks() {
    const byId = new Map();
    const nodes = document.querySelectorAll(
      [
        '[class*="otherSeller"] a',
        '[class*="other-seller"] a',
        '[class*="sellersList"] a',
        '[class*="seller-list"] a',
        '[class*="offerList"] a',
        '[class*="offers-list"] a',
        '[class*="SameProduct"] a',
        '[class*="same-product"] a',
        'a[href*="/other-sellers"]',
      ].join(",")
    );
    for (const a of nodes) {
      const id = nmFromHref(a.getAttribute("href") || a.href || "");
      if (!id) continue;
      const root = a.closest("li, article, [class*='seller'], [class*='offer'], div") || a;
      const priceEl = root.querySelector?.("[class*='price']");
      const digits = String(priceEl?.textContent || root.innerText || "").replace(/[^\d]/g, "");
      const n = Number(digits);
      byId.set(id, {
        productId: id,
        name: (a.getAttribute("aria-label") || a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
        price: n > 0 && n < 1e8 ? n : null,
        url: `https://www.wildberries.ru/catalog/${id}/detail.aspx`,
      });
    }
    return byId;
  }

  async function collectWbSellerVariants(product) {
    const byId = extractWbSellerLinks();
    if (product?.productId) {
      byId.set(product.productId, {
        productId: product.productId,
        name: product.title,
        price: product.price,
        url: product.url,
      });
    }
    try {
      const res = await chrome.runtime.sendMessage({
        type: "wb_other_sellers",
        nm: product.productId,
        name: product.title,
      });
      for (const it of res?.items || []) {
        if (!it?.productId) continue;
        const prev = byId.get(String(it.productId)) || {};
        byId.set(String(it.productId), {
          productId: String(it.productId),
          name: it.name || prev.name || product.title,
          price: it.price != null ? it.price : prev.price,
          url: it.url || `https://www.wildberries.ru/catalog/${it.productId}/detail.aspx`,
          from_china: it.from_china != null ? !!it.from_china : !!prev.from_china,
        });
      }
    } catch {
      /* API недоступен — оставляем DOM */
    }
    return [...byId.values()];
  }

  function extractFromJsonLd() {
    let title = "";
    let productId = "";
    let price = null;
    try {
      for (const script of document.querySelectorAll('script[type*="ld+json"]')) {
        let data;
        try {
          data = JSON.parse(script.textContent || "");
        } catch {
          continue;
        }
        const items = Array.isArray(data) ? data : [data];
        const graph = data?.["@graph"];
        if (Array.isArray(graph)) items.push(...graph);
        for (const item of items) {
          const type = item?.["@type"];
          const types = Array.isArray(type) ? type : [type];
          if (!types.some((t) => String(t).toLowerCase() === "product")) continue;
          title = String(item.name || "").trim();
          productId = String(item.sku || item.productID || "").trim();
          const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
          if (offer?.price != null) {
            price = Number(String(offer.price).replace(/[^\d.]/g, "")) || null;
          }
          break;
        }
        if (title || productId || price) break;
      }
    } catch {
      /* ignore */
    }
    return { title, productId, price };
  }

  function extractOzon() {
    const ld = extractFromJsonLd();
    let { title, productId, price } = ld;
    if (!productId) {
      const m = location.pathname.match(/\/product\/(?:[^/]*-)?(\d+)/i)
        || location.pathname.match(/\/product\/(\d+)/i);
      productId = m ? m[1] : "";
    }
    if (!title) title = (document.querySelector("h1")?.textContent || "").trim();
    const slug = location.pathname.match(/\/product\/([^/?#]+)/i)?.[1] || productId;
    return {
      platform: "ozon",
      productId,
      title: title.slice(0, 120),
      price,
      url: `https://www.ozon.ru/product/${slug}/`,
    };
  }

  function extractYandex() {
    const ld = extractFromJsonLd();
    let { title, productId, price } = ld;
    if (!productId) {
      const m = location.pathname.match(/\/product(?:--[^/]+)?\/(\d+)/i)
        || location.pathname.match(/\/card\/[^/]+\/(\d+)/i);
      productId = m ? m[1] : "";
    }
    if (!title) title = (document.querySelector("h1")?.textContent || "").trim();
    if (price == null) {
      const el =
        document.querySelector('[data-auto="snippet-price-current"]') ||
        document.querySelector('[data-auto="price-value"]') ||
        document.querySelector('[itemprop="price"]');
      const raw = el?.getAttribute("content") || el?.textContent || "";
      const digits = String(raw).replace(/[^\d]/g, "");
      if (digits) price = Number(digits);
    }
    return {
      platform: "yandex",
      productId,
      title: title.slice(0, 120),
      price,
      url: `https://market.yandex.ru/product/${productId}`,
    };
  }

  function isAliExpressProduct() {
    return /aliexpress\.(ru|com)$/i.test(location.hostname)
      && /\/item\/\d+/i.test(location.pathname);
  }

  function detectAeShipsFromRu(extraText) {
    const text = `${extraText || ""}\n${document.body?.innerText || ""}`;
    const html = (document.documentElement?.innerHTML || "").slice(0, 160000);
    const blob = `${text}\n${html}`;
    const fromRu =
      /со склада в рф|склад[ае]?\s+в\s+рф|склад[ае]?\s+в\s+россии|доставк\w*\s+из\s+(рф|россии)|отправк\w*\s+из\s+(рф|россии)|ships?\s*from\s*russia|russian warehouse|локальн\w+\s+склад/i.test(
        blob
      );
    const destOnly =
      /доставк\w*\s+в\s+росси|не доставляется в/i.test(blob) && !fromRu;
    if (destOnly) return false;
    if (fromRu) return true;
    if (/"shipFrom(?:Country)?(?:Code)?"\s*:\s*"RU"/i.test(html)) return true;
    if (/"storeCountry(?:Code)?"\s*:\s*"RU"/i.test(html)) return true;
    if (/"warehouseCountry"\s*:\s*"RU"/i.test(html)) return true;
    return false;
  }

  function parseRamRomPairs(text) {
    const s = String(text || "");
    const out = [];
    const seen = new Set();
    const push = (ram, rom) => {
      const a = Number(ram);
      const b = Number(rom);
      if (!(a >= 2 && a <= 32 && b >= 32 && b <= 2048)) return;
      const key = `${a}/${b}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ ram: a, rom: b, key });
    };
    // 6/128ГБ, 8/256 GB
    for (const m of s.matchAll(/(\d+)\s*[/／]\s*(\d+)\s*(?:гб|gb)?/gi)) {
      push(m[1], m[2]);
    }
    // 8GB 256GB / 8 ГБ 256 ГБ
    for (const m of s.matchAll(/(\d+)\s*(?:gb|гб)\s*[+/]?\s*(\d+)\s*(?:gb|гб)/gi)) {
      push(m[1], m[2]);
    }
    return out;
  }

  function extractAeBaseModel(title) {
    let t = String(title || "").replace(/\s+/g, " ").trim();
    t = t.replace(
      /(?:,?\s*)?\d+\s*[/／]\s*\d+\s*(?:гб|gb)?(?:\s*,\s*\d+\s*[/／]\s*\d+\s*(?:гб|gb)?)*/gi,
      " "
    );
    t = t.replace(/\b\d+\s*(?:gb|гб)\s+\d+\s*(?:gb|гб)\b/gi, " ");
    t = t.replace(/\bglobal\b/gi, " ").replace(/\s+/g, " ").trim();
    t = t.replace(/[,\s]+$/g, "").trim();
    return t || String(title || "").trim();
  }

  function extractAeSelectedMemory() {
    const chunks = [];
    const sels = [
      '[class*="sku-item--selected"]',
      '[class*="SkuValue--selected"]',
      '[class*="sku--selected"]',
      '[class*="skuProperty"] [class*="selected"]',
      '[class*="SkuPropertyItem"][class*="active"]',
      '[class*="sku-property-text"][class*="selected"]',
      'div[class*="sku"] [aria-checked="true"]',
      'div[class*="Sku"] [aria-pressed="true"]',
    ];
    for (const sel of sels) {
      document.querySelectorAll(sel).forEach((el) => {
        const t = (el.getAttribute("title") || el.textContent || "").replace(/\s+/g, " ").trim();
        if (t) chunks.push(t);
      });
    }
    // «Цвет: 8GB 256GB black» в характеристиках / выбранном SKU
    const bodySlice = (document.body?.innerText || "").slice(0, 9000);
    const colorLine = bodySlice.match(
      /(?:цвет|color|память|memory|версия|version)\s*[:：]\s*([^\n]{3,80})/i
    );
    if (colorLine) chunks.push(colorLine[1]);

    for (const chunk of chunks) {
      const pairs = parseRamRomPairs(chunk);
      if (pairs.length) return pairs[0];
    }
    // иногда выбранный пункт целиком «8GB 256GB black»
    for (const el of document.querySelectorAll(
      '[class*="sku"] [class*="selected"], [class*="Sku"] [class*="active"], [class*="sku-item"]'
    )) {
      const t = (el.getAttribute("title") || el.textContent || "").replace(/\s+/g, " ").trim();
      const pairs = parseRamRomPairs(t);
      if (pairs.length === 1 && /gb|гб|\d+\s*\/\s*\d+/i.test(t)) return pairs[0];
    }
    return null;
  }

  function extractAliExpress() {
    const m = location.pathname.match(/\/item\/(\d+)/i);
    const productId = m ? m[1] : "";
    let sku = "";
    try {
      sku = new URLSearchParams(location.search).get("sku_id")
        || new URLSearchParams(location.search).get("skuId")
        || "";
    } catch {
      sku = "";
    }

    const ld = extractFromJsonLd();
    let title = ld.title || "";
    let price = ld.price;

    if (!title) {
      title = (
        document.querySelector("h1")?.textContent
        || document.querySelector('[class*="title"] h1')?.textContent
        || document.querySelector('meta[property="og:title"]')?.getAttribute("content")
        || ""
      ).trim();
    }

    if (price == null) {
      const meta =
        document.querySelector('meta[property="og:price:amount"]')?.getAttribute("content")
        || document.querySelector('meta[itemprop="price"]')?.getAttribute("content")
        || document.querySelector('[itemprop="price"]')?.getAttribute("content");
      if (meta) {
        const n = Number(String(meta).replace(/[^\d.]/g, "").replace(",", "."));
        if (n > 0) price = n;
      }
    }

    if (price == null) {
      const sels = [
        '[class*="Price--main"]',
        '[class*="product-price-value"]',
        '[class*="uniform-banner-box-price"]',
        '[class*="price-default"]',
        '[data-pl="product-price"]',
        ".product-price-current",
        ".price-current",
      ];
      for (const sel of sels) {
        const el = document.querySelector(sel);
        const raw = (el?.textContent || "").replace(/\s+/g, " ");
        const digits = raw.replace(/[^\d]/g, "");
        if (digits && digits.length >= 2) {
          const n = Number(digits);
          if (n > 0 && n < 1e8) {
            price = n;
            break;
          }
        }
      }
    }

    // иногда цена только в тексте «руб»
    if (price == null) {
      const chunk = (document.body?.innerText || "").slice(0, 4000);
      const mRub = chunk.match(/(\d[\d\s]{1,10})\s*(?:₽|руб)/i);
      if (mRub) {
        const n = Number(String(mRub[1]).replace(/\s/g, ""));
        if (n > 0 && n < 1e8) price = n;
      }
    }

    let url = `https://aliexpress.ru/item/${productId}.html`;
    if (sku) url += `?sku_id=${sku}`;

    const pageText = (document.body?.innerText || "").slice(0, 12000);
    const shipsFromRu = detectAeShipsFromRu(pageText);
    const dutyInfo = extractAeDuty(pageText, price);
    const baseModel = extractAeBaseModel(title);
    const titleVariants = parseRamRomPairs(title);
    const selectedMem = extractAeSelectedMemory();
    const memoryVariants = titleVariants.length ? titleVariants : (selectedMem ? [selectedMem] : []);
    const activeMem = selectedMem
      || (memoryVariants.length === 1 ? memoryVariants[0] : null);
    const compareName = activeMem
      ? `${baseModel} ${activeMem.ram}/${activeMem.rom}`.replace(/\s+/g, " ").trim()
      : (title || `AliExpress ${productId}`);

    return {
      platform: "aliexpress",
      productId: sku ? `${productId}_${sku}` : productId,
      title: (title || `AliExpress ${productId}`).slice(0, 160),
      base_model: baseModel,
      compare_name: compareName.slice(0, 160),
      memory_selected: activeMem,
      memory_variants: memoryVariants,
      price,
      url,
      ships_from_ru: shipsFromRu,
      duty: shipsFromRu ? 0 : dutyInfo.duty,
      ae_total: shipsFromRu
        ? price
        : (dutyInfo.total != null ? dutyInfo.total
          : (price != null && dutyInfo.duty != null ? price + dutyInfo.duty : price)),
    };
  }

  function extractAeDuty(pageText, price) {
    let duty = null;
    let total = null;

    // Явный блок AE.ru: «Таможенная пошлина ≈852 ₽»
    const feeNodes = document.querySelectorAll(
      '[class*="customsFee"], [class*="CustomsFee"], [class*="customs-fee"]'
    );
    for (const el of feeNodes) {
      const raw = (el.textContent || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ");
      const m = raw.match(
        /таможенн\w*\s*пошлин\w*\s*[≈~]?\s*(\d[\d\s]{0,10})\s*(?:₽|руб)?/i
      ) || raw.match(/[≈~]?\s*(\d[\d\s]{0,10})\s*(?:₽|руб)/i);
      if (!m) continue;
      const n = Number(String(m[1]).replace(/\s/g, ""));
      if (n > 0 && n < 1e7) {
        duty = n;
        break;
      }
    }

    const text = String(pageText || "").replace(/\u00a0/g, " ");
    const html = (document.documentElement?.innerHTML || "").slice(0, 220000);

    if (duty == null) {
      const patternsDuty = [
        /таможенн\w*\s*пошлин\w*\s*[≈~]?\s*(\d[\d\s]{0,10})\s*(?:₽|руб)?/i,
        /ниже\s*цены[^0-9≈~]{0,40}[≈~]?\s*(\d[\d\s]{0,10})\s*(?:₽|руб)?/i,
        /таможенн\w*\s*сбор\w*[^0-9≈~]{0,40}[≈~]?\s*(\d[\d\s]{0,10})/i,
        /пошлин\w*[^0-9≈~]{0,40}[≈~]?\s*(\d[\d\s]{0,10})\s*(?:₽|руб)/i,
      ];
      for (const re of patternsDuty) {
        const m = text.match(re);
        if (!m) continue;
        const n = Number(String(m[1]).replace(/\s/g, ""));
        if (n > 0 && n < 1e7) {
          duty = n;
          break;
        }
      }
    }

    // JSON fields from AE PDP
    if (duty == null) {
      const jsonKeys = [
        /"taxFee"[^\d]{0,20}(\d+(?:\.\d+)?)/i,
        /"customsDuty"[^\d]{0,20}(\d+(?:\.\d+)?)/i,
        /"importDuty"[^\d]{0,20}(\d+(?:\.\d+)?)/i,
        /"dutyAmount"[^\d]{0,20}(\d+(?:\.\d+)?)/i,
        /"taxAmount"[^\d]{0,20}(\d+(?:\.\d+)?)/i,
      ];
      for (const re of jsonKeys) {
        const m = html.match(re);
        if (!m) continue;
        const n = Number(m[1]);
        if (n > 0 && n < 1e7) {
          duty = n;
          break;
        }
      }
    }

    const mTotal = text.match(
      /итого(?:\s*к\s*оплате)?[^0-9]{0,40}(\d[\d\s]{1,10})\s*(?:₽|руб)/i
    );
    if (mTotal) {
      const n = Number(String(mTotal[1]).replace(/\s/g, ""));
      if (n > 0 && n < 1e8) total = n;
    }
    if (total != null && price != null && duty == null && total > price) {
      duty = Math.round(total - price);
    }
    if (duty != null && price != null && total == null) {
      total = Math.round(price + duty);
    }
    return { duty, total };
  }

  function extractProduct() {
    if (isWbProduct()) return extractWb();
    if (isOzonProduct()) return extractOzon();
    if (isYandexProduct()) return extractYandex();
    if (isAliExpressProduct()) return extractAliExpress();
    return null;
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

  function drawSparkline(canvas, points) {
    if (!canvas || !points?.length) return;
    const prices = points.map((p) => Number(p.price)).filter((n) => !Number.isNaN(n));
    if (!prices.length) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 230;
    const h = canvas.clientHeight || 56;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const pad = 4;
    const span = max - min || 1;
    ctx.beginPath();
    prices.forEach((price, i) => {
      const x = pad + (i / Math.max(prices.length - 1, 1)) * (w - pad * 2);
      const y = h - pad - ((price - min) / span) * (h - pad * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#7eb8da";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function parseIntRu(raw) {
    const digits = String(raw || "").replace(/[^\d]/g, "");
    if (!digits) return null;
    const n = Number(digits);
    return Number.isFinite(n) ? n : null;
  }

  /** Остаток: одно число или сумма складов, без склейки «60 50 40» → 605040… */
  function parseStockValue(raw) {
    const parts = String(raw || "").match(/\d+/g);
    if (!parts || !parts.length) return null;
    const nums = parts
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n > 0 && n <= 5000);
    if (!nums.length) return null;
    if (nums.length === 1) {
      return nums[0] <= 9999 ? nums[0] : null;
    }
    const sum = nums.reduce((a, b) => a + b, 0);
    return sum > 0 && sum <= 20000 ? sum : null;
  }

  /** Только DOM виджета Маяк (без их API). Графики на canvas цифрами недоступны. */
  function extractMayakSnapshot() {
    const roots = [
      ...document.querySelectorAll(
        ".mayak-size-info, .mayak-wrapper.mayak-size-info, .mayak-browser-plugin, .mayak-wrapper, .mayak-popover"
      ),
    ];
    if (!roots.length) return { present: false };
    const text = roots
      .map((el) => (el.innerText || el.textContent || "").replace(/\u00a0/g, " "))
      .join("\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim();

    let stock = null;
    for (const re of [
      /Текущий остаток\s*[:：]?\s*([\d\s]{1,40})/i,
      /Остаток(?:\s+на\s+складах?)?\s*[:：]?\s*([\d\s]{1,40})/i,
      /Остатки\s*(?:по\s+складам)?\s*[:：]?\s*([\d\s]{1,40})/i,
    ]) {
      const m = text.match(re);
      if (!m) continue;
      stock = parseStockValue(m[1]);
      if (stock != null) break;
    }

    if (stock == null) {
      const sizeRoot = document.querySelector(".mayak-size-info");
      if (sizeRoot) {
        const nums = [...sizeRoot.querySelectorAll("span, div, td, li")]
          .map((el) => parseIntRu((el.textContent || "").trim()))
          .filter((n) => n != null && n > 0 && n <= 5000);
        if (nums.length >= 1 && nums.length <= 40) {
          const sum = nums.reduce((a, b) => a + b, 0);
          if (sum > 0 && sum <= 20000) stock = sum;
        }
      }
    }

    // Мусор вроде 605040302010010 (склейка) — отбрасываем
    if (stock != null && (stock > 20000 || String(stock).length > 5)) {
      stock = null;
    }

    let priceMin = null;
    let priceMax = null;
    const minM = text.match(/Мин(?:имальн\w*)?\s*цен\w*\s*[:：]?\s*([\d\s]{1,12})/i);
    const maxM = text.match(/Макс(?:имальн\w*)?\s*цен\w*\s*[:：]?\s*([\d\s]{1,12})/i);
    if (minM) priceMin = parseIntRu(minM[1]);
    if (maxM) priceMax = parseIntRu(maxM[1]);
    if (priceMin != null && priceMin > 1e7) priceMin = null;
    if (priceMax != null && priceMax > 1e7) priceMax = null;

    const stockCapped =
      /остатки больше\s*69/i.test(text) ||
      /\b69\+/.test(text) ||
      (stock != null && stock >= 69 && /ограничен/i.test(text));

    const noteParts = [];
    if (stock != null) noteParts.push(`остаток ${stock}${stockCapped ? "+" : ""}`);
    if (priceMin != null) noteParts.push(`мин ~${priceMin}`);
    if (priceMax != null) noteParts.push(`макс ~${priceMax}`);

    return {
      present: true,
      stock,
      stock_capped: stockCapped,
      price_min_hint: priceMin,
      price_max_hint: priceMax,
      chart_visible: !!document.querySelector(".mayak-wrapper canvas, .mayak-browser-plugin canvas"),
      mayak_note: noteParts.join(", ").slice(0, 280),
    };
  }

  let lastMayakSent = "";
  async function pushMayakIfNeeded(product) {
    const snap = extractMayakSnapshot();
    if (!product?.url || !snap.present) return snap;
    const payload = {
      url: product.url,
      mayak_present: true,
      stock: snap.stock,
      stock_capped: !!snap.stock_capped,
      price_min_hint: snap.price_min_hint,
      price_max_hint: snap.price_max_hint,
      mayak_note: snap.mayak_note || "",
    };
    const key = JSON.stringify(payload);
    if (key === lastMayakSent) return snap;
    try {
      await api("/api/enrich", { method: "POST", body: payload });
      lastMayakSent = key;
    } catch {
      /* ignore offline */
    }
    return snap;
  }

  function renderMayakLine(el, snap) {
    if (!el) return;
    if (!snap?.present) {
      el.textContent = "Маяк: виджет не найден";
      el.className = "pwbo-mayak muted";
      return;
    }
    const bits = [];
    bits.push(snap.stock != null ? `остаток ${snap.stock}${snap.stock_capped ? "+" : ""}` : "остаток —");
    if (snap.price_min_hint != null) bits.push(`мин ${formatPrice(snap.price_min_hint)}`);
    if (snap.price_max_hint != null) bits.push(`макс ${formatPrice(snap.price_max_hint)}`);
    if (snap.chart_visible) bits.push("график: точки с canvas недоступны");
    el.textContent = `Маяк: ${bits.join(" · ")}`;
    el.className = "pwbo-mayak ok";
  }

  function formatDeltaLine(delta) {
    if (delta == null || Number.isNaN(delta)) return { text: "—", kind: "" };
    const abs = Math.abs(Math.round(delta));
    if (delta < -1) {
      return { text: `поставщик дешевле на ${abs.toLocaleString("ru-RU")} ₽`, kind: "cheaper" };
    }
    if (delta > 1) {
      return { text: `поставщик дороже на ${abs.toLocaleString("ru-RU")} ₽`, kind: "expensive" };
    }
    return { text: "почти одинаково", kind: "ok" };
  }

  function renderSupplierCompare(el, data, loading) {
    if (!el) return;
    el.style.display = "block";
    if (loading) {
      el.className = "pwbo-supplier muted";
      el.textContent = "Поставщики: считаю…";
      return;
    }

    // multi: { mode:"multi", duty, ae_price, rows:[{key, selected, data}] }
    if (data?.mode === "multi") {
      const duty = Number(data.duty || 0);
      const lines = [
        `AE товар ${formatPrice(data.ae_price)}`,
        `Пошлина ${formatPrice(duty)}`,
        `Итого AE ${formatPrice(
          data.ae_total != null
            ? data.ae_total
            : (data.ae_price != null ? data.ae_price + duty : null)
        )}`,
      ];
      let kind = "";
      for (const row of data.rows || []) {
        const mark = row.selected ? "★ " : "";
        const r = row.data || {};
        if (!r.matched || !r.best) {
          lines.push(`${mark}${row.key}: нет у поставщиков`);
          continue;
        }
        const d = formatDeltaLine(row.selected ? r.best.delta : null);
        if (row.selected && d.kind) kind = d.kind;
        if (row.selected) {
          lines.push(
            `${mark}${row.key}: ${r.best.supplier} ${formatPrice(r.best.price)} · ${d.text}`
          );
        } else {
          lines.push(
            `${mark}${row.key}: закуп ${formatPrice(r.best.price)} (${r.best.supplier})`
          );
        }
      }
      el.className = `pwbo-supplier${kind ? ` ${kind}` : ""}`;
      el.innerHTML = lines.map((t) => `<div>${t}</div>`).join("");
      return;
    }

    if (!data?.ok) {
      el.className = "pwbo-supplier muted";
      el.textContent = `Поставщики: ${data?.message || "нет данных"}`;
      return;
    }
    if (!data.matched || !data.best) {
      el.className = "pwbo-supplier muted";
      el.textContent = "Поставщики: совпадений нет";
      return;
    }
    const b = data.best;
    const duty = Number(data.duty || 0);
    const aeTotal = data.ae_total != null ? data.ae_total : data.ae_price;
    const d = formatDeltaLine(b.delta);
    const mem = data.memory_label ? ` · ${data.memory_label}` : "";
    const lines = [
      `Конфиг${mem}`,
      `AE товар ${formatPrice(data.ae_price)}`,
      `Пошлина ${formatPrice(duty)}`,
      `Итого AE ${formatPrice(aeTotal)}`,
      `${b.supplier}: ${formatPrice(b.price)}`,
      d.text,
    ];
    el.className = `pwbo-supplier${d.kind ? ` ${d.kind}` : ""}`;
    el.innerHTML = lines.map((t) => `<div>${t}</div>`).join("");
  }

  async function refreshSupplierCompare(el, product) {
    const duty = product.ships_from_ru ? 0 : (product.duty || 0);
    const variants = Array.isArray(product.memory_variants) ? product.memory_variants : [];
    const selected = product.memory_selected;
    const base = product.base_model || extractAeBaseModel(product.title || "");

    // Несколько версий в названии: по выбранной на карточке — delta; по остальным — только закуп
    if (variants.length > 1) {
      const rows = [];
      for (const v of variants) {
        const name = `${base} ${v.ram}/${v.rom}`.replace(/\s+/g, " ").trim();
        const isSel = !!(selected && v.key === selected.key);
        const res = await api("/api/supplier_compare", {
          method: "POST",
          body: {
            name,
            price: isSel ? product.price : null,
            duty: isSel ? duty : 0,
            ships_from_ru: !!product.ships_from_ru,
          },
        });
        rows.push({ key: v.key, selected: isSel, data: res });
      }
      renderSupplierCompare(el, {
        mode: "multi",
        ae_price: product.price,
        duty: selected ? duty : 0,
        ae_total: selected ? product.ae_total : product.price,
        rows,
      }, false);
      return;
    }

    const name = product.compare_name || product.title;
    const res = await api("/api/supplier_compare", {
      method: "POST",
      body: {
        name,
        price: product.price,
        duty,
        ships_from_ru: !!product.ships_from_ru,
      },
    });
    if (selected) res.memory_label = selected.key;
    renderSupplierCompare(el, res, false);
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <button class="pwbo-close" type="button" title="Скрыть">×</button>
      <div class="pwbo-title">PARSERWBOZON</div>
      <div class="pwbo-name"></div>
      <div class="pwbo-meta"></div>
      <div class="pwbo-mayak"></div>
      <div class="pwbo-supplier" style="display:none"></div>
      <canvas class="pwbo-chart" width="230" height="56"></canvas>
      <div class="pwbo-target-row">
        <input class="pwbo-target-input" type="number" min="1" step="1" placeholder="Цель ₽" />
        <button class="pwbo-btn target" type="button">Цель</button>
      </div>
      <button class="pwbo-btn" type="button">Отслеживать</button>
      <button class="pwbo-btn sellers" type="button" style="display:none">Все продавцы</button>
      <button class="pwbo-btn remove" type="button" style="display:none">Убрать из списка</button>
      <div class="pwbo-status"></div>
    `;
    document.documentElement.appendChild(panel);
    panel.querySelector(".pwbo-close").addEventListener("click", () => {
      panel.dataset.closed = "1";
      panel.remove();
    });
    return panel;
  }

  async function autoTrack(product) {
    if (!product?.url || !product.productId) return;
    if (autoAdded.has(product.url)) return;
    autoAdded.add(product.url);
    try {
      const st = await api(`/api/status?url=${encodeURIComponent(product.url)}`);
      const snap = extractMayakSnapshot();
      // Личный заход на карточку → режим personal (даже если раньше добавили из каталога)
      if (st.tracked) {
        try {
          await api("/api/enrich", {
            method: "POST",
            body: {
              url: product.url,
              alert_mode: "personal",
              mayak_present: snap.present || undefined,
              stock: snap.stock,
              stock_capped: snap.stock_capped,
              mayak_note: snap.mayak_note,
            },
          });
        } catch {
          /* ignore */
        }
        return { tracked: true, auto: false, promoted: (st.alert_mode || "") === "catalog" };
      }
      const body = {
        url: product.url,
        name: product.title,
        price: product.price,
        source: product.platform,
        alert_mode: "personal",
      };
      if (snap.present) {
        body.mayak_present = true;
        body.stock = snap.stock;
        body.stock_capped = snap.stock_capped;
        body.mayak_note = snap.mayak_note;
      }
      await api("/api/add", { method: "POST", body });
      return { tracked: true, auto: true };
    } catch (e) {
      autoAdded.delete(product.url);
      throw e;
    }
  }

  async function refreshPanel() {
    const product = extractProduct();
    if (!product || !product.productId) {
      document.getElementById(PANEL_ID)?.remove();
      return;
    }
    if (document.getElementById(PANEL_ID)?.dataset.closed === "1") return;

    const panel = ensurePanel();
    const nameEl = panel.querySelector(".pwbo-name");
    const metaEl = panel.querySelector(".pwbo-meta");
    const mayakEl = panel.querySelector(".pwbo-mayak");
    const supplierEl = panel.querySelector(".pwbo-supplier");
    const btn = panel.querySelector(".pwbo-btn:not(.remove):not(.target):not(.sellers)");
    const btnSellers = panel.querySelector(".pwbo-btn.sellers");
    const btnRemove = panel.querySelector(".pwbo-btn.remove");
    const btnTarget = panel.querySelector(".pwbo-btn.target");
    const targetInput = panel.querySelector(".pwbo-target-input");
    const targetRow = panel.querySelector(".pwbo-target-row");
    const status = panel.querySelector(".pwbo-status");
    const chart = panel.querySelector(".pwbo-chart");

    nameEl.textContent = product.title || `Товар ${product.productId}`;
    {
      let metaBits = `${product.platform.toUpperCase()} · ${formatPrice(product.price)}`;
      if (product.platform === "aliexpress" && product.memory_selected) {
        metaBits += ` · ${product.memory_selected.key}`;
      }
      if (product.ships_from_ru) metaBits += " · 🇷🇺 склад РФ";
      if (product.platform === "aliexpress" && product.duty) {
        metaBits += ` · пошлина ${formatPrice(product.duty)}`;
      }
      metaEl.textContent = metaBits;
    }

    const snap = await pushMayakIfNeeded(product);
    renderMayakLine(mayakEl, snap);
    if (supplierEl) {
      if (product.platform === "aliexpress") {
        lastAeOfferKey = JSON.stringify({
          sku: product.productId,
          mem: product.memory_selected?.key || "",
          price: product.price,
          duty: product.duty || 0,
          href: location.href,
        });
        renderSupplierCompare(supplierEl, null, true);
        refreshSupplierCompare(supplierEl, product).catch(() => {
          renderSupplierCompare(supplierEl, { ok: false, message: "Нет сравнения" }, false);
        });
      } else {
        supplierEl.style.display = "none";
        supplierEl.textContent = "";
      }
    }

    let tracked = false;
    let autoMsg = "";
    try {
      const result = await autoTrack(product);
      tracked = !!result?.tracked;
      if (result?.auto) autoMsg = "Автодобавлено (личный режим: любая скидка)";
      else if (result?.promoted) autoMsg = "Переведён в личный режим (была метка каталога)";
      const st = await api(`/api/status?url=${encodeURIComponent(product.url)}`);
      tracked = !!st.tracked;
      let metaBits = `${product.platform.toUpperCase()} · ${formatPrice(
        st.current_price != null ? st.current_price : product.price
      )}`;
      if (product.ships_from_ru) metaBits += " · 🇷🇺 склад РФ";
      if (st.hist_min != null) metaBits += ` · мин ${formatPrice(st.hist_min)}`;
      if (st.target_price != null) metaBits += ` · цель ${formatPrice(st.target_price)}`;
      metaEl.textContent = metaBits;
      if (targetInput && st.target_price != null) {
        targetInput.value = String(Math.round(Number(st.target_price)));
      }
      const modeLabel =
        (st.alert_mode || "personal") === "catalog" ? "каталог ≥10%" : "личный · любая скидка";
      status.textContent = autoMsg || (tracked ? `В отслеживании · ${modeLabel}` : "Сервер доступен");
      status.className = "pwbo-status ok";

      if (product.platform === "aliexpress") {
        try {
          await api("/api/phones/offer", {
            method: "POST",
            body: {
              url: product.url,
              name: product.title,
              price: product.price,
              ships_from_ru: !!product.ships_from_ru,
            },
          });
        } catch {
          /* каталог смартфонов необязателен */
        }
      }

      if (tracked && product.price != null) {
        try {
          await api("/api/report", {
            method: "POST",
            body: {
              quiet: true,
              items: [
                {
                  url: product.url,
                  name: product.title,
                  price: product.price,
                  source: `${product.platform}_page`,
                  quiet: true,
                  ships_from_ru: !!product.ships_from_ru,
                },
              ],
            },
          });
        } catch {
          /* ignore */
        }
      }

      try {
        const hist = await api(`/api/history?url=${encodeURIComponent(product.url)}&limit=60`);
        if (hist.points?.length) {
          chart.style.display = "block";
          drawSparkline(chart, hist.points);
        } else {
          chart.style.display = "none";
        }
      } catch {
        chart.style.display = "none";
      }
    } catch (e) {
      status.textContent =
        e?.message && e.message !== "Сервер недоступен"
          ? `Нет связи с NAS: ${e.message}`
          : "Нет связи с сервером (NAS :5000)";
      status.className = "pwbo-status err";
      chart.style.display = "none";
    }

    btn.textContent = tracked ? "Уже отслеживается" : "Отслеживать цену";
    btn.classList.toggle("tracked", tracked);
    btn.disabled = tracked;
    btnRemove.style.display = tracked ? "block" : "none";
    if (targetRow) targetRow.style.display = tracked ? "flex" : "none";
    if (btnSellers) {
      btnSellers.style.display = product.platform === "wildberries" ? "block" : "none";
    }

    btnTarget.onclick = async () => {
      const n = Number(String(targetInput.value || "").replace(/[^\d.]/g, ""));
      if (!n || n <= 0) {
        status.textContent = "Укажите целевую цену";
        status.className = "pwbo-status err";
        return;
      }
      btnTarget.disabled = true;
      try {
        if (!tracked) {
          await api("/api/add", {
            method: "POST",
            body: {
              url: product.url,
              name: product.title,
              price: product.price,
              alert_mode: "personal",
              source: product.platform,
            },
          });
        }
        await api("/api/enrich", {
          method: "POST",
          body: { url: product.url, target_price: n },
        });
        status.textContent = `Цель: ${formatPrice(n)} — алерт когда цена ≤`;
        status.className = "pwbo-status ok";
        await refreshPanel();
      } catch (e) {
        status.textContent = e.message || "Ошибка цели";
        status.className = "pwbo-status err";
      } finally {
        btnTarget.disabled = false;
      }
    };

    btn.onclick = async () => {
      btn.disabled = true;
      status.textContent = "Добавляю…";
      status.className = "pwbo-status";
      try {
        const m = extractMayakSnapshot();
        const body = {
          url: product.url,
          name: product.title,
          price: product.price,
          source: product.platform,
          alert_mode: "personal",
        };
        if (m.present) {
          body.mayak_present = true;
          body.stock = m.stock;
          body.stock_capped = m.stock_capped;
          body.mayak_note = m.mayak_note;
        }
        const res = await api("/api/add", {
          method: "POST",
          body,
        });
        status.textContent = res.message || "Добавлено";
        status.className = "pwbo-status ok";
        await refreshPanel();
      } catch (e) {
        status.textContent = e.message || "Ошибка";
        status.className = "pwbo-status err";
        btn.disabled = false;
      }
    };

    if (btnSellers) {
      btnSellers.onclick = async () => {
        btnSellers.disabled = true;
        status.textContent = "Ищу других продавцов…";
        status.className = "pwbo-status";
        try {
          const items = await collectWbSellerVariants(product);
          if (items.length < 2) {
            status.textContent = "Других продавцов не нашёл — откройте «Другие продавцы»";
            status.className = "pwbo-status err";
            return;
          }
          status.textContent = `Добавляю ${items.length} вариантов…`;
          const res = await api("/api/add", {
            method: "POST",
            body: {
              alert_mode: "catalog",
              source: "wb_other_sellers",
              catalog_url: `https://www.wildberries.ru/catalog/${product.productId}/other-sellers`,
              match_nm: product.productId,
              items: items.map((x) => ({
                url: x.url,
                name: x.name || product.title,
                price: x.price,
                from_china: !!x.from_china,
              })),
            },
          });
          status.textContent = res.message || `Добавлено вариантов: ${items.length}`;
          status.className = "pwbo-status ok";
        } catch (e) {
          status.textContent = e.message || "Не удалось добавить продавцов";
          status.className = "pwbo-status err";
        } finally {
          btnSellers.disabled = false;
        }
      };
    }

    btnRemove.onclick = async () => {
      btnRemove.disabled = true;
      try {
        await api("/api/remove", {
          method: "POST",
          body: { url: product.url },
        });
        autoAdded.delete(product.url);
        status.textContent = "Убрано из списка";
        status.className = "pwbo-status ok";
        await refreshPanel();
      } catch (e) {
        status.textContent = e.message || "Ошибка";
        status.className = "pwbo-status err";
      } finally {
        btnRemove.disabled = false;
      }
    };
  }

  let lastUrl = "";
  let lastMayakKey = "";
  let lastAeOfferKey = "";
  let navTimer = null;
  const aeSupplierCache = new Map(); // key -> promise/result
  let aeListScanBusy = false;

  function onProductPage() {
    return isWbProduct() || isOzonProduct() || isYandexProduct() || isAliExpressProduct();
  }

  function isAliExpressHost() {
    return /aliexpress\.(ru|com)$/i.test(location.hostname);
  }

  async function cachedSupplierCompare(name, price, duty, shipsFromRu) {
    const key = `${name}|${price || 0}|${duty || 0}|${shipsFromRu ? 1 : 0}`;
    if (aeSupplierCache.has(key)) return aeSupplierCache.get(key);
    const p = api("/api/supplier_compare", {
      method: "POST",
      body: {
        name,
        price: price || null,
        duty: duty || 0,
        ships_from_ru: !!shipsFromRu,
      },
    }).catch((e) => ({ ok: false, message: e.message || "err" }));
    aeSupplierCache.set(key, p);
    // не раздувать кэш бесконечно
    if (aeSupplierCache.size > 80) {
      const first = aeSupplierCache.keys().next().value;
      aeSupplierCache.delete(first);
    }
    return p;
  }

  function parsePriceFromText(text) {
    const s = String(text || "").replace(/\u00a0/g, " ");
    // берём первое крупное число с ₽ / руб (не купон -1345)
    const m = s.match(/(?<![-\d])(\d[\d\s]{2,10})\s*(?:₽|руб)/);
    if (!m) return null;
    const n = Number(String(m[1]).replace(/\s/g, ""));
    return n > 500 && n < 1e8 ? n : null;
  }

  function findAeDeliveryAnchor(card) {
    const nodes = [
      ...card.querySelectorAll(
        [
          '[class*="delivery"]',
          '[class*="Delivery"]',
          '[class*="logistics"]',
          '[class*="Logistics"]',
          '[class*="shipping"]',
          '[class*="Shipping"]',
          '[class*="freight"]',
          '[class*="Freight"]',
          '[class*="promise"]',
          '[class*="Promise"]',
        ].join(",")
      ),
    ];
    for (const el of nodes) {
      const t = (el.textContent || "").replace(/\s+/g, " ");
      if (/доставк|бесплатн|почт|январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр|\d{1,2}\s*[–—-]\s*\d{1,2}/i.test(t)) {
        return el;
      }
    }
    // fallback: строка с датами доставки в тексте карточки
    for (const el of card.querySelectorAll("div, span, p")) {
      if (el.querySelector(".pwbo-ae-offer-badge")) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length < 8 || t.length > 90) continue;
      if (/^\d{1,2}\s*[–—-]\s*\d{1,2}\s+\S+.*(?:Бесплатно|доставк|₽)?/i.test(t)
        || /(?:Бесплатно).{0,20}\d{1,2}\s*[–—-]\s*\d{1,2}/i.test(t)
        || /доставка.{0,40}\d{1,2}/i.test(t)) {
        return el;
      }
    }
    return null;
  }

  function findAeOfferCards() {
    const cards = new Set();
    // якорь: кнопка «В корзину» в списке предложений
    for (const el of document.querySelectorAll("button, a, div, span")) {
      const label = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!/^в корзину$/i.test(label)) continue;
      let root = el;
      for (let i = 0; i < 10 && root; i++) {
        root = root.parentElement;
        if (!root) break;
        const t = (root.innerText || "").replace(/\u00a0/g, " ");
        if (!/\d[\d\s]{2,}\s*(?:₽|руб)/.test(t)) continue;
        if (!/доставк|бесплатн|ноябр|декабр|январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|\d{1,2}\s*[–—-]\s*\d{1,2}/i.test(t)) {
          continue;
        }
        // карточка не на всю страницу
        if ((root.innerText || "").length > 2500) continue;
        cards.add(root);
        break;
      }
    }
    // альтернатива: блоки «Это предложение» / оффер-карточки
    for (const el of document.querySelectorAll(
      '[class*="OfferCard"], [class*="offer-card"], [class*="OfferItem"], [class*="offerItem"], [class*="PlpOffer"], [class*="groupOffer"], [class*="GroupOffer"], [class*="otherOffer"], [class*="OtherOffer"]'
    )) {
      const t = (el.innerText || "").replace(/\u00a0/g, " ");
      if (/\d[\d\s]{2,}\s*(?:₽|руб)/.test(t) && /в корзину|доставк|бесплатн/i.test(t)) {
        if (t.length <= 2500) cards.add(el);
      }
    }
    return [...cards];
  }

  function extractAeOfferCardInfo(card) {
    const text = (card.innerText || "").replace(/\u00a0/g, " ");
    let title = "";
    const titleEl =
      card.querySelector("h1, h2, h3, a[href*='/item/'] [class*='title'], a[href*='/item/'], [class*='Title'], [class*='title']")
      || null;
    if (titleEl) {
      title = (titleEl.getAttribute("title") || titleEl.textContent || "").replace(/\s+/g, " ").trim();
    }
    if (!title || title.length < 8) {
      const m = text.match(/Смартфон[^\n]{5,120}/i) || text.match(/Poco[^\n]{3,100}/i)
        || text.match(/Redmi[^\n]{3,100}/i) || text.match(/Xiaomi[^\n]{3,100}/i);
      title = m ? m[0].replace(/\s+/g, " ").trim() : "";
    }
    title = title.slice(0, 160);
    // цена: предпочитаем крупный price-блок, иначе первое число ₽ не из купона
    let price = null;
    const priceEl = card.querySelector(
      '[class*="Price"], [class*="price"], [class*="amount"]'
    );
    if (priceEl) {
      const raw = (priceEl.textContent || "").replace(/\u00a0/g, " ");
      if (!/купон|скидк|без\s*купон/i.test(raw) || /\d[\d\s]{2,}\s*₽/.test(raw)) {
        price = parsePriceFromText(raw);
      }
    }
    if (price == null) {
      // вырезаем строки с купоном
      const cleaned = text
        .split("\n")
        .filter((line) => !/купон|без\s*купон|взять/i.test(line))
        .join("\n");
      price = parsePriceFromText(cleaned);
    }
    let duty = null;
    const feeEl = card.querySelector('[class*="customsFee"], [class*="CustomsFee"]');
    if (feeEl) {
      const m = (feeEl.textContent || "").replace(/\u00a0/g, " ")
        .match(/таможенн\w*\s*пошлин\w*\s*[≈~]?\s*(\d[\d\s]{0,10})/i);
      if (m) duty = Number(String(m[1]).replace(/\s/g, ""));
    }
    if (duty == null) {
      const m = text.match(/таможенн\w*\s*пошлин\w*\s*[≈~]?\s*(\d[\d\s]{0,10})/i);
      if (m) duty = Number(String(m[1]).replace(/\s/g, ""));
    }
    const variants = parseRamRomPairs(title);
    const base = extractAeBaseModel(title);
    const shipsFromRu = /склад[ае]?\s+в\s+(рф|россии)|со склада в рф/i.test(text);
    const link = card.querySelector("a[href*='/item/']");
    let url = link?.href || "";
    return {
      title,
      base,
      variants,
      price,
      duty: shipsFromRu ? 0 : duty,
      ships_from_ru: shipsFromRu,
      url,
    };
  }

  function ensureAeOfferBadge(card, deliveryEl) {
    let badge = card.querySelector(".pwbo-ae-offer-badge");
    if (badge) return badge;
    badge = document.createElement("div");
    badge.className = "pwbo-ae-offer-badge muted";
    badge.textContent = "PWBO: …";
    if (deliveryEl && deliveryEl.parentElement) {
      deliveryEl.insertAdjacentElement("afterend", badge);
    } else {
      card.appendChild(badge);
    }
    return badge;
  }

  async function fillAeOfferBadge(badge, info) {
    if (!info?.title || !info.price) {
      badge.className = "pwbo-ae-offer-badge muted";
      badge.textContent = "PWBO: нет цены/названия";
      return;
    }
    const variants = info.variants?.length
      ? info.variants
      : [{ ram: null, rom: null, key: "?" }];
    const duty = info.duty || 0;
    const lines = [];
    let kind = "";
    // если несколько версий в названии — показываем закуп по каждой; delta только если одна версия
    // (в списке офферов выбранный SKU обычно неизвестен)
    const single = variants.length === 1 && variants[0].ram;
    for (const v of variants.slice(0, 4)) {
      const name = v.ram
        ? `${info.base} ${v.ram}/${v.rom}`.replace(/\s+/g, " ").trim()
        : info.title;
      const res = await cachedSupplierCompare(
        name,
        single ? info.price : null,
        single ? duty : 0,
        info.ships_from_ru
      );
      if (!res?.matched || !res.best) {
        lines.push(`${v.key || "—"}: нет у поставщиков`);
        continue;
      }
      const buy = res.best.price;
      if (single && res.best.delta != null) {
        const aeTotal = info.price + (duty || 0);
        const d = formatDeltaLine(res.best.delta);
        if (d.kind) kind = d.kind;
        const dutyBit = duty
          ? ` · пошлина ${formatPrice(duty)} · итого ${formatPrice(aeTotal)}`
          : " · без пошлины в списке";
        lines.push(
          `${v.key}: закуп ${formatPrice(buy)} (${res.best.supplier}) · ${d.text}${dutyBit}`
        );
      } else {
        const aeTotal = info.price + (duty || 0);
        const delta = buy - aeTotal;
        const d = formatDeltaLine(delta);
        if (variants.length === 1 && d.kind) kind = d.kind;
        lines.push(
          `${v.key}: закуп ${formatPrice(buy)} (${res.best.supplier})` +
            (variants.length === 1 ? ` · ${d.text}` : "")
        );
      }
    }
    badge.className = `pwbo-ae-offer-badge${kind ? ` ${kind}` : ""}`;
    badge.innerHTML = `<div class="pwbo-ae-offer-h">PWBO vs поставщики</div>${
      lines.map((t) => `<div>${t}</div>`).join("")
    }`;
  }

  async function scanAeOfferList() {
    if (!isAliExpressHost() || aeListScanBusy) return;
    if (!isAliExpressProduct() && !/\/item\//i.test(location.pathname)) return;
    aeListScanBusy = true;
    try {
      const cards = findAeOfferCards();
      for (const card of cards) {
        const delivery = findAeDeliveryAnchor(card);
        if (!delivery && !(card.innerText || "").match(/в корзину/i)) continue;
        const info = extractAeOfferCardInfo(card);
        // пропускаем основную PDP-панель (уже есть #pwbo-panel) если карточка огромная
        if (!info.title || !info.price) continue;
        // на главной карточке товара список офферов — ок; сам hero можно отличить по отсутствию «В корзину» рядом с доставкой в компактной карточке
        const badge = ensureAeOfferBadge(card, delivery);
        const sig = `${info.title}|${info.price}|${info.duty || 0}`;
        if (badge.dataset.pwboSig === sig) continue;
        badge.dataset.pwboSig = sig;
        badge.className = "pwbo-ae-offer-badge muted";
        badge.textContent = "PWBO: считаю…";
        try {
          await fillAeOfferBadge(badge, info);
        } catch (e) {
          badge.className = "pwbo-ae-offer-badge muted";
          badge.textContent = `PWBO: ${e.message || "ошибка"}`;
        }
      }
    } finally {
      aeListScanBusy = false;
    }
  }

  function forcePanelForNewUrl() {
    // при SPA-переходе старая панель (в т.ч. закрытая) мешает — сбрасываем
    document.getElementById(PANEL_ID)?.remove();
    lastMayakKey = "";
    lastAeOfferKey = "";
    if (navTimer) {
      clearTimeout(navTimer);
      navTimer = null;
    }
    let tries = 0;
    const attempt = () => {
      if (!onProductPage()) return;
      refreshPanel();
      const ready =
        document.getElementById(PANEL_ID)
        && (extractProduct()?.title || extractProduct()?.price != null);
      if (!ready && tries < 10) {
        tries += 1;
        navTimer = setTimeout(attempt, 350);
      }
    };
    attempt();
  }

  function tick() {
    if (!onProductPage()) {
      document.getElementById(PANEL_ID)?.remove();
      lastUrl = location.href;
      lastMayakKey = "";
      lastAeOfferKey = "";
      return;
    }
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastAeOfferKey = "";
      forcePanelForNewUrl();
      return;
    }
    const snap = extractMayakSnapshot();
    const mayakKey = JSON.stringify(snap);
    if (mayakKey !== lastMayakKey) {
      lastMayakKey = mayakKey;
      const panel = document.getElementById(PANEL_ID);
      if (panel && panel.dataset.closed !== "1") {
        const product = extractProduct();
        if (product?.productId) {
          pushMayakIfNeeded(product).then((s) => {
            renderMayakLine(panel.querySelector(".pwbo-mayak"), s);
          });
        }
      }
    }

    // AliExpress: смена SKU/памяти или пошлины → пересчёт сравнения
    if (isAliExpressProduct()) {
      const product = extractProduct();
      if (product?.productId) {
        const offerKey = JSON.stringify({
          sku: product.productId,
          mem: product.memory_selected?.key || "",
          price: product.price,
          duty: product.duty || 0,
          href: location.href,
        });
        if (offerKey !== lastAeOfferKey) {
          lastAeOfferKey = offerKey;
          const panel = document.getElementById(PANEL_ID);
          if (panel && panel.dataset.closed !== "1") {
            const supplierEl = panel.querySelector(".pwbo-supplier");
            const metaEl = panel.querySelector(".pwbo-meta");
            if (metaEl) {
              let metaBits = `ALIEXPRESS · ${formatPrice(product.price)}`;
              if (product.memory_selected) metaBits += ` · ${product.memory_selected.key}`;
              if (product.ships_from_ru) metaBits += " · 🇷🇺 склад РФ";
              if (product.duty) metaBits += ` · пошлина ${formatPrice(product.duty)}`;
              metaEl.textContent = metaBits;
            }
            if (supplierEl) {
              renderSupplierCompare(supplierEl, null, true);
              refreshSupplierCompare(supplierEl, product).catch(() => {
                renderSupplierCompare(supplierEl, { ok: false, message: "Нет сравнения" }, false);
              });
            }
          }
        }
      }
      // список «все предложения» / другие продавцы — бейджи у доставки
      scanAeOfferList().catch(() => {});
    }
  }

  function watchSpaNavigation() {
    const fire = () => {
      if (location.href === lastUrl && onProductPage() && document.getElementById(PANEL_ID)) {
        return;
      }
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
  setInterval(tick, 1000);
})();
