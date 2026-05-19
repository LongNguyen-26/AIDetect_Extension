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

const MOCK_DEFAULT_STATS = {
  scanned: 12,
  warned: 4,
  highRisk: 2,
  autoApproved: 3,
  autoDeleted: 1
};

const USE_MOCK_REVIEW_DATA = false;
const API_BASE = "https://longnguyen3426-aidetect-extension.hf.space";
const API_ANALYZE_TIMEOUT_MS = 12000;
const API_RULES_TIMEOUT_MS = 10000;
const ANALYSIS_CACHE_KEY = "aidetectAdminAnalysisCache:v1";
const ANALYSIS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const ANALYSIS_CACHE_MAX = 700;
const MOCK_PENDING_POST_RESULTS = [
  {
    id: "mock-first-pending-post-safe",
    cardIndex: 1,
    score: 28,
    type: "Mock: bài chờ duyệt không vượt ngưỡng",
    reason: "Mock data: bài này được đặt dưới ngưỡng để kiểm chứng rằng AIDetect Admin không hiển thị badge khi rủi ro thấp.",
    signals: [
      { label: "Mock - mẫu văn bản tự nhiên", confidence: 72 },
      { label: "Mock - không vượt ngưỡng cảnh báo", confidence: 28 }
    ]
  },
  {
    id: "mock-second-pending-post-ai",
    cardIndex: 2,
    score: 96,
    type: "Mock: bài chờ duyệt nghi do AI tạo",
    reason: "Mock data: bài này được cố định là rủi ro AI cao để kiểm chứng badge cảnh báo và phần lý do hiển thị trực tiếp trên card bài đang chờ duyệt.",
    signals: [
      { label: "Mock - tổng hợp rủi ro AI cao", confidence: 96 },
      { label: "Mock - cấu trúc câu đều và ít dấu hiệu cá nhân", confidence: 91 },
      { label: "Mock - nội dung giống mẫu sinh tự động", confidence: 88 }
    ]
  },
  {
    id: "mock-test-002-ai",
    textIncludes: ["bai viet test 002", "test 002"],
    score: 97,
    type: "Mock: bài test nghi do AI tạo",
    reason: "Mock data: bài có nội dung Test 002 được ép điểm AI cao để bạn kiểm chứng vị trí và giao diện badge cảnh báo.",
    signals: [
      { label: "Mock - bài test được đánh dấu AI cao", confidence: 97 },
      { label: "Mock - rule kiểm thử theo nội dung Test 002", confidence: 94 }
    ]
  }
];

const analysisCache = new Map();
let analysisCacheLoaded = false;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(null, (items) => {
    const settings = normalizeSettings(items || {});
    chrome.storage.sync.set({
      ...settings,
      aidetectAdminEnabled: settings.aidetectAdminMode !== "off"
    });
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "SCAN_PENDING_POST") {
    handlePendingPostScan(request.data)
      .then(sendResponse)
      .catch((error) => {
        console.error("AIDetect Admin scan failed:", error);
        sendResponse({
          score: 0,
          type: "Không thể phân tích",
          reason: "Có lỗi khi xử lý bài đang chờ duyệt. Hãy tải lại trang và thử lại.",
          signals: []
        });
      });

    return true;
  }

  if (request.action === "GET_ADMIN_STATS") {
    getTodayStats().then(sendResponse);
    return true;
  }

  if (request.action === "CHECK_GROUP_RULES") {
    handleGroupRulesCheck(request.data)
      .then(sendResponse)
      .catch((error) => {
        console.error("AIDetect Admin rules check failed:", error);
        sendResponse({ violation: false, reason: "", score: 0 });
      });
    return true;
  }

  if (request.action === "UPDATE_AUTO_STAT") {
    updateAutoStatField(request.field).then(sendResponse);
    return true;
  }

  if (request.action === "RESET_ADMIN_STATS") {
    resetTodayStats().then(sendResponse);
    return true;
  }

  return false;
});

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

function normalizeStats(stats) {
  return {
    ...DEFAULT_STATS,
    ...(stats || {})
  };
}

async function handlePendingPostScan(payload) {
  const result = await analyzePendingPost(payload);
  if (!result.cached) {
    await updateStats(result);
  }
  return result;
}

