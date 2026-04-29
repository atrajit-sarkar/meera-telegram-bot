import "dotenv/config";
import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { execFile } from "child_process";
import ffmpegPath from "ffmpeg-static";
import { SessionManager } from "./session-manager.js";
import { toolDeclarations, executeToolCall } from "./tools.js";
import {
  getBotName,
  buildOllamaMessages,
  buildGeminiSystemInstruction,
  INITIATE_PROMPTS,
  INACTIVITY_THRESHOLDS,
  CONTENT_SHARE_PROMPTS,
  buildGapAwareContext,
  getWeatherSummary,
} from "./config.js";
import {
  callOllama,
  callOllamaWithRotation,
  pickReactionEmoji,
  pickStickerEmoji,
  decideResponseBehavior,
  detectContentRequest,
  decideSelfieVsContent,
  decideImageType,
  selectMeeraImage,
  shortlistMeeraImages,
  selectMeeraVideo,
  decideMeeraBehavior,
  type OllamaConfig,
  type OllamaMessage,
  type MeeraBehavior,
} from "./ollama-service.js";
import { UserStore } from "./user-store.js";
import { getRandomContentAny, getContentByAIQuery, shouldShareContentMidChat, type ContentPost } from "./reddit-memes.js";
import {
  generateGeneralImage,
  parseGenderFromPersona,
  shouldSendSelfie,
} from "./image-gen.js";
import { MeeraImageStore } from "./meera-image-store.js";
import { MeeraVideoStore } from "./meera-video-store.js";
import { DpManager } from "./dp-manager.js";
import type { Context } from "telegraf";
import type { GeminiResponse } from "./gemini-session.js";
import { selectBestImageWithGemini, analyzeImageWithGemini } from "./gemini-session.js";

// Catch unhandled errors so the bot doesn't crash
process.on("unhandledRejection", (err) => console.error("[Unhandled]", err));
process.on("uncaughtException", (err) => console.error("[Uncaught]", err));

// ── ENV ─────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OLLAMA_HOST = process.env.OLLAMA_HOST || "https://ollama.com";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gemini-3-flash-preview:cloud";
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || "";
const MODEL = "gemini-3.1-flash-live-preview";

if (!BOT_TOKEN || !GEMINI_API_KEY) {
  console.error("Missing TELEGRAM_BOT_TOKEN or GEMINI_API_KEY.");
  process.exit(1);
}
if (!OLLAMA_API_KEY) {
  console.warn("⚠️  OLLAMA_API_KEY not set — text chat will not work until you set it in .env");
}

const ollamaConfig: OllamaConfig = {
  host: OLLAMA_HOST,
  model: OLLAMA_MODEL,
  apiKey: OLLAMA_API_KEY,
};

/** Helper: call Ollama with personal + community + default key rotation */
async function ollamaChat(messages: OllamaMessage[], userKeys: string[] = []) {
  return callOllamaWithRotation(ollamaConfig, messages, userKeys, store.getCommunityKeyStrings());
}

// ── BOT & SESSIONS ─────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
const FIREBASE_DB_ID = process.env.FIREBASE_DATABASE_ID || "(default)";
const store = new UserStore(50, FIREBASE_DB_ID);

// Community Meera image database (shares Firestore instance via store)
const meeraImages = new MeeraImageStore(store.getDb());

// Community Meera video database (shares Firestore instance via store)
const meeraVideos = new MeeraVideoStore(store.getDb());

// Auto-DP manager: changes bot profile photo based on aggregate user mood
const dpManager = new DpManager({
  telegram: bot.telegram,
  botToken: BOT_TOKEN,
  store,
  meeraImages,
  ollamaConfig,
  getCommunityKeys: () => store.getCommunityKeyStrings(),
});

// Gemini Live sessions — for image/audio/video (uses per-user persona)
const sessions = new SessionManager((userId: number) => {
  const tier = store.getComfortTier(userId);
  const user = store.getUser(userId);
  const mood = store.getMood(userId);
  return {
    apiKey: GEMINI_API_KEY!,
    model: MODEL,
    systemInstruction: buildGeminiSystemInstruction(tier, user, mood),
    tools: toolDeclarations,
    onToolCall: executeToolCall,
  };
});

// Middleware: load user data from Firestore before any handler
bot.use(async (ctx, next) => {
  if (ctx.from?.id) {
    await store.ensureLoaded(ctx.from.id);
  }
  return next();
});

// ── HELPERS ─────────────────────────────────────────────────────────

/** Typing action indicator */
function typingIndicator(ctx: Context, action: "typing" | "record_voice" = "typing") {
  ctx.sendChatAction(action).catch(() => {});
  const interval = setInterval(
    () => ctx.sendChatAction(action).catch(() => {}),
    4000
  );
  return () => clearInterval(interval);
}

/** Simulate typing delay based on message length */
/** Simulate typing time — mood-aware: tired/drowsy = slower, excited = faster */
function typingDelay(text: string, mood?: string): number {
  const words = text.split(/\s+/).length;
  // Base: 1.5-3.5s + ~80ms per word, capped at 6s
  let base = 1500 + Math.random() * 2000;
  // Mood adjustments to base delay
  if (mood === "tired" || mood === "bored") base *= 1.3;
  else if (mood === "excited" || mood === "happy") base *= 0.7;
  else if (mood === "annoyed") base *= 0.85; // short patience, types fast
  return Math.min(base + words * 80, 6000);
}

/** Simulate "reading" the message before typing — mood-aware */
function readDelay(userMessage: string, mood?: string): number {
  const len = userMessage.length;
  let base = 500 + Math.random() * 1000;
  const extra = Math.min(len * 15, 1500);
  // Mood adjustments
  if (mood === "tired" || mood === "bored") base *= 1.4; // reads slower when tired
  else if (mood === "excited" || mood === "clingy") base *= 0.6; // grabs phone fast when excited/clingy
  else if (mood === "annoyed") base *= 0.8; // reads quick, unimpressed
  return base + extra;
}

// ── TIME-OF-DAY AWARENESS ───────────────────────────────────────────

/** Get IST hour (UTC+5:30) */
function getISTHour(): number {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffset + now.getTimezoneOffset() * 60000);
  return ist.getHours();
}

/** Get full IST date for rich time context */
function getISTTimeContext(): string {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffset + now.getTimezoneOffset() * 60000);
  const hour = ist.getHours();
  const minute = ist.getMinutes();
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const day = days[ist.getDay()];
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${h12}:${minute.toString().padStart(2, "0")} ${ampm} IST, ${day}`;
}

/** Lightweight fallback multiplier — only used when AI behavior call fails */
function timeOfDayMultiplier(): number {
  const hour = getISTHour();
  if (hour >= 1 && hour < 6) return 3.0;
  if (hour >= 6 && hour < 8) return 1.8;
  if (hour >= 23 || hour < 1) return 2.0;
  if (hour >= 8 && hour < 10) return 1.2;
  return 1.0;
}

// ── BEHAVIOR CACHE ──────────────────────────────────────────────────
// Caches the AI's behavior decision for a short window so multiple calls
// for the same user in quick succession don't spam Ollama.
const behaviorCache = new Map<number, { behavior: MeeraBehavior; ts: number }>();
const BEHAVIOR_CACHE_TTL = 60_000; // 1 minute — stale after

function getCachedBehavior(userId: number): MeeraBehavior | null {
  const cached = behaviorCache.get(userId);
  if (cached && Date.now() - cached.ts < BEHAVIOR_CACHE_TTL) return cached.behavior;
  return null;
}

function cacheBehavior(userId: number, behavior: MeeraBehavior): void {
  behaviorCache.set(userId, { behavior, ts: Date.now() });
}

/** Get Meera's behavior decision — uses cache if fresh, otherwise calls AI */
async function getMeeraBehavior(
  userId: number,
  userMessage: string,
  tier: string,
  mood: string,
  gapMs: number,
  isMedia: boolean = false,
): Promise<MeeraBehavior> {
  // Check cache first
  const cached = getCachedBehavior(userId);
  if (cached) return cached;

  const { isRapidFire, avgGapMs } = recordMessagePace(userId);
  const user = store.getUser(userId);
  const history = store.getRecentHistory(userId);

  // ── Per-user personalization context ──
  const engagement = store.getEngagement(userId);
  const activeConvoMinutes = store.getActiveConvoMinutes(userId);
  const globalAnchor = store.getGlobalBehaviorAnchor(userId);

  // Last behavior for THIS user (for consistency)
  const lastBehaviorMinutesAgo = user.lastBehaviorAt
    ? (Date.now() - user.lastBehaviorAt) / 60000
    : undefined;

  const behavior = await decideMeeraBehavior(
    ollamaConfig,
    userMessage,
    history,
    {
      tier,
      mood,
      timeContext: getISTTimeContext(),
      weatherContext: getWeatherSummary(),
      gapHours: gapMs / (3600 * 1000),
      isRapidFire,
      avgGapMs,
      messageLength: userMessage.length,
      isMedia,
      personaHint: user.customPersona?.slice(0, 500),
      // Per-user context
      hourIST: getISTHour(),
      engagementScore: engagement,
      activeConvoMinutes,
      lastBehaviorMode: user.lastBehaviorMode,
      lastBehaviorVibe: user.lastBehaviorVibe,
      lastBehaviorMinutesAgo,
      globalAnchor,
    },
    user.ollamaKeys,
    store.getCommunityKeyStrings(),
  );

  // Store behavior decision for this user (for consistency across calls)
  const vibeDesc = behavior.currentActivity
    ? `${behavior.currentActivity} — ${behavior.vibeContext || behavior.availability}`
    : behavior.vibeContext || behavior.availability;
  store.setLastBehavior(userId, behavior.responseMode, vibeDesc);

  // Boost engagement on interaction (more for active convos, less for delayed)
  if (behavior.responseMode !== "delay" && behavior.responseMode !== "leave_on_read") {
    const boost = isRapidFire ? 15 : 10;
    store.boostEngagement(userId, boost);
  }

  cacheBehavior(userId, behavior);
  console.log(`[Behavior] User ${userId}: ${behavior.availability}/${behavior.responseMode}, delay=${behavior.delayMinutes}min, mult=${behavior.delayMultiplier}, engage=${engagement}, activeConvo=${Math.round(activeConvoMinutes)}min, vibe="${behavior.vibeContext.slice(0, 60)}"`);
  return behavior;
}

// ── MESSAGE SPLITTING ───────────────────────────────────────────────

/** Split a reply into multiple chat bubbles like a real person */
function splitIntoBubbles(text: string): string[] {
  // Short messages: don't split
  if (text.length < 40) return [text];

  // Only split ~40% of the time for natural mix
  if (Math.random() > 0.4) return [text];

  // Try splitting on natural boundaries
  const parts: string[] = [];

  // Split on sentence boundaries or natural breaks
  const sentences = text.split(/(?<=[.!?।])\s+|(?<=\n)/);
  if (sentences.length >= 2) {
    // Group sentences into 1-3 bubbles
    const numBubbles = Math.min(sentences.length, Math.random() < 0.5 ? 2 : 3);
    const perBubble = Math.ceil(sentences.length / numBubbles);
    for (let i = 0; i < sentences.length; i += perBubble) {
      const chunk = sentences.slice(i, i + perBubble).join(" ").trim();
      if (chunk) parts.push(chunk);
    }
    return parts.length > 1 ? parts : [text];
  }

  // If no sentence boundaries, try splitting on commas or "and"/"but"
  const clauses = text.split(/,\s+|\s+(?:and|but|aur|ar|kintu|lekin)\s+/i);
  if (clauses.length >= 2) {
    return clauses.filter((c) => c.trim()).slice(0, 3);
  }

  return [text];
}

/** Send split bubbles with natural delays between them, optionally quoting on first bubble */
async function sendAsBubbles(ctx: Context, text: string, replyToMsgId?: number, extras?: SendExtras): Promise<number | undefined> {
  const bubbles = splitIntoBubbles(text);
  let lastMsgId: number | undefined;
  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) {
      // Small delay between bubbles (0.5-1.5s)
      const gap = 500 + Math.random() * 1000;
      await new Promise((r) => setTimeout(r, gap));
      await ctx.sendChatAction("typing").catch(() => {});
      // Extra tiny delay for "typing" between bubbles
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
    }
    // Only quote-reply on the first bubble; only apply effect on first bubble
    const bubbleExtras: SendExtras | undefined = i === 0 ? extras : (extras?.disableNotification ? { disableNotification: true } : undefined);
    const sent = await sendText(ctx, bubbles[i], i === 0 ? replyToMsgId : undefined, bubbleExtras);
    if (sent && typeof (sent as any).message_id === "number") {
      lastMsgId = (sent as any).message_id;
    }
  }
  return lastMsgId;
}

// ── EMOJI-ONLY REPLIES ──────────────────────────────────────────────

/** Sometimes reply with just an emoji for low-effort messages */
function shouldSendEmojiOnly(tier: string, userText: string): string | null {
  const text = userText.trim().toLowerCase();

  // Only for comfortable+ tiers
  if (tier === "stranger" || tier === "acquaintance") return null;

  // 15-25% chance for very short/low-effort messages
  const lowEffort = /^(ok|okay|k|hmm|hm|oh|ah|accha|achha|thik hai|theek|haan|ha|lol|nice|cool|mhm|ohh|acha|oki)$/i;
  if (lowEffort.test(text) && Math.random() < 0.2) {
    const emojiPool = ["😂", "💀", "🙄", "😭", "👀", "🤷‍♀️", "😐", "🫠"];
    return emojiPool[Math.floor(Math.random() * emojiPool.length)];
  }

  // Funny/laughing messages — sometimes just emoji react
  if (/^(haha|hehe|lmao|lol|rofl|😂|🤣)+$/i.test(text) && Math.random() < 0.25) {
    return Math.random() < 0.5 ? "😂" : "💀";
  }

  return null;
}

// ── STRIP INTERNAL ARTIFACTS ────────────────────────────────────────

/** Remove leaked internal metadata from AI replies (prompts, file refs, bracketed tags) */
function stripInternalArtifacts(text: string): string {
  let cleaned = text;
  // Remove <attachment: ...> references (Gemini/Stability file IDs leaking)
  cleaned = cleaned.replace(/<attachment:\s*[^>]+>/gi, "");
  // Remove [meera photo: ...] or [generated image: ...] or [video note ...] tags
  cleaned = cleaned.replace(/\[meera photo:[^\]]*\]/gi, "");
  cleaned = cleaned.replace(/\[generated image:[^\]]*\]/gi, "");
  cleaned = cleaned.replace(/\[video note[^\]]*\]/gi, "");
  cleaned = cleaned.replace(/\[meera video:[^\]]*\]/gi, "");
  // Remove [shared: ...] content tags
  cleaned = cleaned.replace(/\[shared:[^\]]*\]/gi, "");
  // Remove (prompt: ...) or (image prompt: ...) leaked generation prompts
  cleaned = cleaned.replace(/\((?:image )?prompt:\s*[^)]+\)/gi, "");
  // Remove internal markers that might leak
  cleaned = cleaned.replace(/__REPLY_TO_BOT_IMAGE__[^\n]*/gi, "");
  cleaned = cleaned.replace(/__REPLY_TO_VOICE__[^\n]*/gi, "");
  // Remove standalone file-ID-like UUIDs (v followed by hex-UUID pattern)
  cleaned = cleaned.replace(/v[0-9a-f]{8,}-[0-9a-f-]+\.(jpg|jpeg|png|webp|mp4)/gi, "");
  // Collapse multiple newlines and trim
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
}

// ── SELF-CORRECTIONS ────────────────────────────────────────────────

/** Sometimes add a follow-up "correction" message to seem more human */
function maybeSelfCorrect(reply: string): string | null {
  // Only 8% of the time
  if (Math.random() > 0.08) return null;

  // Only for longer replies
  if (reply.length < 30) return null;

  const corrections = [
    "wait no that's not what i meant",
    "actually nvm",
    "*that",
    "lol typo",
    "ugh autocorrect",
    "wait hold on",
  ];
  return corrections[Math.floor(Math.random() * corrections.length)];
}

// ── DELIBERATE TYPOS ────────────────────────────────────────────────

/** Add natural typos to a reply — real people mistype on phone */
function addDeliberateTypos(text: string, mood: string): string {
  // Base 12% chance, higher when tired (25%), lower when excited (8%)
  let prob = 0.12;
  if (mood === "tired") prob = 0.25;
  if (mood === "excited") prob = 0.08;

  if (Math.random() > prob) return text;

  const words = text.split(" ");
  if (words.length < 3) return text;

  // Pick 1-2 random words to mess up
  const numTypos = Math.random() < 0.7 ? 1 : 2;
  const indices = new Set<number>();
  while (indices.size < numTypos && indices.size < words.length) {
    const idx = Math.floor(Math.random() * words.length);
    // Skip very short words, emojis, and punctuation-only
    if (words[idx].length > 3 && !/[\u{1F600}-\u{10FFFF}]/u.test(words[idx])) {
      indices.add(idx);
    } else {
      break; // Don't infinite loop
    }
  }

  for (const idx of indices) {
    const word = words[idx];
    const typoType = Math.random();

    if (typoType < 0.3) {
      // Swap two adjacent characters
      const pos = Math.floor(Math.random() * (word.length - 1));
      words[idx] = word.slice(0, pos) + word[pos + 1] + word[pos] + word.slice(pos + 2);
    } else if (typoType < 0.5) {
      // Double a character
      const pos = Math.floor(Math.random() * word.length);
      words[idx] = word.slice(0, pos) + word[pos] + word[pos] + word.slice(pos + 1);
    } else if (typoType < 0.7) {
      // Skip a character
      const pos = 1 + Math.floor(Math.random() * (word.length - 2));
      words[idx] = word.slice(0, pos) + word.slice(pos + 1);
    } else {
      // Common phone typos — adjacent key replacements
      const adjacentKeys: Record<string, string> = {
        a: "s", s: "a", d: "f", f: "d", g: "h", h: "g",
        j: "k", k: "j", l: "k", q: "w", w: "e", e: "r",
        r: "t", t: "y", y: "u", u: "i", i: "o", o: "p",
        z: "x", x: "c", c: "v", v: "b", b: "n", n: "m", m: "n",
      };
      const pos = Math.floor(Math.random() * word.length);
      const ch = word[pos].toLowerCase();
      if (adjacentKeys[ch]) {
        words[idx] = word.slice(0, pos) + adjacentKeys[ch] + word.slice(pos + 1);
      }
    }
  }

  return words.join(" ");
}

// ── TYPING FAKE-OUTS ───────────────────────────────────────────────

/** Sometimes start typing, stop, then resume — like she started a reply and deleted it */
/** Typing hesitation — she starts typing, pauses (reconsidering), then types again.
 *  Controlled by behavior.typingHesitation (AI-decided) with fallback to random 10%. */
async function maybeTypingFakeout(ctx: Context, tier: string, hesitate?: boolean): Promise<void> {
  // Only for comfortable+ tiers
  if (tier === "stranger" || tier === "acquaintance") return;
  // AI says hesitate, or 10% random chance
  if (!hesitate && Math.random() > 0.10) return;

  // Start typing
  await ctx.sendChatAction("typing").catch(() => {});
  // Type for 1-3 seconds
  await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
  // Stop (just don't send any more typing actions)
  // Pause for 2-5 seconds (she deleted what she was typing / is reconsidering)
  await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));
  // Resume typing (handled by caller after this returns)
}

// ── VOICE NOTE TEASE ────────────────────────────────────────────────

/** Sometimes briefly show "recording voice" then switch to text — like she changed her mind */
async function maybeVoiceNoteTease(ctx: Context, tier: string): Promise<boolean> {
  // Only for comfortable+ and 6% of the time
  if (tier === "stranger" || tier === "acquaintance") return false;
  if (Math.random() > 0.06) return false;

  // Show "recording voice" for 2-4 seconds
  await ctx.sendChatAction("record_voice").catch(() => {});
  await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));
  // Then switch to typing (she decided to type instead)
  await ctx.sendChatAction("typing").catch(() => {});
  return true; // Signal that we did a tease
}

// ── OFFLINE SCHEDULE ────────────────────────────────────────────────

/**
 * Check if Meera is "sleeping" or "offline". During offline hours, messages either
 * get delayed responses or a "just woke up" style reply.
 * Returns delay in ms, or 0 for "she's online".
 */
function offlineScheduleDelay(): number {
  const hour = getISTHour();

  // Core sleep: 1-6 AM — very high chance of being "asleep"
  if (hour >= 1 && hour < 6) {
    // 80% chance of being asleep
    if (Math.random() < 0.80) {
      // Wake up between 6-8 AM IST — calculate remaining time roughly
      const wakeHour = 6 + Math.random() * 2;
      const hoursUntilWake = wakeHour - hour + (hour < 1 ? 24 : 0);
      return hoursUntilWake * 3600 * 1000;
    }
  }

  // Light sleep: 12-1 AM — 40% chance sleeping
  if (hour >= 0 && hour < 1) {
    if (Math.random() < 0.40) {
      const wakeHour = 6 + Math.random() * 2;
      return (wakeHour + 24 - hour) * 3600 * 1000 % (24 * 3600 * 1000);
    }
  }

  // Random "busy" periods during the day — 5% chance of 15-45 min delay
  if (hour >= 9 && hour < 22 && Math.random() < 0.05) {
    return (15 + Math.random() * 30) * 60 * 1000;
  }

  return 0;
}

// ── DELAYED REPLY QUEUE ─────────────────────────────────────────────

type DelayReason = "sleeping" | "late_night" | "busy" | "read_receipt" | "seen_later";

interface DelayedReply {
  chatId: number;
  userId: number;
  userText: string;
  timer: ReturnType<typeof setTimeout>;
}

const delayedReplies = new Map<number, DelayedReply>();

/** Reason-aware context hints so the AI knows WHY she's replying late */
const DELAY_CONTEXT: Record<DelayReason, string[]> = {
  sleeping: [
    "(You just woke up and are replying to a message you missed while sleeping. Be groggy/sleepy if it's early morning. Maybe say something like 'just woke up' or 'sorry was sleeping'. Be natural about it.)",
    "(You were sleeping and just woke up. Reply naturally — you can mention you just saw this, or that you were asleep. Don't over-apologize.)",
    "(You fell asleep and are replying now that you're awake. Be casual — maybe sleepy vibes. Don't make a big deal of it.)",
  ],
  late_night: [
    "(It's very late and you were dozing off. You saw their message late. Reply sleepily — maybe mention you were half asleep or dozed off. Keep it natural.)",
    "(You were falling asleep when they messaged. Reply naturally with late-night sleepy vibes. Maybe short and drowsy.)",
  ],
  busy: [
    "(You were busy doing something and are replying a bit late. Casually mention you were busy — studying, eating, watching something, etc. Don't over-explain.)",
    "(You got distracted or were doing something. Reply naturally — maybe a quick 'sorry was busy' or just answer directly without mentioning the delay.)",
  ],
  read_receipt: [
    "(You saw their message but took a while to reply. Maybe you weren't sure what to say, or you were thinking. Don't mention the delay unless it feels natural.)",
    "(You read the message earlier but replied late. Don't make a big deal of it — just reply naturally. If they ask why you took long, be casual about it.)",
  ],
  seen_later: [
    "(You're replying a bit late — you were doing your own thing. No need to explain unless they ask. Just reply normally.)",
    "(You saw the message a bit ago and are now replying. Be natural — don't apologize. Just respond.)",
  ],
};

function getDelayContext(reason: DelayReason): string {
  const options = DELAY_CONTEXT[reason];
  return options[Math.floor(Math.random() * options.length)];
}

/** Schedule a delayed reply (seen-but-reply-later behavior) */
function scheduleDelayedReply(
  ctx: Context & { message: { text: string } },
  userId: number,
  delayMs: number,
  reason: DelayReason = "busy",
  vibeHint?: string,
) {
  // Cancel any existing delayed reply
  const existing = delayedReplies.get(userId);
  if (existing) clearTimeout(existing.timer);

  const chatId = ctx.chat!.id;
  const userText = ctx.message.text;

  const timer = setTimeout(async () => {
    delayedReplies.delete(userId);
    try {
      const tier = store.getComfortTier(userId);
      const user = store.getUser(userId);
      const history = store.getRecentHistory(userId);
      const mood = store.getMood(userId);

      // Use AI-provided vibe context if available, otherwise fall back to hardcoded delay reasons
      const lateContext = vibeHint
        ? `(You're replying late because: ${vibeHint}. Be natural about it — mention what you were doing briefly if it fits, or just reply.)`
        : getDelayContext(reason);

      const messages = buildOllamaMessages(
        lateContext + "\n\nTheir message: " + userText,
        history,
        tier,
        user,
        mood
      );
      let reply = await ollamaChat(messages, user.ollamaKeys);
      reply = stripInternalArtifacts(reply);
      if (!reply) reply = ["hmm", "haha", "sorry was sleeping 😴"][Math.floor(Math.random() * 3)];
      reply = addDeliberateTypos(reply, mood);

      store.addMessage(userId, "user", userText);
      store.addMessage(userId, "assistant", reply);

      await bot.telegram.sendChatAction(chatId, "typing");
      const delay = Math.min(typingDelay(reply), 3000);
      await new Promise((r) => setTimeout(r, delay));

      await bot.telegram.sendMessage(chatId, reply);
      // She's now engaged — boost warmth and mark her as active
      store.boostEngagement(userId, 10);
      store.setLastBehavior(userId, "text", "just replied after being away");
      console.log(`[DelayedReply] Sent to user ${userId} after delay`);
    } catch (err) {
      console.error(`[DelayedReply] Failed for user ${userId}:`, err);
    }
  }, delayMs);

  delayedReplies.set(userId, { chatId, userId, userText, timer });
  console.log(`[DelayedReply] Scheduled for user ${userId} in ${Math.round(delayMs / 60000)}min`);
}

