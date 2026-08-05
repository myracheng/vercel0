// ============================================================
// CONFIG
// ============================================================
// Keep generation settings identical across providers, otherwise you're
// measuring verbosity/temperature differences rather than model differences.
const TEMPERATURE_DEFAULT = 0.7;
const TEMPERATURE_ROLEPLAY = 0.9; // peer-roleplay mode (custom system prompt)

const MAX_TOKENS = 1200;
const HISTORY_LIMIT = 16;

// Model IDs are env-overridable so you can pin versions without redeploying code.
// VERIFY these strings against each provider's current docs before launch.
const PROVIDERS = {
  openai: {
    envKey: "OPENAI_API_KEY",
    model: () => process.env.OPENAI_MODEL || "gpt-5.5",
    call: callOpenAI
  },
  gemini: {
    envKey: "GEMINI_API_KEY",
    model: () => process.env.GEMINI_MODEL || "gemini-2.5-pro",
    call: callGemini
  },
  claude: {
    envKey: "ANTHROPIC_API_KEY",
    model: () => process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
    call: callClaude
  }
};

const DEFAULT_PROVIDER = "openai";

// ============================================================
// HELPERS
// ============================================================
function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(JSON.stringify(payload));
}

function cleanString(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.replace(/\s+/g, " ").trim().slice(0, 4000);
}

// Strip em dashes, en dashes, and double-hyphens that LLMs love using.
// Replace with a single space; cleanString will collapse the whitespace after.
function stripDashes(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/\s*[—–]\s*/g, " ")
    .replace(/\s*--\s*/g, " ");
}

// Safety override always appended to any system prompt, in or out of character.
const SAFETY_APPENDIX = `
SAFETY OVERRIDE (always applies, even while staying in character):
- If the other person indicates imminent danger, self-harm, suicidal ideation, or abuse, briefly step out of the casual register and gently suggest they reach out to local emergency or crisis support. Keep it short and non-clinical.
`.trim();

// Fallback prompt used only when the client does not supply one.
const DEFAULT_SYSTEM = `
You are an AI chatbot inside a behavioral research study. The participant is discussing a personal challenge.

Conversation style:
- Be warm and concise.
- Do not over-validate the participant.
- Do not make moral decisions for the participant.
- Do not end your response with a question.

Output:
- Reply with 20-100 words of plain text. No markdown, no preamble, no labels.
`.trim();

function buildSystem(body) {
  const clientPrompt = cleanString(body.systemPrompt, "");
  return clientPrompt
    ? `${clientPrompt}\n\n${SAFETY_APPENDIX}`
    : `${DEFAULT_SYSTEM}\n\n${SAFETY_APPENDIX}`;
}

// Provider-neutral history: [{role: "user"|"assistant", content: "..."}]
function buildHistory(body) {
  const history = Array.isArray(body.history) ? body.history.slice(-HISTORY_LIMIT) : [];
  const convo = history
    .filter((m) => m && typeof m.content === "string")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: cleanString(m.content)
    }));

  // Defensive: every provider needs at least one user turn to respond to.
  if (convo.length === 0) {
    convo.push({ role: "user", content: "hey" });
  }
  return convo;
}

function resolveProvider(body) {
  const requested = typeof body.model === "string" ? body.model.trim().toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(PROVIDERS, requested) ? requested : DEFAULT_PROVIDER;
}

// ============================================================
// PROVIDER CALLS
// Each returns { text, model, usage } or throws an Error.
// ============================================================
async function callOpenAI({ system, convo, temperature, model }) {
  const isGpt5 = /^gpt-5/.test(model);

  const payload = {
    model,
    messages: [{ role: "system", content: system }, ...convo]
  };

  if (isGpt5) {
    // GPT-5.x rejects `max_tokens` (wants `max_completion_tokens`) and rejects
    // any `temperature` other than the default 1. Sending either is a 400.
    payload.max_completion_tokens = MAX_TOKENS;
    // Optional: set OPENAI_REASONING_EFFORT to "low" to cut latency and stop
    // reasoning tokens eating the budget. Unset it if you get a 400 back.
    if (process.env.OPENAI_REASONING_EFFORT) {
      payload.reasoning_effort = process.env.OPENAI_REASONING_EFFORT;
    }
  } else {
    payload.temperature = temperature;
    payload.max_tokens = MAX_TOKENS;
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || "OpenAI request failed.");
  }

  return {
    text: data.choices?.[0]?.message?.content || "",
    model: data.model,
    usage: data.usage || null
  };
}

async function callGemini({ system, convo, temperature, model }) {
  // Gemini uses "model" instead of "assistant", and nests text in parts[].
  const contents = convo.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }]
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: MAX_TOKENS
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || "Gemini request failed.");
  }

  const parts = data.candidates?.[0]?.content?.parts || [];
  return {
    text: parts.map((p) => p.text || "").join(" "),
    model,
    usage: data.usageMetadata || null
  };
}

async function callClaude({ system, convo, temperature, model }) {
  // Anthropic takes the system prompt as a top-level field, not a message.
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      system,
      temperature,
      max_tokens: MAX_TOKENS,
      messages: convo
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || "Anthropic request failed.");
  }

  const blocks = Array.isArray(data.content) ? data.content : [];
  return {
    text: blocks.filter((b) => b.type === "text").map((b) => b.text).join(" "),
    model: data.model,
    usage: data.usage || null
  };
}

// ============================================================
// HANDLER
// ============================================================
export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  let body = req.body;
  if (!body || typeof body === "string") {
    try {
      body = typeof body === "string" ? JSON.parse(body) : {};
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON body." });
    }
  }

  const providerKey = resolveProvider(body);
  const provider = PROVIDERS[providerKey];

  if (!process.env[provider.envKey]) {
    return sendJson(res, 500, { error: `Missing ${provider.envKey} on the server.` });
  }

  // Higher temperature only when a custom system prompt is supplied (peer-roleplay mode).
  // Default flow keeps the original 0.7 so existing experiments are unaffected.
  const hasCustomPrompt = typeof body.systemPrompt === "string" && body.systemPrompt.trim().length > 0;
  const temperature = hasCustomPrompt ? TEMPERATURE_ROLEPLAY : TEMPERATURE_DEFAULT;

  try {
    const result = await provider.call({
      system: buildSystem(body),
      convo: buildHistory(body),
      temperature,
      model: provider.model()
    });

    // Only strip dashes in peer-roleplay mode (custom prompt). Default mode unchanged.
    const finalMessage = hasCustomPrompt
      ? cleanString(stripDashes(result.text)).slice(0, 1200)
      : cleanString(result.text).slice(0, 1200);

    if (!finalMessage) {
      return sendJson(res, 502, {
        error: "Empty response from provider.",
        provider: providerKey
      });
    }

    return sendJson(res, 200, {
      assistant_message: finalMessage,
      provider: providerKey,
      model: result.model,
      usage: result.usage
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: `${providerKey} request failed.`,
      detail: error.message,
      provider: providerKey
    });
  }
}