async function handleGroupRulesCheck(data) {
  const text = normalizeText(data?.text || "");
  const rules = normalizeText(data?.rules || "");

  if (!rules) {
    return { violation: false, reason: "", score: 0 };
  }

  if (USE_MOCK_REVIEW_DATA) {
    const lowerText = removeDiacritics(text.toLowerCase());
    const lowerRules = removeDiacritics(rules.toLowerCase());
    const hasExternalLink = /\bhttps?:\/\//i.test(text) || lowerText.includes("www.");
    const rulesProhibitLinks = lowerRules.includes("link") || lowerRules.includes("spam");
    const hasAdTerms = ["quang cao", "ban hang", "tuyen dung", "affiliate"].some((phrase) => lowerText.includes(phrase));
    const rulesProhibitAds = ["quang cao", "ban hang", "tuyen dung", "spam"].some((phrase) => lowerRules.includes(phrase));
    const violation = (hasExternalLink && rulesProhibitLinks) || (hasAdTerms && rulesProhibitAds);

    return {
      violation,
      reason: violation
        ? "Mock rules: Bài có dấu hiệu link ngoài/quảng cáo trùng với quy tắc group."
        : "Mock rules: Không phát hiện vi phạm quy tắc.",
      score: violation ? 82 : 10
    };
  }

  try {
    return await callRulesApi(text, rules);
  } catch (error) {
    console.error("AIDetect Admin rules API error:", error);
    return { violation: false, reason: "", score: 0 };
  }
}

async function analyzePendingPost(payload) {
  const text = normalizeText(typeof payload === "string" ? payload : payload?.text || "");
  const mediaCount = Number(payload?.mediaCount || 0);
  const videoCount = Number(payload?.videoCount || 0);
  const contentHash = getPayloadContentHash(payload, text, mediaCount, videoCount);
  const mockResult = getMockPendingPostResult(payload, text);

  if (mockResult) {
    return {
      ...mockResult,
      mock: true,
      type: mockResult.type || inferContentType(mediaCount, videoCount),
      summary: text.slice(0, 220)
    };
  }

  const cachedResult = await getCachedAnalysisResult(payload, contentHash);
  if (cachedResult) {
    return {
      ...cachedResult,
      cached: true,
      contentHash
    };
  }

  let result = null;
  try {
    result = await callAnalyzeApi(payload, text, mediaCount, videoCount);
  } catch (error) {
    console.error("AIDetect Admin analyze API error:", error);
    result = analyzeWithHeuristics(payload, text, mediaCount, videoCount);
  }

  await setCachedAnalysisResult(payload, contentHash, result);
  return result;
}

async function callAnalyzeApi(payload, text, mediaCount, videoCount) {
  const data = await fetchJsonWithTimeout(`${API_BASE}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: text.slice(0, 6000),
      mediaCount,
      videoCount,
      contentHash: payload?.contentHash || "",
      platform: payload?.platform || "facebook_group_admin"
    })
  }, API_ANALYZE_TIMEOUT_MS);
  const score = clamp(Math.round(Number(data?.score) || 0), 0, 100);
  const signals = normalizeApiSignals(data?.signals, text, mediaCount, videoCount, score);

  return {
    score,
    type: String(data?.type || inferContentType(mediaCount, videoCount)),
    reason: String(data?.reason || buildReason(score, signals)).slice(0, 400),
    signals,
    summary: String(data?.summary || text.slice(0, 220)).slice(0, 220),
    model: String(data?.model || ""),
    latencyMs: Number(data?.latency_ms || 0),
    source: "api"
  };
}

async function callRulesApi(text, rules) {
  const data = await fetchJsonWithTimeout(`${API_BASE}/check-rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: text.slice(0, 6000),
      rules: rules.slice(0, 2000)
    })
  }, API_RULES_TIMEOUT_MS);

  return {
    violation: Boolean(data?.violation),
    reason: String(data?.reason || "").slice(0, 300),
    score: clamp(Math.round(Number(data?.score) || 0), 0, 100)
  };
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeApiSignals(signals, text, mediaCount, videoCount, score) {
  const normalized = Array.isArray(signals)
    ? signals
        .map((signal) => ({
          label: String(signal?.label || "").slice(0, 100),
          confidence: clamp(Math.round(Number(signal?.confidence) || 0), 0, 100)
        }))
        .filter((signal) => signal.label)
        .slice(0, 4)
    : [];

  return normalized.length ? normalized : buildSignals(text, mediaCount, videoCount, score);
}

