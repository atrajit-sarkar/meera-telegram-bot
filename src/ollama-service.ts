/**
 * Ollama-compatible chat completion service.
 * Used for text-to-text conversations.
 */

export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaConfig {
  host: string;
  model: string;
  apiKey: string;
}

/**
 * Call Ollama with key rotation. Tries keys in order; on quota/rate errors, moves to next key.
 */
export async function callOllamaWithRotation(
  config: OllamaConfig,
  messages: OllamaMessage[],
  extraKeys: string[] = []
): Promise<string> {
  const keys = [config.apiKey, ...extraKeys].filter(Boolean);
  let lastError: Error | null = null;

  for (const key of keys) {
    try {
      return await callOllama({ ...config, apiKey: key }, messages);
    } catch (err: any) {
      lastError = err;
      if (err.message === "quota_exceeded") {
        console.log("[Ollama] Key quota exceeded, trying next key...");
        continue;
      }
      if (err.message === "invalid_key") {
        console.log("[Ollama] Invalid key, trying next key...");
        continue;
      }
      throw err; // Non-key error, don't rotate
    }
  }
  throw lastError ?? new Error("All Ollama API keys exhausted");
}

export async function callOllama(
  config: OllamaConfig,
  messages: OllamaMessage[]
): Promise<string> {
  const url = `${config.host.replace(/\/+$/, "")}/api/chat`;
  const body = JSON.stringify({
    model: config.model,
    messages,
    stream: false,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body,
      signal: controller.signal,
    });

    const text = await res.text();

    if (!res.ok) {
      const lower = text.toLowerCase();
      if (lower.includes("unauthorized") || lower.includes("invalid")) {
        throw new Error("invalid_key");
      }
      if (res.status === 429 || lower.includes("rate") || lower.includes("quota") || lower.includes("limit")) {
        throw new Error("quota_exceeded");
      }
      throw new Error(`ollama_error: ${res.status} ${text.slice(0, 200)}`);
    }

    const json = JSON.parse(text);
    const content = json?.message?.content;
    if (!content) throw new Error("No content in Ollama response");
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Telegram Reaction Emojis ─────────────────────────────────────

export const TELEGRAM_REACTION_EMOJIS = [
  "👍","👎","❤","🔥","🥰","👏","😁","🤔","🤯","😱",
  "🤬","😢","🎉","🤩","🤮","💩","🙏","👌","🕊","🤡",
  "🥱","🥴","😍","🐳","❤‍🔥","🌚","🌭","💯","🤣","⚡",
  "🍌","🏆","💔","🤨","😐","🍓","🍾","💋","🖕","😈",
  "😴","😭","🤓","👻","👨‍💻","👀","🎃","🙈","😇","😨",
  "🤝","✍","🤗","🫡","🎅","🎄","☃","💅","🤪","🗿",
  "🆒","💘","🙉","🦄","😘","💊","🙊","😎","👾","🤷‍♂",
  "🤷","🤷‍♀","😡",
];

// Intimate/flirty emojis only allowed for comfortable+ tiers
const INTIMATE_EMOJIS = new Set(["💋", "😘", "💘", "🥰", "😍", "❤‍🔥", "❤", "😈", "🍑", "🍓", "🍾"]);

function getReactionEmojisForTier(tier: string): string[] {
  if (tier === "stranger" || tier === "acquaintance") {
    return TELEGRAM_REACTION_EMOJIS.filter((e) => !INTIMATE_EMOJIS.has(e));
  }
  return TELEGRAM_REACTION_EMOJIS;
}

function buildReactionPrompt(tier: string, personaHint?: string): string {
  const emojis = getReactionEmojisForTier(tier);
  let prompt =
    "You pick reaction emojis for Telegram messages. " +
    "Given a message and conversation context, reply with EXACTLY ONE emoji from this list — nothing else:\n" +
    emojis.join(" ") +
    "\n\nPick the emoji that fits the vibe of the message best. Just the emoji, no text.";

  if (personaHint) {
    prompt += `\n\nYou are reacting AS this character: ${personaHint}\nPick emojis that match this character's personality and vibe.`;
  }

  if (tier === "stranger") {
    prompt += "\n\nYou barely know this person. Keep reactions neutral and casual — nothing romantic or intimate.";
  } else if (tier === "acquaintance") {
    prompt += "\n\nYou're getting to know this person. Keep reactions friendly but not flirty or intimate.";
  }
  return prompt;
}

export async function pickReactionEmoji(
  config: OllamaConfig,
  userMessage: string,
  chatHistory: OllamaMessage[],
  tier: string = "stranger",
  personaHint?: string
): Promise<string | null> {
  try {
    const allowedEmojis = getReactionEmojisForTier(tier);
    const messages: OllamaMessage[] = [
      { role: "system", content: buildReactionPrompt(tier, personaHint) },
      ...chatHistory.slice(-4).filter((m) => m.role !== "system"),
      { role: "user", content: userMessage },
    ];
    const raw = await callOllama(config, messages);
    const emoji = raw.trim();
    if (allowedEmojis.includes(emoji)) return emoji;
    return allowedEmojis.find((e) => raw.includes(e)) ?? null;
  } catch {
    return null;
  }
}

// ── Sticker Emoji Picker ─────────────────────────────────────

const STICKER_PICK_PROMPT =
  "You're picking a sticker to send in a Telegram chat. " +
  "Based on the conversation, reply with EXACTLY ONE emoji that best represents " +
  "the mood or feeling you'd express with a sticker right now. " +
  "Just reply with ONE emoji. Nothing else.";

export async function pickStickerEmoji(
  config: OllamaConfig,
  aiResponse: string,
  chatHistory: OllamaMessage[],
  personaHint?: string
): Promise<string | null> {
  try {
    let stickerPrompt = STICKER_PICK_PROMPT;
    if (personaHint) {
      stickerPrompt += `\n\nYou are this character: ${personaHint}\nPick sticker emojis that match this character's personality.`;
    }
    const messages: OllamaMessage[] = [
      { role: "system", content: stickerPrompt },
      ...chatHistory.slice(-4).filter((m) => m.role !== "system"),
      { role: "assistant", content: aiResponse },
      { role: "user", content: "Pick a sticker emoji for what I just said." },
    ];
    const raw = await callOllama(config, messages);
    const emoji = raw.trim();
    if (emoji.length <= 4 && emoji.length > 0) return emoji;
    const match = raw.match(
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u
    );
    return match?.[0] ?? null;
  } catch {
    return null;
  }
}
