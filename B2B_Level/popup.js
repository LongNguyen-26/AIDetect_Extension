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

const DEFAULT_STATS = {
  scanned: 0,
  warned: 0,
  highRisk: 0,
  autoApproved: 0,
  autoDeleted: 0
};

const elements = {
  modeInputs: Array.from(document.querySelectorAll('input[name="aidetectAdminMode"]')),
  modeValue: document.getElementById("modeValue"),
  modeHint: document.getElementById("modeHint"),
  scannerStatus: document.getElementById("scannerStatus"),
  threshold: document.getElementById("threshold"),
  thresholdValue: document.getElementById("thresholdValue"),
  groupRules: document.getElementById("groupRules"),
  autoAction: document.getElementById("autoAction"),
  autoSkipInvalid: document.getElementById("autoSkipInvalid"),
  scannedCount: document.getElementById("scannedCount"),
  warnedCount: document.getElementById("warnedCount"),
  highRiskCount: document.getElementById("highRiskCount"),
  autoApprovedCount: document.getElementById("autoApprovedCount"),
  autoDeletedCount: document.getElementById("autoDeletedCount"),
  redLegend: document.getElementById("redLegend"),
  silentLegend: document.getElementById("silentLegend"),
  resetStats: document.getElementById("resetStats"),
  saveStatus: document.getElementById("saveStatus")
};

document.addEventListener("DOMContentLoaded", initPopup);

function initPopup() {
  loadSettings((settings) => applySettings(settings));
  refreshStats();
  bindEvents();
}

function bindEvents() {
  elements.modeInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      updateModeUi(input.value);
      saveSettings({
        aidetectAdminMode: input.value,
        aidetectAdminEnabled: input.value !== "off"
      });
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
    saveSettings({ aidetectAdminAutoAction: value });
  });

  elements.autoSkipInvalid.addEventListener("change", () => {
    saveSettings({ aidetectAdminAutoSkipInvalid: elements.autoSkipInvalid.checked });
  });

  elements.resetStats.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "RESET_ADMIN_STATS" }, (stats) => {
      renderStats(stats || DEFAULT_STATS);
      flashStatus("Đã đặt lại");
    });
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
    "aidetectAdminAutoAction"
  ].forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(items, key)) {
      migration[key] = settings[key];
    }
  });

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
  settings.aidetectAdminAutoSkipInvalid = Boolean(settings.aidetectAdminAutoSkipInvalid);

  return settings;
}

function applySettings(settings) {
  elements.modeInputs.forEach((input) => {
    input.checked = input.value === settings.aidetectAdminMode;
  });
  renderThreshold(settings.aidetectAdminThreshold);
  elements.groupRules.value = settings.aidetectAdminGroupRules;
  elements.autoAction.value = settings.aidetectAdminAutoAction;
  elements.autoSkipInvalid.checked = settings.aidetectAdminAutoSkipInvalid;
  updateModeUi(settings.aidetectAdminMode);
}

function saveSettings(values) {
  chrome.storage.sync.set(values, () => flashStatus("Đã lưu"));
}

function updateModeUi(mode) {
  const copy = {
    off: {
      label: "Tắt",
      status: "Đã tắt quét bài chờ duyệt",
      hint: "AIDetect Admin sẽ gỡ badge hiện có và không quét thêm bài mới."
    },
    manual: {
      label: "Manual",
      status: "Manual scan trên trang duyệt bài nhóm",
      hint: "Manual scan sẽ hiện badge theo ngưỡng khi bạn lướt trang duyệt bài."
    },
    auto: {
      label: "Auto",
      status: "Auto moderation đã sẵn sàng cấu hình",
      hint: "Auto mode dùng rules và action bên dưới; thao tác tự động sẽ được bật trong UC02."
    }
  };
  const modeCopy = copy[mode] || copy.manual;

  elements.modeValue.textContent = modeCopy.label;
  elements.scannerStatus.textContent = modeCopy.status;
  elements.modeHint.textContent = modeCopy.hint;
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
