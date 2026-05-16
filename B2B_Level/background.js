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

const MOCK_DEFAULT_STATS = {
  scanned: 12,
  warned: 4,
  highRisk: 2,
  autoApproved: 3,
  autoDeleted: 1
};

const USE_MOCK_REVIEW_DATA = true;
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
  settings.aidetectAdminAutoSkipInvalid = Boolean(settings.aidetectAdminAutoSkipInvalid);

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
  await updateStats(result);
  return result;
}

async function analyzePendingPost(payload) {
  const text = normalizeText(typeof payload === "string" ? payload : payload?.text || "");
  const mediaCount = Number(payload?.mediaCount || 0);
  const videoCount = Number(payload?.videoCount || 0);
  const mockResult = getMockPendingPostResult(payload, text);

  if (mockResult) {
    return {
      ...mockResult,
      mock: true,
      type: mockResult.type || inferContentType(mediaCount, videoCount),
      summary: text.slice(0, 220)
    };
  }

  // MVP/demo analyzer. Replace this with the production AIDetect API when available.
  const textScore = scoreTextHeuristics(text);
  const mediaScore = Math.min(14, mediaCount * 3 + videoCount * 7);
  const templateScore = scoreTemplateSignals(text);
  const stability = stableScoreBoost(text);
  const score = clamp(Math.round(textScore + mediaScore + templateScore + stability), 4, 98);
  const signals = buildSignals(text, mediaCount, videoCount, score);

  return {
    score,
    type: inferContentType(mediaCount, videoCount),
    reason: buildReason(score, signals),
    signals,
    summary: text.slice(0, 220)
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
