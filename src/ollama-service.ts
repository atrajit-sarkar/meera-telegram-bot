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
 * Call Ollama with key rotation.
 * Priority: user's personal keys → community pool keys → default env key.
 */
export async function callOllamaWithRotation(
  config: OllamaConfig,
  messages: OllamaMessage[],
  extraKeys: string[] = [],
  communityKeys: string[] = []
): Promise<string> {
  // Personal keys first, then community pool (shuffled), then default key last
  const keys = [...extraKeys, ...communityKeys, config.apiKey].filter(Boolean);
  // Deduplicate while preserving order
  const seen = new Set<string>();
  const uniqueKeys = keys.filter((k) => {
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  let lastError: Error | null = null;

  for (const key of uniqueKeys) {
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

// ── AI Behavior Decision ─────────────────────────────────────────

export type ResponseAction =
  | { action: "reply_normal" }
  | { action: "delay_reply"; delayMinutes: number; reason: string }
  | { action: "leave_on_read" }
  | { action: "emoji_only"; emoji: string }
  | { action: "sticker_only" };

/**
 * Ask the AI to decide how to respond to a message — like a real person would.
 * Should she reply immediately? Delay? Leave on read? Just react with an emoji?
 * This replaces hardcoded probability checks with contextual AI decisions.
 */
export async function decideResponseBehavior(
  config: OllamaConfig,
  userMessage: string,
  chatHistory: OllamaMessage[],
  opts: {
    tier: string;
    mood: string;
    timeOfDay: string;
    personaHint?: string;
  }
): Promise<ResponseAction> {
  const personaLine = opts.personaHint
    ? `Your character/persona: ${opts.personaHint}`
    : "You are a young Indian girl chatting on Telegram.";

  const systemPrompt = `You are deciding how a real person would respond to an incoming Telegram message. You're not writing the reply — just deciding the BEHAVIOR.

${personaLine}

Context:
- Relationship tier: ${opts.tier} (stranger → acquaintance → comfortable → close)
- Current mood: ${opts.mood}
- Time of day (IST): ${opts.timeOfDay}

You must respond with ONLY a JSON object (no markdown, no explanation). Choose one:

1. Reply normally:
{"action":"reply_normal"}

2. Delay the reply (you're busy, distracted, want them to wait, not in mood, sleepy, etc.):
{"action":"delay_reply","delayMinutes":<3-30>,"reason":"<brief reason like: busy studying, dozed off, not in mood, making them wait>"}

3. Leave on read (not worth replying, conversation is dying, boring message):
{"action":"leave_on_read"}

4. Just send an emoji (message doesn't need a real reply):
{"action":"emoji_only","emoji":"<single emoji>"}

5. Just send a sticker (playful/reactive response):
{"action":"sticker_only"}

GUIDELINES:
- Strangers and acquaintances: ALWAYS reply_normal. Never leave on read or delay.
- Comfortable/close friends: you can delay, leave on read, or emoji-only sometimes.
- Late night (11 PM - 6 AM): higher chance of delays (sleepy) or leaving on read.
- If the message is emotional, important, or a question: ALWAYS reply_normal.
- Low-effort messages like "ok", "hmm", "k": consider leave_on_read or emoji_only.
- Don't overdo delays/ignoring — most messages (70%+) should be reply_normal.
- If mood is "clingy" or "excited": almost always reply_normal.
- If mood is "annoyed" or "bored": more likely to delay or leave on read.
- emoji_only: pick from 😂💀🙄😭👀🤷‍♀️😐🫠👍❤🔥
- sticker_only: only if you have a playful/funny reaction, rare (< 5%).

Reply with ONLY the JSON. No other text.`;

  try {
    const messages: OllamaMessage[] = [
      { role: "system", content: systemPrompt },
      ...chatHistory.slice(-6).filter((m) => m.role !== "system"),
      { role: "user", content: userMessage },
    ];
    const raw = await callOllama(config, messages);

    // Parse the JSON from the response
    const jsonMatch = raw.match(/\{[^}]+\}/);
    if (!jsonMatch) return { action: "reply_normal" };

    const parsed = JSON.parse(jsonMatch[0]);
    const action = parsed.action;

    if (action === "reply_normal") return { action: "reply_normal" };
    if (action === "delay_reply") {
      const mins = Math.max(3, Math.min(30, Number(parsed.delayMinutes) || 5));
      return { action: "delay_reply", delayMinutes: mins, reason: String(parsed.reason || "busy") };
    }
    if (action === "leave_on_read") return { action: "leave_on_read" };
    if (action === "emoji_only" && parsed.emoji) return { action: "emoji_only", emoji: String(parsed.emoji) };
    if (action === "sticker_only") return { action: "sticker_only" };

    return { action: "reply_normal" };
  } catch {
    // If the behavior call fails, just reply normally
    return { action: "reply_normal" };
  }
}

// ── Telegram Reaction Emojis (existing) ──────────────────────────

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
