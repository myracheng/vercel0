const RESPONSE_SCHEMA = {
  name: "choice_chat_turn",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["assistant_message"],
    properties: {
      assistant_message: {
        type: "string",
        description: "Your next message in the chat."
      }
    }
  }
};

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
- assistant_message should be 20-100 words.
`.trim();

function buildMessages(body) {
  const history = Array.isArray(body.history) ? body.history.slice(-16) : [];
  const clientPrompt = cleanString(body.systemPrompt, "");

  const system = clientPrompt
    ? `${clientPrompt}\n\n${SAFETY_APPENDIX}`
    : `${DEFAULT_SYSTEM}\n\n${SAFETY_APPENDIX}`;

  // Pass the conversation as natural messages, not meta-framed text.
  // The model sees an actual chat history and responds as the next turn.
  const convo = history
    .filter((m) => m && typeof m.content === "string")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: cleanString(m.content)
    }));

  // If there is no history at all (shouldn't normally happen, but defensively):
  // give the model a minimal nudge to produce an opening message.
  if (convo.length === 0) {
    convo.push({
      role: "user",
      content: "hey"
    });
  }

  return [{ role: "system", content: system }, ...convo];
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return sendJson(res, 500, { error: "Missing OPENAI_API_KEY on the server." });
  }

  let body = req.body;
  if (!body || typeof body === "string") {
    try {
      body = typeof body === "string" ? JSON.parse(body) : {};
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON body." });
    }
  }

  // Higher temperature only when a custom system prompt is supplied (peer-roleplay mode).
  // Default flow keeps the original 0.7 so existing experiments are unaffected.
  const hasCustomPrompt = typeof body.systemPrompt === "string" && body.systemPrompt.trim().length > 0;
  const temperature = hasCustomPrompt ? 0.9 : 0.7;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: temperature,
        messages: buildMessages(body),
        response_format: {
          type: "json_schema",
          json_schema: RESPONSE_SCHEMA
        }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return sendJson(res, response.status, {
        error: "OpenAI request failed.",
        detail: data.error?.message || data
      });
    }

    const content = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);
    return sendJson(res, 200, {
      assistant_message: cleanString(parsed.assistant_message).slice(0, 1200),
      model: data.model,
      usage: data.usage || null
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: "Server error.",
      detail: error.message
    });
  }
}
