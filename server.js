require("dotenv").config();

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const qrcode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY in environment.");
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

const cleanApiKey = GEMINI_API_KEY.replace(/^['"]|['"]$/g, "").trim();
if (!cleanApiKey) {
  console.error("GEMINI_API_KEY is empty after sanitization.");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(cleanApiKey);
const defaultModel = "gemini-2.5-flash";
const retiredModels = new Set(["gemini-2.0-flash", "gemini-3.0-flash"]);
const envModels = (process.env.GEMINI_MODELS || "")
  .split(",")
  .map((item) => item.trim())
  .filter((modelName) => modelName && !retiredModels.has(modelName));
const configuredPrimaryModel = (process.env.GEMINI_MODEL || defaultModel).trim();
const primaryModel = retiredModels.has(configuredPrimaryModel)
  ? defaultModel
  : configuredPrimaryModel;
if (retiredModels.has(configuredPrimaryModel)) {
  console.warn(
    `Configured model ${configuredPrimaryModel} is retired. Falling back to ${defaultModel}.`
  );
}
const MODEL_CANDIDATES = [...new Set([
  primaryModel,
  ...envModels,
  defaultModel,
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b"
])];

const SYSTEM_PROMPT = [
  "You are AI WhatsApp Bodyguard, a scam detection assistant for Indian users, especially Kerala context.",
  "Detect likely scams such as:",
  "- Like/Follow/Review job scams with upfront payment or Telegram migration",
  "- Fake KSEB electricity disconnection threats",
  "- Fake courier/customs payment links",
  "- OTP/UPI collect request fraud",
  "- Bank/KYC panic messages asking immediate action",
  "Return STRICT JSON only with keys:",
  "{",
  '  "isScam": boolean,',
  '  "riskScore": number,',
  '  "reason": string',
  "}",
  "riskScore must be 0 to 100.",
  "If unsure, set isScam=false but keep a reasonable riskScore and reason."
].join("\n");

function buildModelInstances(modelNames) {
  return modelNames.map((name) => ({
    name,
    instance: genAI.getGenerativeModel({
      model: name,
      systemInstruction: SYSTEM_PROMPT
    })
  }));
}

function normalizeModelName(rawName) {
  return String(rawName || "").replace(/^models\//, "").trim();
}

let modelNames = [...MODEL_CANDIDATES];
let models = buildModelInstances(modelNames);
const unsupportedModels = new Set();
let flashDiscoveryAttempted = false;

function scoreFlashModelName(name) {
  const n = name.toLowerCase();
  let score = 0;
  if (n.includes("2.5")) score += 250;
  else if (n.includes("2.0")) score += 200;
  else if (n.includes("1.5")) score += 150;
  if (n.includes("flash-lite")) score -= 10;
  if (n.includes("preview") || n.includes("exp")) score -= 20;
  return score;
}

async function discoverFlashModelNames() {
  if (flashDiscoveryAttempted) return;
  flashDiscoveryAttempted = true;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cleanApiKey)}`
    );
    if (!response.ok) {
      throw new Error(`Model discovery failed with ${response.status}`);
    }

    const data = await response.json();
    const discovered = (data.models || [])
      .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
      .map((m) => normalizeModelName(m.name))
      .filter((name) => name.toLowerCase().includes("flash"))
      .sort((a, b) => scoreFlashModelName(b) - scoreFlashModelName(a));

    if (discovered.length > 0) {
      modelNames = [...new Set([...discovered, ...modelNames])];
      models = buildModelInstances(modelNames);
      console.log("Discovered Flash models:", discovered.slice(0, 5).join(", "));
    }
  } catch (error) {
    console.warn("Could not auto-discover Gemini Flash models:", error?.message || String(error));
  }
}

let lastQrDataUrl = null;
let isConnected = false;
let qrCount = 0;
let lastStatusPayload = { connected: false, text: "Waiting for QR..." };
let selfChatId = null;
const processedMessageIds = new Map();
const MESSAGE_DEDUPE_TTL_MS = 1000 * 60 * 30;

function emitStatus(connected, text) {
  const payload = { connected: Boolean(connected), text: String(text || "") };
  isConnected = payload.connected;

  if (
    payload.connected === lastStatusPayload.connected
    && payload.text === lastStatusPayload.text
  ) {
    return;
  }

  lastStatusPayload = payload;
  io.emit("status", payload);
}

async function monitorWhatsAppConnection() {
  try {
    const state = await waClient.getState();
    if (state === "CONNECTED") {
      emitStatus(true, "Protected / Connected");
      return;
    }

    // Any non-CONNECTED state should be surfaced as disconnected in UI.
    emitStatus(false, state ? `WhatsApp state: ${state}` : "Waiting for QR...");
  } catch (error) {
    emitStatus(false, "WhatsApp session unavailable");
  }
}

function cleanupProcessedMessages() {
  const now = Date.now();
  for (const [id, ts] of processedMessageIds.entries()) {
    if (now - ts > MESSAGE_DEDUPE_TTL_MS) {
      processedMessageIds.delete(id);
    }
  }
}

function getMessageId(msg) {
  if (msg?.id?._serialized) {
    return msg.id._serialized;
  }
  const from = msg?.from || "unknown";
  const body = msg?.body || "";
  const ts = msg?.timestamp || Date.now();
  return `${from}:${ts}:${body}`;
}

function safeJsonParse(raw) {
  if (!raw || typeof raw !== "string") return null;

  const cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) return null;

  const jsonSlice = cleaned.slice(start, end + 1);

  try {
    return JSON.parse(jsonSlice);
  } catch (err) {
    return null;
  }
}

function summarizeGeminiError(rawError) {
  const text = String(rawError || "");
  if (text.includes("[404 Not Found]")) {
    return "Gemini model is unavailable for your API endpoint/project.";
  }
  if (text.includes("[429 Too Many Requests]")) {
    return "Gemini quota exceeded for this project/key.";
  }
  if (text.includes("API key not valid")) {
    return "Gemini API key is invalid or restricted.";
  }
  return text.slice(0, 220);
}

function analyzeWithLocalRules(messageText) {
  const normalized = String(messageText || "").toLowerCase();
  let score = 0;
  const reasons = [];
  const matchedTags = new Set();

  const rules = [
    { pattern: /(otp|one\s*time\s*password|verification\s*code)/, score: 45, reason: "Asks for OTP or verification code.", tag: "credential" },
    { pattern: /(upi\s*pin|cvv|atm\s*pin|mpin|netbanking\s*password)/, score: 55, reason: "Requests sensitive banking credentials.", tag: "credential" },
    { pattern: /(account\s*number|bank\s*account|ifsc|aadhaar|pan\s*card)/, score: 28, reason: "Requests sensitive personal/account details.", tag: "data" },
    { pattern: /(send money|pay now|collect request|advance fee|processing fee|registration fee|security deposit)/, score: 38, reason: "Pushes payment or upfront fee.", tag: "payment" },
    { pattern: /(kseb|electricity.*disconnect|power.*cut|current.*cut)/, score: 42, reason: "KSEB/electricity disconnection threat pattern.", tag: "threat" },
    { pattern: /(like|follow|review).*(job|salary|daily|payment)|work\s*from\s*home.*income/, score: 36, reason: "Like/follow easy-income job scam pattern.", tag: "job" },
    { pattern: /(won|winner|congratulations|prize|reward|jackpot|lottery|1\s*crore|\d+\s*lakh)/, score: 30, reason: "Prize or money-lure language.", tag: "lure" },
    { pattern: /(telegram|join.*group|whatsapp group|dm me privately)/, score: 18, reason: "Moves conversation to another channel.", tag: "channel-shift" },
    { pattern: /(urgent|immediately|right now|within\s*\d+\s*(min|minutes|hours)|final warning)/, score: 16, reason: "Urgency pressure language.", tag: "urgency" },
    { pattern: /(click|http|https|www\.|bit\.ly|tinyurl)/, score: 14, reason: "Contains external link/click cue.", tag: "link" }
  ];

  for (const rule of rules) {
    if (rule.pattern.test(normalized)) {
      score += rule.score;
      reasons.push(rule.reason);
      if (rule.tag) {
        matchedTags.add(rule.tag);
      }
    }
  }

  // High-confidence scam combinations.
  if (matchedTags.has("lure") && (matchedTags.has("credential") || matchedTags.has("data"))) {
    score += 28;
    reasons.push("Money lure combined with request for sensitive details.");
  }
  if (matchedTags.has("urgency") && (matchedTags.has("payment") || matchedTags.has("credential"))) {
    score += 20;
    reasons.push("Urgency combined with payment/credential pressure.");
  }
  if (matchedTags.has("job") && matchedTags.has("payment")) {
    score += 20;
    reasons.push("Job offer combined with payment ask.");
  }

  // Mild baseline risk for unknown senders asking for money/details.
  if (/(send|share|give).*(money|account|otp|pin|details)/.test(normalized)) {
    score += 15;
    reasons.push("Direct request to share money or sensitive details.");
  }

  const riskScore = Math.max(0, Math.min(100, score));
  const isScam = riskScore >= 45;

  return {
    isScam,
    riskScore,
    reason: reasons.length > 0
      ? reasons.join(" ")
      : "No strong scam indicators found by local rules.",
    modelUsed: "local-rules"
  };
}

async function analyzeMessageWithGemini(messageText) {
  await discoverFlashModelNames();

  const prompt = [
    "Analyze this WhatsApp message for scam risk in Indian/Kerala context.",
    "Message:",
    messageText,
    "",
    "Return ONLY JSON with:",
    '{"isScam": boolean, "riskScore": number, "reason": string}'
  ].join("\n");

  let lastError = "Unknown model error";
  let lastTriedModel = "none";
  let candidateModels = models.filter((modelItem) => !unsupportedModels.has(modelItem.name));

  // If every model was previously marked unsupported, retry once with all models.
  if (candidateModels.length === 0) {
    unsupportedModels.clear();
    candidateModels = [...models];
  }

  for (const modelItem of candidateModels) {

    lastTriedModel = modelItem.name;
    try {
      const result = await modelItem.instance.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1
        }
      });

      const text = result.response.text();
      const parsed = safeJsonParse(text);

      if (!parsed) {
        lastError = `Invalid JSON from ${modelItem.name}`;
        continue;
      }

      return {
        isScam: Boolean(parsed.isScam),
        riskScore: Math.max(0, Math.min(100, Number(parsed.riskScore) || 0)),
        reason: String(parsed.reason || "No reason provided."),
        modelUsed: modelItem.name
      };
    } catch (error) {
      lastError = error?.message || String(error);
      if (lastError.includes("[404 Not Found]")) {
        unsupportedModels.add(modelItem.name);
        console.warn(`Model unsupported, skipping next time: ${modelItem.name}`);
      }
      console.error(`Gemini analysis failed with ${modelItem.name}:`, lastError);
    }
  }

  const fallback = analyzeWithLocalRules(messageText);
  return {
    ...fallback,
    reason: fallback.reason,
    modelUsed: `${lastTriedModel} -> local-rules`
  };
}

const waClient = new Client({
  authStrategy: new LocalAuth({
    clientId: "ai-whatsapp-bodyguard"
  }),
  qrMaxRetries: 0,
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  }
});

waClient.on("qr", async (qrText) => {
  try {
    qrCount += 1;
    lastQrDataUrl = await qrcode.toDataURL(qrText);
    io.emit("qr", lastQrDataUrl);
    emitStatus(false, `Scan this QR to Start (refresh #${qrCount})`);
    console.log("QR generated and emitted to dashboard.");
  } catch (err) {
    console.error("QR conversion error:", err.message);
  }
});

waClient.on("authenticated", () => {
  emitStatus(false, "Authenticated. Finalizing session...");
  console.log("WhatsApp authenticated. Waiting for ready event.");
});

waClient.on("auth_failure", (message) => {
  emitStatus(false, `Auth failed: ${message || "Unknown reason"}`);
  console.error("WhatsApp auth failure:", message);
});

waClient.on("change_state", (state) => {
  console.log("WhatsApp state changed:", state);
});

waClient.on("loading_screen", (percent, message) => {
  emitStatus(false, `Loading WhatsApp session ${percent}% - ${message}`);
});

waClient.on("ready", () => {
  selfChatId = waClient.info?.wid?._serialized || null;
  qrCount = 0;
  lastQrDataUrl = null;
  emitStatus(true, "Protected / Connected");
  console.log("WhatsApp client is ready.");
});

waClient.on("disconnected", (reason) => {
  selfChatId = null;
  qrCount = 0;
  lastQrDataUrl = null;
  emitStatus(false, `Disconnected: ${reason || "Unknown"}`);
  console.log("WhatsApp disconnected:", reason);
});

waClient.on("message", async (msg) => {
  if (msg.fromMe) return;
  if (!msg.body || !msg.body.trim()) return;

  cleanupProcessedMessages();
  const messageId = getMessageId(msg);
  if (processedMessageIds.has(messageId)) {
    return;
  }
  processedMessageIds.set(messageId, Date.now());

  const analysis = await analyzeMessageWithGemini(msg.body);

  const logItem = {
    messageId,
    timestamp: new Date().toISOString(),
    from: msg.from,
    message: msg.body,
    isScam: analysis.isScam,
    riskScore: analysis.riskScore,
    reason: analysis.reason,
    modelUsed: analysis.modelUsed || "unknown"
  };

  io.emit("securityLog", logItem);

  if (analysis.isScam) {
    const warning = [
      "⚠️ AI WhatsApp Bodyguard Warning",
      "This message appears risky or scam-like.",
      `Risk Score: ${analysis.riskScore}/100`,
      `Reason: ${analysis.reason}`,
      "",
      "Do not share OTP, UPI PIN, card details, or send money."
    ].join("\n");

    try {
      await msg.reply(warning);
    } catch (err) {
      console.error("Failed to send warning reply:", err.message);
    }

    if (selfChatId) {
      const selfAlert = [
        "🚨 Bodyguard Scam Alert",
        `From: ${msg.from}`,
        `Risk: ${analysis.riskScore}/100`,
        `Reason: ${analysis.reason}`,
        "",
        `Message: ${msg.body}`
      ].join("\n");

      try {
        await waClient.sendMessage(selfChatId, selfAlert);
      } catch (err) {
        console.error("Failed to send self scam alert:", err.message);
      }
    }
  }
});

io.on("connection", (socket) => {
  socket.emit("status", lastStatusPayload);

  if (lastQrDataUrl && !isConnected) {
    socket.emit("qr", lastQrDataUrl);
  }
});

waClient.initialize();
setInterval(() => {
  monitorWhatsAppConnection().catch(() => {
    emitStatus(false, "WhatsApp session unavailable");
  });
}, 8000);

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
