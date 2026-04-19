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

// ── AI Content Request Detection ─────────────────────────────────

export type ContentDecision =
  | { wantsContent: false }
  | { wantsContent: true; searchQuery: string; contentType: "meme" | "video" | "reel" | "any" };

/**
 * Ask the AI to determine if the user is requesting content (memes, reels, videos, YouTube shorts)
 * and what search query would best match their request.
 * Works across ALL languages — Hindi, Bengali, English, Hinglish, etc.
 */
export async function detectContentRequest(
  config: OllamaConfig,
  userMessage: string,
  chatHistory: OllamaMessage[],
  opts?: { personaHint?: string }
): Promise<ContentDecision> {
  const systemPrompt = `You are a classifier that determines if a Telegram user is asking for memes, funny videos, reels, YouTube shorts, or any entertaining content to be shared with them.

You must understand requests in ANY language — English, Hindi, Bengali, Hinglish, Bangla, etc.

Examples of content requests (in various languages):
- "send me a funny reel" / "show me something funny"
- "ek meme bhej" / "kuch funny bhejo" / "video bhej na"
- "ekta pathao" / "ar ekta" / "hasi video pathao"
- "bore ho raha hu kuch dikha" / "entertain me"
- "more" / "another one" / "next" / "aur ek" / "ar ekta pathao"
- "memes dikha" / "reel pathao" / "funny video send kar"

Also detect FOLLOW-UP requests: if recent messages show content was shared (messages containing "[shared:") and user says things like "more", "another", "next", "aur", "ar ekta", laughing + asking, etc.

Respond with ONLY a JSON object, no markdown, no explanation:

If the user IS requesting content:
{"wantsContent":true,"searchQuery":"<YouTube search query in English, 2-5 words, optimized for finding relevant shorts>","contentType":"<meme|video|reel|any>"}

If the user is NOT requesting content:
{"wantsContent":false}

GUIDELINES:
- "searchQuery" should be an English YouTube search query that matches what they're asking for. Be specific based on context.
  - "send me something funny" → "funny viral shorts"
  - "ar ekta hasi video pathao" → "funny comedy shorts"
  - "scary reel bhej" → "scary short videos"
  - "cute animals dikha" → "cute animals shorts"
  - "send me dank memes" → "dank memes shorts"
  - If they just say "another" or "more" after a share → "funny trending shorts"
- "contentType": "reel" for YouTube shorts/reels, "meme" for images, "video" for longer clips, "any" if unclear
- Most normal conversation messages are NOT content requests. Don't over-classify.
- Questions, emotional messages, opinions, greetings = NOT content requests.

Reply with ONLY the JSON.`;

  try {
    // Include last 6 history messages so AI can see if content was recently shared
    const messages: OllamaMessage[] = [
      { role: "system", content: systemPrompt },
      ...chatHistory.slice(-6).filter((m) => m.role !== "system"),
      { role: "user", content: userMessage },
    ];
    const raw = await callOllama(config, messages);

    const jsonMatch = raw.match(/\{[^}]+\}/);
    if (!jsonMatch) return { wantsContent: false };

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.wantsContent) return { wantsContent: false };

    const searchQuery = String(parsed.searchQuery || "funny trending shorts").slice(0, 100);
    const validTypes = ["meme", "video", "reel", "any"] as const;
    const contentType = validTypes.includes(parsed.contentType) ? parsed.contentType : "any";

    console.log(`[AI-Content] Detected content request: query="${searchQuery}", type="${contentType}"`);
    return { wantsContent: true, searchQuery, contentType };
  } catch (err) {
    console.error("[AI-Content] Detection failed:", err);
    return { wantsContent: false };
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

// ── Selfie vs Content Decision ───────────────────────────────────

export type SelfieVsContentChoice = "selfie" | "content" | "both";

/**
 * When both a selfie and content (meme/reel/video) are detected for the same message,
 * ask the AI to decide which one to send — like a real girl would.
 *
 * E.g. if she's close with the user and they say "send me a pic", she'd send a selfie.
 * But if they say "send me a funny reel" her photo isn't relevant.
 */
export async function decideSelfieVsContent(
  config: OllamaConfig,
  userMessage: string,
  comfortTier: string,
  mood: string,
  selfieReason: "asked" | "vibe" | "spontaneous",
  contentReason: "asked" | "vibe" | "random",
  chatHistory: OllamaMessage[],
  userKeys: string[] = []
): Promise<SelfieVsContentChoice> {
  const systemPrompt = `You are deciding what a real girl (Meera) should send in a Telegram chat when BOTH a selfie/photo AND a meme/reel/video could be sent.

Context:
- Comfort tier with user: ${comfortTier} (stranger < acquaintance < comfortable < close)
- Current mood: ${mood}
- Selfie trigger reason: ${selfieReason}
- Content trigger reason: ${contentReason}

Rules (think like a real girl):
- If the user is EXPLICITLY asking for a selfie/pic/photo → "selfie"
- If the user is EXPLICITLY asking for a meme/reel/video/content → "content"
- If the user's message could mean either, decide based on comfort tier:
  - "close" tier: lean towards "selfie" (she's comfortable sharing photos)
  - "comfortable" tier: could go either way based on context
  - "acquaintance"/"stranger" tier: lean towards "content" (not comfortable enough for selfies yet)
- If both are explicitly asked for ("send me a pic and a meme") → "both"
- If neither is explicitly asked (both are vibe/spontaneous triggers) → pick whichever fits the conversation better, usually "content" unless the vibe is very personal/intimate

Reply with ONLY one word: "selfie", "content", or "both". Nothing else.`;

  try {
    const messages: OllamaMessage[] = [
      { role: "system", content: systemPrompt },
      ...chatHistory.slice(-6).filter((m) => m.role !== "system"),
      { role: "user", content: userMessage },
    ];
    const raw = await callOllamaWithRotation(config, messages, userKeys);
    const choice = raw.trim().toLowerCase().replace(/[^a-z]/g, "");
    if (choice === "selfie" || choice === "content" || choice === "both") {
      return choice;
    }
    // Default: if user asked for selfie explicitly, prefer selfie
    return selfieReason === "asked" ? "selfie" : "content";
  } catch (err) {
    console.error("[AI] decideSelfieVsContent failed:", err);
    return selfieReason === "asked" ? "selfie" : "content";
  }
}

// ── Image Type Decision ──────────────────────────────────────────

export type ImageTypeChoice = "meera" | "generate" | "none";

/**
 * Decide what type of image to send:
 * - "meera": Send a community-contributed Meera image (selfie/photo of herself)
 * - "generate": Generate a new image via Stability AI (landscapes, objects, art, anything NOT Meera's face)
 * - "none": No image needed
 */
export async function decideImageType(
  config: OllamaConfig,
  userMessage: string,
  comfortTier: string,
  mood: string,
  hasMeeraImages: boolean,
  hasStabilityKey: boolean,
  chatHistory: OllamaMessage[],
  userKeys: string[] = [],
): Promise<{ type: ImageTypeChoice; prompt?: string }> {
  const systemPrompt = `You are deciding what a real girl (Meera) should do in a Telegram chat when the user might want an image.

Available options:
${hasMeeraImages ? '- "meera": Send a photo OF Meera herself (selfie, photo, pic of her)' : ""}
${hasStabilityKey ? '- "generate": Generate a NEW image that is NOT Meera (landscape, food, art, drawing, scenery, meme, anything creative)' : ""}
- "none": No image is needed — just a normal text/voice reply

Context:
- Comfort tier: ${comfortTier} (stranger < acquaintance < comfortable < close)
- Mood: ${mood}

Rules (think like a real girl deciding what to send):
- If user asks for a selfie/pic/photo OF HER (e.g. "send pic", "show me your face", "selfie bhej") → "meera"
- If user asks to CREATE/GENERATE/DRAW something (e.g. "draw a sunset", "generate an image of a cat", "make me a picture of...") → "generate"
- If the conversation vibe suggests she'd spontaneously send a pic of herself → "meera" (only for comfortable+)
- If neither is needed → "none"
- Strangers/acquaintances should rarely get "meera" (she's not comfortable sharing photos yet)
${!hasMeeraImages ? '- "meera" is NOT available (no community images yet), use "generate" only for non-Meera image requests' : ""}
${!hasStabilityKey ? '- "generate" is NOT available (no API key), use "meera" only for selfie requests' : ""}

Reply format: TYPE|PROMPT
- For "meera": just reply "meera" (no prompt needed)
- For "generate": reply "generate|a detailed description of what to create" — write a high-quality image generation prompt
- For "none": just reply "none"

Examples:
- User: "send me a pic" → meera
- User: "draw me a sunset over the ocean" → generate|a breathtaking sunset over a calm ocean, golden hour light reflecting on the water, vibrant orange and purple sky, photorealistic
- User: "how was your day" → none
- User: "generate an image of a cute cat" → generate|an adorable fluffy orange tabby cat with big green eyes, sitting on a windowsill, soft natural lighting, photographic quality

Reply with ONLY the format above. Nothing else.`;

  try {
    const messages: OllamaMessage[] = [
      { role: "system", content: systemPrompt },
      ...chatHistory.slice(-6).filter((m) => m.role !== "system"),
      { role: "user", content: userMessage },
    ];
    const raw = await callOllamaWithRotation(config, messages, userKeys);
    const cleaned = raw.trim();

    if (cleaned.toLowerCase().startsWith("generate|") || cleaned.toLowerCase().startsWith("generate |")) {
      const prompt = cleaned.slice(cleaned.indexOf("|") + 1).trim();
      if (hasStabilityKey && prompt.length > 0) {
        return { type: "generate", prompt };
      }
      // Fallback if no key
      return { type: "none" };
    }
    if (cleaned.toLowerCase().startsWith("meera")) {
      return hasMeeraImages ? { type: "meera" } : { type: "none" };
    }
    return { type: "none" };
  } catch (err) {
    console.error("[AI] decideImageType failed:", err);
    return { type: "none" };
  }
}

/**
 * Given conversation context and a list of available Meera image captions,
 * pick the best matching image to send.
 * Returns the index of the chosen image.
 */
export async function selectMeeraImage(
  config: OllamaConfig,
  userMessage: string,
  mood: string,
  comfortTier: string,
  captions: Array<{ index: number; caption: string }>,
  chatHistory: OllamaMessage[],
  userKeys: string[] = [],
): Promise<number> {
  if (captions.length === 0) return -1;
  if (captions.length === 1) return captions[0].index;

  const captionList = captions
    .map((c) => `${c.index + 1}. ${c.caption}`)
    .join("\n");

  const systemPrompt = `You are helping Meera (a real girl) pick which photo of herself to send in a Telegram chat.

Available photos:
${captionList}

Context:
- Current mood: ${mood}
- Comfort tier with user: ${comfortTier}

Rules:
- Pick the photo that best matches the conversation context and what the user asked for
- If the user asked for a specific type of photo (e.g. "send me a morning selfie"), pick one that matches
- If no specific request, pick one that matches Meera's current mood or the conversation vibe
- Consider the time of day — morning photos for morning, night photos for night, etc.
- If multiple photos could work, pick randomly but lean towards ones that feel natural
- If NONE of the available photos match what the user asked for, reply "0" — don't force a bad match

Reply with ONLY the number of the photo you pick (1-${captions.length}), or "0" if none fit. Nothing else.`;

  try {
    const messages: OllamaMessage[] = [
      { role: "system", content: systemPrompt },
      ...chatHistory.slice(-6).filter((m) => m.role !== "system"),
      { role: "user", content: userMessage },
    ];
    const raw = await callOllamaWithRotation(config, messages, userKeys);
    const num = parseInt(raw.trim().replace(/[^0-9]/g, ""));
    if (num === 0) return -1; // No matching image
    if (num >= 1 && num <= captions.length) {
      return captions[num - 1].index; // Convert 1-based to actual index
    }
    // Fallback: random
    return captions[Math.floor(Math.random() * captions.length)].index;
  } catch (err) {
    console.error("[AI] selectMeeraImage failed:", err);
    return captions[Math.floor(Math.random() * captions.length)].index;
  }
}