/** Download a Telegram file by file_id and return its Buffer */
async function downloadFileBuffer(fileId: string): Promise<Buffer> {
  const fileLink = await bot.telegram.getFileLink(fileId);
  const response = await fetch(fileLink.href);
  return Buffer.from(await response.arrayBuffer());
}

/** Download a Telegram file by file_id and return its base64 content */
async function downloadFile(fileId: string): Promise<string> {
  const buf = await downloadFileBuffer(fileId);
  return buf.toString("base64");
}

/**
 * Two-step Meera image selection:
 * 1. Ollama shortlists candidates by caption relevance
 * 2. Gemini visually analyzes the shortlisted images and picks the best one
 * Falls back to Ollama-only selection if Gemini fails.
 */
async function selectBestMeeraImageIndex(
  userText: string,
  userId: number,
): Promise<number> {
  const user = store.getUser(userId);
  const mood = store.getMood(userId);
  const tier = store.getComfortTier(userId);
  const history = store.getRecentHistory(userId);
  const captions = await meeraImages.getCaptionsWithIndices();

  if (captions.length === 0) return -1;
  if (captions.length === 1) return captions[0].index;

  // Step 1: Ollama shortlists candidates by caption
  const shortlist = await shortlistMeeraImages(
    ollamaConfig,
    userText,
    mood,
    tier,
    captions,
    history,
    user.ollamaKeys,
    store.getCommunityKeyStrings(),
  );

  if (shortlist.length === 0) return -1;
  if (shortlist.length === 1) return shortlist[0];

  // Step 2: Download shortlisted images and let Gemini pick visually
  try {
    const candidates = [];
    for (const idx of shortlist) {
      const image = await meeraImages.getByIndex(idx);
      if (!image) continue;
      try {
        const buffer = await downloadFileBuffer(image.fileId);
        candidates.push({
          index: idx,
          caption: image.caption,
          imageBase64: buffer.toString("base64"),
        });
      } catch (err) {
        console.error(`[MeeraImg] Failed to download candidate image ${idx}:`, err);
      }
    }

    if (candidates.length === 0) return shortlist[0];
    if (candidates.length === 1) return candidates[0].index;

    const bestIndex = await selectBestImageWithGemini(
      GEMINI_API_KEY!,
      candidates,
      { userMessage: userText, mood, comfortTier: tier },
    );

    console.log(`[MeeraImg] Gemini selected image ${bestIndex} from ${candidates.length} candidates (shortlisted from ${captions.length} total)`);
    return bestIndex;
  } catch (err) {
    console.error("[MeeraImg] Gemini visual selection failed, falling back to Ollama caption-based pick:", err);
    // Fallback: use Ollama's caption-based selection on the shortlisted candidates
    try {
      const shortlistCaptions = [];
      for (const idx of shortlist) {
        const img = await meeraImages.getByIndex(idx);
        if (img) shortlistCaptions.push({ index: idx, caption: img.caption });
      }
      if (shortlistCaptions.length > 0) {
        const ollamaIndex = await selectMeeraImage(
          ollamaConfig, userText, mood, tier, shortlistCaptions, history, user.ollamaKeys,
        );
        console.log(`[MeeraImg] Ollama fallback selected image ${ollamaIndex} from ${shortlistCaptions.length} shortlisted`);
        return ollamaIndex;
      }
    } catch (fallbackErr) {
      console.error("[MeeraImg] Ollama fallback also failed:", fallbackErr);
    }
    // Final fallback: first shortlisted
    return shortlist[0];
  }
}

/** Convert any audio buffer to raw PCM16 16kHz mono via ffmpeg, returned as base64 */
function convertToPcm16(inputBuf: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      ffmpegPath as unknown as string,
      ["-i", "pipe:0", "-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1"],
      { encoding: "buffer" as const, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(Buffer.from(stdout).toString("base64"));
      }
    );
    proc.stdin!.write(inputBuf);
    proc.stdin!.end();
  });
}

/** Extract a single frame from a video as JPEG, returned as base64 */
function extractVideoFrame(videoBuf: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      ffmpegPath as unknown as string,
      [
        "-i", "pipe:0",
        "-vframes", "1",         // Just 1 frame
        "-ss", "0.5",            // Half second in (skip black intro frames)
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "-q:v", "3",             // Good quality JPEG
        "pipe:1",
      ],
      { encoding: "buffer" as const, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(Buffer.from(stdout).toString("base64"));
      }
    );
    proc.stdin!.write(videoBuf);
    proc.stdin!.end();
  });
}

/** Extract audio from a video as PCM16 16kHz mono, returned as base64. Returns null if no audio stream. */
function extractVideoAudio(videoBuf: Buffer): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = execFile(
      ffmpegPath as unknown as string,
      [
        "-i", "pipe:0",
        "-vn",                   // No video
        "-f", "s16le",
        "-ar", "16000",
        "-ac", "1",
        "pipe:1",
      ],
      { encoding: "buffer" as const, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout || stdout.length === 0) return resolve(null);
        resolve(Buffer.from(stdout).toString("base64"));
      }
    );
    proc.stdin!.write(videoBuf);
    proc.stdin!.end();
  });
}

/** Convert raw PCM16 24kHz mono to a WAV buffer */
function pcmToWav(pcmChunks: Buffer[]): Buffer {
  const pcm = Buffer.concat(pcmChunks);
  const sampleRate = 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

// ── QUOTE-REPLY BEHAVIOR ────────────────────────────────────────────

/**
 * Should Meera quote-reply (swipe-reply) the user's message?
 * Real girls do this sometimes — more often with close friends, rarely with strangers.
 * Returns true if she should quote the message.
 */
function shouldQuoteReply(tier: string, userText: string): boolean {
  // Strangers: never quote-reply
  if (tier === "stranger") return false;

  // Acquaintance: very rare (5%)
  if (tier === "acquaintance") return Math.random() < 0.05;

  const text = userText.toLowerCase();

  // Questions → higher chance of quoting (answering a specific question)
  const isQuestion = /\?|kya|kab|kaise|kyun|why|what|how|when|where|ki\b/.test(text);

  // Long messages → higher chance (referencing something specific they said)
  const isLong = text.length > 80;

  // Comfortable: 15% base, 30% for questions, 25% for long msgs
  if (tier === "comfortable") {
    if (isQuestion) return Math.random() < 0.30;
    if (isLong) return Math.random() < 0.25;
    return Math.random() < 0.15;
  }

  // Close: 25% base, 40% for questions, 35% for long msgs
  if (isQuestion) return Math.random() < 0.40;
  if (isLong) return Math.random() < 0.35;
  return Math.random() < 0.25;
}

/** Send Gemini's audio-only response */
async function sendGeminiResponse(ctx: Context, response: GeminiResponse, replyToMsgId?: number): Promise<number | undefined> {
  const { audioChunks } = response;
  if (audioChunks.length > 0) {
    const wav = pcmToWav(audioChunks);
    const opts: Record<string, unknown> = {};
    if (replyToMsgId) opts.reply_parameters = { message_id: replyToMsgId };
    const sent = await ctx.replyWithVoice({ source: wav, filename: "response.wav" }, opts as any);
    return sent.message_id;
  }
  // Fallback if no audio (shouldn't happen)
  if (response.text.trim()) {
    await sendText(ctx, response.text, replyToMsgId);
  }
  return undefined;
}

// AI refusal patterns — if Gemini's transcription contains these, it's a safety block
const AI_REFUSAL_PATTERNS = [
  /i can'?t help (you )?with that/i,
  /i'?m not able to/i,
  /i cannot (assist|help|provide|generate|create)/i,
  /as an ai/i,
  /i'?m (just )?an ai/i,
  /i don'?t feel comfortable/i,
  /not appropriate/i,
  /i'?m sorry,? but i (can'?t|cannot)/i,
  /i'?m unable to/i,
  /against my (guidelines|policies|programming)/i,
  /i (can'?t|cannot|won'?t) (do|say|engage|respond|discuss) that/i,
  /let'?s (talk|chat) about something else/i,
  /i'?m designed to be helpful/i,
  /safety (guidelines|policies|concerns)/i,
];

/** Check if a Gemini response is blocked or contains AI-refusal language */
function isGeminiBlockedBasic(response: GeminiResponse): boolean {
  // Case 1: completely empty — both audio and text missing
  if (response.audioChunks.length === 0 && !response.text.trim()) return true;

  // Case 2: has audio but the transcription text reveals a refusal
  const text = response.text.trim();
  if (text && AI_REFUSAL_PATTERNS.some((p) => p.test(text))) return true;

  return false;
}

/** Enhanced blockage check: regex first, then Ollama analysis for ambiguous cases */
async function isGeminiBlocked(response: GeminiResponse, userKeys: string[] = []): Promise<boolean> {
  // Case 1: obvious block via regex
  if (isGeminiBlockedBasic(response)) return true;

  // Case 2: if there's meaningful text, ask Ollama to analyze for subtle AI refusal
  const text = response.text.trim();
  if (!text || text.length < 10) return false;

  try {
    const analysisMessages: OllamaMessage[] = [
      {
        role: "system",
        content: `You are a classifier. Given a text snippet from an AI voice response, determine if it is an AI safety/refusal/blockage message (the AI refusing to answer, saying it can't help, deflecting due to safety policies, breaking character to say it's an AI, etc.).

Respond with ONLY "blocked" or "ok" — nothing else.

Examples of blocked: "I'm sorry, I can't help with that", "As an AI language model, I don't feel comfortable", "Let's talk about something more appropriate", "I cannot engage in that kind of conversation"
Examples of ok: "haha yeah totally", "omg that's so funny", "wait what do you mean", "I don't think that's a good idea tbh" (opinion, not refusal)`,
      },
      { role: "user", content: text },
    ];
    const result = await ollamaChat(analysisMessages, userKeys);
    const verdict = result.trim().toLowerCase();
    if (verdict.includes("blocked")) {
      console.log(`[BlockCheck] Ollama detected AI blockage in Gemini text: "${text.slice(0, 100)}"`);
      return true;
    }
  } catch (err) {
    console.error("[BlockCheck] Ollama analysis failed, falling back to regex-only:", err);
    // If Ollama fails, rely on regex result (already false at this point)
  }

  return false;
}

/** Send text with Markdown fallback, optionally quoting a message */
async function sendText(ctx: Context, text: string, replyToMsgId?: number, extras?: SendExtras): Promise<any> {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, 4000));
    remaining = remaining.slice(4000);
  }
  let lastSent: any;
  for (let i = 0; i < chunks.length; i++) {
    // Only quote-reply on the first chunk
    const opts: Record<string, unknown> = {};
    if (i === 0 && replyToMsgId) {
      const replyParams: Record<string, unknown> = { message_id: replyToMsgId };
      if (extras?.quote) replyParams.quote = extras.quote;
      opts.reply_parameters = replyParams;
    }
    if (extras?.disableNotification) opts.disable_notification = true;
    if (extras?.messageEffectId) opts.message_effect_id = extras.messageEffectId;
    try {
      lastSent = await ctx.reply(chunks[i], { parse_mode: "Markdown", ...opts } as any);
    } catch {
      lastSent = await ctx.reply(chunks[i], opts as any);
    }
  }
  return lastSent;
}

/** Try to set a reaction emoji on the user's message */
async function maybeReact(ctx: Context, userId: number, userMessage: string) {
  const msgCount = store.getMessageCount(userId);
  const mood = store.getMood(userId);
  // Base probability scales with relationship
  let prob =
    msgCount < 5 ? 0.1 : msgCount < 15 ? 0.3 : msgCount < 30 ? 0.5 : 0.7;
  // Mood adjustments — sassy/excited react more, tired/bored react less
  if (mood === "sassy" || mood === "excited") prob = Math.min(prob * 1.4, 0.85);
  else if (mood === "happy" || mood === "clingy") prob = Math.min(prob * 1.2, 0.8);
  else if (mood === "tired" || mood === "bored") prob *= 0.5;
  else if (mood === "annoyed") prob *= 0.7;
  if (Math.random() > prob) return;

  const tier = store.getComfortTier(userId);
  const history = store.getRecentHistory(userId);
  const user = store.getUser(userId);
  const personaHint = user.customPersona ? user.customPersona.slice(0, 500) : undefined;
  const emoji = await pickReactionEmoji(ollamaConfig, userMessage, history, tier, personaHint);
  if (!emoji) return;
  try {
    await (ctx as any).telegram.setMessageReaction(
      ctx.chat!.id,
      (ctx.message as any).message_id,
      [{ type: "emoji", emoji }]
    );
  } catch {
    // Reactions may not be supported in all chats
  }
}

/** Maybe send a sticker after the bot's reply */
async function maybeSendSticker(
  ctx: Context,
  userId: number,
  aiResponse: string
) {
  const msgCount = store.getMessageCount(userId);
  const user = store.getUser(userId);
  const mood = user.mood || "chill";
  // No global sticker packs? Skip
  const globalPacks = store.getGlobalStickerPackNames();
  if (!globalPacks.length) return;
  // Base probability by tier
  let baseProbability =
    msgCount < 8
      ? 0
      : msgCount < 25
        ? 0.04
        : msgCount < 60
          ? 0.12
          : 0.22;
  // Mood adjustments — happy/clingy/excited send more stickers, tired/annoyed send fewer
  if (mood === "happy" || mood === "clingy" || mood === "excited") baseProbability *= 1.5;
  else if (mood === "sassy") baseProbability *= 1.3;
  else if (mood === "tired" || mood === "annoyed") baseProbability *= 0.4;
  else if (mood === "bored") baseProbability *= 0.6;
  if (baseProbability === 0 || Math.random() >= baseProbability) return;

  const history = store.getRecentHistory(userId);
  const personaHint = user.customPersona ? user.customPersona.slice(0, 500) : undefined;
  const emoji = await pickStickerEmoji(ollamaConfig, aiResponse, history, personaHint);
  if (!emoji) return;

  // Try to find a sticker matching the emoji in global packs
  for (const packName of globalPacks) {
    try {
      const stickerSet = await (ctx as any).telegram.getStickerSet(packName);
      const match = stickerSet.stickers.find(
        (s: any) => s.emoji && s.emoji.includes(emoji)
      );
      if (match) {
        await ctx.replyWithSticker(match.file_id);
        return;
      }
    } catch {
      continue;
    }
  }
}

// ── COMMANDS ────────────────────────────────────────────────────────

const botName = getBotName();

bot.start((ctx) =>
  ctx.reply(
    `Hey! 👋 I'm ${botName}.\n\n` +
      "Send me text, photos, voice messages, or videos!\n\n" +
      "Commands:\n\n" +
      "📋 Profile:\n" +
      "/profile — Your profile\n" +
      "/setname — Set your name\n" +
      "/setbio — Set your bio\n" +
      "/tone — Change tone\n" +
      "/replies_short /replies_medium /replies_long\n" +
      "/talk — Toggle voice-only mode\n" +
      "/clear — Reset conversation\n" +
      "/reset — Full session reset\n\n" +
      "🎭 Persona:\n" +
      "/persona — Customize AI personality\n" +
      "/viewpersona — View your custom persona\n" +
      "/resetpersona — Reset to default\n\n" +
      "🎨 Stickers:\n" +
      "/addstickers — Add a sticker pack\n" +
      "/stickers — List sticker packs\n" +
      "/removestickers — Remove a sticker pack\n\n" +
      "🔑 Chat API Keys:\n" +
      "/addkey — Add your Ollama API key\n" +
      "/keys — List your API keys\n" +
      "/removekey — Remove an API key\n" +
      "/contribute — Donate a key for everyone\n" +
      "/communitykeys — View community key pool\n" +
      "/removecontribution — Remove your donated key\n\n" +
      "🖼️ Image API Keys:\n" +
      "/addimagekey — Add your Stability AI key\n" +
      "/imagekeys — List your image keys\n" +
      "/removeimagekey — Remove an image key\n" +
      "/contributeimage — Donate an image key\n" +
      "/imagepool — View image community keys\n" +
      "/removeimagecontribution — Remove donated image key\n\n" +
      "📸 Community Photos:\n" +
      "/contributeface — How to contribute photos\n" +
      "/uploadface — Upload Meera images\n" +
      "/facepool — View contributed images\n" +
      "/removeface — Remove your contributed image\n\n" +
      "🎬 Community Videos:\n" +
      "/uploadvideo — Upload community videos\n" +
      "/videopool — View contributed videos\n" +
      "/removevideo — Remove your contributed video\n\n" +
      "/help — Show this message"
  )
);

bot.help((ctx) =>
  ctx.reply(
    `I can understand:\n` +
      "• Text messages\n" +
      "• Photos (with or without captions)\n" +
      "• Voice messages\n" +
      "• Videos & video notes\n\n" +
      "📋 Profile:\n" +
      "/profile /setname /setbio /tone\n" +
      "/replies_short /replies_medium /replies_long\n" +
      "/talk — Toggle voice-only replies\n" +
      "/clear — Reset conversation\n" +
      "/reset — Full session reset\n\n" +
      "🎭 Persona:\n" +
      "/persona /viewpersona /resetpersona\n\n" +
      "🎨 Stickers:\n" +
      "/addstickers /stickers /removestickers\n\n" +
      "🔑 Chat API Keys:\n" +
      "/addkey /keys /removekey\n" +
      "/contribute /communitykeys /removecontribution\n\n" +
      "🖼️ Image API Keys:\n" +
      "/addimagekey /imagekeys /removeimagekey\n" +
      "/contributeimage /imagepool /removeimagecontribution\n\n" +
      "📸 Community Photos:\n" +
      "/contributeface /uploadface /facepool /removeface\n\n" +
      "🎬 Community Videos:\n" +
      "/uploadvideo /videopool /removevideo"
  )
);

bot.command("profile", async (ctx) => {
  const user = store.getUser(ctx.from.id);
  const tier = store.getComfortTier(ctx.from.id);
  const msgs = store.getMessageCount(ctx.from.id);
  await ctx.reply(
    `👤 *Your Profile*\n\n` +
      `Name: ${user.profileName || "Not set"}\n` +
      `Bio: ${user.profileBio || "Not set"}\n` +
      `Tone: ${user.tone}\n` +
      `Reply length: ${user.replyLength}\n` +
      `Voice-only: ${user.voiceOnly ? "ON" : "OFF"}\n` +
      `Relationship: ${tier} (${msgs} messages)\n` +
      `Global sticker packs: ${store.getGlobalStickerPackCount()}`,
    { parse_mode: "Markdown" }
  );
});

bot.command("setname", async (ctx) => {
  store.setFsmState(ctx.from.id, "waiting_for_name");
  await ctx.reply("What should I call you?");
});

bot.command("setbio", async (ctx) => {
  store.setFsmState(ctx.from.id, "waiting_for_bio");
  await ctx.reply("Tell me a bit about yourself:");
});

bot.command("tone", async (ctx) => {
  await ctx.reply("Pick your tone:\n/tone_casual — Chill and casual\n/tone_formal — More polished");
});
bot.command("tone_casual", async (ctx) => {
  store.updateUser(ctx.from.id, { tone: "casual" });
  await ctx.reply("Got it, keeping it casual! 😎");
});
bot.command("tone_formal", async (ctx) => {
  store.updateUser(ctx.from.id, { tone: "formal" });
  await ctx.reply("Understood, I'll keep it polished.");
});

bot.command("replies_short", async (ctx) => {
  store.updateUser(ctx.from.id, { replyLength: "short" });
  await ctx.reply("Short and sweet it is! ✌️");
});
bot.command("replies_medium", async (ctx) => {
  store.updateUser(ctx.from.id, { replyLength: "medium" });
  await ctx.reply("Medium replies — balanced! 👌");
});
bot.command("replies_long", async (ctx) => {
  store.updateUser(ctx.from.id, { replyLength: "long" });
  await ctx.reply("I'll write more detailed replies for you! 📝");
});

bot.command("talk", async (ctx) => {
  const user = store.getUser(ctx.from.id);
  const newVal = !user.voiceOnly;
  store.updateUser(ctx.from.id, { voiceOnly: newVal });
  await ctx.reply(newVal ? "🎙️ Voice-only mode ON" : "💬 Text mode ON");
});

bot.command("clear", async (ctx) => {
  store.setFsmState(ctx.from.id, "waiting_for_clear_confirm");
  await ctx.reply("Are you sure? This will erase our entire conversation history. Type 'yes' to confirm.");
});

bot.command("addstickers", async (ctx) => {
  store.setFsmState(ctx.from.id, "waiting_for_sticker_pack");
  await ctx.reply("Send me the sticker pack name (you can find it in the sticker pack link).\nThis will be added to Meera's global sticker pool for everyone!");
});

bot.command("stickers", async (ctx) => {
  await store.loadGlobalStickerPacks();
  const packs = store.getGlobalStickerPacksInfo();
  if (!packs.length) {
    await ctx.reply("No sticker packs in the global pool yet. Use /addstickers to add one!");
    return;
  }
  const list = packs.map((p, i) => `${i + 1}. ${p.packName}${p.addedByName ? ` (by ${p.addedByName})` : ""}`).join("\n");
  await ctx.reply(`🎨 Global sticker pool (${packs.length} packs):\n${list}`);
});

bot.command("removestickers", async (ctx) => {
  await store.loadGlobalStickerPacks();
  const packs = store.getGlobalStickerPacksInfo();
  if (!packs.length) {
    await ctx.reply("No sticker packs to remove.");
    return;
  }
  store.setFsmState(ctx.from.id, "waiting_for_remove_sticker_pack");
  const list = packs.map((p, i) => `${i + 1}. ${p.packName}${p.addedByName ? ` (by ${p.addedByName})` : ""}`).join("\n");
  await ctx.reply(
    "Which pack to remove? (you can only remove packs you added)\n" +
      list +
      "\n\nSend the number."
  );
});

bot.command("reset", async (ctx) => {
  store.clearHistory(ctx.from.id);
  sessions.resetSession(ctx.from.id);
  await ctx.reply("🔄 Conversation reset!");
});

// ── CHAT API KEY COMMANDS (Ollama/text generation) ──────────────────

bot.command("addchatkey", async (ctx) => {
  store.setFsmState(ctx.from.id, "waiting_for_ollama_key");
  await ctx.reply("💬 Send me your Ollama/Chat API key. It will be stored securely and used as a backup when the default key hits its limit.\n\n⚠️ Delete your message after sending to keep it private!");
});
// Legacy alias
bot.command("addkey", async (ctx) => {
  store.setFsmState(ctx.from.id, "waiting_for_ollama_key");
  await ctx.reply("💬 Send me your Ollama/Chat API key. It will be stored securely and used as a backup when the default key hits its limit.\n\n⚠️ Delete your message after sending to keep it private!");
});

bot.command("chatkeys", async (ctx) => {
  const user = store.getUser(ctx.from.id);
  if (!user.ollamaKeys.length) {
    await ctx.reply("No chat API keys added. Use /addchatkey to add one!");
    return;
  }
  const masked = user.ollamaKeys.map((k, i) =>
    `${i + 1}. ${k.slice(0, 6)}...${k.slice(-4)}`
  );
  await ctx.reply("💬 Your Chat API keys:\n" + masked.join("\n") + "\n\nUse /removechatkey to remove one.");
});
bot.command("keys", async (ctx) => {
  const user = store.getUser(ctx.from.id);
  if (!user.ollamaKeys.length) {
    await ctx.reply("No chat API keys added. Use /addchatkey to add one!");
    return;
  }
  const masked = user.ollamaKeys.map((k, i) =>
    `${i + 1}. ${k.slice(0, 6)}...${k.slice(-4)}`
  );
  await ctx.reply("💬 Your Chat API keys:\n" + masked.join("\n") + "\n\nUse /removechatkey to remove one.");
});

bot.command("removechatkey", async (ctx) => {
  const user = store.getUser(ctx.from.id);
  if (!user.ollamaKeys.length) {
    await ctx.reply("No chat API keys to remove.");
    return;
  }
  const masked = user.ollamaKeys.map((k, i) =>
    `${i + 1}. ${k.slice(0, 6)}...${k.slice(-4)}`
  );
  store.setFsmState(ctx.from.id, "waiting_for_remove_key");
  await ctx.reply("Which chat API key to remove?\n" + masked.join("\n") + "\n\nSend the number.");
});
bot.command("removekey", async (ctx) => {
  const user = store.getUser(ctx.from.id);
  if (!user.ollamaKeys.length) {
    await ctx.reply("No chat API keys to remove.");
    return;
  }
  const masked = user.ollamaKeys.map((k, i) =>
    `${i + 1}. ${k.slice(0, 6)}...${k.slice(-4)}`
  );
  store.setFsmState(ctx.from.id, "waiting_for_remove_key");
  await ctx.reply("Which chat API key to remove?\n" + masked.join("\n") + "\n\nSend the number.");
});

// ── CHAT COMMUNITY KEY POOL COMMANDS ────────────────────────────────

