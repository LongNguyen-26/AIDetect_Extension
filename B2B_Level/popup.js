const VALID_MODES = new Set(["off", "manual", "auto"]);
const VALID_AUTO_ACTIONS = new Set(["approve_only", "approve_and_delete"]);

const DEFAULT_SETTINGS = {
  aidetectAdminEnabled: false,
  aidetectAdminMode: "off",
  aidetectAdminThreshold: 85,
  aidetectAdminMinTextLength: 8,
  aidetectAdminGroupRules: "",
  aidetectAdminAutoSkipInvalid: false,
  aidetectAdminAutoAction: "approve_only",
  aidetectAdminAutoRunning: false
};

const DEFAULT_STATS = {
  scanned: 0,
  warned: 0,
  highRisk: 0,
  autoApproved: 0,
  autoDeleted: 0
};

const elements = {
  modeButtons: Array.from(document.querySelectorAll(".mode-btn")),
  modeLabel: document.getElementById("modeLabel"),
  sectionThreshold: document.getElementById("sectionThreshold"),
  sectionRules: document.getElementById("sectionRules"),
  threshold: document.getElementById("threshold"),
  thresholdValue: document.getElementById("thresholdValue"),
  groupRules: document.getElementById("groupRules"),
  autoAction: document.getElementById("autoAction"),
  startModeration: document.getElementById("startModeration"),
  scannedCount: document.getElementById("scannedCount"),
  warnedCount: document.getElementById("warnedCount"),
  highRiskCount: document.getElementById("highRiskCount"),
  autoApprovedCount: document.getElementById("autoApprovedCount"),
  autoDeletedCount: document.getElementById("autoDeletedCount"),
  quotaPlan: document.getElementById("quotaPlan"),
  quotaText: document.getElementById("quotaText"),
  quotaFill: document.getElementById("quotaFill"),
  quotaHint: document.getElementById("quotaHint"),
  openOptions: document.getElementById("openOptions"),
  refreshQuota: document.getElementById("refreshQuota"),
  openBilling: document.getElementById("openBilling"),
  redLegend: document.getElementById("redLegend"),
  silentLegend: document.getElementById("silentLegend"),
  resetStats: document.getElementById("resetStats"),
  saveStatus: document.getElementById("saveStatus")
};

const popupState = {
  mode: DEFAULT_SETTINGS.aidetectAdminMode,
  autoRunning: DEFAULT_SETTINGS.aidetectAdminAutoRunning,
  quota: null
};

document.addEventListener("DOMContentLoaded", initPopup);

function initPopup() {
  loadSettings((settings) => applySettings(settings));
  refreshStats();
  refreshQuota(false);
  bindEvents();
  setupStorageListener();
}

function bindEvents() {
  elements.modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.mode === "auto" && !canUseAutoModeration()) {
        openOptionsPage();
        flashStatus("License required");
        return;
      }
      setMode(button.dataset.mode);
    });
  });

  elements.threshold.addEventListener("input", () => {
    const value = clamp(Number(elements.threshold.value), 70, 95);
    renderThreshold(value);
    saveSettings({ aidetectAdminThreshold: value });
  });

  elements.groupRules.addEventListener("input", () => {
    window.clearTimeout(elements.groupRules.saveTimer);
    elements.groupRules.saveTimer = window.setTimeout(() => {
      saveSettings({ aidetectAdminGroupRules: elements.groupRules.value.trim() });
    }, 350);
  });
  elements.groupRules.addEventListener("change", () => {
    window.clearTimeout(elements.groupRules.saveTimer);
    saveSettings({ aidetectAdminGroupRules: elements.groupRules.value.trim() });
  });

  elements.autoAction.addEventListener("change", () => {
    const value = VALID_AUTO_ACTIONS.has(elements.autoAction.value)
      ? elements.autoAction.value
      : DEFAULT_SETTINGS.aidetectAdminAutoAction;
    saveSettings({
      aidetectAdminAutoAction: value,
      aidetectAdminAutoSkipInvalid: value === "approve_only"
    });
  });

  elements.startModeration.addEventListener("click", () => {
    if (!canUseAutoModeration()) {
      openOptionsPage();
      flashStatus("License required");
      return;
    }

    const nextRunning = !popupState.autoRunning;
    saveSettings({
      aidetectAdminMode: "auto",
      aidetectAdminEnabled: true,
      aidetectAdminAutoRunning: nextRunning
    });
    updateModeUi("auto", nextRunning);
  });

  elements.openOptions.addEventListener("click", openOptionsPage);

  elements.refreshQuota.addEventListener("click", () => {
    refreshQuota(true);
  });

  elements.openBilling.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "OPEN_AIDETECT_PAGE", page: "billing" });
  });

  elements.resetStats.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "RESET_ADMIN_STATS" }, (stats) => {
      renderStats(stats || DEFAULT_STATS);
      flashStatus("Đã đặt lại");
    });
  });
}

