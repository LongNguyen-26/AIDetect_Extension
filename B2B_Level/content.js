(function () {
  "use strict";

  const LOG_PREFIX = "AIDetect Admin";
  const VALID_MODES = new Set(["off", "manual", "auto"]);
  const VALID_AUTO_ACTIONS = new Set(["approve_only", "approve_and_delete"]);
  const DEFAULT_SETTINGS = {
    aidetectAdminEnabled: true,
    aidetectAdminMode: "manual",
    aidetectAdminThreshold: 85,
    aidetectAdminMinTextLength: 8,
    aidetectAdminGroupRules: "",
    aidetectAdminAutoSkipInvalid: true,
    aidetectAdminAutoAction: "approve_only"
  };

  const UI_TEXT = {
    approve: ["phê duyệt", "phe duyet", "approve"],
    reject: ["từ chối", "tu choi", "decline", "reject"],
    bulkChrome: [
      "bài viết đang chờ",
      "bai viet dang cho",
      "phê duyệt",
      "phe duyet",
      "từ chối",
      "tu choi",
      "xóa bộ lọc",
      "xoa bo loc",
      "chọn ngày",
      "chon ngay",
      "tác giả",
      "tac gia",
      "loại nội dung",
      "loai noi dung",
      "liên kết",
      "lien ket",
      "mới nhất trước",
      "moi nhat truoc",
      "quản lý",
      "quan ly",
      "công cụ quản trị",
      "cong cu quan tri",
      "trang chủ của cộng đồng",
      "trang chu cua cong dong",
      "tổng quan",
      "tong quan",
      "hỗ trợ quản trị",
      "ho tro quan tri",
      "yêu cầu làm thành viên",
      "yeu cau lam thanh vien",
      "bài viết đã lên lịch",
      "bai viet da len lich",
      "like",
      "comment",
      "share",
      "thích",
      "binh luan",
      "bình luận",
      "chia sẻ",
      "xem thêm",
      "see more"
    ]
  };

  const state = {
    ...DEFAULT_SETTINGS,
    observer: null,
    scanTimer: null,
    intersectionObserver: null
  };

  const scannedCards = new WeakSet();
  const observedCards = new WeakSet();
  const resultCache = new WeakMap();
  const cardIndexes = new WeakMap();
  let nextCardIndex = 1;

  init();

  async function init() {
    console.info(`${LOG_PREFIX}: content script loaded`);
    await loadSettings();
    setupStorageListener();
    setupViewportScanner();
    setupDomObserver();
    scheduleScan(150);
    setTimeout(() => scheduleScan(0), 1200);
  }

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(null, (items) => {
        Object.assign(state, normalizeSettings(items || {}));
        resolve();
      });
    });
  }

  function normalizeSettings(items) {
    const settings = { ...DEFAULT_SETTINGS, ...(items || {}) };

    if (!Object.prototype.hasOwnProperty.call(items || {}, "aidetectAdminMode") && typeof settings.aidetectAdminEnabled === "boolean") {
      settings.aidetectAdminMode = settings.aidetectAdminEnabled ? "manual" : "off";
    }

    settings.aidetectAdminMode = normalizeMode(settings.aidetectAdminMode);
    settings.aidetectAdminThreshold = clamp(
      Number(settings.aidetectAdminThreshold) || DEFAULT_SETTINGS.aidetectAdminThreshold,
      70,
      95
    );
    settings.aidetectAdminMinTextLength = Math.max(
      0,
      Number(settings.aidetectAdminMinTextLength) || DEFAULT_SETTINGS.aidetectAdminMinTextLength
    );
    settings.aidetectAdminGroupRules = String(settings.aidetectAdminGroupRules || "");
    settings.aidetectAdminAutoSkipInvalid = Boolean(settings.aidetectAdminAutoSkipInvalid);
    settings.aidetectAdminAutoAction = normalizeAutoAction(settings.aidetectAdminAutoAction);

    return settings;
  }

  function normalizeMode(value) {
    return VALID_MODES.has(value) ? value : DEFAULT_SETTINGS.aidetectAdminMode;
  }

  function normalizeAutoAction(value) {
    return VALID_AUTO_ACTIONS.has(value) ? value : DEFAULT_SETTINGS.aidetectAdminAutoAction;
  }

  function isScanModeActive() {
    return state.aidetectAdminMode !== "off";
  }

  function setupStorageListener() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") return;

      if (changes.aidetectAdminMode) {
        state.aidetectAdminMode = normalizeMode(changes.aidetectAdminMode.newValue);
        if (!isScanModeActive()) {
          removeAllBadges();
          return;
        }
      }

      if (changes.aidetectAdminEnabled && !changes.aidetectAdminMode) {
        state.aidetectAdminMode = changes.aidetectAdminEnabled.newValue ? "manual" : "off";
        if (!isScanModeActive()) {
          removeAllBadges();
          return;
        }
      }

      if (changes.aidetectAdminThreshold) {
        state.aidetectAdminThreshold = Number(changes.aidetectAdminThreshold.newValue) || DEFAULT_SETTINGS.aidetectAdminThreshold;
        refreshVisibleBadges();
      }

      if (changes.aidetectAdminMinTextLength) {
        state.aidetectAdminMinTextLength = Math.max(
          0,
          Number(changes.aidetectAdminMinTextLength.newValue) || DEFAULT_SETTINGS.aidetectAdminMinTextLength
        );
      }

      if (changes.aidetectAdminGroupRules) {
        state.aidetectAdminGroupRules = String(changes.aidetectAdminGroupRules.newValue || "");
      }

      if (changes.aidetectAdminAutoSkipInvalid) {
        state.aidetectAdminAutoSkipInvalid = Boolean(changes.aidetectAdminAutoSkipInvalid.newValue);
      }

      if (changes.aidetectAdminAutoAction) {
        state.aidetectAdminAutoAction = normalizeAutoAction(changes.aidetectAdminAutoAction.newValue);
      }

      if (isScanModeActive()) {
        scheduleScan(0);
      }
    });
  }

  function setupViewportScanner() {
    if (!("IntersectionObserver" in window)) return;

    state.intersectionObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting || !isScanModeActive()) return;
        const card = entry.target;
        state.intersectionObserver.unobserve(card);
        analyzePendingCard(card);
      });
    }, {
      root: null,
      rootMargin: "550px 0px",
      threshold: 0.01
    });
  }

  function setupDomObserver() {
    state.observer = new MutationObserver(() => scheduleScan(250));
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  function scheduleScan(delay) {
    window.clearTimeout(state.scanTimer);
    state.scanTimer = window.setTimeout(scanPendingPosts, delay);
  }

  function scanPendingPosts() {
    if (!isScanModeActive()) return;
    if (!isLikelyGroupModerationPage()) return;

    findPendingPostCards().forEach((card) => {
      if (scannedCards.has(card)) {
        const cached = resultCache.get(card);
        if (cached) renderOrRemoveBadge(card, cached);
        return;
      }

      if (observedCards.has(card)) return;

      observedCards.add(card);
      card.dataset.aidetectAdminObserved = "true";

      if (state.intersectionObserver) {
        state.intersectionObserver.observe(card);
      } else {
        analyzePendingCard(card);
      }
    });
  }

  function isLikelyGroupModerationPage() {
    const path = removeDiacritics(location.pathname.toLowerCase());
    if (path.includes("/groups/") && (
      path.includes("pending") ||
      path.includes("moderation") ||
      path.includes("admin") ||
      path.includes("post")
    )) {
      return true;
    }

    const pageText = removeDiacritics((document.body.innerText || "").slice(0, 5000).toLowerCase());
    return pageText.includes("bai viet dang cho") || pageText.includes("pending posts");
  }

  function findPendingPostCards() {
    const cards = new Set();
    const controls = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"]'));

    controls.forEach((control) => {
      if (!isApproveControl(control)) return;

      const card = findCardFromApproveControl(control);
      if (card && isValidPendingCard(card)) {
        cards.add(card);
      }
    });

    document.querySelectorAll('div[role="article"]').forEach((article) => {
      if (isValidPendingCard(article)) {
        cards.add(article);
      }
    });

    return Array.from(cards);
  }

  function findCardFromApproveControl(control) {
    let current = control;
    for (let depth = 0; depth < 10 && current && current !== document.body; depth += 1) {
      if (current instanceof HTMLElement && isValidPendingCard(current)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function isValidPendingCard(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (!isVisible(element)) return false;

    const rect = element.getBoundingClientRect();
    if (rect.width < 320 || rect.height < 120) return false;
    if (rect.top > window.innerHeight + 1400 || rect.bottom < -700) return false;

    if (!hasActionPair(element)) return false;
    if (isBulkToolbar(element)) return false;

    const payload = buildCardPayload(element);
    return payload.text.length >= state.aidetectAdminMinTextLength || payload.mediaCount > 0;
  }

  function hasActionPair(element) {
    const controls = Array.from(element.querySelectorAll('button, [role="button"], a[role="button"]'));
    const hasApprove = controls.some(isApproveControl);
    const hasReject = controls.some(isRejectControl);
    return hasApprove && hasReject;
  }

  function isApproveControl(element) {
    return hasAnyLabel(element, UI_TEXT.approve);
  }

  function isRejectControl(element) {
    return hasAnyLabel(element, UI_TEXT.reject);
  }

  function hasAnyLabel(element, labels) {
    const text = getAccessibleText(element);
    return labels.some((label) => text.includes(removeDiacritics(label)));
  }

  function getAccessibleText(element) {
    const text = [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.innerText,
      element.textContent
    ].filter(Boolean).join(" ");

    return removeDiacritics(normalizeText(text).toLowerCase());
  }

  function isBulkToolbar(element) {
    const rect = element.getBoundingClientRect();
    if (rect.height > 260) return false;

    const text = removeDiacritics(normalizeText(element.innerText || "").toLowerCase());
    const hasSearchOrFilters = [
      "tim kiem",
      "xoa bo loc",
      "chon ngay",
      "tac gia",
      "loai noi dung",
      "moi nhat truoc"
    ].some((label) => text.includes(label));

    return hasSearchOrFilters && !text.includes("vua xong") && !text.includes("just now");
  }

  function analyzePendingCard(card) {
    if (!isScanModeActive() || scannedCards.has(card)) return;

    const cached = resultCache.get(card);
    if (cached) {
      renderOrRemoveBadge(card, cached);
      return;
    }

    const payload = buildCardPayload(card);
    if (!payload.text && payload.mediaCount === 0) return;

    scannedCards.add(card);
    card.dataset.aidetectAdminScanned = "true";

    chrome.runtime.sendMessage({ action: "SCAN_PENDING_POST", data: payload }, (response) => {
      if (chrome.runtime.lastError || !response || typeof response.score !== "number") {
        return;
      }

      const result = { ...response, status: "done" };
      resultCache.set(card, result);
      if (!isScanModeActive()) return;
      renderOrRemoveBadge(card, result);
    });
  }

  function buildCardPayload(card) {
    const text = extractPendingPostText(card);
    const links = Array.from(card.querySelectorAll("a[href]"))
      .map((link) => link.href)
      .filter(Boolean)
      .filter((href) => !href.includes("/groups/") || href.includes("/posts/") || href.includes("story_fbid="))
      .slice(0, 10);

    return {
      platform: "facebook_group_admin",
      pageType: "pending_post_review",
      mode: state.aidetectAdminMode,
      cardIndex: getCardIndex(card),
      url: location.href,
      text,
      mediaCount: countMedia(card),
      imageCount: card.querySelectorAll("img").length,
      videoCount: card.querySelectorAll("video").length,
      links,
      groupRules: state.aidetectAdminGroupRules,
      autoSkipInvalid: state.aidetectAdminAutoSkipInvalid,
      autoAction: state.aidetectAdminAutoAction
    };
  }

  function getCardIndex(card) {
    if (!cardIndexes.has(card)) {
      const index = nextCardIndex;
      nextCardIndex += 1;
      cardIndexes.set(card, index);
      card.dataset.aidetectAdminCardIndex = String(index);
    }

    return cardIndexes.get(card);
  }

  function extractPendingPostText(card) {
    const messageSelectors = [
      '[data-ad-comet-preview="message"]',
      '[data-ad-preview="message"]',
      '[data-testid="post_message"]',
      '[dir="auto"]'
    ];

    const pieces = [];
    messageSelectors.forEach((selector) => {
      card.querySelectorAll(selector).forEach((node) => {
        if (!isContentNode(node)) return;
        const text = cleanupPostText(node.innerText || node.textContent || "");
        if (text) pieces.push(text);
      });
    });

    const directText = dedupeTexts(pieces).join("\n").trim();
    if (directText.length >= state.aidetectAdminMinTextLength) {
      return directText.slice(0, 6000);
    }

    const clone = card.cloneNode(true);
    clone.querySelectorAll([
      ".aidetect-admin-badge-host",
      "button",
      '[role="button"]',
      "nav",
      "input",
      "textarea",
      "select",
      "svg",
      "[aria-hidden='true']"
    ].join(",")).forEach((node) => node.remove());

    return cleanupPostText(clone.innerText || clone.textContent || "").slice(0, 6000);
  }

  function isContentNode(node) {
    if (!(node instanceof HTMLElement)) return false;
    if (node.closest(".aidetect-admin-badge-host")) return false;
    if (node.closest('button, [role="button"], nav, input, textarea, select')) return false;
    return true;
  }

  function cleanupPostText(text) {
    const lines = String(text)
      .split(/\n+/)
      .map((line) => normalizeText(line))
      .filter(Boolean)
      .filter((line) => !isUiChromeLine(line));

    return dedupeTexts(lines).join("\n").trim();
  }

  function isUiChromeLine(line) {
    const normalized = removeDiacritics(line.toLowerCase());
    if (UI_TEXT.bulkChrome.some((label) => normalized === removeDiacritics(label))) return true;
    if (/^\d+\s*(muc|item|post|bai)/i.test(normalized)) return true;
    if (/^(vua xong|just now|dang cho|pending)$/i.test(normalized)) return true;
    if (normalized.length <= 2) return true;
    return false;
  }

  function countMedia(card) {
    return card.querySelectorAll("img, video, canvas").length;
  }

  function renderOrRemoveBadge(card, result) {
    if (result.score >= state.aidetectAdminThreshold) {
      renderBadge(card, result);
      return;
    }

    removeBadge(card);
  }

  function renderBadge(card, result) {
    const host = getOrCreateBadgeHost(card);
    host.dataset.aidetectAdminResult = JSON.stringify(result);

    const root = host.shadowRoot || host.attachShadow({ mode: "open" });
    root.innerHTML = buildBadgeMarkup(result);

    const toggle = root.querySelector("[data-aidetect-admin-toggle]");
    const detail = root.querySelector("[data-aidetect-admin-detail]");
    if (toggle && detail) {
      toggle.addEventListener("click", () => {
        const open = detail.hidden;
        detail.hidden = !open;
        toggle.setAttribute("aria-expanded", String(open));
      });
    }

    card.style.outline = "2px solid rgba(220, 38, 38, 0.42)";
    card.style.outlineOffset = "3px";
  }

  function getOrCreateBadgeHost(card) {
    const existing = card.querySelector(".aidetect-admin-badge-host");
    if (existing) return existing;

    const host = document.createElement("div");
    host.className = "aidetect-admin-badge-host";
    host.style.display = "block";
    host.style.position = "relative";
    host.style.zIndex = "9999";

    const anchor = findCardHeader(card);
    if (anchor && anchor.parentElement) {
      anchor.parentElement.insertBefore(host, anchor.nextSibling);
    } else {
      card.insertBefore(host, card.firstChild);
    }

    return host;
  }

  function findCardHeader(card) {
    const headings = Array.from(card.querySelectorAll('h2, h3, [role="heading"], strong, a[role="link"]'));
    const heading = headings.find((node) => {
      const text = normalizeText(node.innerText || node.textContent || "");
      return text.length > 0 && text.length < 120 && !isUiChromeLine(text);
    });

    return heading ? heading.closest("div") || heading : null;
  }

  function buildBadgeMarkup(result) {
    const score = Math.round(Number(result.score) || 0);
    const reason = escapeHtml(result.reason || "Bài viết có nhiều dấu hiệu giống nội dung do AI tạo ra.");
    const type = escapeHtml(result.type || "Bài viết đang chờ duyệt");
    const signals = Array.isArray(result.signals) ? result.signals.slice(0, 4) : [];
    const signalMarkup = signals.length
      ? signals.map((signal) => `
          <li>
            <span>${escapeHtml(signal.label || "Tín hiệu AI")}</span>
            <strong>${Math.round(Number(signal.confidence) || 0)}%</strong>
          </li>
        `).join("")
      : `<li><span>Không có tín hiệu chi tiết</span><strong>-</strong></li>`;

    return `
      <style>
        :host {
          all: initial;
          color-scheme: light;
          font-family: Arial, "Segoe UI", sans-serif;
        }

        .wrap {
          box-sizing: border-box;
          margin: 10px 16px 8px;
          border: 1px solid #fca5a5;
          border-left: 5px solid #dc2626;
          border-radius: 8px;
          background: #fef2f2;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
          overflow: hidden;
        }

        .main {
          box-sizing: border-box;
          width: 100%;
          border: 0;
          background: transparent;
          cursor: pointer;
          display: grid;
          grid-template-columns: auto 1fr auto;
          gap: 10px;
          align-items: center;
          padding: 10px 12px;
          text-align: left;
          color: #1c1e21;
          font: inherit;
        }

        .icon {
          display: grid;
          place-items: center;
          width: 26px;
          height: 26px;
          border-radius: 50%;
          background: #dc2626;
          color: #ffffff;
          font-size: 16px;
          font-weight: 900;
          line-height: 1;
        }

        .label {
          min-width: 0;
        }

        .title {
          display: block;
          color: #b91c1c;
          font-size: 13px;
          font-weight: 800;
          line-height: 1.25;
        }

        .meta {
          display: block;
          color: #4b5563;
          font-size: 12px;
          line-height: 1.35;
          margin-top: 2px;
          overflow-wrap: anywhere;
        }

        .score {
          min-width: 54px;
          border-radius: 999px;
          background: #ffffff;
          border: 1px solid #fca5a5;
          color: #b91c1c;
          font-size: 13px;
          font-weight: 800;
          line-height: 1;
          padding: 7px 9px;
          text-align: center;
        }

        .detail {
          border-top: 1px solid #fecaca;
          padding: 10px 12px 12px 48px;
          color: #273240;
          font-size: 12px;
          line-height: 1.45;
          background: rgba(255, 255, 255, 0.62);
        }

        .detail p {
          margin: 0 0 8px;
        }

        .signals {
          display: grid;
          gap: 6px;
          margin: 0;
          padding: 0;
          list-style: none;
        }

        .signals li {
          display: flex;
          justify-content: space-between;
          gap: 12px;
        }

        .signals strong {
          color: #b91c1c;
        }
      </style>

      <div class="wrap" role="group" aria-label="AIDetect AI warning">
        <button class="main" type="button" data-aidetect-admin-toggle aria-expanded="false">
          <span class="icon" aria-hidden="true">!</span>
          <span class="label">
            <span class="title">Cảnh báo nội dung có khả năng do AI tạo - ${score}%</span>
            <span class="meta">${type}</span>
          </span>
          <span class="score">${score}%</span>
        </button>
        <div class="detail" data-aidetect-admin-detail hidden>
          <p>${reason}</p>
          <ul class="signals">${signalMarkup}</ul>
        </div>
      </div>
    `;
  }

  function refreshVisibleBadges() {
    document.querySelectorAll(".aidetect-admin-badge-host").forEach((host) => {
      const result = safeParseJson(host.dataset.aidetectAdminResult);
      const card = host.closest('[data-aidetect-admin-scanned="true"]') || host.parentElement;
      if (result && card instanceof HTMLElement) {
        renderOrRemoveBadge(card, result);
      }
    });
  }

  function removeAllBadges() {
    document.querySelectorAll(".aidetect-admin-badge-host").forEach((host) => {
      const card = host.closest('[data-aidetect-admin-scanned="true"]') || host.parentElement;
      if (card instanceof HTMLElement) {
        card.style.outline = "";
        card.style.outlineOffset = "";
      }
      host.remove();
    });
  }

  function removeBadge(card) {
    const host = card.querySelector(".aidetect-admin-badge-host");
    if (host) host.remove();
    card.style.outline = "";
    card.style.outlineOffset = "";
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function normalizeText(text) {
    return String(text)
      .replace(/\s+/g, " ")
      .trim();
  }

  function dedupeTexts(texts) {
    const seen = new Set();
    return texts.filter((text) => {
      const key = removeDiacritics(text.toLowerCase());
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function removeDiacritics(value) {
    return String(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D");
  }

  function safeParseJson(value) {
    try {
      return value ? JSON.parse(value) : null;
    } catch (error) {
      return null;
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
})();