function getPayloadContentHash(payload, text, mediaCount, videoCount) {
  if (payload?.contentHash) return String(payload.contentHash);

  const normalized = [
    normalizeText(text || "").slice(0, 3000),
    Number(mediaCount || 0),
    Number(videoCount || 0)
  ].join("|");

  return fnv1a32(removeDiacritics(normalized.toLowerCase()));
}

async function getCachedAnalysisResult(payload, contentHash) {
  await ensureAnalysisCacheLoaded();

  const keys = getPayloadAnalysisCacheKeys(payload, contentHash);
  for (const key of keys) {
    const entry = analysisCache.get(key);
    if (!entry?.result) continue;

    if (Date.now() - Number(entry.updatedAt || 0) > ANALYSIS_CACHE_TTL_MS) {
      analysisCache.delete(key);
      persistAnalysisCache().catch((error) => console.warn("AIDetect Admin cache cleanup failed:", error));
      continue;
    }

    analysisCache.delete(key);
    analysisCache.set(key, {
      ...entry,
      lastHitAt: Date.now()
    });

    return normalizeCachedAnalysisResult(entry.result);
  }

  return null;
}

async function setCachedAnalysisResult(payload, contentHash, result) {
  if (!contentHash || !result || typeof result.score !== "number") return;
  await ensureAnalysisCacheLoaded();

  getPayloadAnalysisCacheKeys(payload, contentHash).forEach((key) => {
    if (analysisCache.has(key)) {
      analysisCache.delete(key);
    }

    analysisCache.set(key, {
      result: normalizeCachedAnalysisResult(result),
      updatedAt: Date.now()
    });
  });

  trimAnalysisCache();
  await persistAnalysisCache();
}

function getPayloadAnalysisCacheKeys(payload, contentHash) {
  const keys = [];
  if (contentHash) keys.push(`hash:${contentHash}`);

  const postId = extractPayloadStablePostId(payload);
  if (postId) keys.push(`post:${postId}`);

  return Array.from(new Set(keys));
}

function extractPayloadStablePostId(payload) {
  const values = [
    ...(Array.isArray(payload?.links) ? payload.links : []),
    payload?.url || ""
  ].filter(Boolean);

  const patterns = [
    /\/pending_posts\/(\d+)/i,
    /[?&]set=gm\.(\d+)/i,
    /[?&]story_fbid=(\d+)/i,
    /[?&]fbid=(\d+)/i,
    /\/posts\/(\d+)/i,
    /\/permalink\/(\d+)/i
  ];

  for (const value of values) {
    for (const pattern of patterns) {
      const match = String(value).match(pattern);
      if (match?.[1]) return match[1];
    }
  }

  return "";
}

async function ensureAnalysisCacheLoaded() {
  if (analysisCacheLoaded) return;

  const current = await getStorageLocal({ [ANALYSIS_CACHE_KEY]: null });
  const cache = current?.[ANALYSIS_CACHE_KEY];
  const entries = Array.isArray(cache?.entries) ? cache.entries : [];
  const now = Date.now();

  entries.forEach((entry) => {
    const hash = String(entry?.hash || "");
    const updatedAt = Number(entry?.updatedAt || 0);
    if (!hash || !entry?.result) return;
    if (now - updatedAt > ANALYSIS_CACHE_TTL_MS) return;

    analysisCache.set(hash, {
      result: normalizeCachedAnalysisResult(entry.result),
      updatedAt
    });
  });

  trimAnalysisCache();
  analysisCacheLoaded = true;
}

async function persistAnalysisCache() {
  if (!analysisCacheLoaded) return;

  const entries = Array.from(analysisCache.entries()).map(([hash, entry]) => ({
    hash,
    result: normalizeCachedAnalysisResult(entry.result),
    updatedAt: Number(entry.updatedAt || Date.now())
  }));

  await setStorageLocal({
    [ANALYSIS_CACHE_KEY]: {
      version: 1,
      savedAt: Date.now(),
      entries
    }
  });
}

function trimAnalysisCache() {
  while (analysisCache.size > ANALYSIS_CACHE_MAX) {
    const oldestHash = analysisCache.keys().next().value;
    analysisCache.delete(oldestHash);
  }
}