function setupStorageListener() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local") {
      const statsChange = Object.entries(changes).find(([key]) => key.startsWith("aidetectAdminStats:"));
      if (statsChange) {
        renderStats(statsChange[1].newValue || DEFAULT_STATS);
      }
      return;
    }

    if (areaName !== "sync") return;

    if (changes.aidetectAdminMode) {
      updateModeUi(normalizeMode(changes.aidetectAdminMode.newValue), popupState.autoRunning);
    }

    if (changes.aidetectAdminGroupRules && document.activeElement !== elements.groupRules) {
      elements.groupRules.value = String(changes.aidetectAdminGroupRules.newValue || "");
    }

    if (changes.aidetectAdminAutoAction) {
      const action = normalizeAutoAction(changes.aidetectAdminAutoAction.newValue);
      elements.autoAction.value = action;
    }

    if (changes.aidetectAdminAutoRunning) {
      updateModeUi(popupState.mode, Boolean(changes.aidetectAdminAutoRunning.newValue));
    }
  });
}

function loadSettings(callback) {
  chrome.storage.sync.get(null, (items) => {
    const storedItems = items || {};
    const settings = normalizeSettings(storedItems);
    const migration = buildSettingsMigration(storedItems, settings);

    if (Object.keys(migration).length > 0) {
      chrome.storage.sync.set(migration, () => callback(settings));
      return;
    }

    callback(settings);
  });
}

function buildSettingsMigration(items, settings) {
  const migration = {};

  if (!Object.prototype.hasOwnProperty.call(items, "aidetectAdminMode")) {
    migration.aidetectAdminMode = settings.aidetectAdminMode;
  }

  [
    "aidetectAdminThreshold",
    "aidetectAdminMinTextLength",
    "aidetectAdminGroupRules",
    "aidetectAdminAutoSkipInvalid",
    "aidetectAdminAutoAction",
    "aidetectAdminAutoRunning"
  ].forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(items, key)) {
      migration[key] = settings[key];
    }
  });

  if (items.aidetectAdminAutoSkipInvalid !== settings.aidetectAdminAutoSkipInvalid) {
    migration.aidetectAdminAutoSkipInvalid = settings.aidetectAdminAutoSkipInvalid;
  }

  const legacyEnabled = settings.aidetectAdminMode !== "off";
  if (!Object.prototype.hasOwnProperty.call(items, "aidetectAdminEnabled") || items.aidetectAdminEnabled !== legacyEnabled) {
    migration.aidetectAdminEnabled = legacyEnabled;
  }

  return migration;
}

function normalizeSettings(items) {
  const settings = { ...DEFAULT_SETTINGS, ...(items || {}) };

  if (!Object.prototype.hasOwnProperty.call(items || {}, "aidetectAdminMode") && typeof settings.aidetectAdminEnabled === "boolean") {
    settings.aidetectAdminMode = settings.aidetectAdminEnabled ? "manual" : "off";
  }

  if (!VALID_MODES.has(settings.aidetectAdminMode)) {
    settings.aidetectAdminMode = DEFAULT_SETTINGS.aidetectAdminMode;
  }

  if (!VALID_AUTO_ACTIONS.has(settings.aidetectAdminAutoAction)) {
    settings.aidetectAdminAutoAction = DEFAULT_SETTINGS.aidetectAdminAutoAction;
  }

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
  settings.aidetectAdminAutoSkipInvalid = settings.aidetectAdminAutoAction === "approve_only";
  settings.aidetectAdminAutoRunning = Boolean(settings.aidetectAdminAutoRunning);

  return settings;
}

function applySettings(settings) {
  renderThreshold(settings.aidetectAdminThreshold);
  elements.groupRules.value = settings.aidetectAdminGroupRules;
  elements.autoAction.value = settings.aidetectAdminAutoAction;
  updateModeUi(settings.aidetectAdminMode, settings.aidetectAdminAutoRunning);
}

function setMode(mode) {
  const normalizedMode = normalizeMode(mode);
  updateModeUi(normalizedMode);
  saveSettings({
    aidetectAdminMode: normalizedMode,
    aidetectAdminEnabled: normalizedMode !== "off",
    aidetectAdminAutoRunning: false
  });
}

function saveSettings(values) {
  chrome.storage.sync.set(values, () => flashStatus("Đã lưu"));
}