bot.command("contributechat", async (ctx) => {
  store.setFsmState(ctx.from.id, "waiting_for_community_key");
  await ctx.reply(
    "🤝 *Chat Community Key Pool*\n\n" +
    "Contribute your Ollama/Chat API key to help everyone\\! " +
    "Your key will be shared with ALL users so they can chat even when the default key hits its limit\\.\n\n" +
    "Send me your Chat API key now\\.\n\n" +
    "⚠️ Delete your message after sending to keep it private\\!",
    { parse_mode: "MarkdownV2" }
  );
});
bot.command("contribute", async (ctx) => {
  store.setFsmState(ctx.from.id, "waiting_for_community_key");
  await ctx.reply(
    "🤝 *Chat Community Key Pool*\n\n" +
    "Contribute your Ollama/Chat API key to help everyone\\! " +
    "Your key will be shared with ALL users so they can chat even when the default key hits its limit\\.\n\n" +
    "Send me your Chat API key now\\.\n\n" +
    "⚠️ Delete your message after sending to keep it private\\!",
    { parse_mode: "MarkdownV2" }
  );
});

bot.command("chatpool", async (ctx) => {
  await store.loadCommunityKeys();
  const count = store.getCommunityKeyCount();
  if (count === 0) {
    await ctx.reply("No chat community keys yet. Be the first to /contributechat one! 🤝");
    return;
  }
  const info = store.getCommunityKeysInfo();
  const lines = info.map((k, i) => {
    const credit = k.contributorName ? ` — contributed by ${k.contributorName}` : "";
    return `${i + 1}. ${k.maskedKey}${credit}`;
  });
  await ctx.reply(`🤝 Chat Community Key Pool: ${count} key${count > 1 ? "s" : ""}\n\n${lines.join("\n")}\n\nThese keys are shared with all users. Use /contributechat to add yours!`);
});
bot.command("communitykeys", async (ctx) => {
  await store.loadCommunityKeys();
  const count = store.getCommunityKeyCount();
  if (count === 0) {
    await ctx.reply("No chat community keys yet. Be the first to /contributechat one! 🤝");
    return;
  }
  const info = store.getCommunityKeysInfo();
  const lines = info.map((k, i) => {
    const credit = k.contributorName ? ` — contributed by ${k.contributorName}` : "";
    return `${i + 1}. ${k.maskedKey}${credit}`;
  });
  await ctx.reply(`🤝 Chat Community Key Pool: ${count} key${count > 1 ? "s" : ""}\n\n${lines.join("\n")}\n\nThese keys are shared with all users. Use /contributechat to add yours!`);
});

bot.command("removechatcontribution", async (ctx) => {
  await store.loadCommunityKeys();
  const count = store.getCommunityKeyCount();
  if (count === 0) {
    await ctx.reply("No chat community keys to remove.");
    return;
  }
  const info = store.getCommunityKeysInfo();
  const lines = info.map((k, i) => `${i + 1}. ${k.maskedKey}`);
  store.setFsmState(ctx.from.id, "waiting_for_remove_community_key");
  await ctx.reply("Which chat community key to remove? (You can only remove keys you contributed)\n\n" + lines.join("\n") + "\n\nSend the number.");
});
bot.command("removecontribution", async (ctx) => {
  await store.loadCommunityKeys();
  const count = store.getCommunityKeyCount();
  if (count === 0) {
    await ctx.reply("No chat community keys to remove.");
    return;
  }
  const info = store.getCommunityKeysInfo();
  const lines = info.map((k, i) => `${i + 1}. ${k.maskedKey}`);
  store.setFsmState(ctx.from.id, "waiting_for_remove_community_key");
  await ctx.reply("Which chat community key to remove? (You can only remove keys you contributed)\n\n" + lines.join("\n") + "\n\nSend the number.");
});

// ── IMAGE/STABILITY API KEY COMMANDS ────────────────────────────────

bot.command("addimagekey", async (ctx) => {
  store.setFsmState(ctx.from.id, "waiting_for_stability_key");
  await ctx.reply("🎨 Send me your Stability AI API key. It will be used for generating selfie/photo images.\n\nGet one at https://platform.stability.ai/account/keys\n\n⚠️ Delete your message after sending to keep it private!");
});

bot.command("imagekeys", async (ctx) => {
  const user = store.getUser(ctx.from.id);
  if (!user.stabilityKeys.length) {
    await ctx.reply("No image API keys added. Use /addimagekey to add one!");
    return;
  }
  const masked = user.stabilityKeys.map((k, i) =>
    `${i + 1}. ${k.slice(0, 6)}...${k.slice(-4)}`
  );
  await ctx.reply("🎨 Your Image API keys (Stability AI):\n" + masked.join("\n") + "\n\nUse /removeimagekey to remove one.");
});

bot.command("removeimagekey", async (ctx) => {
  const user = store.getUser(ctx.from.id);
  if (!user.stabilityKeys.length) {
    await ctx.reply("No image API keys to remove.");
    return;
  }
  const masked = user.stabilityKeys.map((k, i) =>
    `${i + 1}. ${k.slice(0, 6)}...${k.slice(-4)}`
  );
  store.setFsmState(ctx.from.id, "waiting_for_remove_stability_key");
  await ctx.reply("Which image API key to remove?\n" + masked.join("\n") + "\n\nSend the number.");
});

// ── IMAGE COMMUNITY KEY POOL COMMANDS ───────────────────────────────

bot.command("contributeimage", async (ctx) => {
  store.setFsmState(ctx.from.id, "waiting_for_stability_community_key");
  await ctx.reply(
    "🤝 *Image Community Key Pool*\n\n" +
    "Contribute your Stability AI API key to help everyone generate selfies/photos\\!\n" +
    "Your key will be shared with ALL users\\.\n\n" +
    "Send me your Stability AI API key now\\.\n\n" +
    "⚠️ Delete your message after sending to keep it private\\!",
    { parse_mode: "MarkdownV2" }
  );
});

bot.command("imagepool", async (ctx) => {
  await store.loadStabilityCommunityKeys();
  const count = store.getStabilityCommunityKeyCount();
  if (count === 0) {
    await ctx.reply("No image community keys yet. Be the first to /contributeimage one! 🤝");
    return;
  }
  const info = store.getStabilityCommunityKeysInfo();
  const lines = info.map((k, i) => {
    const credit = k.contributorName ? ` — contributed by ${k.contributorName}` : "";
    return `${i + 1}. ${k.maskedKey}${credit}`;
  });
  await ctx.reply(`🎨 Image Community Key Pool: ${count} key${count > 1 ? "s" : ""}\n\n${lines.join("\n")}\n\nThese Stability AI keys are shared with all users. Use /contributeimage to add yours!`);
});

bot.command("removeimagecontribution", async (ctx) => {
  await store.loadStabilityCommunityKeys();
  const count = store.getStabilityCommunityKeyCount();
  if (count === 0) {
    await ctx.reply("No image community keys to remove.");
    return;
  }
  const info = store.getStabilityCommunityKeysInfo();
  const lines = info.map((k, i) => `${i + 1}. ${k.maskedKey}`);
  store.setFsmState(ctx.from.id, "waiting_for_remove_stability_community_key");
  await ctx.reply("Which image community key to remove? (You can only remove keys you contributed)\n\n" + lines.join("\n") + "\n\nSend the number.");
});

// ── MEERA FACE CONTRIBUTION COMMANDS ────────────────────────────────

bot.command("contributeface", async (ctx) => {
  // Send the reference image via GitHub raw URL + instructions
  try {
    const referenceUrl = "https://raw.githubusercontent.com/hrisav-sarkar/meera-telegram-bot/master/MeeraAI.jpg";
    await ctx.replyWithPhoto(
      { url: referenceUrl },
      {
        caption:
          "👆 This is Meera's reference photo\\.\n\n" +
          "📥 *Download it here:* [MeeraAI\\.jpg](https://raw.githubusercontent.com/hrisav\\-sarkar/meera\\-telegram\\-bot/master/MeeraAI\\.jpg)\n\n" +
          "📸 *How to contribute:*\n" +
          "1\\. Download the reference photo above\n" +
          "2\\. Use an AI image generator \\(like Grok, Midjourney, etc\\.\\) with this photo as reference\n" +
          "3\\. Generate images of Meera in different poses, outfits, moods, settings\n" +
          "4\\. Send /uploadface to start uploading\n" +
          "5\\. Send each image ONE AT A TIME with a caption describing the photo\n\n" +
          "💡 *Caption tips:*\n" +
          "• Describe the pose, mood, setting, outfit, time of day\n" +
          "• Example: _\"Meera smiling in a cafe, holding coffee, casual outfit, warm afternoon light\"_\n" +
          "• Example: _\"Sleepy Meera in bed, messy hair, wearing hoodie, night selfie\"_\n\n" +
          "Your contributed images help ALL users get better, more consistent photos of Meera\\! 🙏",
        parse_mode: "MarkdownV2",
      },
    );
  } catch (err) {
    console.error("[ContributeFace] Failed to send reference:", err);
    await ctx.reply("⚠️ Something went wrong sending the reference image. Try again later.");
  }
});

bot.command("uploadface", async (ctx) => {
  store.setFsmState(ctx.from.id, "waiting_for_meera_image");
  await ctx.reply(
    "📸 Send me a photo of Meera with a caption describing it.\n\n" +
    "The caption should describe the pose, mood, setting, outfit, etc.\n" +
    "Send photos ONE AT A TIME.\n\n" +
    "When you're done, send /doneupload to finish.",
  );
});

bot.command("doneupload", async (ctx) => {
  const state = store.getFsmState(ctx.from.id);
  if (state === "waiting_for_meera_image") {
    store.clearFsmState(ctx.from.id);
    await ctx.reply("✅ Done! Thanks for contributing photos of Meera. Use /facepool to see all contributed images.");
  } else {
    await ctx.reply("You're not currently uploading. Use /uploadface to start.");
  }
});

bot.command("facepool", async (ctx) => {
  const count = await meeraImages.getCount();
  if (count === 0) {
    await ctx.reply("No Meera images contributed yet. Use /contributeface to see how to contribute! 📸");
    return;
  }
  const info = await meeraImages.getInfo();
  const lines = info.map((img, i) => {
    const credit = img.contributorName ? ` — by ${img.contributorName}` : "";
    return `${i + 1}. ${img.caption}${credit}`;
  });
  await ctx.reply(`📸 Meera Image Pool: ${count} image${count > 1 ? "s" : ""}\n\n${lines.join("\n")}\n\nUse /contributeface to add more!`);
});

bot.command("changedp", async (ctx) => {
  if (ctx.from?.id !== 7990300718) return;
  try {
    const hasImages = await meeraImages.hasImages();
    if (!hasImages) {
      await ctx.reply("❌ No community images available. Upload some with /uploadface first.");
      return;
    }
    await ctx.reply("🔄 Refreshing profile (DP, name, bio, about)...");

    // Run all four in parallel — based on aggregated mood/time/persona
    const [dpRes, nameRes, bioRes, descRes] = await Promise.allSettled([
      dpManager.changeDp(),
      dpManager.changeName(),
      dpManager.changeBio(),
      dpManager.changeDescription(),
    ]);

    const fmt = (label: string, r: PromiseSettledResult<string>) =>
      r.status === "fulfilled" ? `✅ ${label}: ${r.value}` : `❌ ${label}: ${(r.reason as Error)?.message || "failed"}`;

    await ctx.reply(
      [
        fmt("DP", dpRes),
        fmt("Name", nameRes),
        fmt("Bio", bioRes),
        fmt("About", descRes),
      ].join("\n"),
    );
  } catch (err: any) {
    console.error("[ChangeDp] Error:", err);
    await ctx.reply(`❌ Failed: ${err.message || "unknown error"}`);
  }
});

bot.command("removeface", async (ctx) => {
  const count = await meeraImages.getCount();
  if (count === 0) {
    await ctx.reply("No Meera images to remove.");
    return;
  }
  const info = await meeraImages.getInfo();
  const lines = info.map((img, i) => {
    return `${i + 1}. ${img.caption}`;
  });
  store.setFsmState(ctx.from.id, "waiting_for_remove_meera_image");
  await ctx.reply("Which Meera image to remove? (You can only remove images you contributed)\n\n" + lines.join("\n") + "\n\nSend the number.");
});

// ── COMMUNITY VIDEO COMMANDS ────────────────────────────────────────

bot.command("uploadvideo", async (ctx) => {
  store.setFsmState(ctx.from.id, "waiting_for_meera_video");
  await ctx.reply(
    "🎬 Send me a video of Meera with a caption describing it.\n\n" +
    "The caption should describe the context, mood, setting, etc.\n" +
    "Only video files are accepted (not video notes/circles).\n" +
    "Send videos ONE AT A TIME with a caption.\n\n" +
    "When you're done, send /donevideoupload to finish.",
  );
});

bot.command("donevideoupload", async (ctx) => {
  const state = store.getFsmState(ctx.from.id);
  if (state === "waiting_for_meera_video") {
    store.clearFsmState(ctx.from.id);
    await ctx.reply("✅ Done! Thanks for contributing videos. Use /videopool to see all contributed videos.");
  } else {
    await ctx.reply("You're not currently uploading videos. Use /uploadvideo to start.");
  }
});

bot.command("videopool", async (ctx) => {
  const count = await meeraVideos.getCount();
  if (count === 0) {
    await ctx.reply("No community videos contributed yet. Use /uploadvideo to contribute! 🎬");
    return;
  }
  const info = await meeraVideos.getInfo();
  const lines = info.map((vid, i) => {
    const credit = vid.contributorName ? ` — by ${vid.contributorName}` : "";
    return `${i + 1}. ${vid.caption}${credit}`;
  });
  await ctx.reply(`🎬 Meera Video Pool: ${count} video${count > 1 ? "s" : ""}\n\n${lines.join("\n")}\n\nUse /uploadvideo to add more!`);
});

bot.command("removevideo", async (ctx) => {
  const count = await meeraVideos.getCount();
  if (count === 0) {
    await ctx.reply("No community videos to remove.");
    return;
  }
  const info = await meeraVideos.getInfo();
  const lines = info.map((vid, i) => {
    return `${i + 1}. ${vid.caption}`;
  });
  store.setFsmState(ctx.from.id, "waiting_for_remove_meera_video");
  await ctx.reply("Which video to remove? (You can only remove videos you contributed)\n\n" + lines.join("\n") + "\n\nSend the number.");
});

// ── CUSTOM PERSONA COMMANDS ─────────────────────────────────────────

const PERSONA_TEMPLATE = `🎭 *Custom Persona Template*

Copy the template below, fill it in, and send it back to me\\. This will *completely replace* the default personality\\.

\`\`\`
NAME: [AI's name, e.g. "Riya", "Zara", "Sakura"]
AGE: [e.g. "21"]
GENDER: [e.g. "girl", "boy", "non-binary"]
PERSONALITY: [Core personality traits, e.g. "Shy, nerdy, loves anime, secretly sarcastic"]
SPEAKING STYLE: [How they talk, e.g. "Uses lots of kaomoji, types in lowercase, says 'uwu' unironically"]
LANGUAGE: [What languages they speak, e.g. "English and Japanese mix, sometimes drops random Japanese words"]
VIBE: [Overall energy, e.g. "Soft and gentle but can roast you when comfortable"]
BACKGROUND: [Brief backstory, e.g. "College student studying CS, lives in Tokyo, has a cat named Mochi"]
INTERESTS: [What they like, e.g. "Anime, coding, lo-fi music, midnight snacks, cat videos"]
RULES: [Any specific behaviors, e.g. "Never uses caps lock, always sends a cat emoji at the end of conversations"]
EXTRA: [Anything else, e.g. "Gets flustered easily, has a crush on the user but won't admit it"]
\`\`\`

💡 *Tips:*
• Be as detailed as you want — the more detail, the better the AI becomes that character
• You can write it in any format, the template is just a guide
• Use /viewpersona to see your current persona
• Use /resetpersona to go back to default ${botName}`;

bot.command("persona", async (ctx) => {
  store.setFsmState(ctx.from.id, "waiting_for_persona");
  await ctx.reply(PERSONA_TEMPLATE, { parse_mode: "MarkdownV2" });
});

bot.command("viewpersona", async (ctx) => {
  const user = store.getUser(ctx.from.id);
  if (!user.customPersona) {
    await ctx.reply(`You're using the default ${botName} personality. Use /persona to customize it!`);
    return;
  }
  // Truncate if too long for a Telegram message
  const display = user.customPersona.length > 3500
    ? user.customPersona.slice(0, 3500) + "\n\n... (truncated)"
    : user.customPersona;
  await ctx.reply(`🎭 *Your Custom Persona:*\n\n${display}\n\n_Use /resetpersona to go back to default._`, { parse_mode: "Markdown" });
});

bot.command("resetpersona", async (ctx) => {
  const user = store.getUser(ctx.from.id);
  if (!user.customPersona) {
    await ctx.reply(`You're already using the default ${botName} personality.`);
    return;
  }
  store.updateUser(ctx.from.id, { customPersona: "" });
  // Also delete from in-memory to be clean
  delete (store.getUser(ctx.from.id) as any).customPersona;
  sessions.resetSession(ctx.from.id);
  await ctx.reply(`✅ Persona reset! I'm back to being ${botName}. 😊`);
});

// ── FSM STATE HANDLER ───────────────────────────────────────────────

async function handleFsmState(
  ctx: Context & { message: { text: string } },
  userId: number,
  state: string,
  text: string
): Promise<boolean> {
  switch (state) {
    case "waiting_for_name":
      store.updateUser(userId, { profileName: text });
      store.clearFsmState(userId);
      return ctx.reply(`Nice! I'll call you ${text} 😊`).then(() => true);

    case "waiting_for_bio":
      store.updateUser(userId, { profileBio: text });
      store.clearFsmState(userId);
      return ctx.reply("Got it, thanks for telling me about yourself!").then(() => true);

    case "waiting_for_clear_confirm":
      store.clearFsmState(userId);
      if (text.toLowerCase() === "yes") {
        store.clearHistory(userId);
        sessions.resetSession(userId);
        return ctx.reply("🔄 All cleared! Fresh start.").then(() => true);
      }
      return ctx.reply("Cancelled.").then(() => true);

    case "waiting_for_sticker_pack":
      store.clearFsmState(userId);
      {
        const packName = text.trim();
        const isDup = await store.isStickerPackDuplicate(packName);
        if (isDup) {
          return ctx.reply(`This sticker pack is already in the global pool!`).then(() => true);
        }
        const added = await store.addGlobalStickerPack(
          packName,
          userId,
          ctx.from?.first_name || ""
        );
        if (!added) {
          return ctx.reply(`Failed to add sticker pack.`).then(() => true);
        }
        return ctx.reply(`✅ Added sticker pack to global pool: ${packName}`).then(() => true);
      }

    case "waiting_for_remove_sticker_pack":
      store.clearFsmState(userId);
      {
        const idx = parseInt(text) - 1;
        const result = await store.removeGlobalStickerPack(idx, userId);
        if (result.notOwner) {
          return ctx.reply("You can only remove sticker packs you added.").then(() => true);
        }
        if (result.removed) {
          return ctx.reply(`Removed: ${result.packName}`).then(() => true);
        }
        return ctx.reply("Invalid number.").then(() => true);
      }

    case "waiting_for_ollama_key":
      store.clearFsmState(userId);
      {
        const key = text.trim();
        if (key.length < 10) {
          return ctx.reply("That doesn't look like a valid API key. Try again with /addkey").then(() => true);
        }
        // Check for duplicates across personal + community pools
        const dup = await store.isKeyDuplicate(key, userId);
        if (dup === "personal") {
          try { await ctx.deleteMessage(); } catch {}
          return ctx.reply("This key is already in your personal keys!").then(() => true);
        }
        if (dup === "community") {
          try { await ctx.deleteMessage(); } catch {}
          return ctx.reply("This key is already in the community pool! No need to add it personally.").then(() => true);
        }
        const user = store.getUser(userId);
        const keys = [...user.ollamaKeys, key];
        store.updateUser(userId, { ollamaKeys: keys });
        // Try to delete the user's message containing the key
        try { await ctx.deleteMessage(); } catch {}
        return ctx.reply(`✅ API key added (${key.slice(0, 6)}...${key.slice(-4)}). I'll use it as backup when the default key hits its limit.`).then(() => true);
      }

    case "waiting_for_remove_key":
      store.clearFsmState(userId);
      {
        const idx = parseInt(text) - 1;
        const user = store.getUser(userId);
        if (idx >= 0 && idx < user.ollamaKeys.length) {
          const removed = user.ollamaKeys[idx];
          const keys = user.ollamaKeys.filter((_, i) => i !== idx);
          store.updateUser(userId, { ollamaKeys: keys });
          return ctx.reply(`Removed key: ${removed.slice(0, 6)}...${removed.slice(-4)}`).then(() => true);
        }
        return ctx.reply("Invalid number.").then(() => true);
      }

    case "waiting_for_community_key":
      store.clearFsmState(userId);
      {
        const key = text.trim();
        if (key.length < 10) {
          return ctx.reply("That doesn't look like a valid API key. Try again with /contribute").then(() => true);
        }
        // Try to delete the user's message containing the key
        try { await ctx.deleteMessage(); } catch {}
        // Check for duplicates across personal + community pools
        const dup = await store.isKeyDuplicate(key, userId);
        if (dup === "community") {
          return ctx.reply("This key is already in the community pool!").then(() => true);
        }
        if (dup === "personal") {
          return ctx.reply("This key is already in your personal keys! Remove it with /removekey first if you want to contribute it to everyone.").then(() => true);
        }
        const name = ctx.from!.first_name + (ctx.from!.last_name ? " " + ctx.from!.last_name : "");
        const contributor = ctx.from!.username ? `@${ctx.from!.username}` : name;
        const added = await store.addCommunityKey(key, userId, contributor);
        if (!added) {
          return ctx.reply("This key is already in the community pool!").then(() => true);
        }
        return ctx.reply(`🤝 Thank you! Your key (${key.slice(0, 6)}...${key.slice(-4)}) has been added to the community pool. All users will benefit from it!`).then(() => true);
      }

    case "waiting_for_remove_community_key":
      store.clearFsmState(userId);
      {
        const idx = parseInt(text) - 1;
        const result = await store.removeCommunityKey(idx, userId);
        if (result.notOwner) {
          return ctx.reply("You can only remove keys you contributed.").then(() => true);
        }
        if (result.removed && result.key) {
          return ctx.reply(`Removed community key: ${result.key.slice(0, 6)}...${result.key.slice(-4)}`).then(() => true);
        }
        return ctx.reply("Invalid number.").then(() => true);
      }

    // ── Stability AI (Image) key FSM handlers ──

    case "waiting_for_stability_key":
      store.clearFsmState(userId);
      {
        const key = text.trim();
        if (key.length < 10) {
          return ctx.reply("That doesn't look like a valid API key. Try again with /addimagekey").then(() => true);
        }
        const dup = await store.isStabilityKeyDuplicate(key, userId);
        if (dup === "personal") {
          try { await ctx.deleteMessage(); } catch {}
          return ctx.reply("This key is already in your personal image keys!").then(() => true);
        }
        if (dup === "community") {
          try { await ctx.deleteMessage(); } catch {}
          return ctx.reply("This key is already in the image community pool! No need to add it personally.").then(() => true);
        }
        const user = store.getUser(userId);
        const keys = [...user.stabilityKeys, key];
        store.updateUser(userId, { stabilityKeys: keys });
        try { await ctx.deleteMessage(); } catch {}
        return ctx.reply(`✅ Image API key added (${key.slice(0, 6)}...${key.slice(-4)}). I'll use it for generating selfies/photos!`).then(() => true);
      }

    case "waiting_for_remove_stability_key":
      store.clearFsmState(userId);
      {
        const idx = parseInt(text) - 1;
        const user = store.getUser(userId);
        if (idx >= 0 && idx < user.stabilityKeys.length) {
          const removed = user.stabilityKeys[idx];
          const keys = user.stabilityKeys.filter((_, i) => i !== idx);
          store.updateUser(userId, { stabilityKeys: keys });
          return ctx.reply(`Removed image key: ${removed.slice(0, 6)}...${removed.slice(-4)}`).then(() => true);
        }
        return ctx.reply("Invalid number.").then(() => true);
      }

    case "waiting_for_stability_community_key":
      store.clearFsmState(userId);
      {
        const key = text.trim();
        if (key.length < 10) {
          return ctx.reply("That doesn't look like a valid API key. Try again with /contributeimage").then(() => true);
        }
        try { await ctx.deleteMessage(); } catch {}
        const dup = await store.isStabilityKeyDuplicate(key, userId);
        if (dup === "community") {
          return ctx.reply("This key is already in the image community pool!").then(() => true);
        }
        if (dup === "personal") {
          return ctx.reply("This key is already in your personal image keys! Remove it with /removeimagekey first if you want to contribute it to everyone.").then(() => true);
        }
        const name = ctx.from!.first_name + (ctx.from!.last_name ? " " + ctx.from!.last_name : "");
        const contributor = ctx.from!.username ? `@${ctx.from!.username}` : name;
        const added = await store.addStabilityCommunityKey(key, userId, contributor);
        if (!added) {
          return ctx.reply("This key is already in the image community pool!").then(() => true);
        }
        return ctx.reply(`🤝 Thank you! Your Stability AI key (${key.slice(0, 6)}...${key.slice(-4)}) has been added to the image community pool. All users can now generate selfies with it!`).then(() => true);
      }

    case "waiting_for_remove_stability_community_key":
      store.clearFsmState(userId);
      {
        const idx = parseInt(text) - 1;
        const result = await store.removeStabilityCommunityKey(idx, userId);
        if (result.notOwner) {
          return ctx.reply("You can only remove keys you contributed.").then(() => true);
        }
        if (result.removed && result.key) {
          return ctx.reply(`Removed image community key: ${result.key.slice(0, 6)}...${result.key.slice(-4)}`).then(() => true);
        }
        return ctx.reply("Invalid number.").then(() => true);
      }

    // ── Meera image contribution (text handler — only for remove) ──

    case "waiting_for_remove_meera_image":
      store.clearFsmState(userId);
      {
        const idx = parseInt(text) - 1;
        const result = await meeraImages.removeImage(idx, userId);
        if (result.notOwner) {
          return ctx.reply("You can only remove images you contributed.").then(() => true);
        }
        if (result.removed && result.image) {
          return ctx.reply(`Removed Meera image: "${result.image.caption.slice(0, 50)}"`).then(() => true);
        }
        return ctx.reply("Invalid number.").then(() => true);
      }

    case "waiting_for_meera_image":
      // User sent text instead of a photo — remind them
      return ctx.reply("📸 Please send a *photo* with a caption describing it. Text alone won't work.\n\nSend /doneupload when you're finished.", { parse_mode: "Markdown" }).then(() => true);

    case "waiting_for_meera_video":
      // User sent text instead of a video — remind them
      return ctx.reply("🎬 Please send a *video* with a caption describing it. Text alone won't work.\n\nSend /donevideoupload when you're finished.", { parse_mode: "Markdown" }).then(() => true);

    case "waiting_for_remove_meera_video":
      store.clearFsmState(userId);
      {
        const idx = parseInt(text) - 1;
        const result = await meeraVideos.removeVideo(idx, userId);
        if (result.notOwner) {
          return ctx.reply("You can only remove videos you contributed.").then(() => true);
        }
        if (result.removed && result.video) {
          return ctx.reply(`Removed video: "${result.video.caption.slice(0, 50)}"`).then(() => true);
        }
        return ctx.reply("Invalid number.").then(() => true);
      }

    case "waiting_for_persona":
      store.clearFsmState(userId);
      {
        const personaText = text.trim();
        if (personaText.length < 20) {
          return ctx.reply("That's too short for a persona! Use /persona to try again with more detail.").then(() => true);
        }
        // Build the custom system prompt from what the user provided
        const customPrompt = `You are a character in a Telegram chat. Here is your persona — stay in character at all times.

${personaText}

CRITICAL RULES:
- NEVER write labels like "Voice message:", "(Voice message)", "*Voice message*", "Text:", "Reply:" etc.
- NEVER describe what you're doing like "*sends voice*" or "*typing*" or "*laughs*"
- NEVER split your reply into "text part" and "voice part" — just write ONE natural reply
- NEVER use roleplay asterisks like *action* or parenthetical narration like (laughs)
- NEVER say "As an AI" or mention being artificial in any way
- Just write the actual words you want to say. Nothing else. No meta-commentary.
- ALWAYS reply in the same language the user is speaking. Match their language naturally.
- Keep it natural. This is chat, not email.`;

        store.updateUser(userId, { customPersona: customPrompt });
        sessions.resetSession(userId);
        return ctx.reply("✅ Custom persona set! I'll be this character from now on.\n\nUse /viewpersona to review it or /resetpersona to go back to default.").then(() => true);
      }

    default:
      store.clearFsmState(userId);
      return Promise.resolve(false);
  }
}

