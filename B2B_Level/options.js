const LICENSE_KEY_STORAGE_KEY = "aidetectLicenseKey";

const elements = {
  input: document.getElementById("licenseKey"),
  toggleKey: document.getElementById("toggleKey"),
  saveKey: document.getElementById("saveKey"),
  removeKey: document.getElementById("removeKey"),
  status: document.getElementById("status"),
  quotaPlan: document.getElementById("quotaPlan"),
  quotaUsage: document.getElementById("quotaUsage"),
  quotaFill: document.getElementById("quotaFill"),
  quotaHint: document.getElementById("quotaHint")
};

document.addEventListener("DOMContentLoaded", initOptions);

function initOptions() {
  chrome.storage.sync.get({ [LICENSE_KEY_STORAGE_KEY]: "" }, (items) => {
    elements.input.value = String(items[LICENSE_KEY_STORAGE_KEY] || "");
    refreshQuota(false);
  });

  elements.toggleKey.addEventListener("click", () => {
    const isHidden = elements.input.type === "password";
    elements.input.type = isHidden ? "text" : "password";
    elements.toggleKey.textContent = isHidden ? "Hide" : "Show";
  });

  elements.saveKey.addEventListener("click", saveAndValidate);
  elements.removeKey.addEventListener("click", removeLicense);
}

function saveAndValidate() {
  const licenseKey = elements.input.value.trim();
  if (!licenseKey) {
    setStatus("Enter a License Key first.", "error");
    return;
  }

  if (!licenseKey.startsWith("aidetect_live_")) {
    setStatus("License Key format is invalid.", "error");
    return;
  }

  setStatus("Checking License Key...", "");
  chrome.runtime.sendMessage({
    action: "SAVE_LICENSE_KEY",
    licenseKey
  }, (quota) => {
    if (chrome.runtime.lastError) {
      setStatus("Cannot check License Key right now.", "error");
      return;
    }

    renderQuota(quota);
    if (quota?.license_status === "valid") {
      setStatus(`Activated. Current plan: ${formatPlan(quota.plan)}.`, "ok");
      return;
    }

    setStatus(quota?.error || "License Key is invalid.", "error");
  });
}

function removeLicense() {
  chrome.runtime.sendMessage({ action: "REMOVE_LICENSE_KEY" }, (quota) => {
    elements.input.value = "";
    renderQuota(quota);
    setStatus("License Key removed.", "ok");
  });
}

function refreshQuota(forceRefresh) {
  chrome.runtime.sendMessage({
    action: "GET_QUOTA_STATUS",
    forceRefresh
  }, (quota) => {
    if (chrome.runtime.lastError) {
      setStatus("Cannot load quota.", "error");
      return;
    }
    renderQuota(quota);
  });
}

function renderQuota(quota) {
  const limit = Math.max(0, Number(quota?.quota_limit || 0));
  const used = Math.max(0, Number(quota?.quota_used || 0));
  const remaining = Math.max(0, Number(quota?.quota_remaining || 0));
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  elements.quotaPlan.textContent = formatPlan(quota?.plan || "free");
  elements.quotaUsage.textContent = `${used} / ${limit}`;
  elements.quotaFill.style.width = `${percent}%`;

  if (quota?.license_status === "missing") {
    elements.quotaHint.textContent = "Manual scan is free. Paste a License Key to enable auto moderation.";
  } else if (quota?.license_status === "invalid") {
    elements.quotaHint.textContent = "License Key is invalid or rotated. Paste the newest key from dashboard.";
  } else if (quota?.quota_exceeded) {
    elements.quotaHint.textContent = "Auto quota is used up. Manual scan is still free.";
  } else {
    elements.quotaHint.textContent = `${remaining} auto moderation requests remaining this month.`;
  }
}

function setStatus(message, type) {
  elements.status.textContent = message;
  elements.status.classList.toggle("ok", type === "ok");
  elements.status.classList.toggle("error", type === "error");
}

function formatPlan(plan) {
  const value = String(plan || "free");
  return value.charAt(0).toUpperCase() + value.slice(1);
}