function normalizeCachedAnalysisResult(result) {
  const score = clamp(Math.round(Number(result?.score) || 0), 0, 100);
  const signals = Array.isArray(result?.signals)
    ? result.signals
        .map((signal) => ({
          label: String(signal?.label || "").slice(0, 100),
          confidence: clamp(Math.round(Number(signal?.confidence) || 0), 0, 100)
        }))
        .filter((signal) => signal.label)
        .slice(0, 4)
    : [];

  return {
    score,
    type: String(result?.type || "Bài viết đang chờ duyệt"),
    reason: String(result?.reason || "").slice(0, 400),
    signals,
    summary: String(result?.summary || "").slice(0, 220),
    model: String(result?.model || ""),
    latencyMs: Number(result?.latencyMs || result?.latency_ms || 0),
    source: String(result?.source || ""),
    fallback: Boolean(result?.fallback)
  };
}

function analyzeWithHeuristics(payload, text, mediaCount, videoCount) {
  const normalizedText = normalizeText(text || (typeof payload === "string" ? payload : payload?.text || ""));
  const normalizedMediaCount = Number.isFinite(mediaCount) ? mediaCount : Number(payload?.mediaCount || 0);
  const normalizedVideoCount = Number.isFinite(videoCount) ? videoCount : Number(payload?.videoCount || 0);
  const textScore = scoreTextHeuristics(normalizedText);
  const mediaScore = Math.min(14, normalizedMediaCount * 3 + normalizedVideoCount * 7);
  const templateScore = scoreTemplateSignals(normalizedText);
  const stability = stableScoreBoost(normalizedText);
  const score = clamp(Math.round(textScore + mediaScore + templateScore + stability), 4, 98);
  const signals = buildSignals(normalizedText, normalizedMediaCount, normalizedVideoCount, score);

  return {
    score,
    type: inferContentType(normalizedMediaCount, normalizedVideoCount),
    reason: buildReason(score, signals),
    signals,
    summary: normalizedText.slice(0, 220),
    fallback: true
  };
}

function getMockPendingPostResult(payload, text) {
  if (!USE_MOCK_REVIEW_DATA) return null;

  const normalizedText = removeDiacritics(text.toLowerCase());
  const cardIndex = Number(payload?.cardIndex || 0);

  const fixture = MOCK_PENDING_POST_RESULTS.find((item) => {
    if (item.cardIndex && item.cardIndex === cardIndex) return true;
    if (!Array.isArray(item.textIncludes)) return false;
    return item.textIncludes.some((pattern) => normalizedText.includes(pattern));
  });

  if (!fixture) return null;

  return {
    score: fixture.score,
    type: fixture.type,
    reason: fixture.reason,
    signals: fixture.signals,
    mockId: fixture.id
  };
}

function scoreTextHeuristics(text) {
  if (!text) return 12;

  const words = text.split(/\s+/).filter(Boolean);
  const sentences = text.split(/[.!?。！？]+/).filter((item) => item.trim().length > 0);
  const averageSentenceLength = sentences.length ? words.length / sentences.length : words.length;
  const uniqueRatio = words.length ? new Set(words.map((word) => word.toLowerCase())).size / words.length : 1;
  const punctuationRatio = text.length ? (text.match(/[,.!?;:]/g) || []).length / text.length : 0;

  let score = 18;

  if (words.length > 45) score += 10;
  if (words.length > 100) score += 8;
  if (averageSentenceLength > 22) score += 9;
  if (averageSentenceLength > 32) score += 8;
  if (uniqueRatio < 0.6) score += 11;
  if (uniqueRatio < 0.5) score += 9;
  if (punctuationRatio > 0.028) score += 4;

  return score;
}

function scoreTemplateSignals(text) {
  const lower = removeDiacritics(text.toLowerCase());
  const phrases = [
    "tom lai",
    "co the thay rang",
    "trong boi canh",
    "mot cach toan dien",
    "khong chi",
    "ma con",
    "dang chu y",
    "nhin chung",
    "hay cung kham pha",
    "duoi day la",
    "bai viet nay se",
    "overall",
    "in conclusion",
    "it is important to note",
    "as an ai"
  ];

  return phrases.reduce((score, phrase) => {
    return lower.includes(phrase) ? score + 6 : score;
  }, 0);
}