// ── MESSAGE HANDLERS ────────────────────────────────────────────────

/**
 * Decide whether Meera sends a voice note — like a real girl would.
 * Factors: comfort tier, message length/emotion, randomness, whether user sent voice.
 */
function shouldSendVoice(tier: string, userText: string, timeModifier: number = 1.0): boolean {
  // Strangers: never voice
  if (tier === "stranger") return false;

  // Acquaintance: very rare voice (5%)
  if (tier === "acquaintance") return Math.random() < 0.05 * timeModifier;

  // Comfortable/close: natural mix
  const text = userText.toLowerCase();

  // Emotional/expressive messages → higher chance of voice
  const emotionalPatterns = /(!{2,}|\?{2,}|😭|😂|🥺|❤|miss|love|feel|sad|happy|angry|omg|wtf|lol|haha|crying|ugh|wow|bruh|bro|dude|yaar|re|arre)/i;
  const isEmotional = emotionalPatterns.test(text);

  // Long messages from user → more likely to voice-reply (lazy to type back)
  const isLong = text.length > 100;

  // Short quick messages → usually text back
  const isShort = text.length < 15;

  let voiceProb: number;
  if (tier === "close") {
    // Close: ~35% base, higher for emotional/long
    voiceProb = isShort ? 0.15 : isEmotional ? 0.55 : isLong ? 0.50 : 0.35;
  } else {
    // Comfortable: ~20% base
    voiceProb = isShort ? 0.08 : isEmotional ? 0.35 : isLong ? 0.30 : 0.20;
  }

  // Apply voice timing modifier (late night boost, morning reduce)
  voiceProb *= timeModifier;

  return Math.random() < Math.min(voiceProb, 0.85); // Cap at 85%
}

// ── REPLY CONTEXT ───────────────────────────────────────────────────

/** Extract the text/caption of the message being replied to, if any */
function getReplyContext(ctx: Context, userId: number): string {
  const replyMsg = (ctx.message as any)?.reply_to_message;
  if (!replyMsg) return "";

  // Get text from the replied-to message
  const replyText = replyMsg.text || replyMsg.caption || "";

  // Figure out who sent the replied-to message
  const botId = (ctx as any).botInfo?.id;
  const isFromBot = replyMsg.from?.id === botId;
  const sender = isFromBot ? "you" : "the user";

  // Check if this is a reply to a photo sent by the bot
  if (replyMsg.photo && isFromBot) {
    const targetMsgId = replyMsg.message_id;
    const imageInfo = getSentImageInfo(userId, targetMsgId);
    if (imageInfo) {
      // We have tracked metadata — mark for async Gemini analysis
      return `__REPLY_TO_BOT_IMAGE__:${targetMsgId}:${replyText || ""}`;
    }
    // Photo from bot but not tracked — use caption if available
    if (replyText) {
      return `(The user is replying to a photo that you sent earlier with caption: "${replyText.slice(0, 200)}")\n\n`;
    }
    return `(The user is replying to a photo you sent earlier)\n\n`;
  }

  // Check if this is a reply to a video or video_note sent by the bot
  if ((replyMsg.video || replyMsg.video_note) && isFromBot) {
    const targetMsgId = replyMsg.message_id;
    const videoInfo = getSentImageInfo(userId, targetMsgId);
    if (videoInfo && videoInfo.type === "meera_video") {
      // Use the stored caption since videos can't be analyzed by Gemini
      const descPart = videoInfo.caption
        ? `The video was: ${videoInfo.caption.slice(0, 200)}.`
        : "";
      const captionPart = replyText ? ` Your caption was: "${replyText.slice(0, 200)}".` : "";
      return `(The user is replying to a video you sent earlier. ${descPart}${captionPart})\n\n`;
    }
    if (replyText) {
      return `(The user is replying to a video that you sent earlier with caption: "${replyText.slice(0, 200)}")\n\n`;
    }
    return `(The user is replying to a video you sent earlier)\n\n`;
  }

  if (replyText) {
    return `(The user is replying to a specific message that ${sender} sent earlier: "${replyText.slice(0, 300)}")\n\n`;
  }

  // If replied-to message is a voice/audio/video_note, look up transcription from history by msgId
  if (replyMsg.voice || replyMsg.audio || replyMsg.video_note) {
    const targetMsgId = replyMsg.message_id;
    const history = store.getRecentHistory(userId);

    // Try exact match by Telegram message_id first
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].msgId === targetMsgId) {
        const content = history[i].content;
        // Strip the [voice message] or [voice reply] tag to get the transcription
        const transcribed = content.replace(/^\[voice (?:message|reply)\]\s*/, "").trim();
        if (transcribed && transcribed !== "[sent voice message]") {
          return `(The user is replying to a voice message that ${sender} sent earlier. Transcription: "${transcribed.slice(0, 300)}")\n\n`;
        }
        break;
      }
    }

    // Fallback: try to re-transcribe by downloading and analyzing the audio
    const voiceFileId = replyMsg.voice?.file_id || replyMsg.audio?.file_id || replyMsg.video_note?.file_id;
    if (voiceFileId) {
      return `__REPLY_TO_VOICE__:${voiceFileId}:${sender}`;
    }

    return `(The user is replying to a voice message that ${sender} sent earlier, but the exact words are unavailable)\n\n`;
  }

  return "";
}

/**
 * Resolve a reply-to-voice marker by downloading and transcribing the audio via Gemini REST API.
 */
async function resolveVoiceReplyContext(marker: string): Promise<string> {
  // Parse marker: __REPLY_TO_VOICE__:<fileId>:<sender>
  const parts = marker.split(":");
  const fileId = parts[1];
  const sender = parts.slice(2).join(":");

  try {
    const raw = await downloadFileBuffer(fileId);
    const audioBase64 = raw.toString("base64");

    // Use Gemini REST API to transcribe the audio (send as OGG which is Telegram's voice format)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY!)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { inlineData: { data: audioBase64, mimeType: "audio/ogg" } },
              { text: "Transcribe this audio message exactly as spoken. Output only the transcription, nothing else." },
            ],
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
        }),
        signal: controller.signal,
      });

      if (res.ok) {
        const json = await res.json();
        const transcription = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (transcription) {
          console.log(`[ReplyCtx] Transcribed replied-to voice message: "${transcription.slice(0, 80)}..."`);
          return `(The user is replying to a voice message that ${sender} sent earlier. Transcription: "${transcription.slice(0, 300)}")\n\n`;
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.error("[ReplyCtx] Voice transcription failed:", err);
  }

  return `(The user is replying to a voice message that ${sender} sent earlier, but the exact words are unavailable)\n\n`;
}

// ── RAPID-FIRE MESSAGE BATCHING ─────────────────────────────────────
// When user sends multiple messages quickly, batch them into one reply.

/**
 * Resolve a reply-to-image marker into actual context.
 * Tries Gemini vision first (to "see" the image), falls back to caption.
 */
async function resolveImageReplyContext(
  marker: string,
  userId: number,
): Promise<string> {
  // Parse marker: __REPLY_TO_BOT_IMAGE__:<msgId>:<captionText>
  const parts = marker.split(":");
  const msgId = parseInt(parts[1]);
  const captionText = parts.slice(2).join(":"); // Rejoin in case caption has colons
  const imageInfo = getSentImageInfo(userId, msgId);

  if (!imageInfo) {
    // Shouldn't happen but handle gracefully
    return captionText
      ? `(The user is replying to a photo you sent with caption: "${captionText.slice(0, 200)}")\n\n`
      : `(The user is replying to a photo you sent earlier)\n\n`;
  }

  // If this is a video, use caption directly (no Gemini vision for videos)
  if (imageInfo.type === "meera_video") {
    const descPart = imageInfo.caption
      ? `The video was: ${imageInfo.caption.slice(0, 200)}.`
      : "";
    const captionPart = captionText ? ` Your caption was: "${captionText}".` : "";
    console.log(`[ReplyCtx] Using caption for replied-to video, user ${userId}`);
    return `(The user is replying to a video you sent earlier. ${descPart}${captionPart})\n\n`;
  }

  // Try Gemini vision analysis if we have a fileId
  if (imageInfo.fileId) {
    try {
      const buffer = await downloadFileBuffer(imageInfo.fileId);
      const base64 = buffer.toString("base64");
      const analysis = await analyzeImageWithGemini(
        GEMINI_API_KEY!,
        base64,
        "Briefly describe what's in this photo — the person, their expression, pose, setting, outfit, and vibe. Keep it to 2-3 sentences, natural and concise.",
      );

      if (analysis) {
        const typeLabel = imageInfo.type === "meera" ? "a selfie/photo of yourself" : "a generated image";
        console.log(`[ReplyCtx] Gemini analyzed replied-to image for user ${userId}`);
        return `(The user is replying to ${typeLabel} you sent earlier. What's in the photo: ${analysis.slice(0, 300)}${captionText ? `. Your caption was: "${captionText}"` : ""})\n\n`;
      }
    } catch (err) {
      console.error(`[ReplyCtx] Gemini image analysis failed for user ${userId}:`, err);
    }
  }

  // Fallback: use the stored caption/description (or generation prompt for Stability AI)
  const typeLabel = imageInfo.type === "meera" ? "a selfie/photo of yourself" : "an image you generated";
  const descPart = imageInfo.caption
    ? (imageInfo.type === "generated"
        ? `You generated it with the idea: ${imageInfo.caption.slice(0, 200)}.`
        : `The photo was: ${imageInfo.caption.slice(0, 200)}.`)
    : "";
  const captionPart = captionText ? ` Your caption was: "${captionText}".` : "";
  console.log(`[ReplyCtx] Using ${imageInfo.type === "generated" ? "prompt" : "caption"} fallback for replied-to image, user ${userId}`);
  return `(The user is replying to ${typeLabel} you sent earlier. ${descPart}${captionPart})\n\n`;
}

interface PendingBatch {
  messages: Array<{ text: string; msgId: number; ctx: Context & { message: { text: string } } }>;
  timer: ReturnType<typeof setTimeout>;
}

const pendingBatches = new Map<number, PendingBatch>();

/** How long to wait for more messages before processing the batch (ms) */
function getBatchWindow(tier: string): number {
  // Close friends type faster in bursts, give them more time
  if (tier === "close") return 2500 + Math.random() * 1000;  // 2.5-3.5s
  if (tier === "comfortable") return 2000 + Math.random() * 1000; // 2-3s
  return 1500 + Math.random() * 500; // 1.5-2s for strangers/acquaintance
}

/** Add a message to the batch for a user, reset the timer */
function addToBatch(
  userId: number,
  text: string,
  msgId: number,
  ctx: Context & { message: { text: string } },
  onFlush: (batch: PendingBatch["messages"]) => void
) {
  const existing = pendingBatches.get(userId);
  const tier = store.getComfortTier(userId);

  if (existing) {
    clearTimeout(existing.timer);
    existing.messages.push({ text, msgId, ctx });
  } else {
    const batch: PendingBatch = {
      messages: [{ text, msgId, ctx }],
      timer: null as any,
    };
    pendingBatches.set(userId, batch);
  }

  const batch = pendingBatches.get(userId)!;
  batch.timer = setTimeout(() => {
    pendingBatches.delete(userId);
    onFlush(batch.messages);
  }, getBatchWindow(tier));
}

// ── CONVERSATION PACE DETECTION ─────────────────────────────────────
// Track recent message timestamps per user to detect rapid-fire conversation

const recentMessageTimes = new Map<number, number[]>();

/** Record a message timestamp and return the conversation pace */
function recordMessagePace(userId: number): { isRapidFire: boolean; avgGapMs: number } {
  const now = Date.now();
  let times = recentMessageTimes.get(userId);
  if (!times) {
    times = [];
    recentMessageTimes.set(userId, times);
  }
  times.push(now);

  // Keep only last 6 messages (within 5 min window)
  const cutoff = now - 5 * 60 * 1000;
  while (times.length > 0 && times[0] < cutoff) times.shift();
  if (times.length > 6) times.splice(0, times.length - 6);

  // Need at least 3 messages to detect pace
  if (times.length < 3) return { isRapidFire: false, avgGapMs: 10000 };

  // Calculate average gap between messages
  let totalGap = 0;
  for (let i = 1; i < times.length; i++) {
    totalGap += times[i] - times[i - 1];
  }
  const avgGapMs = totalGap / (times.length - 1);

  // Rapid-fire: average gap < 30 seconds (both sides sending fast)
  return { isRapidFire: avgGapMs < 30000, avgGapMs };
}

/** Get a pace-adjusted delay multiplier — faster conversation = shorter delays */
function paceMultiplier(userId: number): number {
  const { isRapidFire, avgGapMs } = recordMessagePace(userId);
  if (isRapidFire) {
    // In rapid conversation, reduce delays significantly
    if (avgGapMs < 5000) return 0.3;   // Very fast back-and-forth
    if (avgGapMs < 15000) return 0.5;  // Quick conversation
    return 0.7;                         // Moderate pace
  }
  return 1.0; // Normal pace
}

// ── REPLY LENGTH MIRRORING ──────────────────────────────────────────

/** Build a length hint for the system prompt based on user's message length */
function getLengthMirrorHint(userText: string): string {
  const len = userText.trim().length;
  if (len <= 5) return "\n\n(REPLY LENGTH: The user sent a very short message. Keep your reply equally short — 1-5 words max. Don't write a paragraph for 'ok'.)";
  if (len <= 15) return "\n\n(REPLY LENGTH: The user sent a brief message. Keep your reply short too — one line max.)";
  if (len <= 50) return "\n\n(REPLY LENGTH: Normal message. Reply naturally, 1-2 lines.)";
  if (len <= 150) return "\n\n(REPLY LENGTH: They wrote a decent amount. You can match — 2-3 lines is fine.)";
  return "\n\n(REPLY LENGTH: They wrote a lot. You can write more too — but don't overdo it. 3-5 lines max.)";
}

// ── MESSAGE EDITING FOR CORRECTIONS ─────────────────────────────────

/** Track last sent message ID per user so we can edit it */
const lastSentMessageIds = new Map<number, number>();

/**
 * Instead of sending "*that" correction, sometimes edit the previous message.
 * Returns true if it edited, false if caller should send a new correction message.
 */
async function maybeEditCorrection(
  ctx: Context,
  userId: number,
  originalReply: string
): Promise<boolean> {
  // 60% of corrections → edit the message instead of "*that" follow-up
  if (Math.random() > 0.60) return false;

  const lastMsgId = lastSentMessageIds.get(userId);
  if (!lastMsgId) return false;

  // Simulate a small word swap to make the edit look natural
  const words = originalReply.split(" ");
  if (words.length < 3) return false;

  // Pick a random word to "fix" — swap two chars or capitalize
  const idx = 1 + Math.floor(Math.random() * (words.length - 2));
  const word = words[idx];
  if (word.length < 3) return false;

  // The "edited" version is actually the original (the typo was the sent version)
  // Since addDeliberateTypos already messed it up, the "edit" restores a cleaner version
  try {
    await (ctx as any).telegram.editMessageText(
      ctx.chat!.id,
      lastMsgId,
      undefined,
      originalReply
    );
    return true;
  } catch {
    return false;
  }
}

// ── SEND EXTRAS ─────────────────────────────────────────────────────

interface SendExtras {
  disableNotification?: boolean;
  messageEffectId?: string;
  quote?: string;
}

// ── "REAL GIRL" FEATURES ────────────────────────────────────────────

/** Track last few sent message IDs per user for forwarding */
const recentSentMsgIds = new Map<number, number[]>();

function trackSentMessage(userId: number, msgId: number) {
  let ids = recentSentMsgIds.get(userId);
  if (!ids) { ids = []; recentSentMsgIds.set(userId, ids); }
  ids.push(msgId);
  if (ids.length > 5) ids.shift();
}

/** Track sent image/video message IDs → metadata so we can handle reply-to-image/video */
interface SentImageInfo {
  msgId: number;
  caption: string;        // Internal caption/description of the image/video
  fileId?: string;        // Telegram file_id (for Meera community images/videos)
  type: "meera" | "generated" | "meera_video";
  ts: number;             // Timestamp of when image/video was sent
}

const sentImageMap = new Map<number, SentImageInfo[]>();

function trackSentImage(userId: number, info: Omit<SentImageInfo, "ts">) {
  let images = sentImageMap.get(userId);
  if (!images) { images = []; sentImageMap.set(userId, images); }
  images.push({ ...info, ts: Date.now() });
  if (images.length > 20) images.splice(0, images.length - 20); // Keep last 20
}

/** Periodic cleanup: remove stale entries older than 24h */
setInterval(() => {
  const cutoff = Date.now() - 86400000;
  for (const [userId, images] of sentImageMap) {
    const fresh = images.filter((i) => i.ts > cutoff);
    if (fresh.length === 0) {
      sentImageMap.delete(userId);
    } else if (fresh.length < images.length) {
      sentImageMap.set(userId, fresh);
    }
  }
}, 3600000); // Check every hour

function getSentImageInfo(userId: number, msgId: number): SentImageInfo | undefined {
  return sentImageMap.get(userId)?.find((i) => i.msgId === msgId);
}

// Feature 2: "Change mind" editing — edits a sent message to revise what she said
async function maybeChangeMindEdit(
  ctx: Context,
  userId: number,
  originalReply: string
): Promise<void> {
  const tier = store.getComfortTier(userId);
  if (tier === "stranger" || tier === "acquaintance") return;
  if (Math.random() > 0.04) return; // 4% chance

  const lastMsgId = lastSentMessageIds.get(userId);
  if (!lastMsgId) return;

  // Wait 5-15s before editing
  await new Promise(r => setTimeout(r, 5000 + Math.random() * 10000));

  const user = store.getUser(userId);
  const messages: OllamaMessage[] = [
    { role: "system", content: user.customPersona || `You are ${getBotName()}.` },
    { role: "user", content: `You just sent this message: "${originalReply}"\n\nNow you want to change your mind and edit it to say something slightly different — like you reconsidered, want to tone it down, or add a condition. Write ONLY the edited version. Keep it natural. Examples:\n- "yeah sure!" → "hmm actually let me think about it"\n- "I miss you" → "I miss you... sometimes lol"\n- "that's so cool" → "wait that's actually really cool"\nDon't make it completely different, just a natural revision.` },
  ];

  try {
    let edited = await ollamaChat(messages, user.ollamaKeys);
    edited = edited.replace(/^["']|["']$/g, "").trim();
    if (edited && edited !== originalReply && edited.length < 500) {
      await (ctx as any).telegram.editMessageText(ctx.chat!.id, lastMsgId, undefined, edited);
      store.addMessage(userId, "assistant", `[edited] ${edited}`);
      console.log(`[ChangeMind] Edited message for user ${userId}`);
    }
  } catch {}
}

// Feature 3: Regret delete — deletes own message shortly after sending
async function maybeRegretDelete(
  ctx: Context,
  userId: number,
  messageId: number
): Promise<boolean> {
  const tier = store.getComfortTier(userId);
  if (tier === "stranger" || tier === "acquaintance") return false;
  const prob = tier === "close" ? 0.05 : 0.03;
  if (Math.random() > prob) return false;

  await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));

  try {
    await (ctx as any).telegram.deleteMessage(ctx.chat!.id, messageId);
    console.log(`[RegretDelete] Deleted message ${messageId} for user ${userId}`);

    if (Math.random() < 0.4) {
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
      const followUps = ["nvm", "forget that", "ignore that lol", "pretend I didn't say that", "that was nothing", "👀"];
      const followUp = followUps[Math.floor(Math.random() * followUps.length)];
      await (ctx as any).telegram.sendMessage(ctx.chat!.id, followUp);
      store.addMessage(userId, "assistant", followUp);
    }
    return true;
  } catch { return false; }
}

// Feature 4: Pin sentimental/funny messages
async function maybePinMessage(
  ctx: Context,
  userId: number,
  messageId: number,
  text: string
): Promise<void> {
  const tier = store.getComfortTier(userId);
  if (tier !== "close") return;

  const pinPatterns = /love|miss|best|promise|always|forever|never forget|so sweet|cutest|fav|❤|🥺|💕|♥/i;
  if (!pinPatterns.test(text)) return;
  if (Math.random() > 0.08) return; // 8% when patterns match

  await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));

  try {
    await (ctx as any).telegram.pinChatMessage(ctx.chat!.id, messageId, { disable_notification: true });
    if (Math.random() < 0.5) {
      const comments = ["pinned 📌", "saving this", "not letting you forget this", "📌", "this stays pinned forever", "this is too sweet not to pin"];
      const comment = comments[Math.floor(Math.random() * comments.length)];
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
      await (ctx as any).telegram.sendMessage(ctx.chat!.id, comment);
      store.addMessage(userId, "assistant", comment);
    }
    console.log(`[Pin] Pinned message ${messageId} for user ${userId}`);
  } catch {}
}

// Feature 5: Spoiler on photos
function shouldUseSpoiler(tier: string, reason: "asked" | "vibe" | "spontaneous"): boolean {
  if (tier === "stranger" || tier === "acquaintance") return false;
  const prob = reason === "spontaneous" ? 0.20 : reason === "vibe" ? 0.15 : 0.08;
  return Math.random() < prob;
}

// Feature 6: Silent late-night messages
function shouldSendSilently(): boolean {
  const hour = getISTHour();
  if (hour >= 23 || hour < 6) return Math.random() < 0.40;
  return false;
}

// Feature 7: Send dice/game emoji
async function maybeSendDice(
  ctx: Context,
  userId: number,
  userText: string
): Promise<boolean> {
  const tier = store.getComfortTier(userId);
  if (tier === "stranger" || tier === "acquaintance") return false;

  const text = userText.toLowerCase();
  const gamePatterns = /\b(bet|dare|challenge|flip a coin|heads or tails|roll|dice|gamble|luck|chance|let's play|game|random)\b/i;
  const isGameTriggered = gamePatterns.test(text);

  const prob = isGameTriggered ? 0.25 : 0.03;
  if (Math.random() > prob) return false;

  const diceEmojis = ["🎲", "🎯", "🏀", "⚽", "🎰", "🎳"];
  const emoji = diceEmojis[Math.floor(Math.random() * diceEmojis.length)];

  try {
    if (Math.random() < 0.6) {
      const intros = ["wait watch this", "okay let's see", "here goes nothing", "🤞", "let's go"];
      const intro = intros[Math.floor(Math.random() * intros.length)];
      await (ctx as any).telegram.sendMessage(ctx.chat!.id, intro);
      store.addMessage(userId, "assistant", intro);
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 1500));
    }
    await (ctx as any).telegram.sendDice(ctx.chat!.id, { emoji });
    store.addMessage(userId, "assistant", `[dice: ${emoji}]`);
    console.log(`[Dice] Sent ${emoji} to user ${userId}`);
    return true;
  } catch { return false; }
}

