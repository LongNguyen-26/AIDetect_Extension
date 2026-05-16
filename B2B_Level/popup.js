const VALID_MODES = new Set(["off", "manual", "auto"]);
const VALID_AUTO_ACTIONS = new Set(["approve_only", "approve_and_delete"]);

const DEFAULT_SETTINGS = {
  aidetectAdminEnabled: false,
  aidetectAdminMode: "off",
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
  modeButtons: Array.from(document.querySelectorAll(".mode-btn")),
  modeLabel: document.getElementById("modeLabel"),
  sectionThreshold: document.getElementById("sectionThreshold"),
  sectionRules: document.getElementById("sectionRules"),
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
  setupStorageListener();
}

function bindEvents() {
  elements.modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
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

function setupStorageListener() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;

    if (changes.aidetectAdminMode) {
      updateModeUi(normalizeMode(changes.aidetectAdminMode.newValue));
    }

    if (changes.aidetectAdminGroupRules && document.activeElement !== elements.groupRules) {
      elements.groupRules.value = String(changes.aidetectAdminGroupRules.newValue || "");
    }

    if (changes.aidetectAdminAutoSkipInvalid) {
      elements.autoSkipInvalid.checked = Boolean(changes.aidetectAdminAutoSkipInvalid.newValue);
    }

    if (changes.aidetectAdminAutoAction) {
      const action = normalizeAutoAction(changes.aidetectAdminAutoAction.newValue);
      elements.autoAction.value = action;
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
  renderThreshold(settings.aidetectAdminThreshold);
  elements.groupRules.value = settings.aidetectAdminGroupRules;
  elements.autoAction.value = settings.aidetectAdminAutoAction;
  elements.autoSkipInvalid.checked = settings.aidetectAdminAutoSkipInvalid;
  updateModeUi(settings.aidetectAdminMode);
}

function setMode(mode) {
  const normalizedMode = normalizeMode(mode);
  updateModeUi(normalizedMode);
  saveSettings({
    aidetectAdminMode: normalizedMode,
    aidetectAdminEnabled: normalizedMode !== "off"
  });
}

function saveSettings(values) {
  chrome.storage.sync.set(values, () => flashStatus("Đã lưu"));
}

function updateModeUi(mode) {
  const copy = {
    off: {
      label: "Chưa kích hoạt"
    },
    manual: {
      label: "Đang quét thủ công - hãy lướt bài"
    },
    auto: {
      label: "Đang tự động kiểm duyệt"
    }
  };
  const normalizedMode = normalizeMode(mode);
  const modeCopy = copy[normalizedMode] || copy.off;

  elements.modeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === normalizedMode);
  });
  elements.modeLabel.textContent = modeCopy.label;
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

function normalizeMode(value) {
  return VALID_MODES.has(value) ? value : DEFAULT_SETTINGS.aidetectAdminMode;
}

function normalizeAutoAction(value) {
  return VALID_AUTO_ACTIONS.has(value) ? value : DEFAULT_SETTINGS.aidetectAdminAutoAction;
}