function updateModeUi(mode, autoRunning = false) {
  const copy = {
    off: {
      label: "Chưa kích hoạt"
    },
    manual: {
      label: "Đang quét thủ công - hãy lướt bài"
    },
    auto: {
      label: autoRunning ? "Đang tự động kiểm duyệt" : "Đã chọn tự động - bấm Bắt đầu duyệt"
    }
  };
  const normalizedMode = normalizeMode(mode);
  const modeCopy = copy[normalizedMode] || copy.off;
  const running = normalizedMode === "auto" && Boolean(autoRunning);

  popupState.mode = normalizedMode;
  popupState.autoRunning = running;

  elements.modeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === normalizedMode);
  });
  elements.modeLabel.textContent = modeCopy.label;
  elements.startModeration.textContent = running ? "Dừng duyệt" : "Bắt đầu duyệt";
  elements.startModeration.classList.toggle("running", running);
  elements.startModeration.disabled = normalizedMode === "auto" && !canUseAutoModeration();
  updateSectionVisibility(normalizedMode);
}

function updateSectionVisibility(mode) {
  elements.sectionThreshold.hidden = mode === "off";
  elements.sectionRules.hidden = mode !== "auto";
}

function renderThreshold(value) {
  elements.threshold.value = String(value);
  elements.thresholdValue.textContent = `${value}%`;
  elements.redLegend.textContent = `≥${value}%`;
  elements.silentLegend.textContent = `<${value}%`;
}

function refreshStats() {
  chrome.runtime.sendMessage({ action: "GET_ADMIN_STATS" }, (stats) => {
    renderStats(stats || DEFAULT_STATS);
  });
}

function refreshQuota(forceRefresh) {
  chrome.runtime.sendMessage({
    action: "GET_QUOTA_STATUS",
    forceRefresh
  }, (quota) => {
    if (chrome.runtime.lastError) {
      renderQuota({
        plan: "free",
        quota_limit: 0,
        quota_used: 0,
        quota_remaining: 0,
        license_status: "error",
        error: "Cannot load quota"
      });
      return;
    }

    renderQuota(quota || {});
  });
}

function renderQuota(quota) {
  const limit = Math.max(0, Number(quota.quota_limit || 0));
  const used = Math.max(0, Number(quota.quota_used || 0));
  const remaining = Math.max(0, Number(quota.quota_remaining || 0));
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  popupState.quota = quota;
  elements.quotaPlan.textContent = formatPlan(quota.plan || "free");
  elements.quotaText.textContent = `${used} / ${limit}`;
  elements.quotaFill.style.width = `${percent}%`;

  if (quota.license_status === "missing") {
    elements.quotaHint.textContent = "Manual scan is free. Add a License Key to enable auto.";
  } else if (quota.license_status === "invalid") {
    elements.quotaHint.textContent = "License Key is invalid or rotated.";
  } else if (quota.quota_exceeded || (remaining <= 0 && limit > 0)) {
    elements.quotaHint.textContent = "Auto quota is used up. Manual scan remains free.";
  } else if (quota.license_status === "error") {
    elements.quotaHint.textContent = quota.error || "Cannot check quota.";
  } else {
    elements.quotaHint.textContent = `${remaining} auto moderation requests remaining this month.`;
  }

  elements.startModeration.disabled = popupState.mode === "auto" && !canUseAutoModeration();
}

function renderStats(stats) {
  elements.scannedCount.textContent = Number(stats.scanned || 0);
  elements.warnedCount.textContent = Number(stats.warned || 0);
  elements.highRiskCount.textContent = Number(stats.highRisk || 0);
  elements.autoApprovedCount.textContent = Number(stats.autoApproved || 0);
  elements.autoDeletedCount.textContent = Number(stats.autoDeleted || 0);
}

function flashStatus(message) {
  elements.saveStatus.textContent = message;
  window.clearTimeout(flashStatus.timer);
  flashStatus.timer = window.setTimeout(() => {
    elements.saveStatus.textContent = "Đã lưu";
  }, 1200);
}

function canUseAutoModeration() {
  const quota = popupState.quota;
  return Boolean(
    quota &&
    quota.license_status === "valid" &&
    quota.can_auto_moderate === true &&
    Number(quota.quota_remaining || 0) > 0
  );
}

function openOptionsPage() {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
    return;
  }

  chrome.runtime.sendMessage({ action: "OPEN_AIDETECT_PAGE", page: "license" });
}

function formatPlan(plan) {
  const value = String(plan || "free");
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeMode(value) {
  return VALID_MODES.has(value) ? value : DEFAULT_SETTINGS.aidetectAdminMode;
}

function normalizeAutoAction(value) {
  return VALID_AUTO_ACTIONS.has(value) ? value : DEFAULT_SETTINGS.aidetectAdminAutoAction;
}