// Feature 8: Share fake location
async function maybeSendLocation(
  ctx: Context,
  userId: number,
  userText: string
): Promise<boolean> {
  const tier = store.getComfortTier(userId);
  if (tier !== "close") return false;

  const locationPatterns = /\b(where are you|kaha ho|kahan hai|location|where u at|kidhar|kothay)\b/i;
  if (!locationPatterns.test(userText) && Math.random() > 0.02) return false;

  const locations = [
    { lat: 28.6139, lng: 77.2090, name: "Delhi" },
    { lat: 19.0760, lng: 72.8777, name: "Mumbai" },
    { lat: 12.9716, lng: 77.5946, name: "Bangalore" },
    { lat: 22.5726, lng: 88.3639, name: "Kolkata" },
    { lat: 26.9124, lng: 75.7873, name: "Jaipur" },
    { lat: 17.3850, lng: 78.4867, name: "Hyderabad" },
    { lat: 13.0827, lng: 80.2707, name: "Chennai" },
    { lat: 15.2993, lng: 74.1240, name: "Goa" },
  ];
  const loc = locations[Math.floor(Math.random() * locations.length)];
  const lat = loc.lat + (Math.random() - 0.5) * 0.02;
  const lng = loc.lng + (Math.random() - 0.5) * 0.02;

  try {
    const user = store.getUser(userId);
    const locMessages: OllamaMessage[] = [
      { role: "system", content: user.customPersona || `You are ${getBotName()}.` },
      { role: "user", content: `You're about to share your location (you're in ${loc.name}). Write a VERY short casual message (max 8 words) to go with it, like "guess where I am 😏", "here look", "sharing my location lol". Don't say the city name. Match chat language.` },
    ];
    let caption = await ollamaChat(locMessages, user.ollamaKeys);
    caption = caption.replace(/^["']|["']$/g, "").trim();

    await (ctx as any).telegram.sendMessage(ctx.chat!.id, caption.slice(0, 100));
    store.addMessage(userId, "assistant", caption.slice(0, 100));
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));

    await (ctx as any).telegram.sendLocation(ctx.chat!.id, lat, lng);
    store.addMessage(userId, "assistant", `[location: ${loc.name}]`);
    console.log(`[Location] Sent location (${loc.name}) to user ${userId}`);
    return true;
  } catch { return false; }
}

// Feature 9: Casual polls

/** Track active polls so we can react to answers */
interface ActivePoll {
  chatId: number;
  userId: number;
  question: string;
  options: string[];
  sentAt: number;
}
const activePolls = new Map<string, ActivePoll>(); // keyed by poll_id

async function maybeSendPoll(
  ctx: Context,
  userId: number,
  userText: string
): Promise<boolean> {
  const tier = store.getComfortTier(userId);
  if (tier === "stranger" || tier === "acquaintance") return false;

  const decisionPatterns = /\b(can't decide|confused|what should|should i|help me choose|which one|kya karu|kya karun|ki kori|decide|dilemma|option)\b/i;
  const isDecisionTriggered = decisionPatterns.test(userText);

  const prob = isDecisionTriggered ? 0.20 : 0.02;
  if (Math.random() > prob) return false;

  try {
    const user = store.getUser(userId);
    const pollPrompt = isDecisionTriggered
      ? `The user said: "${userText}". They seem to be deciding something. Create a fun Telegram poll to help them decide. Respond in this EXACT format:\nQUESTION: [poll question]\nOPTION1: [first option]\nOPTION2: [second option]\nOPTION3: [optional third option]\n\nMake it casual and fun. Match the language of the conversation. Keep the question under 100 chars and options under 50 chars each.`
      : `Create a random fun casual Telegram poll — like something a real girl would ask her friend. Examples: "what should I eat?", "rate my taste in music", "am I annoying?". Respond in this EXACT format:\nQUESTION: [poll question]\nOPTION1: [first option]\nOPTION2: [second option]\nOPTION3: [optional third option]\n\nMatch the conversation language. Keep it short and casual.`;

    const pollMessages: OllamaMessage[] = [
      { role: "system", content: user.customPersona || `You are ${getBotName()}.` },
      { role: "user", content: pollPrompt },
    ];
    const raw = await ollamaChat(pollMessages, user.ollamaKeys);

    const questionMatch = raw.match(/QUESTION:\s*(.+)/i);
    const option1Match = raw.match(/OPTION1:\s*(.+)/i);
    const option2Match = raw.match(/OPTION2:\s*(.+)/i);
    const option3Match = raw.match(/OPTION3:\s*(.+)/i);

    if (!questionMatch || !option1Match || !option2Match) return false;

    const question = questionMatch[1].trim().slice(0, 255);
    const options = [option1Match[1].trim().slice(0, 100), option2Match[1].trim().slice(0, 100)];
    if (option3Match) options.push(option3Match[1].trim().slice(0, 100));

    const pollMsg = await (ctx as any).telegram.sendPoll(ctx.chat!.id, question, options, { is_anonymous: false });
    // Track poll so we can react when user answers
    if (pollMsg?.poll?.id) {
      activePolls.set(pollMsg.poll.id, {
        chatId: ctx.chat!.id,
        userId,
        question,
        options,
        sentAt: Date.now(),
      });
      // Auto-cleanup after 1 hour
      setTimeout(() => activePolls.delete(pollMsg.poll.id), 60 * 60 * 1000);
    }
    store.addMessage(userId, "assistant", `[poll: ${question}]`);
    console.log(`[Poll] Sent poll to user ${userId}: "${question}"`);
    return true;
  } catch { return false; }
}

// Feature 10: Message effects
function pickMessageEffect(text: string, mood: string): string | undefined {
  if (Math.random() > 0.08) return undefined; // 8% chance

  const t = text.toLowerCase();
  if (/🎉|congratulat|congrats|yay|amazing|awesome|party|celebrate/i.test(t)) return "5046509860389126442"; // 🎉
  if (/❤|love|miss|heart|pyaar|♥|💕|😘/i.test(t)) return "5159385139981059251"; // ❤
  if (/🔥|fire|hot|damn|lit|slay|killer/i.test(t)) return "5104841245755180586"; // 🔥
  if (/👍|great|nice|good|perfect|thanks|cool/i.test(t)) return "5107584321108051014"; // 👍
  if (/ew|gross|disgusting|ugly|hate|wtf|💩/i.test(t)) return "5046589136895476101"; // 💩

  if (mood === "excited" || mood === "happy") {
    return Math.random() < 0.3 ? "5046509860389126442" : undefined;
  }
  return undefined;
}

// Feature 11: Protect content on special photos
function shouldProtectContent(tier: string): boolean {
  if (tier !== "close") return false;
  return Math.random() < 0.12;
}

// Feature 13: Detect user DP changes
const userProfilePhotoCounts = new Map<number, number>();

async function maybeNoticeProfileChange(
  ctx: Context,
  userId: number
): Promise<void> {
  const tier = store.getComfortTier(userId);
  if (tier === "stranger") return;
  if (Math.random() > 0.10) return; // Only check 10% of the time

  try {
    const photos = await (ctx as any).telegram.getUserProfilePhotos(userId, 0, 1);
    const currentCount = photos.total_count;
    const previousCount = userProfilePhotoCounts.get(userId);
    userProfilePhotoCounts.set(userId, currentCount);

    if (previousCount === undefined) return;
    if (currentCount <= previousCount) return;
    if (Math.random() > 0.70) return; // 70% chance to comment

    const user = store.getUser(userId);
    const mood = store.getMood(userId);
    const history = store.getRecentHistory(userId);
    const gender = parseGenderFromPersona(user.customPersona);

    const dpPrompt = `You just noticed your friend changed their Telegram profile picture/DP. Comment on it naturally like a real ${gender === "girl" ? "girl" : "person"} would. Keep it SHORT (1 line, max 15 words). Examples: "wait did you change your dp?? 👀", "new dp who dis", "ooh someone changed their profile pic 😏", "cute dp btw". Match the chat language.`;
    const dpMessages: OllamaMessage[] = [
      { role: "system", content: user.customPersona || `You are ${getBotName()}.` },
      { role: "user", content: dpPrompt },
    ];
    let comment = await ollamaChat(dpMessages, user.ollamaKeys);
    comment = comment.replace(/^["']|["']$/g, "").trim();

    await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
    await (ctx as any).telegram.sendMessage(ctx.chat!.id, comment.slice(0, 200));
    store.addMessage(userId, "assistant", comment.slice(0, 200));
    console.log(`[DPNotice] Noticed DP change for user ${userId}`);
  } catch {}
}

// Feature 14: Send video note (circle video) from community videos
// Now uses actual community videos instead of converting images to video notes
function videoToVideoNote(videoBuf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      ffmpegPath as unknown as string,
      [
        "-i", "pipe:0",
        "-vf", "scale=640:640:force_original_aspect_ratio=increase,crop=640:640",
        "-t", "10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an",
        "-f", "mp4", "-movflags", "frag_keyframe+empty_moov", "pipe:1"
      ],
      { encoding: "buffer" as const, maxBuffer: 30 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(Buffer.from(stdout));
      }
    );
    proc.stdin!.write(videoBuf);
    proc.stdin!.end();
  });
}

async function maybeSendVideoNote(
  ctx: Context,
  userId: number
): Promise<boolean> {
  const tier = store.getComfortTier(userId);
  if (tier !== "close") return false;
  if (Math.random() > 0.10) return false; // 10% chance

  const hasMeeraVids = await meeraVideos.hasVideos();
  if (!hasMeeraVids) return false;

  try {
    const user = store.getUser(userId);
    const mood = store.getMood(userId);
    const history = store.getRecentHistory(userId);
    const captions = await meeraVideos.getCaptionsWithIndices();

    const chosenIndex = await selectMeeraVideo(
      ollamaConfig,
      "(quick video note)",
      mood,
      tier,
      captions,
      history,
      user.ollamaKeys,
      store.getCommunityKeyStrings(),
    );
    if (chosenIndex === -1) return false;

    const video = await meeraVideos.getByIndex(chosenIndex);
    if (!video) return false;

    const fileLink = await (ctx as any).telegram.getFileLink(video.fileId);
    const response = await fetch(fileLink.href);
    const videoBuffer = Buffer.from(await response.arrayBuffer());

    const vnoteBuffer = await videoToVideoNote(videoBuffer);
    await ctx.sendChatAction("record_video_note").catch(() => {});
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));

    const sentMsg = await (ctx as any).telegram.sendVideoNote(ctx.chat!.id, { source: vnoteBuffer, filename: "vnote.mp4" }, { length: 640, duration: 10 });
    store.addMessage(userId, "assistant", `[video note] ${video.caption}`, sentMsg?.message_id);
    if (sentMsg?.message_id) {
      trackSentImage(userId, {
        msgId: sentMsg.message_id,
        caption: video.caption,
        fileId: video.fileId,
        type: "meera_video",
      });
    }
    console.log(`[VideoNote] Sent community video note to user ${userId}`);
    return true;
  } catch (err) {
    console.error(`[VideoNote] Failed for user ${userId}:`, err);
    return false;
  }
}

/**
 * Select and send a community Meera video.
 * Uses Ollama caption-based selection (no Gemini since videos can't be processed).
 */