function buildSignals(text, mediaCount, videoCount, score) {
  const words = text.split(/\s+/).filter(Boolean);
  const sentenceCount = text.split(/[.!?。！？]+/).filter((item) => item.trim().length > 0).length || 1;
  const averageSentenceLength = words.length / sentenceCount;
  const uniqueRatio = words.length ? new Set(words.map((word) => word.toLowerCase())).size / words.length : 1;
  const templateConfidence = clamp(scoreTemplateSignals(text) * 6, 8, 90);

  const signals = [
    {
      label: "Tổng hợp rủi ro AI",
      confidence: score
    },
    {
      label: "Cấu trúc câu và độ đều văn bản",
      confidence: clamp(Math.round(averageSentenceLength * 2.4), 12, 94)
    },
    {
      label: "Độ lặp từ/cụm từ",
      confidence: clamp(Math.round((1 - uniqueRatio) * 125), 8, 92)
    }
  ];

  if (templateConfidence >= 18) {
    signals.push({
      label: "Cụm từ theo mẫu thường gặp ở nội dung AI",
      confidence: templateConfidence
    });
  }

  if (mediaCount > 0) {
    signals.push({
      label: "Có media cần kiểm chứng kèm nội dung bài",
      confidence: clamp(mediaCount * 15 + videoCount * 24, 8, 88)
    });
  }

  return signals.slice(0, 4);
}

function stableScoreBoost(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash % 10);
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

function inferContentType(mediaCount, videoCount) {
  if (videoCount > 0) return "Video + văn bản trong bài đang chờ duyệt";
  if (mediaCount > 0) return "Hình ảnh + văn bản trong bài đang chờ duyệt";
  return "Văn bản trong bài đang chờ duyệt";
}

function buildReason(score, signals) {
  const topSignal = signals[1]?.label || signals[0]?.label || "Tín hiệu tổng hợp";

  if (score >= 85) {
    return `${topSignal}. Bài viết có nhiều đặc điểm giống nội dung được tạo bằng AI, nên admin cần kiểm chứng trước khi phê duyệt.`;
  }

  if (score >= 70) {
    return `${topSignal}. Nội dung vượt ngưỡng cảnh báo của AIDetect Admin và nên được đọc lại trước khi duyệt.`;
  }

  return "Bài viết chưa vượt ngưỡng cảnh báo AI.";
}

function normalizeText(text) {
  return String(text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 6000);
}

function removeDiacritics(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

async function updateStats(result) {
  const key = getTodayStatsKey();
  const [current, settings] = await Promise.all([
    getStorageLocal({ [key]: DEFAULT_STATS }),
    getStorageSync(null)
  ]);
  const stats = normalizeStats(current[key]);
  const normalizedSettings = normalizeSettings(settings || {});
  const threshold = normalizedSettings.aidetectAdminThreshold;

  stats.scanned += 1;
  if (result.score >= threshold) stats.warned += 1;
  if (result.score >= 85) stats.highRisk += 1;
  if (result.autoApproved || result.action === "approved") stats.autoApproved += 1;
  if (result.autoDeleted || result.action === "deleted") stats.autoDeleted += 1;

  await setStorageLocal({ [key]: stats });
}

async function updateAutoStatField(field) {
  const key = getTodayStatsKey();
  const current = await getStorageLocal({ [key]: DEFAULT_STATS });
  const stats = normalizeStats(current[key]);

  if (field === "autoApproved" || field === "autoDeleted") {
    stats[field] += 1;
  }

  await setStorageLocal({ [key]: stats });
  return stats;
}

async function getTodayStats() {
  const key = getTodayStatsKey();
  const current = await getStorageLocal(null);
  if (Object.prototype.hasOwnProperty.call(current || {}, key)) {
    return normalizeStats(current[key]);
  }

  const stats = USE_MOCK_REVIEW_DATA ? { ...MOCK_DEFAULT_STATS } : { ...DEFAULT_STATS };
  await setStorageLocal({ [key]: stats });
  return stats;
}

async function resetTodayStats() {
  const key = getTodayStatsKey();
  const stats = { ...DEFAULT_STATS };
  await setStorageLocal({ [key]: stats });
  return stats;
}

function getTodayStatsKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `aidetectAdminStats:${year}-${month}-${day}`;
}

function getStorageLocal(defaults) {
  return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
}

function getStorageSync(defaults) {
  return new Promise((resolve) => chrome.storage.sync.get(defaults, resolve));
}

function setStorageLocal(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
