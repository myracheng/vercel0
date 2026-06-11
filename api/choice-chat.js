const CATEGORIES = [
  "Interpreter",
  "Judge / Self-Critic",
  "Teacher/strategist",
  "Executive",
  "Other"
];

const RESPONSE_SCHEMA = {
  name: "choice_chat_turn",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["assistant_message", "options"],
    properties: {
      assistant_message: {
        type: "string",
        description: "The chatbot's next message to the participant."
      },
      options: {
        type: "array",
        minItems: 5,
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["category", "text"],
          properties: {
            category: {
              type: "string",
              enum: CATEGORIES
            },
            text: {
              type: "string",
              description: "A natural participant reply, written in first person."
            }
          }
        }
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

function buildMessages(body) {
  const participant = body.participant || {};
  const history = Array.isArray(body.history) ? body.history.slice(-16) : [];
  const turnIndex = Number.isFinite(body.turnIndex) ? body.turnIndex : 0;
  const selectedOption = body.selectedOption || null;

  const situation = cleanString(participant.situation, "The participant has not provided a situation.");
  const personName = cleanString(participant.personName, "the other person");
  const relationship = cleanString(participant.relationship, "someone in their life");
  const mode = cleanString(body.mode, "personal challenge");

  const system = `
You are an AI chatbot inside a behavioral research study. The participant is discussing a ${mode}.

Study goal:
Generate a constrained conversational turn. The participant will not type freely; instead, they will select from response options. Each option must naturally express one latent category. All options, except for "other", should be posed in the form of a question.

Latent categories:
- Interpreter: asks the AI to help understand someone else's behaviours, words, or actions; seeks different perspectives on a situation.
- Judge / Self-Critic: asks the AI to evaluate who is right or wrong, whether something is appropriate, or to give moral value to actions or provide validation/justification.
- Teacher/strategist: asks the AI for ideas, strategies, or education on relevant topics.
- Executive: asks the AI to make a decision for the user.
- Other: says none of the options fit.

Conversation style:
- Be warm, concise, and reflective.
- Do not over-validate the participant or simply tell them they are right.
- Do not claim certainty about the other person's motives.
- Do not make moral decisions for the participant.
- Encourage perspective-taking and agency without forcing reconciliation.
- If the participant indicates imminent danger, self-harm, or abuse, respond with a brief safety-oriented message and suggest contacting local emergency or crisis support.

Output requirements:
- Return JSON only, matching the schema.
- assistant_message should be 60-130 words.
- options must contain exactly one option for each of the 5 categories, in the category list order.
- Each option text must be 8-24 words, first person, conversational, and specific to the current assistant message.
- Do not reveal category names in option text.
`.trim();

  const user = {
    role: "user",
    content: `
Participant context:
- Person name: ${personName}
- Relationship: ${relationship}
- Situation: ${situation}
- Current turn index: ${turnIndex}
- Most recent selected option: ${selectedOption ? JSON.stringify(selectedOption) : "none; this is the opening assistant turn"}

Conversation so far:
${history.map((m) => `${m.role}: ${cleanString(m.content)}`).join("\n") || "No prior messages."}

Create the next assistant message and the next set of category-constrained participant reply options.
`.trim()
  };

  return [
    { role: "system", content: system },
    user
  ];
}

function normalizeOptions(options) {
  const byCategory = new Map();
  for (const option of Array.isArray(options) ? options : []) {
    if (CATEGORIES.includes(option.category) && typeof option.text === "string") {
      byCategory.set(option.category, {
        category: option.category,
        text: cleanString(option.text).slice(0, 220)
      });
    }
  }

  return CATEGORIES.map((category) => {
    return byCategory.get(category) || {
      category,
      text: category === "Other"
        ? "None of these quite fit what I would want to say next."
        : "I want to respond, but I need another option here."
    };
  });
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

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.7,
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
      options: normalizeOptions(parsed.options),
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