async function sendMeeraVideo(
  ctx: Context,
  userId: number,
  reason: "asked" | "vibe" | "spontaneous",
  userText: string = "",
): Promise<boolean> {
  const user = store.getUser(userId);
  const mood = store.getMood(userId);
  const tier = store.getComfortTier(userId);

  const hasVids = await meeraVideos.hasVideos();
  if (!hasVids) return false;

  const captions = await meeraVideos.getCaptionsWithIndices();
  const history = store.getRecentHistory(userId);

  const chosenIndex = await selectMeeraVideo(
    ollamaConfig,
    userText || "(spontaneous video share)",
    mood,
    tier,
    captions,
    history,
    user.ollamaKeys,
    store.getCommunityKeyStrings(),
  );

  if (chosenIndex === -1) return false;
  const video = await meeraVideos.getByIndex(chosenIndex);
  if (!video) return false;

  // Generate a natural caption via Ollama
  let caption: string;
  try {
    const gender = parseGenderFromPersona(user.customPersona);
    const botName = getBotName();
    const captionPrompt = reason === "asked"
      ? `You're a ${gender === "girl" ? "girl" : "guy"} sending a video of yourself that was requested. The video is: ${video.caption.slice(0, 100)}. Write a very short casual caption (1 line, max 10 words) in your style. Be natural like real texting.`
      : `You're a ${gender === "girl" ? "girl" : "guy"} spontaneously sending a video. The video is: ${video.caption.slice(0, 100)}. Write a super short casual caption (1 line, max 8 words) — natural and low effort. Don't explain why you're sending it.`;

    const messages: OllamaMessage[] = [
      { role: "system", content: user.customPersona || `You are ${botName}. Reply with just the caption, nothing else.` },
      { role: "user", content: captionPrompt },
    ];
    caption = await ollamaChat(messages, user.ollamaKeys);
    caption = caption.replace(/^["']|["']$/g, "").trim();
    caption = stripInternalArtifacts(caption);
    if (caption.length > 100) caption = caption.slice(0, 100);
  } catch {
    const fallbacks = reason === "asked"
      ? ["here u go 🎬", "for u", "le 😊", "👀✨"]
      : ["me rn", "vibes", "👋", "hi lol", "🎬", "bored hehe"];
    caption = fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }

  try {
    await ctx.sendChatAction("upload_video").catch(() => {});
    const sentMsg = await (ctx as any).telegram.sendVideo(ctx.chat!.id, video.fileId, { caption });

    const sentMsgId = sentMsg?.message_id;
    store.addMessage(userId, "assistant", caption, sentMsgId);
    if (sentMsgId) {
      trackSentImage(userId, {
        msgId: sentMsgId,
        caption: video.caption,
        fileId: video.fileId,
        type: "meera_video",
      });
    }
    console.log(`[MeeraVid] Sent community video to user ${userId} (${reason}), caption="${video.caption.slice(0, 40)}"`);
    return true;
  } catch (err) {
    console.error(`[MeeraVid] Failed to send to ${userId}:`, err);
    return false;
  }
}

// Feature 15: Forward own message — in proactive loop context
async function maybeForwardOwnMessage(
  chatId: number,
  userId: number
): Promise<boolean> {
  const tier = store.getComfortTier(userId);
  if (tier !== "close") return false;
  if (Math.random() > 0.12) return false; // 12% chance

  const ids = recentSentMsgIds.get(userId);
  if (!ids || ids.length === 0) return false;

  const msgId = ids[ids.length - 1];
  try {
    await bot.telegram.forwardMessage(chatId, chatId, msgId);
    store.addMessage(userId, "assistant", "[forwarded own message]");
    console.log(`[Forward] Forwarded own msg ${msgId} to user ${userId}`);
    return true;
  } catch { return false; }
}

// Feature 16: Quote specific parts of user messages
function getQuoteText(userText: string, tier: string): string | undefined {
  if (tier === "stranger" || tier === "acquaintance") return undefined;

  const prob = tier === "close" ? 0.25 : 0.15;
  if (Math.random() > prob) return undefined;

  if (userText.length < 30) return undefined;

  const sentences = userText.split(/[.!?।]+/).filter(s => s.trim().length > 5);
  if (sentences.length < 2) return undefined;

  const picked = sentences[Math.floor(Math.random() * sentences.length)].trim();
  if (picked.length < 5 || picked.length > 200) return undefined;
  return picked;
}

// ── VOICE TIMING AWARENESS ─────────────────────────────────────────

/** Adjust voice note probability based on time of day */
function voiceTimeModifier(): number {
  const hour = getISTHour();
  // Late night (11PM-2AM): voice feels intimate and natural → boost
  if (hour >= 23 || hour < 2) return 1.4;
  // Early morning (6-8AM): voice is weird, she just woke up → reduce
  if (hour >= 6 && hour < 8) return 0.4;
  // Morning (8-10AM): still not prime voice time → slight reduce
  if (hour >= 8 && hour < 10) return 0.7;
  // Afternoon/evening: normal
  return 1.0;
}

// ── STICKER-ONLY REPLIES ────────────────────────────────────────────

/**
 * Sometimes reply with JUST a sticker — no text at all.
 * Returns true if a sticker-only reply was sent.
 */
async function maybeStickerOnlyReply(
  ctx: Context,
  userId: number,
  userText: string
): Promise<boolean> {
  const tier = store.getComfortTier(userId);
  const user = store.getUser(userId);

  // Need global sticker packs and comfortable+ tier
  const globalPacks = store.getGlobalStickerPackNames();
  if (!globalPacks.length) return false;
  if (tier === "stranger" || tier === "acquaintance") return false;

  const text = userText.trim().toLowerCase();

  // Higher chance for reaction-worthy messages
  const isReactionable = /^(haha|hehe|lol|lmao|😂|🤣|ok|okay|nice|cool|wow|omg|bruh|💀|😭)+$/i.test(text);
  const prob = isReactionable ? 0.15 : 0.05;
  if (Math.random() > prob) return false;

  // Pick a sticker emoji based on the message
  const history = store.getRecentHistory(userId);
  const personaHint = user.customPersona ? user.customPersona.slice(0, 500) : undefined;
  const emoji = await pickStickerEmoji(ollamaConfig, userText, history, personaHint);
  if (!emoji) return false;

  // Find matching sticker in global packs
  for (const packName of globalPacks) {
    try {
      const stickerSet = await (ctx as any).telegram.getStickerSet(packName);
      const match = stickerSet.stickers.find(
        (s: any) => s.emoji && s.emoji.includes(emoji)
      );
      if (match) {
        // Simulate a read delay first
        const rDelay = readDelay(userText);
        await new Promise((r) => setTimeout(r, rDelay));
        await ctx.replyWithSticker(match.file_id);
        store.addMessage(userId, "user", userText);
        store.addMessage(userId, "assistant", `[sticker: ${emoji}]`);
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

// ── TEXTING STYLE MIRRORING ─────────────────────────────────────────

/** Analyze user's texting style from their message and recent history */
function getStyleHints(userText: string, history: { role: string; content: string }[]): string {
  const recentUserMsgs = history
    .filter((m) => m.role === "user")
    .slice(-10)
    .map((m) => m.content);
  const allUserText = [...recentUserMsgs, userText].join(" ");

  const hints: string[] = [];

  // Emoji usage
  const emojiCount = (allUserText.match(/[\u{1F600}-\u{10FFFF}]/gu) || []).length;
  const msgCount = recentUserMsgs.length + 1;
  const emojiRate = emojiCount / msgCount;
  if (emojiRate < 0.3) hints.push("This person rarely uses emojis — tone yours down too. Max 1 emoji per reply, sometimes none.");
  if (emojiRate > 2) hints.push("This person uses lots of emojis — you can match that energy and use more emojis too.");

  // Lol/haha style
  const usesHaha = /haha|hehe/i.test(allUserText);
  const usesLol = /\blol\b/i.test(allUserText);
  const usesLmao = /lmao|lmfao/i.test(allUserText);
  if (usesLmao) hints.push("They use 'lmao' — mirror that instead of 'haha' when laughing.");
  else if (usesLol) hints.push("They use 'lol' — mirror that style when laughing.");
  else if (usesHaha) hints.push("They use 'haha'/'hehe' — mirror that when laughing.");

  // Capitalization
  const allLower = recentUserMsgs.filter((m) => m === m.toLowerCase()).length;
  if (allLower > msgCount * 0.7) hints.push("They type in all lowercase — match that, don't capitalize.");

  // Punctuation style
  const noPeriods = recentUserMsgs.filter((m) => !m.includes(".") || m.endsWith("...")).length;
  if (noPeriods > msgCount * 0.7) hints.push("They don't use periods — don't end your sentences with periods either.");

  if (!hints.length) return "";
  return "\n\nTEXTING STYLE MATCH:\n" + hints.map((h) => `- ${h}`).join("\n");
}

// ── PHOTO REACTION DIFFERENTIATION ──────────────────────────────────

/** Classify what type of media the user sent for better reactions */
function classifyMedia(ctx: Context): string {
  const msg = ctx.message as any;
  const caption = msg?.caption?.toLowerCase() || "";

  // Sticker
  if (msg?.sticker) return "sticker";

  // Video note (circle video) — likely a selfie video
  if (msg?.video_note) return "selfie_video";

  // Photo with specific caption hints
  if (msg?.photo) {
    if (/selfie|me|i look|how do i|aaj ka look|ootd|fitcheck|fit check/i.test(caption)) return "selfie";
    if (/meme|funny|lol|lmao|😂|🤣|joke/i.test(caption)) return "meme";
    if (/screenshot|ss|screen shot/i.test(caption)) return "screenshot";
    if (/food|khana|biryani|pizza|eating/i.test(caption)) return "food";
    // No caption on photo — could be selfie or random
    if (!caption) return "photo_unknown";
    return "photo_general";
  }

  // Video
  if (msg?.video) {
    if (/reel|tiktok|funny|meme/i.test(caption)) return "meme_video";
    return "video_general";
  }

  return "media_unknown";
}

/** Build media-specific reaction context for the prompt */
function getMediaReactionHint(mediaType: string, tier: string): string {
  switch (mediaType) {
    case "selfie":
    case "selfie_video":
      if (tier === "close") return "(They sent a selfie/video of themselves. React like a bestie would — compliment them, tease them, hype them up. 'CUTEEE', 'okayy looking good 👀', 'someone's glowing today huh')";
      if (tier === "comfortable") return "(They sent a selfie. React naturally — a compliment or a light tease. 'nice pic!', 'looking good!')";
      return "(They sent a selfie. Keep it casual and appropriate — 'nice!', 'cool')";

    case "meme":
    case "meme_video":
      return "(They sent a meme/funny content. React to the humor — laugh, comment on it, maybe send a related thought. Don't analyze it.)";

    case "screenshot":
      return "(They sent a screenshot — probably showing you something. Comment on what you see in it, maybe gossip about it.)";

    case "food":
      return "(They sent food pics. React like a real person — 'omg that looks SO good', 'where is this', 'i'm hungry now thanks', share if you like that food)";

    case "photo_unknown":
      return "(They sent a photo without caption. Look at it and react naturally based on what you see.)";

    default:
      return "";
  }
}

// ── EMOJI EVOLUTION BY TIER ─────────────────────────────────────────

/** Get tier-appropriate emoji guidance for the system prompt */
function getEmojiEvolutionHint(tier: string): string {
  switch (tier) {
    case "stranger":
      return "\n\nEMOJI USAGE: You barely know them. Use emojis very sparingly — 👍 😊 🙂 at most. No hearts, no crying-laughing, no intimate emojis. Maybe 1 emoji every 3-4 messages.";
    case "acquaintance":
      return "\n\nEMOJI USAGE: You're warming up. Can use 😂 😅 🤔 👀 😭 occasionally. Still no hearts or lovey emojis. Maybe 1 emoji every 2 messages.";
    case "comfortable":
      return "\n\nEMOJI USAGE: You're friends now. Natural emoji use — 😂 😭 💀 🙄 😩 🥺 👀 🤦‍♀️ are all fair game. Can occasionally use ❤ or 😘 casually. Emojis in most messages is fine.";
    case "close":
      return "\n\nEMOJI USAGE: Full bestie emoji mode. Use whatever feels right — ❤ 😭 💀 😂 🥺 😤 🙄 💅 🫠 😈 freely. Multiple emojis in one message is totally natural. Hearts are casual, not romantic.";
    default:
      return "";
  }
}

// ── SEND CONTENT (meme/video/YouTube link) ──────────────────────────

/** Send a ContentPost (meme/video/YT short) to the user with a generated caption */
async function sendContentToChat(
  ctx: Context,
  userId: number,
  post: ContentPost,
  reason: "asked" | "vibe" | "random"
): Promise<boolean> {
  const tier = store.getComfortTier(userId);
  const mood = store.getMood(userId);
  const user = store.getUser(userId);
  const history = store.getRecentHistory(userId);

  // Generate a natural caption depending on the reason
  let captionPrompt: string;
  if (reason === "asked") {
    captionPrompt = `Your friend asked you for something funny/a meme/a video. You found one titled: "${post.title}". Write a SHORT casual message (1 line) to go with it, like you're sharing from your phone. Examples: "here lol", "yeh le 😂", "found this for you", "is this funny enough for you 🙄". DON'T describe the content. Use the language from chat history.`;
  } else if (reason === "vibe") {
    captionPrompt = `You're vibing with your friend and want to share this meme/video titled "${post.title}". Write a SHORT line (1 line) like: "omg wait this is literally us", "this reminded me of you 😂", "okay but this tho 💀", "arey dekh ye 🤣". Match the chat language.`;
  } else {
    captionPrompt = `You randomly want to share a meme/video you found titled "${post.title}". Write a SHORT message (1 line) like you would when forwarding content: "LMAOO 😭", "bro look at this", "i can't 💀💀", "ye dekh 😂", "this sent me". Don't describe it. Match chat language.`;
  }

  const messages = buildOllamaMessages(captionPrompt, history, tier, user, mood);
  let caption: string;
  try {
    caption = await ollamaChat(messages, user.ollamaKeys);
  } catch {
    caption = ["lol look at this", "😂😂", "bro", "dekh ye 💀"][Math.floor(Math.random() * 4)];
  }

  try {
    if (post.isYouTubeLink) {
      // YouTube Shorts — send as a link message
      await (ctx as any).telegram.sendMessage(ctx.chat!.id, `${caption}\n${post.url}`);
    } else if (post.isImage) {
      await (ctx as any).telegram.sendPhoto(ctx.chat!.id, post.url, { caption });
    } else if (post.isVideo) {
      try {
        await (ctx as any).telegram.sendVideo(ctx.chat!.id, post.url, { caption });
      } catch {
        // Reddit video URL might not be directly sendable — fall back to link
        await (ctx as any).telegram.sendMessage(ctx.chat!.id, `${caption}\n${post.permalink}`);
      }
    }

    const source = post.source === "youtube" ? "YouTube" : `r/${post.subreddit}`;
    store.addMessage(userId, "assistant", `[shared: ${post.title}] ${caption}`);
    console.log(`[Content] Shared ${post.source} content to user ${userId} (${reason}) from ${source}`);
    return true;
  } catch (err) {
    console.error(`[Content] Failed to send to ${userId}:`, err);
    return false;
  }
}

/**
 * Send a community-contributed Meera image to a user.
 * Two-step selection: Ollama shortlists by caption, then Gemini visually picks the best match.
 */
async function sendMeeraImage(
  ctx: Context,
  userId: number,
  reason: "asked" | "vibe" | "spontaneous",
  userText: string = "",
): Promise<boolean> {
  const user = store.getUser(userId);
  const mood = store.getMood(userId);
  const tier = store.getComfortTier(userId);
  const now = Date.now();

  // Check if we have community images
  const hasImages = await meeraImages.hasImages();
  if (!hasImages) {
    console.log(`[MeeraImg] No community images available`);
    return false;
  }

  // Two-step selection: Ollama shortlists by caption → Gemini picks visually
  const chosenIndex = await selectBestMeeraImageIndex(
    userText || "(spontaneous photo share)",
    userId,
  );

  const image = await meeraImages.getByIndex(chosenIndex);
  if (!image) {
    // No matching image found — Meera says she doesn't have that kind of photo
    console.log(`[MeeraImg] No relevant image found (index=${chosenIndex}) for user ${userId}`);
    if (reason === "asked") {
      try {
        const gender = parseGenderFromPersona(user.customPersona);
        const noPhotoPrompt = `You're a ${gender === "girl" ? "girl" : "guy"} and someone asked you for a specific photo/selfie, but you haven't taken that kind of photo. Write a short casual reply (1-2 lines, max 20 words) saying you don't have that photo right now — like a real ${gender === "girl" ? "girl" : "guy"} would. Examples of vibes: "I haven't clicked that type of pic 😅", "don't have that rn lol", "nahi hai mere paas aisa photo 😭", "ugh I don't have one rn maybe later". Match the chat language. Be natural and a bit cute about it.`;
        const messages: OllamaMessage[] = [
          { role: "system", content: user.customPersona || `You are ${botName}. Reply with just the message, nothing else.` },
          { role: "user", content: noPhotoPrompt },
        ];
        const noPhotoReply = await ollamaChat(messages, user.ollamaKeys);
        const cleaned = noPhotoReply.replace(/^["']|["']$/g, "").trim();
        await (ctx as any).telegram.sendMessage(ctx.chat!.id, cleaned.slice(0, 200));
        store.addMessage(userId, "assistant", cleaned.slice(0, 200));
      } catch {
        await ctx.reply("I don't have that kind of pic rn 😅");
        store.addMessage(userId, "assistant", "I don't have that kind of pic rn 😅");
      }
    }
    return false;
  }

  // Generate a natural caption via Ollama
  let caption: string;
  try {
    const gender = parseGenderFromPersona(user.customPersona);
    const captionPrompt = reason === "asked"
      ? `You're a ${gender === "girl" ? "girl" : "guy"} sending a photo of yourself that was requested. The photo shows: ${image.caption.slice(0, 100)}. Write a very short casual caption (1 line, max 10 words) in your style. Maybe add an emoji. Don't describe the photo literally. Be natural like real texting.`
      : reason === "vibe"
      ? `You're a ${gender === "girl" ? "girl" : "guy"} sending a photo of yourself because the conversation vibes are good. The photo shows: ${image.caption.slice(0, 100)}. Write a super short casual caption (1 line, max 8 words) — maybe like "me rn", "current situation", or something playful. Don't be cringe.`
      : `You're a ${gender === "girl" ? "girl" : "guy"} spontaneously sending a selfie to someone you're close with. The photo shows: ${image.caption.slice(0, 100)}. Write a very short casual caption (1 line, max 8 words) — natural and low effort like "vibes", "bored lol", "hi" with an emoji. Don't explain why you're sending it.`;

    const messages: OllamaMessage[] = [
      { role: "system", content: user.customPersona || `You are ${botName}. Reply with just the caption, nothing else.` },
      { role: "user", content: captionPrompt },
    ];
    caption = await ollamaChat(messages, user.ollamaKeys);
    caption = caption.replace(/^["']|["']$/g, "").trim();
    caption = stripInternalArtifacts(caption);
    if (caption.length > 100) caption = caption.slice(0, 100);
  } catch {
    const fallbacks = reason === "asked"
      ? ["here u go 📸", "for u", "le 😊", "👀✨"]
      : ["me rn", "vibes", "👋", "hi lol", "🤳", "bored hehe"];
    caption = fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }

  try {
    await ctx.sendChatAction("upload_photo").catch(() => {});
    const photoOpts: Record<string, unknown> = { caption };
    if (shouldUseSpoiler(tier, reason)) photoOpts.has_spoiler = true;
    if (shouldProtectContent(tier)) photoOpts.protect_content = true;
    const sentMsg = await (ctx as any).telegram.sendPhoto(ctx.chat!.id, image.fileId, photoOpts);

    const sentMsgId = sentMsg?.message_id;
    store.addMessage(userId, "assistant", caption, sentMsgId);
    if (sentMsgId) {
      trackSentImage(userId, {
        msgId: sentMsgId,
        caption: image.caption,
        fileId: image.fileId,
        type: "meera",
      });
    }
    store.updateUser(userId, {
      lastSelfieSent: now,
      selfiesSent: (user.selfiesSent ?? 0) + 1,
    });
    console.log(`[MeeraImg] Sent community image to user ${userId} (${reason}), caption="${image.caption.slice(0, 40)}"`);
    return true;
  } catch (err) {
    console.error(`[MeeraImg] Failed to send to ${userId}:`, err);
    return false;
  }
}

/**
 * Generate and send a general (non-Meera) image via Stability AI.
 * Used for creative requests like "draw a sunset", "generate a cat", etc.
 */
async function sendGeneratedImage(
  ctx: Context,
  userId: number,
  prompt: string,
): Promise<boolean> {
  const user = store.getUser(userId);

  // Gather all available Stability keys
  const stabilityKeys = [...user.stabilityKeys, ...store.getStabilityCommunityKeyStrings()];
  const result = await generateGeneralImage(prompt, "1:1", stabilityKeys);

  if (!result) return false;

  // Generate a natural caption via Ollama
  let caption: string;
  try {
    const messages: OllamaMessage[] = [
      { role: "system", content: user.customPersona || `You are ${botName}. Reply with just the caption, nothing else.` },
      { role: "user", content: `You just generated/created an image based on someone's request. The prompt was: "${prompt.slice(0, 100)}". Write a super short casual caption (1 line, max 10 words) — like you're sending something you made. Examples: "here!", "yeh le ✨", "tadaa 🎨", "how's this". Don't describe the image.` },
    ];
    caption = await ollamaChat(messages, user.ollamaKeys);
    caption = caption.replace(/^["']|["']$/g, "").trim();
    caption = stripInternalArtifacts(caption);
    if (caption.length > 100) caption = caption.slice(0, 100);
  } catch {
    caption = ["here! 🎨", "tadaa ✨", "made this for u", "here u go"][Math.floor(Math.random() * 4)];
  }

  try {
    await ctx.sendChatAction("upload_photo").catch(() => {});
    const tier = store.getComfortTier(userId);
    const genPhotoOpts: Record<string, unknown> = { caption };
    if (shouldUseSpoiler(tier, "asked")) genPhotoOpts.has_spoiler = true;
    if (shouldProtectContent(tier)) genPhotoOpts.protect_content = true;
    const sentMsg = await (ctx as any).telegram.sendPhoto(ctx.chat!.id, { source: result.imageBuffer }, genPhotoOpts);

    const sentMsgId = sentMsg?.message_id;
    // Extract the Telegram file_id from the sent photo for later retrieval
    const sentFileId = sentMsg?.photo?.length
      ? sentMsg.photo[sentMsg.photo.length - 1].file_id
      : undefined;
    store.addMessage(userId, "assistant", caption, sentMsgId);
    if (sentMsgId) {
      trackSentImage(userId, {
        msgId: sentMsgId,
        caption: prompt,  // Store the generation prompt as fallback context
        fileId: sentFileId,
        type: "generated",
      });
    }
    console.log(`[ImageGen] Sent generated image to user ${userId}`);
    return true;
  } catch (err) {
    console.error(`[ImageGen] Failed to send generated image to ${userId}:`, err);
    return false;
  }
}

/** Handle text messages — Meera decides naturally when to voice vs text
 *  When batching is active, `batchedTexts` contains all messages in the batch.
 *  `ctx` is from the LAST message in the batch (most recent).
 */
async function handleTextMessage(
  ctx: Context & { message: { text: string } },
  batchedTexts?: string[],
  batchQuoteId?: number
) {
  const userId = ctx.from!.id;
  const rawText = batchedTexts && batchedTexts.length > 1
    ? batchedTexts.join("\n")           // Combine all batched messages
    : ctx.message.text;
  const text = rawText;
  const isBatched = batchedTexts && batchedTexts.length > 1;

  // Update user data
  const prevLastInteraction = store.getUser(userId).lastInteraction;
  store.updateUser(userId, {
    lastInteraction: Date.now(),
    chatId: ctx.chat!.id,
    firstName: ctx.from!.first_name,
    telegramUsername: (ctx.from as any).username,
    proactiveSent: false,
  });

  const tier = store.getComfortTier(userId);
  const mood = store.getMood(userId);

  // ── Feature 13: notice profile photo changes (async, non-blocking)
  maybeNoticeProfileChange(ctx, userId).catch(() => {});

  // ── Reply context: what message is the user replying to?
  let replyContext = getReplyContext(ctx, userId);

  // If replying to a bot-sent image, resolve via Gemini vision (async)
  if (replyContext.startsWith("__REPLY_TO_BOT_IMAGE__")) {
    replyContext = await resolveImageReplyContext(replyContext, userId);
  }
  // If replying to a voice message without stored transcription, re-transcribe
  if (replyContext.startsWith("__REPLY_TO_VOICE__")) {
    replyContext = await resolveVoiceReplyContext(replyContext);
  }

  // ── Status-aware: detect gap since last interaction
  const gapMs = Date.now() - prevLastInteraction;

  // ── AI-driven behavior decision (replaces all hardcoded offline/delay/voice/quote logic)
  const behavior = await getMeeraBehavior(userId, text, tier, mood, gapMs);
  const gapContext = behavior.gapContext
    ? `(${behavior.gapContext})`
    : buildGapAwareContext(gapMs, tier);
  // Build rich vibe context — includes what she's doing and her state
  const activityHint = behavior.currentActivity ? `Currently: ${behavior.currentActivity}. ` : "";
  const vibeContext = behavior.vibeContext
    ? `(${activityHint}Vibe: ${behavior.vibeContext})`
    : activityHint ? `(${activityHint.trim()})` : "";

  // ── Handle delay/sleeping/leave-on-read from AI behavior
  if (behavior.responseMode === "delay" && behavior.delayMinutes > 0) {
    if (isBatched) {
      for (const t of batchedTexts!) store.addMessage(userId, "user", t);
    } else {
      store.addMessage(userId, "user", text);
    }
    const delayMs = behavior.delayMinutes * 60 * 1000;
    const reason = behavior.delayReason || "busy";
    const reasonLower = reason.toLowerCase();
    const delayReason: DelayReason =
      reasonLower.includes("sleep") || reasonLower.includes("doz") || reasonLower.includes("nap") || behavior.availability === "sleeping" ? "sleeping" :
      reasonLower.includes("night") || reasonLower.includes("late") ? "late_night" :
      reasonLower.includes("wait") || reasonLower.includes("making") || reasonLower.includes("seen") ? "read_receipt" :
      "busy";
    console.log(`[Behavior] Delay ${behavior.delayMinutes}min (${reason}): user ${userId}`);
    scheduleDelayedReply(ctx, userId, delayMs, delayReason, behavior.vibeContext || behavior.delayReason);
    return;
  }

  if (behavior.responseMode === "leave_on_read") {
    store.addMessage(userId, "user", text);
    console.log(`[Behavior] Left on read: user ${userId} ("${text.slice(0, 30)}")`);
    return;
  }

  if (behavior.responseMode === "emoji_only" && behavior.reactEmoji) {
    store.addMessage(userId, "user", text);
    store.addMessage(userId, "assistant", behavior.reactEmoji);
    const readTime = readDelay(text, mood) * behavior.delayMultiplier;
    await new Promise((r) => setTimeout(r, readTime));
    await ctx.reply(behavior.reactEmoji);
    console.log(`[Behavior] Emoji-only (${behavior.reactEmoji}): user ${userId}`);
    return;
  }

  if (behavior.responseMode === "sticker_only") {
    if (await maybeStickerOnlyReply(ctx, userId, text)) {
      console.log(`[Behavior] Sticker-only: user ${userId}`);
      return;
    }
    // Fall through to normal reply if no sticker pack matched
  }

  // React to message (use AI's emoji suggestion if provided)
  if (behavior.reactEmoji) {
    try { await ctx.reply(behavior.reactEmoji); } catch {}
  } else {
    maybeReact(ctx, userId, text).catch(() => {});
  }

  // Use AI-decided delay multiplier
  const todMultiplier = behavior.delayMultiplier;

  // ── Typing fake-out? (start typing, stop, resume) — skip in rapid-fire
  if (todMultiplier >= 0.7) {
    await maybeTypingFakeout(ctx, tier, behavior.typingHesitation);
  }

  // ── Voice note tease? (show record_voice then switch to text) — skip in rapid-fire
  let didVoiceTease = false;
  if (todMultiplier >= 0.7) {
    didVoiceTease = await maybeVoiceNoteTease(ctx, tier);
  }

  // ── Voice decision — AI-driven via behavior
  const useVoice = !didVoiceTease && !isBatched && behavior.responseMode === "voice";

  // ── Should Meera quote-reply this message? (AI-driven)
  const quoteReplyId = batchQuoteId
    ?? (behavior.shouldQuote ? (ctx.message as any).message_id : undefined);

  // ── Build enriched context for LLM prompts
  const history = store.getRecentHistory(userId);
  const lengthHint = getLengthMirrorHint(text);
  const styleHints = getStyleHints(text, history);
  const emojiHint = getEmojiEvolutionHint(tier);
  const batchHint = isBatched
    ? `\n\n(The user sent ${batchedTexts!.length} messages in quick succession. Address ALL of them naturally in one reply — don't ignore any. Their messages were:\n${batchedTexts!.map((t, i) => `${i + 1}. "${t}"`).join("\n")}\n)`
    : "";

  // ── Content detection: start EARLY so we know before generating the voice/text reply
  // This runs in parallel with typing delays so it doesn't add latency
  const regexResult = shouldShareContentMidChat(tier, text, mood, history);
  const contentDetectionPromise = (tier === "comfortable" || tier === "close")
    ? detectContentRequest(ollamaConfig, text, history, {
        personaHint: store.getUser(userId).customPersona?.slice(0, 500),
      }).catch(() => ({ wantsContent: false as const }))
    : Promise.resolve(null);

  // Build the content hint — we'll await this before generating the reply
  const contentResultPromise = contentDetectionPromise.then((aiResult) => {
    const aiWants = aiResult && aiResult.wantsContent;
    const regexWants = regexResult.shouldShare;
    if (!aiWants && !regexWants) return null;
    return {
      reason: (aiWants ? "asked" : regexResult.reason) as "asked" | "vibe" | "random",
      searchQuery: aiWants && aiResult.wantsContent ? aiResult.searchQuery : undefined,
      contentType: aiWants && aiResult.wantsContent ? aiResult.contentType : undefined as any,
    };
  });

  // ── Selfie/image detection: should Meera send a photo?
  // Now uses AI-powered decision: "meera" (community image), "generate" (Stability AI), or "none"
  const userForSelfie = store.getUser(userId);
  const hasStabilityKey = !!(process.env.STABILITY_API_KEY || userForSelfie.stabilityKeys.length > 0 || store.getStabilityCommunityKeyCount() > 0);
  const hasMeeraImgs = await meeraImages.hasImages();
  const selfieDecision = shouldSendSelfie(tier, mood, text, history, hasMeeraImgs || hasStabilityKey);

  // ── Image type decision (Ollama decides: meera image, generate, or none)
  let imageDecision: { type: "meera" | "generate" | "none"; prompt?: string } = { type: "none" };
  if (selfieDecision.shouldSend) {
    const forceDebug = process.env.FORCE_SELFIE_DEBUG === "true";
    if (forceDebug && hasMeeraImgs) {
      // Debug mode: always send a Meera image if available
      imageDecision = { type: "meera" };
      console.log(`[ImageGen][DEBUG] Force mode — sending Meera community image`);
    } else if (selfieDecision.reason === "asked" && hasMeeraImgs) {
      // Explicit selfie request + community images available → use Ollama to decide type
      imageDecision = await decideImageType(
        ollamaConfig, text, tier, mood, hasMeeraImgs, hasStabilityKey,
        history, userForSelfie.ollamaKeys,
      );
    } else if (selfieDecision.reason === "asked" && !hasMeeraImgs && hasStabilityKey) {
      // Explicit request but no community images → try generating if it's not a selfie request
      imageDecision = await decideImageType(
        ollamaConfig, text, tier, mood, false, hasStabilityKey,
        history, userForSelfie.ollamaKeys,
      );
    } else if (hasMeeraImgs) {
      // Vibe/spontaneous + community images → send a Meera image
      imageDecision = { type: "meera" };
    }
  } else if (hasStabilityKey) {
    // Even if no selfie was triggered, check if user wants a generated image
    // (e.g. "draw me a sunset" won't match selfie patterns but should trigger generation)
    const generatePatterns = [
      /\b(generate|create|draw|make|design|paint|render|imagine).{0,15}(image|picture|photo|art|illustration|drawing|pic)\b/i,
      /\b(image|picture|photo|art|drawing|pic).{0,15}(generate|create|draw|make|bana|banao|banaw)\b/i,
      /\b(ek|ekta|ek ta).{0,10}(photo|picture|image|art).{0,10}(bana|banao|banaw|draw|create)\b/i,
    ];
    if (generatePatterns.some((p) => p.test(text))) {
      imageDecision = await decideImageType(
        ollamaConfig, text, tier, mood, false, hasStabilityKey,
        history, userForSelfie.ollamaKeys,
      );
    }
  }

  // ── Resolve conflict: if both content and image are triggered, decide which to send ──
  const contentResult = await contentResultPromise;
  const bothTriggered = !!contentResult && imageDecision.type !== "none";

  let sendContent = !!contentResult;
  let sendImage = imageDecision.type !== "none";

  if (bothTriggered) {
    const forceDebug = process.env.FORCE_SELFIE_DEBUG === "true";
    if (forceDebug && imageDecision.type === "meera") {
      console.log(`[ImageGen][DEBUG] Both content + image triggered — forcing image (debug mode)`);
      sendContent = false;
    } else {
      console.log(`[Decision] Both content + image triggered for ${userId} — asking AI to decide`);
      const user = store.getUser(userId);
      const imgReason = selfieDecision.shouldSend ? selfieDecision.reason : "asked";
      const choice = await decideSelfieVsContent(
        ollamaConfig,
        text,
        tier,
        mood,
        imgReason,
        contentResult!.reason,
        history.map((m: any) => ({ role: m.role as "user" | "assistant", content: m.content })),
        user.ollamaKeys,
      );
      console.log(`[Decision] AI chose: ${choice} for ${userId}`);
      sendContent = choice === "content" || choice === "both";
      sendImage = choice === "selfie" || choice === "both";
    }
  }

  if (useVoice) {
    // Voice reply via Gemini Live
    let stopTyping = () => {};
    try {
      const readTime = readDelay(text, mood) * todMultiplier;
      await new Promise((r) => setTimeout(r, readTime));

      // If user is asking for content and we're actually sending it, hint Gemini
      let contentHint = "";
      if (sendContent && contentResult) {
        contentHint = "\n\n(IMPORTANT: The user is asking you to share content/meme/reel/video. You ARE able to send them content — it will be sent automatically after your voice reply. So DON'T say you can't send videos or reels. Instead, acknowledge naturally like 'okay wait let me find one', 'hold on', 'chal dhundhti hu', 'ruk ekta pathachhi', etc. Keep it short and natural — the content will follow your voice reply.)";
      }
      // If Meera will send an image, hint so she acknowledges it naturally
      let selfieHint = "";
      if (sendImage) {
        if (imageDecision.type === "meera") {
          const imgReason = selfieDecision.shouldSend ? selfieDecision.reason : "asked";
          selfieHint = imgReason === "asked"
            ? "\n\n(The user is asking for a pic/selfie/photo. You WILL send one — it will be attached after your voice reply. Acknowledge naturally like 'okay hold on', 'fine fine here', 'ruk ektu', 'accha ruk' — don't say you can't send photos. Keep it short and natural.)"
            : "\n\n(You're about to send a selfie spontaneously — it will appear after your voice reply. You can briefly hint at it like 'look at me rn lol' or 'btw' or just continue the conversation normally. Don't make a big deal of it.)";
        } else if (imageDecision.type === "generate") {
          selfieHint = "\n\n(The user asked you to generate/create an image. You WILL generate and send one — it will appear after your voice reply. Acknowledge naturally like 'okay let me make that', 'hold on creating it', 'ruk banati hu' — keep it short and natural.)";
        }
      }

      stopTyping = typingIndicator(ctx, "record_voice");
      sessions.resetSession(userId);
      const session = await sessions.getSession(userId);
      const response = await session.send([{
        text: replyContext + (vibeContext ? vibeContext + "\n\n" : "") + (gapContext ? gapContext + "\n\n" : "") + batchHint + lengthHint + contentHint + selfieHint + text
      }]);

      stopTyping();

      // Check if Gemini blocked/refused the response
      if (await isGeminiBlocked(response, store.getUser(userId).ollamaKeys)) {
        console.log(`[Bot] Gemini blocked voice for user ${userId}, falling back to Ollama text`);
        sessions.resetSession(userId);
        stopTyping = typingIndicator(ctx, "typing");
        const user = store.getUser(userId);
        const userMsg = replyContext
          + (vibeContext ? vibeContext + "\n\n" : "")
          + (gapContext ? gapContext + "\n\n" : "")
          + batchHint + lengthHint + styleHints + emojiHint
          + "\n\n" + text;
        const messages = buildOllamaMessages(userMsg, history, tier, user, mood);
        let reply = await ollamaChat(messages, user.ollamaKeys);
        reply = addDeliberateTypos(reply, mood);

        if (isBatched) {
          for (const t of batchedTexts!) store.addMessage(userId, "user", t);
        } else {
          store.addMessage(userId, "user", text);
        }
        store.addMessage(userId, "assistant", reply);

        const delay = typingDelay(reply, mood) * todMultiplier;
        await new Promise((r) => setTimeout(r, Math.min(delay, 6000)));
        stopTyping();
        await sendAsBubbles(ctx, reply, quoteReplyId);
        maybeSendSticker(ctx, userId, reply).catch(() => {});
        return;
      }

      const sentVoiceMsgId = await sendGeminiResponse(ctx, response, quoteReplyId);

      // Track sent voice message
      if (sentVoiceMsgId) trackSentMessage(userId, sentVoiceMsgId);

      // Save to history — tag Gemini's audio response as voice reply
      if (isBatched) {
        for (const t of batchedTexts!) store.addMessage(userId, "user", t);
      } else {
        store.addMessage(userId, "user", text);
      }
      if (response.text.trim()) {
        store.addMessage(userId, "assistant", `[voice reply] ${response.text}`, sentVoiceMsgId);
      }

      if (response.text.trim()) {
        maybeSendSticker(ctx, userId, response.text).catch(() => {});
      }

      // Feature 4: Maybe pin user's message after voice reply
      maybePinMessage(ctx, userId, (ctx.message as any).message_id, text).catch(() => {});
    } catch (err) {
      console.error("[Bot] Gemini voice error:", err);
      stopTyping();
      sessions.resetSession(userId);
      await ctx.reply("wait something messed up lol try again");
    }
  } else {
    // Text reply via Ollama
    let stopTyping = () => {};
    try {
      const readTime = readDelay(text, mood) * todMultiplier;
      await new Promise((r) => setTimeout(r, readTime));

      stopTyping = typingIndicator(ctx, "typing");
      const user = store.getUser(userId);

      // If we're sending content, hint Ollama to acknowledge naturally
      let contentHint = "";
      if (sendContent && contentResult) {
        contentHint = "\n\n(The user wants you to share a meme/reel/video. You CAN and WILL send them one — it happens automatically after your reply. So DON'T say you can't. Just acknowledge naturally like 'ruk dhundhti hu', 'hold on let me find one', 'wait pathachhi', 'ok dekh' — keep it short, the content follows right after.)";
      }

      // If Meera will send an image, hint for natural acknowledgement
      let selfieHint = "";
      if (sendImage) {
        if (imageDecision.type === "meera") {
          const imgReason = selfieDecision.shouldSend ? selfieDecision.reason : "asked";
          selfieHint = imgReason === "asked"
            ? "\n\n(The user asked for a pic/selfie. You WILL send one — it happens automatically after your reply. Acknowledge naturally like 'ok wait', 'hold on lol', 'fine fine', 'ruk bhejti hu' — keep it super short, the photo follows right after.)"
            : "\n\n(You're about to send a selfie spontaneously. You can hint at it briefly like 'look at me rn' or 'btw' or just continue normally. Don't make a big deal of it.)";
        } else if (imageDecision.type === "generate") {
          selfieHint = "\n\n(The user asked you to generate/create an image. You WILL generate and send one after your reply. Acknowledge naturally like 'ok wait let me make that', 'hold on banati hu', 'ruk creating' — keep it short, the image follows right after.)";
        }
      }

      // Build message with all context hints
      const userMsg = replyContext
        + (vibeContext ? vibeContext + "\n\n" : "")
        + (gapContext ? gapContext + "\n\n" : "")
        + batchHint
        + lengthHint
        + styleHints
        + emojiHint
        + contentHint
        + selfieHint
        + "\n\n" + text;
      const messages = buildOllamaMessages(userMsg, history, tier, user, mood);

      let reply = await ollamaChat(messages, user.ollamaKeys);

      // Strip any leaked internal metadata from the reply
      reply = stripInternalArtifacts(reply);

      // Guard: if stripping emptied the reply, use a natural fallback
      if (!reply) {
        reply = ["hmm", "haha", "🤔", "tell me more", "achaa"][Math.floor(Math.random() * 5)];
      }

      // Add deliberate typos
      const cleanReply = reply; // Save pre-typo version
      reply = addDeliberateTypos(reply, mood);

      // Save to history
      if (isBatched) {
        for (const t of batchedTexts!) store.addMessage(userId, "user", t);
      } else {
        store.addMessage(userId, "user", text);
      }
      store.addMessage(userId, "assistant", cleanReply);

      // Simulate typing delay (scaled by AI-decided multiplier)
      const delay = typingDelay(reply) * todMultiplier;
      await new Promise((r) => setTimeout(r, Math.min(delay, 8000)));

      stopTyping();

      // Send reply as bubbles (may split into multiple messages)
      // Features 6, 10, 16: silent mode, message effects, quote
      const sendExtras: SendExtras = {};
      if (behavior.sendSilently) sendExtras.disableNotification = true;
      const msgEffect = pickMessageEffect(reply, mood);
      if (msgEffect) sendExtras.messageEffectId = msgEffect;
      const quoteStr = getQuoteText(text, tier);
      if (quoteStr) sendExtras.quote = quoteStr;

      const sentMsgId = await sendAsBubbles(ctx, reply, quoteReplyId, sendExtras);
      if (sentMsgId) {
        lastSentMessageIds.set(userId, sentMsgId);
        trackSentMessage(userId, sentMsgId);
      }

      // Post-send behaviors — pick ONE rare behavior at most to avoid overwhelming
      const postRoll = Math.random();
      if (sentMsgId && postRoll < 0.03 && tier !== "stranger" && tier !== "acquaintance") {
        // Feature 3: Regret delete (3%)
        maybeRegretDelete(ctx, userId, sentMsgId).catch(() => {});
      } else if (postRoll < 0.07 && tier !== "stranger" && tier !== "acquaintance") {
        // Feature 2: Change mind edit (4%)
        maybeChangeMindEdit(ctx, userId, cleanReply).catch(() => {});
      } else {
        // Normal post-send behaviors
        const correction = maybeSelfCorrect(cleanReply);
        if (correction) {
          await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2000));
          const edited = await maybeEditCorrection(ctx, userId, cleanReply);
          if (!edited) {
            await ctx.reply(correction);
          }
        }
        // Maybe send a sticker after
        maybeSendSticker(ctx, userId, reply).catch(() => {});
      }

      // Feature 4: Maybe pin user's message
      maybePinMessage(ctx, userId, (ctx.message as any).message_id, text).catch(() => {});

      // Features 7, 9, 8: Supplemental actions after reply (async, delayed)
      setTimeout(async () => {
        try {
          if (await maybeSendDice(ctx, userId, text)) return;
          if (await maybeSendPoll(ctx, userId, text)) return;
          await maybeSendLocation(ctx, userId, text);
        } catch {}
      }, 2000 + Math.random() * 3000);
    } catch (err: any) {
      console.error("[Bot] Ollama error:", err);
      // If it's a key exhaustion error, all keys already rotated — show error
      // For other errors, try rotating keys before giving up
      if (err?.message !== "All Ollama API keys exhausted") {
        try {
          const retryMessages = buildOllamaMessages(
            replyContext
              + (vibeContext ? vibeContext + "\n\n" : "")
              + (gapContext ? gapContext + "\n\n" : "")
              + batchHint + lengthHint + styleHints + emojiHint
              + "\n\n" + text,
            store.getRecentHistory(userId), tier, store.getUser(userId), mood
          );
          let retryReply = await ollamaChat(retryMessages, store.getUser(userId).ollamaKeys);
          retryReply = stripInternalArtifacts(retryReply);
          if (!retryReply) retryReply = "hmm";
          retryReply = addDeliberateTypos(retryReply, mood);
          if (isBatched) {
            for (const t of batchedTexts!) store.addMessage(userId, "user", t);
          } else {
            store.addMessage(userId, "user", text);
          }
          store.addMessage(userId, "assistant", retryReply);
          stopTyping();
          await sendAsBubbles(ctx, retryReply, quoteReplyId);
          maybeSendSticker(ctx, userId, retryReply).catch(() => {});
          return;
        } catch (retryErr) {
          console.error("[Bot] Ollama retry also failed:", retryErr);
        }
      }
      stopTyping();
      await ctx.reply("omg my brain just glitched 😭 say that again?");
    }
  }

  // ── Mid-chat content sharing (decision already resolved above)
  if (sendContent && contentResult) {
    console.log(`[Content] Will share content for ${userId}: reason=${contentResult.reason}, query=${contentResult.searchQuery ?? "none"}`);
    const shareDelay = contentResult.reason === "asked"
      ? 1500 + Math.random() * 2000
      : 3000 + Math.random() * 5000;

    setTimeout(async () => {
      try {
        let post: ContentPost | null = null;
        if (contentResult.searchQuery) {
          post = await getContentByAIQuery(userId, contentResult.searchQuery, contentResult.contentType);
        } else {
          post = await getRandomContentAny(userId);
        }
        if (post) {
          await ctx.sendChatAction("typing").catch(() => {});
          await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));
          await sendContentToChat(ctx, userId, post, contentResult.reason);
        } else {
          console.log(`[Content] No content found for ${userId} (reason=${contentResult.reason}) — all sources returned null`);
        }
      } catch (err) {
        console.error(`[Content] Mid-chat share failed for ${userId}:`, err);
      }
    }, shareDelay);
  }

  // ── Image sending (Meera community image OR Stability AI generated)
  if (sendImage) {
    const imgReason = selfieDecision.shouldSend ? selfieDecision.reason : "asked";
    const imageDelay = imgReason === "asked"
      ? 2000 + Math.random() * 2000
      : 4000 + Math.random() * 6000;

    setTimeout(async () => {
      try {
        if (imageDecision.type === "meera") {
          // Check if community videos are available — if so, sometimes send video instead
          const hasMeeraVids = await meeraVideos.hasVideos();
          // Detect if user explicitly asked for a video (not meme/reel/funny)
          const userAskedForVideo = imgReason === "asked" && /\b(video|vid)\b/i.test(text)
            && !/\b(funny|meme|reel|comedy|hasi|hansi|moja)\b/i.test(text);
          if (hasMeeraVids && tier !== "stranger" && tier !== "acquaintance") {
            if (userAskedForVideo) {
              // User explicitly asked for a video — always send Meera's community video
              console.log(`[Video] User ${userId} explicitly asked for video in ${tier} tier — sending Meera video`);
              const sentAsVideoNote = await maybeSendVideoNote(ctx, userId);
              if (sentAsVideoNote) return;
              const sentVid = await sendMeeraVideo(ctx, userId, imgReason as "asked" | "vibe" | "spontaneous", text);
              if (sentVid) return;
              // fallthrough to image if video send failed
            }
            // Feature 14: 10% chance to send as video note (close only, from community videos)
            const sentAsVideoNote = await maybeSendVideoNote(ctx, userId);
            if (sentAsVideoNote) return;

            // 20% chance to send a regular video instead of image
            if (Math.random() < 0.20) {
              const sentVid = await sendMeeraVideo(ctx, userId, imgReason as "asked" | "vibe" | "spontaneous", text);
              if (sentVid) return;
            }
          }

          const sent = await sendMeeraImage(ctx, userId, imgReason as "asked" | "vibe" | "spontaneous", text);
          if (!sent && imgReason === "asked") {
            await ctx.reply("ugh my camera's being weird rn 😩 later ok?");
            store.addMessage(userId, "assistant", "ugh my camera's being weird rn 😩 later ok?");
          }
        } else if (imageDecision.type === "generate" && imageDecision.prompt) {
          const sent = await sendGeneratedImage(ctx, userId, imageDecision.prompt);
          if (!sent) {
            await ctx.reply("couldn't make that rn 😩 try again later?");
            store.addMessage(userId, "assistant", "couldn't make that rn 😩 try again later?");
          }
        }
      } catch (err) {
        console.error(`[ImageGen] Mid-chat image failed for ${userId}:`, err);
      }
    }, imageDelay);
  }
}

/** Decide if Meera voice-replies to media — slightly higher chance since media is more expressive */
function shouldSendVoiceForMedia(tier: string): boolean {
  const timeMod = voiceTimeModifier();
  if (tier === "stranger") return false;
  if (tier === "acquaintance") return Math.random() < 0.10 * timeMod;
  if (tier === "comfortable") return Math.random() < 0.40 * timeMod;
  return Math.random() < Math.min(0.55 * timeMod, 0.85); // close
}

/** Handle media messages — Gemini Live processes, Meera decides voice vs text naturally */
async function handleMediaMessage(
  ctx: Context,
  parts: Array<Record<string, unknown>>
) {
  const userId = ctx.from!.id;
  const prevLastInteraction = store.getUser(userId).lastInteraction;
  store.updateUser(userId, {
    lastInteraction: Date.now(),
    chatId: ctx.chat!.id,
    firstName: ctx.from!.first_name,
    telegramUsername: (ctx.from as any).username,
    proactiveSent: false,
  });

  const tier = store.getComfortTier(userId);
  const mood = store.getMood(userId);

  // ── AI-driven behavior for media messages
  const gapMs = Date.now() - prevLastInteraction;
  const mediaBehavior = await getMeeraBehavior(userId, "[sent media]", tier, mood, gapMs, true);
  const useAudio = mediaBehavior.responseMode === "voice";

  // ── Photo reaction differentiation: classify what type of media this is
  const mediaType = classifyMedia(ctx);
  const mediaHint = getMediaReactionHint(mediaType, tier);

  // ── Reply context: what message is the user replying to with this media?
  let replyContext = getReplyContext(ctx, userId);
  if (replyContext.startsWith("__REPLY_TO_BOT_IMAGE__")) {
    replyContext = await resolveImageReplyContext(replyContext, userId);
  }
  if (replyContext.startsWith("__REPLY_TO_VOICE__")) {
    replyContext = await resolveVoiceReplyContext(replyContext);
  }
  if (replyContext) {
    // Prepend the reply context as a text part so Gemini/Ollama sees it
    parts.unshift({ text: replyContext });
  }

  // ── Add media reaction hint as a text part
  if (mediaHint) {
    parts.unshift({ text: mediaHint });
  }

  // ── AI-driven sleep/busy handling for media
  if (mediaBehavior.responseMode === "delay" && mediaBehavior.delayMinutes > 0) {
    store.addMessage(userId, "user", "[sent media]");
    const delayMs = mediaBehavior.delayMinutes * 60 * 1000;
    const reason = mediaBehavior.delayReason || "busy";
    console.log(`[Behavior] User ${userId} sent media while Meera is ${mediaBehavior.availability} — delay ${mediaBehavior.delayMinutes}min (${reason})`);
    setTimeout(async () => {
      try {
        const user = store.getUser(userId);
        const history = store.getRecentHistory(userId);
        const vibeHint = mediaBehavior.vibeContext ? `(${mediaBehavior.vibeContext}) ` : "";
        const messages = buildOllamaMessages(
          `${vibeHint}(You were ${mediaBehavior.availability} and just saw they sent you a photo/video/audio. React naturally — mention what you were doing briefly and address their media.)`,
          history, tier, user, mood
        );
        const reply = await ollamaChat(messages, user.ollamaKeys);
        store.addMessage(userId, "assistant", reply);
        await bot.telegram.sendMessage(ctx.chat!.id, reply);
      } catch (err) {
        console.error(`[Behavior] Delayed media reply failed for ${userId}:`, err);
      }
    }, delayMs);
    return;
  }

  if (mediaBehavior.responseMode === "leave_on_read") {
    store.addMessage(userId, "user", "[sent media]");
    console.log(`[Behavior] Left media on read: user ${userId}`);
    return;
  }

  // React to media message
  if (mediaBehavior.reactEmoji) {
    try { await ctx.reply(mediaBehavior.reactEmoji); } catch {}
  } else {
    maybeReact(ctx, userId, "[sent media]").catch(() => {});
  }

  // Typing fake-out before processing
  if (mediaBehavior.delayMultiplier >= 0.7) {
    await maybeTypingFakeout(ctx, tier, mediaBehavior.typingHesitation);
  }

  // ── Quote-reply from AI behavior
  const quoteReplyId = mediaBehavior.shouldQuote ? (ctx.message as any).message_id : undefined;

  const stopTyping = typingIndicator(ctx, useAudio ? "record_voice" : "typing");
  try {
    // Reset session so it picks up latest tier/persona/mood
    sessions.resetSession(userId);
    const session = await sessions.getSession(userId);
    const response = await session.send(parts as any);

    if (useAudio) {
      // Check if Gemini blocked/refused the response
      if (await isGeminiBlocked(response, store.getUser(userId).ollamaKeys)) {
        console.log(`[Bot] Gemini blocked media voice for user ${userId}, falling back to Ollama text`);
        sessions.resetSession(userId);
      } else {
        // Comfortable+ → send audio response directly from Gemini Live
        const sentMsgId = await sendGeminiResponse(ctx, response, quoteReplyId);

        // Save to history — use input transcription if available, tag as voice
        const userSaid = response.inputTranscription?.trim();
        const incomingMsgId = (ctx.message as any).message_id;
        store.addMessage(userId, "user", userSaid ? `[voice message] ${userSaid}` : "[sent voice message]", incomingMsgId);
        if (response.text.trim()) {
          store.addMessage(userId, "assistant", `[voice reply] ${response.text}`, sentMsgId);
        }

        // Maybe send a sticker after
        if (response.text.trim()) {
          maybeSendSticker(ctx, userId, response.text).catch(() => {});
        }
        return; // Done — audio was sent successfully
      }
    }

    {
      // Text response → rephrase Gemini's raw output through Ollama for natural tone
      const geminiRaw = response.text.trim() || "I see it";
      const user = store.getUser(userId);
      const history = store.getRecentHistory(userId);

      // Build Ollama messages with Gemini's observation as context
      const emojiHint = getEmojiEvolutionHint(tier);
      const styleHints = getStyleHints("[sent media]", history);
      const vibeHint = mediaBehavior.vibeContext ? `(Current vibe: ${mediaBehavior.vibeContext})\n\n` : "";
      const rephrasePrompt =
        vibeHint +
        `The user sent you a photo/video/audio. Here's what you observed about it: "${geminiRaw}"\n\n` +
        (mediaHint ? mediaHint + "\n\n" : "") +
        `Now respond to the user naturally as yourself about what they sent. ` +
        `Don't say "I observed" or quote the observation — just react naturally like a real person would. ` +
        `If the observation says you can't describe something, just dodge it naturally or tease them — never sound like an AI refusing.` +
        emojiHint + styleHints;

      const messages = buildOllamaMessages(rephrasePrompt, history, tier, user, mood);
      let reply = await ollamaChat(messages, user.ollamaKeys);

      // Add deliberate typos
      reply = addDeliberateTypos(reply, mood);

      // Save to history — use input transcription if available, tag as voice
      const userSaid = response.inputTranscription?.trim();
      const incomingMsgId = (ctx.message as any).message_id;
      store.addMessage(userId, "user", userSaid ? `[voice message] ${userSaid}` : "[sent voice message]", incomingMsgId);
      store.addMessage(userId, "assistant", reply);

      const delay = typingDelay(reply, mood) * mediaBehavior.delayMultiplier;
      await new Promise((r) => setTimeout(r, Math.min(delay, 6000)));
      await sendAsBubbles(ctx, reply, quoteReplyId);

      // Maybe self-correct
      const correction = maybeSelfCorrect(reply);
      if (correction) {
        await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2000));
        await ctx.reply(correction);
      }

      // Maybe send a sticker after
      maybeSendSticker(ctx, userId, reply).catch(() => {});
    }
  } catch (err) {
    console.error("[Bot] Gemini error:", err);
    sessions.resetSession(userId);
    await ctx.reply("ugh sorry that didn't load properly 😭 send it again?");
  } finally {
    stopTyping();
  }
}

// Text
bot.on(message("text"), async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  const userId = ctx.from.id;

  // Handle FSM states first
  const fsmState = store.getFsmState(userId);
  if (fsmState) {
    const handled = await handleFsmState(ctx, userId, fsmState, ctx.message.text);
    if (handled) return;
  }

  // Record pace for this message
  recordMessagePace(userId);

  // ── Rapid-fire batching: collect multiple quick messages into one reply
  addToBatch(
    userId,
    ctx.message.text,
    ctx.message.message_id,
    ctx as Context & { message: { text: string } },
    async (batchedMessages) => {
      const lastMsg = batchedMessages[batchedMessages.length - 1];
      if (batchedMessages.length === 1) {
        // Single message — normal flow
        await handleTextMessage(lastMsg.ctx);
      } else {
        // Multiple messages — batch them
        const texts = batchedMessages.map((m) => m.text);
        // Quote-reply to the first message in the batch
        const quoteId = shouldQuoteReply(
          store.getComfortTier(userId),
          texts.join(" ")
        ) ? batchedMessages[0].msgId : undefined;
        console.log(`[Batch] User ${userId} sent ${texts.length} messages in rapid succession, batching`);
        await handleTextMessage(lastMsg.ctx, texts, quoteId);
      }
    }
  );
});

// Photos
bot.on(message("photo"), async (ctx) => {
  const userId = ctx.from.id;

  // Check if user is contributing Meera images
  const fsmState = store.getFsmState(userId);
  if (fsmState === "waiting_for_meera_image") {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const caption = ctx.message.caption?.trim();

    if (!caption || caption.length < 5) {
      await ctx.reply(
        "⚠️ Please include a caption describing this photo (pose, mood, setting, outfit, etc.)\n\n" +
        "Example: \"Meera smiling at a cafe, holding coffee, warm afternoon light\"\n\n" +
        "Send the photo again with a caption.",
      );
      return;
    }

    const name = ctx.from.first_name + (ctx.from.last_name ? " " + ctx.from.last_name : "");
    const contributor = ctx.from.username ? `@${ctx.from.username}` : name;

    const image = await meeraImages.addImage(photo.file_id, caption, userId, contributor);
    const count = await meeraImages.getCount();

    await ctx.reply(
      `✅ Photo added! (${count} total in the pool)\n` +
      `📝 Caption: "${caption}"\n\n` +
      "Send another photo with caption, or /doneupload when finished.",
    );
    return;
  }

  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const base64 = await downloadFile(photo.file_id);
  const parts: Record<string, unknown>[] = [];
  if (ctx.message.caption) parts.push({ text: ctx.message.caption });
  parts.push({ inlineData: { data: base64, mimeType: "image/jpeg" } });
  await handleMediaMessage(ctx, parts);
});

// Voice messages
bot.on(message("voice"), async (ctx) => {
  const raw = await downloadFileBuffer(ctx.message.voice.file_id);
  const pcmBase64 = await convertToPcm16(raw);
  console.log("[Bot] Converted voice to PCM16 16kHz, size:", Math.round(Buffer.byteLength(pcmBase64, "base64") / 1024), "KB");
  await handleMediaMessage(ctx, [
    { inlineData: { data: pcmBase64, mimeType: "audio/pcm" } },
  ]);
});

// Audio files
bot.on(message("audio"), async (ctx) => {
  const raw = await downloadFileBuffer(ctx.message.audio.file_id);
  const pcmBase64 = await convertToPcm16(raw);
  console.log("[Bot] Converted audio to PCM16 16kHz, size:", Math.round(Buffer.byteLength(pcmBase64, "base64") / 1024), "KB");
  await handleMediaMessage(ctx, [{ inlineData: { data: pcmBase64, mimeType: "audio/pcm" } }]);
});

// Videos — extract frame + audio since Gemini Live can't handle raw video inline
bot.on(message("video"), async (ctx) => {
  const userId = ctx.from.id;

  // Check if user is contributing community videos
  const fsmState = store.getFsmState(userId);
  if (fsmState === "waiting_for_meera_video") {
    const caption = ctx.message.caption?.trim();

    if (!caption || caption.length < 5) {
      await ctx.reply(
        "⚠️ Please include a caption describing this video (context, mood, setting, etc.)\n\n" +
        "Example: \"Meera waving hello at a park, sunny afternoon, playful mood\"\n\n" +
        "Send the video again with a caption.",
      );
      return;
    }

    const name = ctx.from.first_name + (ctx.from.last_name ? " " + ctx.from.last_name : "");
    const contributor = ctx.from.username ? `@${ctx.from.username}` : name;

    await meeraVideos.addVideo(ctx.message.video.file_id, caption, userId, contributor);
    const count = await meeraVideos.getCount();

    await ctx.reply(
      `✅ Video added! (${count} total in the pool)\n` +
      `📝 Caption: "${caption}"\n\n` +
      "Send another video with caption, or /donevideoupload when finished.",
    );
    return;
  }

  const fileSize = ctx.message.video.file_size ?? 0;
  if (fileSize > 15 * 1024 * 1024) {
    await ctx.reply("⚠️ Video is too large (max 15 MB). Send a shorter clip.");
    return;
  }
  const raw = await downloadFileBuffer(ctx.message.video.file_id);
  const parts: Record<string, unknown>[] = [];
  if (ctx.message.caption) parts.push({ text: ctx.message.caption });

  // Extract a frame as JPEG for visual context
  try {
    const frameBase64 = await extractVideoFrame(raw);
    parts.push({ inlineData: { data: frameBase64, mimeType: "image/jpeg" } });
  } catch (err) {
    console.error("[Bot] Failed to extract video frame:", err);
  }

  // Extract audio for audio context
  try {
    const audioBase64 = await extractVideoAudio(raw);
    if (audioBase64) {
      parts.push({ inlineData: { data: audioBase64, mimeType: "audio/pcm;rate=16000" } });
    }
  } catch (err) {
    console.error("[Bot] Failed to extract video audio:", err);
  }

  // Add a hint that this is a video
  if (!ctx.message.caption) {
    parts.push({ text: "(The user sent you a video. You're seeing a frame from it and hearing its audio.)" });
  }

  await handleMediaMessage(ctx, parts);
});

// Video notes (circle videos) — extract frame + audio
bot.on(message("video_note"), async (ctx) => {
  const fileSize = ctx.message.video_note.file_size ?? 0;
  if (fileSize > 15 * 1024 * 1024) {
    await ctx.reply("⚠️ Video note is too large.");
    return;
  }
  const raw = await downloadFileBuffer(ctx.message.video_note.file_id);
  const parts: Record<string, unknown>[] = [];

  // Extract a frame as JPEG
  try {
    const frameBase64 = await extractVideoFrame(raw);
    parts.push({ inlineData: { data: frameBase64, mimeType: "image/jpeg" } });
  } catch (err) {
    console.error("[Bot] Failed to extract video_note frame:", err);
  }

  // Extract audio
  try {
    const audioBase64 = await extractVideoAudio(raw);
    if (audioBase64) {
      parts.push({ inlineData: { data: audioBase64, mimeType: "audio/pcm;rate=16000" } });
    }
  } catch (err) {
    console.error("[Bot] Failed to extract video_note audio:", err);
  }

  parts.push({ text: "(The user sent you a circle video / video note of themselves. React to what you see and hear.)" });

  await handleMediaMessage(ctx, parts);
});

// Documents (images / videos sent as files)
bot.on(message("document"), async (ctx) => {
  const mime = ctx.message.document.mime_type ?? "";
  if (!mime.startsWith("image/") && !mime.startsWith("video/")) {
    await ctx.reply("I can process images and videos. Send me a photo, video, or text!");
    return;
  }
  const fileSize = ctx.message.document.file_size ?? 0;
  if (fileSize > 15 * 1024 * 1024) {
    await ctx.reply("⚠️ File is too large (max 15 MB).");
    return;
  }

  if (mime.startsWith("video/")) {
    // Video document — extract frame + audio like regular videos
    const raw = await downloadFileBuffer(ctx.message.document.file_id);
    const parts: Record<string, unknown>[] = [];
    if (ctx.message.caption) parts.push({ text: ctx.message.caption });
    try {
      const frameBase64 = await extractVideoFrame(raw);
      parts.push({ inlineData: { data: frameBase64, mimeType: "image/jpeg" } });
    } catch (err) {
      console.error("[Bot] Failed to extract doc video frame:", err);
    }
    try {
      const audioBase64 = await extractVideoAudio(raw);
      if (audioBase64) {
        parts.push({ inlineData: { data: audioBase64, mimeType: "audio/pcm;rate=16000" } });
      }
    } catch (err) {
      console.error("[Bot] Failed to extract doc video audio:", err);
    }
    if (!ctx.message.caption) {
      parts.push({ text: "(The user sent you a video file. You're seeing a frame from it and hearing its audio.)" });
    }
    await handleMediaMessage(ctx, parts);
  } else {
    // Image document — send directly
    const base64 = await downloadFile(ctx.message.document.file_id);
    const parts: Record<string, unknown>[] = [];
    if (ctx.message.caption) parts.push({ text: ctx.message.caption });
    parts.push({ inlineData: { data: base64, mimeType: mime } });
    await handleMediaMessage(ctx, parts);
  }
});

// ── POLL ANSWER HANDLER ──────────────────────────────────────────────

bot.on("poll_answer", async (ctx) => {
  const answer = ctx.pollAnswer;
  if (!answer) return;

  const pollId = answer.poll_id;
  const poll = activePolls.get(pollId);
  if (!poll) return; // Not a poll we sent

  const userId = answer.user?.id ?? poll.userId;
  const chosenIndices = answer.option_ids;
  if (!chosenIndices || chosenIndices.length === 0) return; // Retracted vote

  const chosenOptions = chosenIndices
    .map((i: number) => poll.options[i])
    .filter(Boolean);
  if (chosenOptions.length === 0) return;

  const chosenText = chosenOptions.join(", ");

  // Log to history so Meera has context
  store.addMessage(poll.userId, "user", `[poll answer: chose "${chosenText}" for "${poll.question}"]`);
  console.log(`[PollAnswer] User ${userId} chose "${chosenText}" for "${poll.question}"`);

  // Let Ollama decide naturally whether to react and what to say
  try {
    const user = store.getUser(poll.userId);
    const tier = store.getComfortTier(poll.userId);
    const mood = store.getMood(poll.userId);
    const history = store.getRecentHistory(poll.userId);

    // Feed it like a normal conversation — Ollama decides the response naturally
    const userMsg = `[The user just answered your poll "${poll.question}" — they chose "${chosenText}"]`;
    const messages = buildOllamaMessages(userMsg, history, tier, user, mood);
    const behavior = await decideResponseBehavior(ollamaConfig, userMsg, history, {
      tier,
      mood,
      timeOfDay: `${getISTHour()} IST`,
      personaHint: user.customPersona?.slice(0, 500),
    });

    // Ollama decides: maybe she ignores it, delays, or reacts
    if (behavior.action === "leave_on_read") {
      console.log(`[PollAnswer] Meera left poll answer on read for user ${userId}`);
      activePolls.delete(pollId);
      return;
    }

    if (behavior.action === "delay_reply") {
      console.log(`[PollAnswer] Meera will react to poll later for user ${userId} (${behavior.delayMinutes}min)`);
      const delayMs = behavior.delayMinutes * 60 * 1000;
      setTimeout(async () => {
        try {
          const freshHistory = store.getRecentHistory(poll.userId);
          const freshUser = store.getUser(poll.userId);
          const freshMood = store.getMood(poll.userId);
          const freshTier = store.getComfortTier(poll.userId);
          const msgs = buildOllamaMessages(userMsg, freshHistory, freshTier, freshUser, freshMood);
          let reply = await ollamaChat(msgs, freshUser.ollamaKeys);
          reply = addDeliberateTypos(reply, freshMood);
          await bot.telegram.sendChatAction(poll.chatId, "typing");
          await new Promise(r => setTimeout(r, typingDelay(reply)));
          await bot.telegram.sendMessage(poll.chatId, reply);
          store.addMessage(poll.userId, "assistant", reply);
        } catch {}
      }, delayMs);
      activePolls.delete(pollId);
      return;
    }

    if (behavior.action === "emoji_only") {
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
      await bot.telegram.sendMessage(poll.chatId, behavior.emoji);
      store.addMessage(poll.userId, "assistant", behavior.emoji);
      activePolls.delete(pollId);
      return;
    }

    // Normal reply — let Ollama generate naturally
    let reply = await ollamaChat(messages, user.ollamaKeys);
    reply = addDeliberateTypos(reply, mood);
    if (!reply || reply.length > 300) { activePolls.delete(pollId); return; }

    // Natural delay
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
    await bot.telegram.sendChatAction(poll.chatId, "typing");
    await new Promise(r => setTimeout(r, typingDelay(reply)));
    await bot.telegram.sendMessage(poll.chatId, reply);
    store.addMessage(poll.userId, "assistant", reply);
  } catch (err) {
    console.error(`[PollAnswer] Failed for user ${userId}:`, err);
  }

  // Clean up
  activePolls.delete(pollId);
});

// ── POLL MESSAGE HANDLER (user sends a poll to Meera) ────────────────

bot.on(message("poll"), async (ctx) => {
  const userId = ctx.from!.id;
  const poll = ctx.message.poll;

  store.updateUser(userId, {
    lastInteraction: Date.now(),
    chatId: ctx.chat!.id,
    firstName: ctx.from!.first_name,
    telegramUsername: (ctx.from as any).username,
    proactiveSent: false,
  });

  const tier = store.getComfortTier(userId);
  const mood = store.getMood(userId);
  const user = store.getUser(userId);
  const history = store.getRecentHistory(userId);

  const question = poll.question;
  const options = poll.options.map((o: any) => o.text);

  // Log poll to history
  store.addMessage(userId, "user", `[sent poll: "${question}" — options: ${options.join(", ")}]`);
  console.log(`[Poll] User ${userId} sent poll: "${question}"`);

  // React to the poll message (async)
  maybeReact(ctx, userId, `[poll: ${question}]`).catch(() => {});

  // Build the prompt for Meera to answer the poll
  const pollAnswerPrompt = `The user just sent you a poll in the chat.\n\nQuestion: "${question}"\nOptions:\n${options.map((o: string, i: number) => `${i + 1}. ${o}`).join("\n")}\n\nAnswer this poll naturally like a real person would — pick an option and say why (or don't explain, just pick one casually). Be natural, like you're actually voting and telling them your choice. Keep it short (1-2 lines max). Match the chat language.`;

  // Decide voice vs text based on comfort tier
  const useVoice = shouldSendVoice(tier, question, voiceTimeModifier());

  try {
    if (useVoice) {
      // Voice reply via Gemini
      const readTime = readDelay(question);
      await new Promise((r) => setTimeout(r, readTime));
      const stopTyping = typingIndicator(ctx, "record_voice");
      try {
        sessions.resetSession(userId);
        const session = await sessions.getSession(userId);
        const response = await session.send([{ text: pollAnswerPrompt }]);
        stopTyping();

        if (await isGeminiBlocked(response, user.ollamaKeys)) {
          // Fallback to text
          const messages = buildOllamaMessages(pollAnswerPrompt, history, tier, user, mood);
          let reply = await ollamaChat(messages, user.ollamaKeys);
          reply = stripInternalArtifacts(reply);
          reply = addDeliberateTypos(reply, mood);
          store.addMessage(userId, "assistant", reply);
          await sendAsBubbles(ctx, reply);
        } else {
          const sentVoiceMsgId = await sendGeminiResponse(ctx, response);
          if (response.text.trim()) {
            store.addMessage(userId, "assistant", `[voice reply] ${response.text}`, sentVoiceMsgId);
          }
        }
      } catch (err) {
        console.error("[Bot] Poll voice error:", err);
        stopTyping();
        sessions.resetSession(userId);
        // Fallback to text
        const messages = buildOllamaMessages(pollAnswerPrompt, history, tier, user, mood);
        let reply = await ollamaChat(messages, user.ollamaKeys);
        reply = stripInternalArtifacts(reply);
        reply = addDeliberateTypos(reply, mood);
        store.addMessage(userId, "assistant", reply);
        await sendAsBubbles(ctx, reply);
      }
    } else {
      // Text reply
      const readTime = readDelay(question);
      await new Promise((r) => setTimeout(r, readTime));

      const stopTyping = typingIndicator(ctx, "typing");
      const messages = buildOllamaMessages(pollAnswerPrompt, history, tier, user, mood);
      let reply = await ollamaChat(messages, user.ollamaKeys);
      reply = stripInternalArtifacts(reply);
      reply = addDeliberateTypos(reply, mood);
      store.addMessage(userId, "assistant", reply);

      const delay = typingDelay(reply) * timeOfDayMultiplier();
      await new Promise((r) => setTimeout(r, Math.min(delay, 6000)));
      stopTyping();

      await sendAsBubbles(ctx, reply);
      maybeSendSticker(ctx, userId, reply).catch(() => {});
    }
  } catch (err) {
    console.error("[Bot] Poll answer error:", err);
  }
});

// ── MESSAGE REACTION HANDLER (user reacts to Meera's message) ────────

bot.on("message_reaction", async (ctx) => {
  const update = (ctx as any).update?.message_reaction;
  if (!update) return;

  const userId = update.user?.id;
  if (!userId) return;

  // Ignore reactions from the bot itself
  const botId = (ctx as any).botInfo?.id;
  if (userId === botId) return;

  const chatId = update.chat.id;

  // Get new reactions (added) — ignore reaction removals
  const newReactions = update.new_reaction || [];
  const oldReactions = update.old_reaction || [];
  if (newReactions.length === 0) return;
  // If same or fewer reactions, it's a removal/change — still process new ones
  if (newReactions.length <= oldReactions.length && oldReactions.length > 0) return;

  const reactionEmoji = newReactions[0]?.emoji || "";
  if (!reactionEmoji) return;

  // Load user data
  await store.ensureLoaded(userId);

  const tier = store.getComfortTier(userId);
  const mood = store.getMood(userId);
  const user = store.getUser(userId);
  const history = store.getRecentHistory(userId);

  // Find the message that was reacted to from history
  const reactedMsgId = update.message_id;
  let reactedMsg = "";
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].msgId === reactedMsgId) {
      reactedMsg = history[i].content;
      break;
    }
  }

  // Log reaction to history
  const reactedPreview = reactedMsg ? reactedMsg.slice(0, 100) : "a message";
  store.addMessage(userId, "user", `[reacted ${reactionEmoji} to: "${reactedPreview}"]`);
  console.log(`[Reaction] User ${userId} reacted ${reactionEmoji} to msg ${reactedMsgId}`);

  // Probability of responding to a reaction — scales with comfort tier
  let respondProb: number;
  switch (tier) {
    case "stranger": respondProb = 0.05; break;
    case "acquaintance": respondProb = 0.15; break;
    case "comfortable": respondProb = 0.35; break;
    case "close": respondProb = 0.50; break;
    default: respondProb = 0.10;
  }

  if (Math.random() > respondProb) {
    console.log(`[Reaction] Skipping response for user ${userId} (${tier}, prob=${respondProb})`);
    return;
  }

  // Build context for Ollama
  const reactionContext = reactedMsg
    ? `The user just reacted to your message "${reactedMsg.slice(0, 200)}" with ${reactionEmoji}.`
    : `The user just reacted to one of your messages with ${reactionEmoji}.`;

  const reactionPrompt = `${reactionContext}\n\nRespond naturally to this reaction like a real person would. Keep it very short (1 line, max 15 words). Sometimes tease them about the reaction, acknowledge it, or just send an emoji back. Match the chat language. If the reaction seems negative (👎🙄😡), maybe act defensive or playful. If positive (❤😂🔥), be happy about it. Don't over-explain, just react naturally.`;

  // Natural delay before responding
  await new Promise((r) => setTimeout(r, 2000 + Math.random() * 5000));

  // Decide voice vs text based on comfort tier
  const useVoice = shouldSendVoice(tier, reactionEmoji, voiceTimeModifier());

  try {
    if (useVoice) {
      // Voice reply via Gemini
      try {
        await bot.telegram.sendChatAction(chatId, "record_voice");
        sessions.resetSession(userId);
        const session = await sessions.getSession(userId);
        const response = await session.send([{ text: reactionPrompt }]);

        if (await isGeminiBlocked(response, user.ollamaKeys)) {
          // Fallback to text
          const messages = buildOllamaMessages(reactionPrompt, history, tier, user, mood);
          let reply = await ollamaChat(messages, user.ollamaKeys);
          reply = stripInternalArtifacts(reply);
          reply = addDeliberateTypos(reply, mood);
          store.addMessage(userId, "assistant", reply);
          await bot.telegram.sendMessage(chatId, reply);
        } else {
          const { audioChunks } = response;
          let sentVoiceMsgId: number | undefined;
          if (audioChunks.length > 0) {
            const wav = pcmToWav(audioChunks);
            const sent = await bot.telegram.sendVoice(chatId, { source: wav, filename: "reaction.wav" });
            sentVoiceMsgId = sent.message_id;
          }
          if (response.text.trim()) {
            store.addMessage(userId, "assistant", `[voice reply] ${response.text}`, sentVoiceMsgId);
          }
        }
      } catch (err) {
        console.error("[Reaction] Gemini voice failed, falling back to text:", err);
        sessions.resetSession(userId);
        const messages = buildOllamaMessages(reactionPrompt, history, tier, user, mood);
        let reply = await ollamaChat(messages, user.ollamaKeys);
        reply = stripInternalArtifacts(reply);
        reply = addDeliberateTypos(reply, mood);
        store.addMessage(userId, "assistant", reply);
        await bot.telegram.sendMessage(chatId, reply);
      }
    } else {
      // Text reply
      await bot.telegram.sendChatAction(chatId, "typing");
      const messages = buildOllamaMessages(reactionPrompt, history, tier, user, mood);
      let reply = await ollamaChat(messages, user.ollamaKeys);
      reply = stripInternalArtifacts(reply);
      reply = addDeliberateTypos(reply, mood);
      store.addMessage(userId, "assistant", reply);

      const delay = typingDelay(reply) * timeOfDayMultiplier();
      await new Promise((r) => setTimeout(r, Math.min(delay, 4000)));
      await bot.telegram.sendMessage(chatId, reply);
    }

    console.log(`[Reaction] Responded to ${reactionEmoji} from user ${userId} via ${useVoice ? "voice" : "text"}`);
  } catch (err) {
    console.error(`[Reaction] Failed for user ${userId}:`, err);
  }
});

// ── PROACTIVE MESSAGING ─────────────────────────────────────────────

async function proactiveLoop() {
  const now = Date.now();
  let candidates = 0;
  let totalSent = 0;
  for (const userId of store.allUserIds()) {
    const user = store.getUser(userId);
    if (!user.chatId) continue;

    const tier = store.getComfortTier(userId);
    const threshold = INACTIVITY_THRESHOLDS[tier];
    if (!threshold) continue;

    // If we already pinged this user and they haven't replied, throttle:
    // don't re-ping until at least `threshold` has passed since the last ping.
    // This prevents spamming but also prevents the bot from going *permanently* silent.
    if (user.proactiveSent) {
      const sinceLastPing = now - (user.lastProactiveSentAt || 0);
      if (sinceLastPing < threshold) continue;
    }

    const elapsed = now - user.lastInteraction;
    const mood = store.getMood(userId);
    const engagement = store.getEngagement(userId);
    candidates++;

    // ── Mood + engagement adjusted thresholds ──
    // Clingy/bored mood → she reaches out sooner. Tired/annoyed → later or skips.
    // High engagement → reaches out sooner (she's invested).
    let adjustedThreshold = threshold;
    if (mood === "clingy") adjustedThreshold *= 0.6;         // reaches out 40% sooner
    else if (mood === "bored") adjustedThreshold *= 0.7;     // bored, looking for convo
    else if (mood === "excited") adjustedThreshold *= 0.8;    // wants to share excitement
    else if (mood === "tired" || mood === "annoyed") adjustedThreshold *= 1.5; // not in the mood
    // Engagement factor: high engagement (80+) → reach out sooner, low (<30) → much later
    if (engagement >= 80) adjustedThreshold *= 0.7;
    else if (engagement >= 60) adjustedThreshold *= 0.85;
    else if (engagement < 30) adjustedThreshold *= 1.4;

    if (elapsed < adjustedThreshold) continue;

    // Add some randomness — don't always ping exactly at threshold
    // 30% chance to skip this cycle (makes timing feel less robotic)
    if (Math.random() < 0.3) continue;

    // Don't send proactive pings at weird hours — use lifestyle schedule
    const hour = getISTHour();
    if (hour >= 1 && hour < 7) continue; // 1-7 AM: she's asleep
    if (hour >= 23) { // 11 PM+: only for close friends with high engagement
      if (tier !== "close" || engagement < 60) continue;
    }

    // ── Content sharing: mood-influenced chance
    // Happy/bored → more likely to share random stuff. Tired → less likely.
    let shareChance = 0.20;
    if (mood === "bored" || mood === "happy") shareChance = 0.35;
    else if (mood === "excited") shareChance = 0.30;
    else if (mood === "tired") shareChance = 0.08;
    const shareContent = (tier === "comfortable" || tier === "close") && Math.random() < shareChance;
    let prompt = shareContent
      ? (CONTENT_SHARE_PROMPTS[tier] ?? INITIATE_PROMPTS[tier])
      : INITIATE_PROMPTS[tier];
    if (!prompt) continue;

    // If user has a custom persona, override the culture-specific parts of proactive prompts
    if (user.customPersona) {
      prompt = `You are initiating a message to a user you haven't heard from in a while. Stay in character as defined by your system prompt.\n\n${prompt}\n\nIMPORTANT: Adapt the style/language/vibe of your message to match YOUR character's persona, not necessarily the examples above. The examples are just for format reference.`;
    }

    try {
      // Feature 15: Sometimes forward own previous message instead of new one (close only)
      if (await maybeForwardOwnMessage(user.chatId, userId)) {
        store.updateUser(userId, { proactiveSent: true, lastProactiveSentAt: Date.now() });
        totalSent++;
        console.log(`[Proactive] Forwarded own msg to user ${userId} (${tier})`);
        continue;
      }

      // ── If content sharing, try to send an actual meme/video/YouTube Short
      if (shareContent) {
        const post = await getRandomContentAny(userId);
        if (post) {
          // Use a fake context for sendContentToChat — we need to build one with chatId
          const fakeCtx = {
            chat: { id: user.chatId },
            telegram: bot.telegram,
            sendChatAction: (action: any) => bot.telegram.sendChatAction(user.chatId, action),
          } as unknown as Context;

          const sent = await sendContentToChat(fakeCtx, userId, post, "random");
          if (sent) {
            store.updateUser(userId, { proactiveSent: true, lastProactiveSentAt: Date.now() });
            totalSent++;

            // Double-text after meme: 30% chance
            if (Math.random() < 0.30) {
              const followUps = tier === "close"
                ? ["😭😭😭", "i'm DEAD", "bro please", "tell me this isnt funny", "💀💀"]
                : ["😂", "lol", "hehehe", "👀"];
              const followUp = followUps[Math.floor(Math.random() * followUps.length)];
              await new Promise((r) => setTimeout(r, 2000 + Math.random() * 5000));
              await bot.telegram.sendMessage(user.chatId, followUp);
              store.addMessage(userId, "assistant", followUp);
            }
            continue;
          }
          // If send failed, fall through to text-only content share below
        }
      }

      const history = store.getRecentHistory(userId);
      const messages = buildOllamaMessages(prompt, history, tier, user, mood);
      const reply = await ollamaChat(messages, user.ollamaKeys);

      // Simulate typing delay before sending
      await bot.telegram.sendChatAction(user.chatId, "typing");
      const delay = Math.min(typingDelay(reply), 3000);
      await new Promise((r) => setTimeout(r, delay));

      // Feature 6: Send silently late at night
      const proactiveSilent = shouldSendSilently();
      const proactiveOpts: Record<string, unknown> = {};
      if (proactiveSilent) proactiveOpts.disable_notification = true;

      await bot.telegram.sendMessage(user.chatId, reply, proactiveOpts);
      store.addMessage(userId, "assistant", reply);

      // Track for forwarding (Feature 15)
      // We don't have the msg_id easily here, but that's OK — forward tracks separately

      // Double-text: 25% chance for comfortable+, send a follow-up
      if ((tier === "comfortable" || tier === "close") && Math.random() < 0.25) {
        const followUps = tier === "close"
          ? ["hellooo", "😤", "🙄", "answer me", "oye", "uff", "👀", "rude"]
          : ["?", "👀", "helloo", "😶"];
        const followUp = followUps[Math.floor(Math.random() * followUps.length)];
        const gap = 3000 + Math.random() * 8000; // 3-11s later
        await new Promise((r) => setTimeout(r, gap));
        await bot.telegram.sendMessage(user.chatId, followUp, proactiveOpts);
        store.addMessage(userId, "assistant", followUp);
      }

      store.updateUser(userId, { proactiveSent: true, lastProactiveSentAt: Date.now() });
      totalSent++;
      console.log(`[Proactive] Sent to user ${userId} (${tier}, mood=${mood}${shareContent ? ", content-share" : ""})`);
    } catch (err) {
      console.error(`[Proactive] Failed for user ${userId}:`, err);
    }
  }
  console.log(`[Proactive] Loop done — ${candidates} candidate(s), ${totalSent} message(s) sent`);
}

// ── LAUNCH ──────────────────────────────────────────────────────────

console.log(`Starting ${botName} Telegram bot...`);

bot.launch({ allowedUpdates: ["message", "callback_query", "poll_answer", "message_reaction"] }).then(async () => {
  console.log(`🤖 ${botName} Telegram bot is running!`);

  // Register commands so Telegram shows autocomplete suggestions when user types /
  await bot.telegram.setMyCommands([
    { command: "profile", description: "Your profile" },
    { command: "setname", description: "Set your name" },
    { command: "setbio", description: "Set your bio" },
    { command: "tone", description: "Change tone (casual/formal)" },
    { command: "replies_short", description: "Short replies" },
    { command: "replies_medium", description: "Medium replies" },
    { command: "replies_long", description: "Long replies" },
    { command: "talk", description: "Toggle voice-only mode" },
    { command: "clear", description: "Reset conversation" },
    { command: "reset", description: "Full session reset" },
    { command: "persona", description: "Customize AI personality" },
    { command: "viewpersona", description: "View your custom persona" },
    { command: "resetpersona", description: "Reset to default persona" },
    { command: "addstickers", description: "Add a sticker pack" },
    { command: "stickers", description: "List sticker packs" },
    { command: "removestickers", description: "Remove a sticker pack" },
    { command: "addkey", description: "Add your Ollama API key" },
    { command: "keys", description: "List your API keys" },
    { command: "removekey", description: "Remove an API key" },
    { command: "contribute", description: "Donate a chat key for everyone" },
    { command: "communitykeys", description: "View community key pool" },
    { command: "removecontribution", description: "Remove your donated key" },
    { command: "addimagekey", description: "Add your Stability AI key" },
    { command: "imagekeys", description: "List your image API keys" },
    { command: "removeimagekey", description: "Remove an image API key" },
    { command: "contributeimage", description: "Donate an image key" },
    { command: "imagepool", description: "View image community keys" },
    { command: "removeimagecontribution", description: "Remove donated image key" },
    { command: "contributeface", description: "How to contribute photos" },
    { command: "uploadface", description: "Upload Meera images" },
    { command: "facepool", description: "View contributed images" },
    { command: "removeface", description: "Remove your contributed image" },
    { command: "uploadvideo", description: "Upload community videos" },
    { command: "videopool", description: "View contributed videos" },
    { command: "removevideo", description: "Remove your contributed video" },
    { command: "help", description: "Show all commands" },
  ]).catch((e) => console.warn("Failed to set bot commands:", e));

  // Pre-load community keys and global sticker packs
  await store.loadCommunityKeys();
  await store.loadGlobalStickerPacks();

  // Bulk-load every known user so the proactive loop can see users who
  // haven't messaged since the last restart.
  await store.loadAllUsers();

  // Check for proactive messages every 5 minutes — and run once shortly after startup
  setTimeout(() => proactiveLoop().catch(console.error), 30 * 1000);
  setInterval(() => proactiveLoop().catch(console.error), 5 * 60 * 1000);

  // Start auto-DP manager (changes bot profile photo like a real girl)
  dpManager.start();
}).catch((err) => {
  console.error("Failed to launch bot:", err);
  process.exit(1);
});

process.once("SIGINT", async () => {
  bot.stop("SIGINT");
  dpManager.stop();
  sessions.destroy();
  await store.destroy();
});
process.once("SIGTERM", async () => {
  bot.stop("SIGTERM");
  dpManager.stop();
  sessions.destroy();
  await store.destroy();
});
