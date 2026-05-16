(function () {
  "use strict";

  const LOG_PREFIX = "AIDetect Admin";
  const VALID_MODES = new Set(["off", "manual", "auto"]);
  const VALID_AUTO_ACTIONS = new Set(["approve_only", "approve_and_delete"]);
  const DEFAULT_SETTINGS = {
    aidetectAdminEnabled: false,
    aidetectAdminMode: "off",
    aidetectAdminThreshold: 85,
    aidetectAdminMinTextLength: 8,
    aidetectAdminGroupRules: "",
    aidetectAdminAutoSkipInvalid: false,
    aidetectAdminAutoAction: "approve_only"
  };
  const FAB_HOST_ID = "aidetect-admin-fab-host";
  const MODE_ICON = { off: "AI", manual: "🔍", auto: "⚡" };
  const MODE_COLOR = { off: "#1877f2", manual: "#1877f2", auto: "#16a34a" };
  const HASH_CACHE_MAX = 500;
  const AUTO_BATCH_SIZE = 3;

  const UI_TEXT = {
    approve: ["phê duyệt", "phe duyet", "approve"],
    reject: ["từ chối", "tu choi", "decline", "reject"],
    confirmDelete: ["xóa", "xoa", "delete", "xác nhận", "xac nhan", "confirm", "ok"],
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
    autoScanTimer: null,
    autoScrollTimer: null,
    intersectionObserver: null,
    fabRoot: null
  };

  const scannedCards = new WeakSet();
  const observedCards = new WeakSet();
  const contentHashCache = new Map();
  const pendingHashRequests = new Map();
  const resultCache = new WeakMap();
  const cardIndexes = new WeakMap();
  const cardDecisions = new WeakMap();
  const warningStateByCard = new WeakMap();
  let nextCardIndex = 1;
  let warnedCardCount = 0;

  init();

  async function init() {
    console.info(`${LOG_PREFIX}: content script loaded`);
    await loadSettings();
    injectFloatingButton();
    updateFabMode(state.aidetectAdminMode);
    setupStorageListener();
    setupViewportScanner();
    setupDomObserver();
    if (isAutoModeActive()) {
      startAutoMode();
    } else {
      scheduleScan(150);
      setTimeout(() => scheduleScan(0), 1200);
    }
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

  function isManualModeActive() {
    return state.aidetectAdminMode === "manual";
  }

  function isAutoModeActive() {
    return state.aidetectAdminMode === "auto";
  }

  function fnv1a32(value) {
    let hash = 0x811c9dc5;
    const input = String(value);

    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }

    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function buildContentHash(payload) {
    const normalized = [
      normalizeText(payload.text || "").slice(0, 3000),
      Number(payload.mediaCount || 0),
      Number(payload.videoCount || 0)
    ].join("|");

    return fnv1a32(removeDiacritics(normalized.toLowerCase()));
  }

  function setContentHashCache(hash, result) {
    if (!hash) return;

    if (contentHashCache.has(hash)) {
      contentHashCache.delete(hash);
    } else if (contentHashCache.size >= HASH_CACHE_MAX) {
      const oldestHash = contentHashCache.keys().next().value;
      contentHashCache.delete(oldestHash);
    }

    contentHashCache.set(hash, result);
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function scanCardAsync(payload) {
    const contentHash = payload.contentHash || buildContentHash(payload);
    payload.contentHash = contentHash;

    if (contentHashCache.has(contentHash)) {
      return Promise.resolve(contentHashCache.get(contentHash));
    }

    if (pendingHashRequests.has(contentHash)) {
      return pendingHashRequests.get(contentHash);
    }

    const request = new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "SCAN_PENDING_POST", data: payload }, (response) => {
        if (chrome.runtime.lastError || !response || typeof response.score !== "number") {
          resolve(null);
          return;
        }

        const result = { ...response, status: "done", contentHash };
        setContentHashCache(contentHash, result);
        resolve(result);
      });
    }).finally(() => {
      pendingHashRequests.delete(contentHash);
    });

    pendingHashRequests.set(contentHash, request);
    return request;
  }

  function checkGroupRules(text, rules) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: "CHECK_GROUP_RULES",
        data: { text, rules }
      }, (response) => {
        if (chrome.runtime.lastError || !response) {
          resolve(null);
          return;
        }

        resolve(response);
      });
    });
  }

  function updateAutoStats(field) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "UPDATE_AUTO_STAT", field }, resolve);
    });
  }

  function injectFloatingButton() {
    if (!document.body) {
      window.setTimeout(injectFloatingButton, 100);
      return;
    }

    const existingHost = document.getElementById(FAB_HOST_ID);
    if (existingHost?.shadowRoot) {
      state.fabRoot = existingHost.shadowRoot;
      return;
    }
    if (existingHost) {
      existingHost.remove();
    }

    const host = document.createElement("div");
    host.id = FAB_HOST_ID;
    document.body.appendChild(host);

    const root = host.attachShadow({ mode: "open" });
    state.fabRoot = root;
    root.innerHTML = buildFabMarkup();

    root.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    root.getElementById("aidetect-fab-toggle")?.addEventListener("click", () => {
      root.getElementById("aidetect-fab-menu")?.classList.toggle("open");
    });

    root.getElementById("aidetect-fab-manual")?.addEventListener("click", () => {
      setModeFromFab("manual");
    });

    root.getElementById("aidetect-fab-auto")?.addEventListener("click", () => {
      setModeFromFab("auto");
    });

    root.getElementById("aidetect-fab-stop")?.addEventListener("click", () => {
      setModeFromFab("off");
    });

    document.addEventListener("click", closeFabMenu);
  }

  function buildFabMarkup() {
    return `
      <style>
        :host {
          all: initial;
          position: fixed;
          right: 24px;
          bottom: 24px;
          z-index: 2147483647;
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 8px;
          color-scheme: light;
          font-family: "Segoe UI", Arial, sans-serif;
        }

        button {
          font: inherit;
        }

        .menu {
          display: none;
          flex-direction: column;
          align-items: flex-end;
          gap: 6px;
        }

        .menu.open {
          display: flex;
        }

        .item {
          display: flex;
          align-items: center;
          gap: 8px;
          min-height: 34px;
          border: 1px solid #e5e7eb;
          border-radius: 20px;
          background: #ffffff;
          color: #374151;
          cursor: pointer;
          font-size: 13px;
          font-weight: 700;
          line-height: 1.2;
          padding: 7px 14px 7px 10px;
          white-space: nowrap;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.14);
          transition: 120ms ease;
        }

        .item:hover {
          background: #f3f4f6;
        }

        .item.manual {
          color: #1877f2;
        }

        .item.auto {
          color: #15803d;
        }

        .item.stop {
          color: #dc2626;
        }

        .item-icon {
          display: grid;
          place-items: center;
          width: 20px;
          height: 20px;
          border-radius: 999px;
          background: transparent;
          color: currentColor;
          font-size: 14px;
          font-weight: 800;
          line-height: 1;
        }

        .main-wrap {
          position: relative;
        }

        .main {
          display: grid;
          place-items: center;
          width: 52px;
          height: 52px;
          border: 0;
          border-radius: 50%;
          background: #1877f2;
          color: #ffffff;
          cursor: pointer;
          font-size: 21px;
          font-weight: 900;
          line-height: 1;
          box-shadow: 0 4px 14px rgba(24, 119, 242, 0.45);
          transition: 120ms ease;
          user-select: none;
        }

        .main:hover {
          filter: brightness(0.94);
        }

        .badge {
          position: absolute;
          top: -4px;
          right: -4px;
          display: none;
          min-width: 18px;
          border-radius: 999px;
          background: #dc2626;
          color: #ffffff;
          font-size: 10px;
          font-weight: 900;
          line-height: 1;
          padding: 3px 5px;
          text-align: center;
        }
      </style>

      <div class="menu" id="aidetect-fab-menu">
        <button class="item manual" id="aidetect-fab-manual" type="button">
          <span class="item-icon" aria-hidden="true">🔍</span>
          <span>Quét thủ công</span>
        </button>
        <button class="item auto" id="aidetect-fab-auto" type="button">
          <span class="item-icon" aria-hidden="true">⚡</span>
          <span>Tự động kiểm duyệt</span>
        </button>
        <button class="item stop" id="aidetect-fab-stop" type="button">
          <span class="item-icon" aria-hidden="true">■</span>
          <span>Dừng</span>
        </button>
      </div>
      <div class="main-wrap">
        <button class="main" id="aidetect-fab-toggle" type="button" title="AIDetect Admin">AI</button>
        <span class="badge" id="aidetect-fab-count"></span>
      </div>
    `;
  }

  function setModeFromFab(mode) {
    const normalizedMode = normalizeMode(mode);
    state.aidetectAdminMode = normalizedMode;
    updateFabMode(normalizedMode);
    closeFabMenu();

    chrome.storage.sync.set({
      aidetectAdminMode: normalizedMode,
      aidetectAdminEnabled: normalizedMode !== "off"
    });

    if (!isScanModeActive()) {
      stopAutoMode();
      removeAllBadges();
      return;
    }

    if (isAutoModeActive()) {
      startAutoMode();
      return;
    }

    stopAutoMode();
    scheduleScan(0);
  }

  function closeFabMenu() {
    state.fabRoot?.getElementById("aidetect-fab-menu")?.classList.remove("open");
  }

  function updateFabMode(mode) {
    const button = state.fabRoot?.getElementById("aidetect-fab-toggle");
    if (!button) return;

    const normalizedMode = normalizeMode(mode);
    button.textContent = MODE_ICON[normalizedMode] || MODE_ICON.off;
    button.style.background = MODE_COLOR[normalizedMode] || MODE_COLOR.off;
    button.title = `AIDetect Admin - ${normalizedMode}`;
  }

  function updateFabBadge(warnCount) {
    const badge = state.fabRoot?.getElementById("aidetect-fab-count");
    if (!badge) return;

    badge.style.display = warnCount > 0 ? "block" : "none";
    badge.textContent = warnCount > 99 ? "99+" : String(warnCount);
  }

  function startAutoMode() {
    console.info(`${LOG_PREFIX}: auto mode started`);
    stopManualScanTimer();
    resetAutoDecisionsForCurrentCards();
    scheduleAutoScan(300);
  }

  function stopAutoMode() {
    window.clearTimeout(state.autoScanTimer);
    window.clearTimeout(state.autoScrollTimer);
    state.autoScanTimer = null;
    state.autoScrollTimer = null;
    removeActionBadges();
  }

  function stopManualScanTimer() {
    window.clearTimeout(state.scanTimer);
    state.scanTimer = null;
  }

  function resetAutoDecisionsForCurrentCards() {
    if (!isLikelyGroupModerationPage()) return;

    findPendingPostCards().forEach((card) => {
      if (cardDecisions.get(card) !== "done") {
        cardDecisions.set(card, "pending");
      }
    });
  }

  function scheduleAutoScan(delay = 800) {
    window.clearTimeout(state.autoScanTimer);
    state.autoScanTimer = window.setTimeout(autoScanCycle, delay);
  }

  async function autoScanCycle() {
    if (!isAutoModeActive()) return;

    if (!isLikelyGroupModerationPage()) {
      scheduleAutoScan(2000);
      return;
    }

    const cards = findPendingPostCards().filter((card) => {
      const decision = cardDecisions.get(card);
      return !decision || decision === "pending";
    });
    const batch = cards.slice(0, AUTO_BATCH_SIZE);

    for (const card of batch) {
      if (!isAutoModeActive()) return;

      cardDecisions.set(card, "analyzing");
      await analyzeAndDecide(card);
      await sleep(randomBetween(400, 900));
    }

    if (state.aidetectAdminAutoSkipInvalid) {
      checkAndScrollIfScreenFull();
    }

    scheduleAutoScan(1500);
  }

  async function analyzeAndDecide(card) {
    const payload = buildCardPayload(card);
    if (!payload.text && payload.mediaCount === 0) {
      cardDecisions.set(card, "pending");
      return;
    }

    const contentHash = buildContentHash(payload);
    payload.contentHash = contentHash;
    card.dataset.aidetectAdminContentHash = contentHash;
    scannedCards.add(card);
    card.dataset.aidetectAdminScanned = "true";
    renderLoadingBadge(card);

    const aiResult = await scanCardAsync(payload);
    if (!aiResult) {
      cardDecisions.set(card, "pending");
      removeBadge(card);
      return;
    }

    resultCache.set(card, aiResult);
    const rulesResult = state.aidetectAdminGroupRules
      ? await checkGroupRules(payload.text, state.aidetectAdminGroupRules)
      : null;
    const verdict = computeVerdict(aiResult, rulesResult);

    cardDecisions.set(card, verdict);
    renderDecisionBadge(card, aiResult, verdict, rulesResult);

    const delay = randomBetween(1200, 2400);
    window.setTimeout(() => executeDecision(card, verdict), delay);
  }

  function computeVerdict(aiResult, rulesResult) {
    const isAiHigh = Number(aiResult?.score || 0) >= state.aidetectAdminThreshold;
    const isRulesViolation = rulesResult?.violation === true;
    const isInvalid = isAiHigh || isRulesViolation;

    if (!isInvalid) return "approve";
    if (state.aidetectAdminAutoSkipInvalid) return "skip";
    if (state.aidetectAdminAutoAction === "approve_and_delete") return "delete";
    return "skip";
  }

  async function executeDecision(card, verdict) {
    if (!isAutoModeActive()) return;
    if (verdict === "skip") return;
    if (cardDecisions.get(card) === "done") return;

    if (verdict === "approve") {
      const approved = await clickApproveButton(card);
      if (approved) {
        await updateAutoStats("autoApproved");
        markCardDone(card, "approved");
      } else {
        cardDecisions.set(card, "pending");
      }
      return;
    }

    if (verdict === "delete") {
      const deleted = await clickDeleteButton(card);
      if (deleted) {
        await updateAutoStats("autoDeleted");
        markCardDone(card, "deleted");
      } else {
        cardDecisions.set(card, "pending");
      }
    }
  }

  function markCardDone(card, action) {
    cardDecisions.set(card, "done");
    card.dataset.aidetectAdminAction = action;
    setCardWarningState(card, false);

    card.style.transition = "opacity 0.4s ease";
    card.style.opacity = "0.35";
    window.setTimeout(() => {
      card.style.opacity = "";
      card.style.transition = "";
    }, 800);
  }

  async function clickApproveButton(card) {
    const controls = Array.from(card.querySelectorAll('button, [role="button"], a[role="button"]'));
    const approveButton = controls.find(isApproveControl);
    if (!approveButton) return false;

    approveButton.click();
    await sleep(300);
    return true;
  }

  async function clickDeleteButton(card) {
    const controls = Array.from(card.querySelectorAll('button, [role="button"], a[role="button"]'));
    const deleteButton = controls.find(isRejectControl);
    if (!deleteButton) return false;

    deleteButton.click();
    await sleep(600);

    const confirmButton = findConfirmDeleteButton();
    if (confirmButton) {
      confirmButton.click();
      await sleep(300);
    }

    return true;
  }

  function findConfirmDeleteButton() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));

    for (const dialog of dialogs) {
      const controls = Array.from(dialog.querySelectorAll('button, [role="button"], a[role="button"]'));
      const confirmButton = controls.find((control) => hasAnyLabel(control, UI_TEXT.confirmDelete));
      if (confirmButton) return confirmButton;
    }

    return null;
  }

  function checkAndScrollIfScreenFull() {
    if (!state.aidetectAdminAutoSkipInvalid) return;

    const visibleCards = findPendingPostCards().filter((card) => {
      const rect = card.getBoundingClientRect();
      return rect.top >= 0 && rect.top <= window.innerHeight && rect.bottom <= window.innerHeight + 200;
    });

    if (visibleCards.length === 0) return;

    const allSkipped = visibleCards.every((card) => cardDecisions.get(card) === "skip");
    if (allSkipped) {
      console.info(`${LOG_PREFIX}: screen full of skipped posts, scrolling down`);
      smoothScrollDown();
    }
  }

  function smoothScrollDown() {
    window.clearTimeout(state.autoScrollTimer);
    const target = window.scrollY + window.innerHeight * 0.7;
    window.scrollTo({ top: target, behavior: "smooth" });
    state.autoScrollTimer = window.setTimeout(() => scheduleAutoScan(800), 1200);
  }

  function removeActionBadges() {
    document.querySelectorAll('.aidetect-admin-badge-host[data-aidetect-admin-status="decision"]').forEach((host) => {
      const card = host.closest('[data-aidetect-admin-scanned="true"]') || host.parentElement;
      if (card instanceof HTMLElement) {
        const result = resultCache.get(card);
        setCardWarningState(card, false);
        if (isManualModeActive() && result) {
          renderOrRemoveBadge(card, result);
          return;
        }
        card.style.outline = "";
        card.style.outlineOffset = "";
      }

      host.remove();
    });
  }

  function setupStorageListener() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") return;

      if (changes.aidetectAdminMode) {
        state.aidetectAdminMode = normalizeMode(changes.aidetectAdminMode.newValue);
        updateFabMode(state.aidetectAdminMode);
        if (!isScanModeActive()) {
          stopAutoMode();
          removeAllBadges();
          return;
        }
        if (isAutoModeActive()) {
          startAutoMode();
        } else {
          stopAutoMode();
          scheduleScan(0);
        }
      }

      if (changes.aidetectAdminEnabled && !changes.aidetectAdminMode) {
        state.aidetectAdminMode = changes.aidetectAdminEnabled.newValue ? "manual" : "off";
        updateFabMode(state.aidetectAdminMode);
        if (!isScanModeActive()) {
          stopAutoMode();
          removeAllBadges();
          return;
        }
        stopAutoMode();
        scheduleScan(0);
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

      if (isManualModeActive()) {
        scheduleScan(0);
      } else if (isAutoModeActive()) {
        scheduleAutoScan(300);
      }
    });
  }

  function setupViewportScanner() {
    if (!("IntersectionObserver" in window)) return;

    state.intersectionObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting || !isManualModeActive()) return;
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
    state.observer = new MutationObserver(() => {
      if (isAutoModeActive()) {
        scheduleAutoScan(500);
        return;
      }

      scheduleScan(250);
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  function scheduleScan(delay) {
    window.clearTimeout(state.scanTimer);
    state.scanTimer = window.setTimeout(scanPendingPosts, delay);
  }

  function scanPendingPosts() {
    if (!isManualModeActive()) return;
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

  async function analyzePendingCard(card) {
    if (!isManualModeActive() || scannedCards.has(card)) return;

    const cached = resultCache.get(card);
    if (cached) {
      renderOrRemoveBadge(card, cached);
      return;
    }

    const payload = buildCardPayload(card);
    if (!payload.text && payload.mediaCount === 0) return;

    const contentHash = buildContentHash(payload);
    payload.contentHash = contentHash;
    card.dataset.aidetectAdminContentHash = contentHash;

    scannedCards.add(card);
    card.dataset.aidetectAdminScanned = "true";
    renderLoadingBadge(card);

    const result = await scanCardAsync(payload);
    if (!result) {
      removeBadge(card);
      return;
    }

    resultCache.set(card, result);
    if (!isManualModeActive()) return;
    renderOrRemoveBadge(card, result);
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
      setCardWarningState(card, true);
      renderBadge(card, result);
      return;
    }

    setCardWarningState(card, false);
    removeBadge(card);
  }

  function setCardWarningState(card, isWarning) {
    const wasWarning = warningStateByCard.get(card) === true;

    if (isWarning && !wasWarning) {
      warnedCardCount += 1;
    } else if (!isWarning && wasWarning) {
      warnedCardCount = Math.max(0, warnedCardCount - 1);
    }

    warningStateByCard.set(card, isWarning);
    updateFabBadge(warnedCardCount);
  }

  function renderLoadingBadge(card) {
    const host = getOrCreateBadgeHost(card);
    host.dataset.aidetectAdminResult = "";
    host.dataset.aidetectAdminStatus = "loading";

    const root = host.shadowRoot || host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host {
          all: initial;
          color-scheme: light;
          font-family: Arial, "Segoe UI", sans-serif;
        }

        .loading {
          box-sizing: border-box;
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 10px 16px 8px;
          border: 1px solid #e5e7eb;
          border-left: 5px solid #9ca3af;
          border-radius: 8px;
          background: #f9fafb;
          color: #6b7280;
          font-size: 12px;
          line-height: 1.35;
          padding: 8px 12px;
        }

        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }

        .spinner {
          width: 14px;
          height: 14px;
          border: 2px solid #e5e7eb;
          border-top-color: #9ca3af;
          border-radius: 50%;
          animation: spin 0.7s linear infinite;
          flex: 0 0 auto;
        }
      </style>

      <div class="loading" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <span>AIDetect đang phân tích...</span>
      </div>
    `;
  }

  function renderDecisionBadge(card, aiResult, verdict, rulesResult) {
    const config = {
      approve: {
        color: "#16a34a",
        background: "#f0fdf4",
        border: "#86efac",
        icon: "✓",
        label: "Sẽ phê duyệt"
      },
      delete: {
        color: "#dc2626",
        background: "#fef2f2",
        border: "#fca5a5",
        icon: "×",
        label: "Sẽ xóa bài"
      },
      skip: {
        color: "#a16207",
        background: "#fffbeb",
        border: "#fcd34d",
        icon: "II",
        label: "Bỏ qua - giữ trong hàng chờ"
      }
    };
    const decision = config[verdict] || config.skip;
    const score = Math.round(Number(aiResult?.score) || 0);
    const ruleNote = rulesResult?.violation
      ? `<small>Vi phạm quy tắc: ${escapeHtml(rulesResult.reason || "Không rõ lý do")}</small>`
      : "";

    const host = getOrCreateBadgeHost(card);
    host.dataset.aidetectAdminResult = JSON.stringify(aiResult || {});
    host.dataset.aidetectAdminStatus = "decision";
    host.dataset.aidetectAdminVerdict = verdict;

    const root = host.shadowRoot || host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host {
          all: initial;
          color-scheme: light;
          font-family: Arial, "Segoe UI", sans-serif;
        }

        .wrap {
          box-sizing: border-box;
          display: flex;
          align-items: center;
          gap: 10px;
          margin: 8px 16px;
          border: 1px solid ${decision.border};
          border-left: 5px solid ${decision.color};
          border-radius: 8px;
          background: ${decision.background};
          color: #1c1e21;
          font-size: 13px;
          line-height: 1.35;
          padding: 9px 12px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.10);
        }

        .icon {
          display: grid;
          place-items: center;
          width: 24px;
          height: 24px;
          border-radius: 999px;
          background: ${decision.color};
          color: #ffffff;
          font-size: 13px;
          font-weight: 900;
          line-height: 1;
          flex: 0 0 auto;
        }

        .body {
          min-width: 0;
          display: grid;
          gap: 2px;
        }

        .label {
          color: ${decision.color};
          font-weight: 800;
        }

        small {
          color: #4b5563;
          font-size: 12px;
          overflow-wrap: anywhere;
        }

        .score {
          margin-left: auto;
          color: #6b7280;
          font-size: 12px;
          font-weight: 700;
          white-space: nowrap;
        }
      </style>

      <div class="wrap aidetect-action-badge" role="status">
        <span class="icon" aria-hidden="true">${decision.icon}</span>
        <span class="body">
          <span class="label">${decision.label}</span>
          ${ruleNote}
        </span>
        <span class="score">AI: ${score}%</span>
      </div>
    `;

    setCardWarningState(card, verdict !== "approve");
    card.style.outline = `2px solid ${hexToRgba(decision.color, 0.36)}`;
    card.style.outlineOffset = "3px";
  }

  function renderBadge(card, result) {
    const host = getOrCreateBadgeHost(card);
    host.dataset.aidetectAdminResult = JSON.stringify(result);
    host.dataset.aidetectAdminStatus = "done";

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
    document.querySelectorAll('[data-aidetect-admin-scanned="true"]').forEach((card) => {
      if (!(card instanceof HTMLElement)) return;
      if (isAutoModeActive() && cardDecisions.get(card)) return;

      const result = resultCache.get(card);
      if (result) {
        renderOrRemoveBadge(card, result);
      }
    });
  }

  function removeAllBadges() {
    document.querySelectorAll(".aidetect-admin-badge-host").forEach((host) => {
      const card = host.closest('[data-aidetect-admin-scanned="true"]') || host.parentElement;
      if (card instanceof HTMLElement) {
        setCardWarningState(card, false);
        card.style.outline = "";
        card.style.outlineOffset = "";
      }
      host.remove();
    });

    warnedCardCount = 0;
    updateFabBadge(warnedCardCount);
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

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function hexToRgba(hex, alpha) {
    const value = String(hex || "").replace("#", "");
    if (value.length !== 6) return `rgba(0, 0, 0, ${alpha})`;

    const red = parseInt(value.slice(0, 2), 16);
    const green = parseInt(value.slice(2, 4), 16);
    const blue = parseInt(value.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
})();
