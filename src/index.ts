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
} from "./config.js";
import {
  callOllama,
  callOllamaWithRotation,
  pickReactionEmoji,
  pickStickerEmoji,
  type OllamaConfig,
} from "./ollama-service.js";
import { UserStore } from "./user-store.js";
import { getRandomContentAny, shouldShareContentMidChat, type ContentPost } from "./reddit-memes.js";
import type { Context } from "telegraf";
import type { GeminiResponse } from "./gemini-session.js";

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

// ── BOT & SESSIONS ─────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
const FIREBASE_DB_ID = process.env.FIREBASE_DATABASE_ID || "(default)";
const store = new UserStore(50, FIREBASE_DB_ID);

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
function typingDelay(text: string): number {
  const words = text.split(/\s+/).length;
  // Base: 1.5-3.5s + ~80ms per word, capped at 6s
  const base = 1500 + Math.random() * 2000;
  return Math.min(base + words * 80, 6000);
}

/** Simulate "reading" the message before typing — real girls don't start typing instantly */
function readDelay(userMessage: string): number {
  const len = userMessage.length;
  // Short messages: 0.5-1.5s read time
  // Longer messages: up to 3s
  const base = 500 + Math.random() * 1000;
  const extra = Math.min(len * 15, 1500);
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

/** Extra delay multiplier based on time of day — slower at night, normal during day */
function timeOfDayMultiplier(): number {
  const hour = getISTHour();
  if (hour >= 1 && hour < 6) return 3.0;    // 1-6 AM: very slow (sleeping)
  if (hour >= 6 && hour < 8) return 1.8;     // 6-8 AM: groggy/waking up
  if (hour >= 23 || hour < 1) return 2.0;    // 11 PM - 1 AM: sleepy
  if (hour >= 8 && hour < 10) return 1.2;    // morning routine
  return 1.0;                                 // normal hours
}

/** Should the bot ignore/delay-reply based on time? Returns delay in ms, or 0 for normal */
function lateNightDelay(): number {
  const hour = getISTHour();
  if (hour >= 2 && hour < 6) {
    // 2-6 AM: 50% chance of not replying for 10-30 min (she's sleeping!)
    if (Math.random() < 0.5) {
      return (10 + Math.random() * 20) * 60 * 1000;
    }
  }
  return 0;
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
async function sendAsBubbles(ctx: Context, text: string, replyToMsgId?: number): Promise<number | undefined> {
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
    // Only quote-reply on the first bubble
    const sent = await sendText(ctx, bubbles[i], i === 0 ? replyToMsgId : undefined);
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
async function maybeTypingFakeout(ctx: Context, tier: string): Promise<void> {
  // Only for comfortable+ and 10% of the time
  if (tier === "stranger" || tier === "acquaintance") return;
  if (Math.random() > 0.10) return;

  // Start typing
  await ctx.sendChatAction("typing").catch(() => {});
  // Type for 1-3 seconds
  await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
  // Stop (just don't send any more typing actions)
  // Pause for 2-5 seconds (she deleted what she was typing)
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

// ── READ RECEIPT GAMING (advanced) ──────────────────────────────────

/**
 * More sophisticated read-receipt behavior.
 * Sometimes: read instantly but reply late. Sometimes: don't even "read" for a while.
 * Returns: { readDelay: ms, replyDelay: ms, showTypingFirst: boolean }
 */
function readReceiptStrategy(tier: string, mood: string): { readDelay: number; replyDelay: number; showTypingFirst: boolean } {
  // Strangers/acquaintances: mostly normal behavior
  if (tier === "stranger" || tier === "acquaintance") {
    return { readDelay: 0, replyDelay: 0, showTypingFirst: false };
  }

  const strategies = Math.random();

  if (mood === "annoyed" || mood === "sassy") {
    // More likely to leave them hanging
    if (strategies < 0.20) {
      // Read instantly, reply after 3-8 min (making them wait on purpose)
      return { readDelay: 0, replyDelay: (3 + Math.random() * 5) * 60 * 1000, showTypingFirst: true };
    }
  }

  if (mood === "clingy") {
    // Reply fast when clingy
    return { readDelay: 0, replyDelay: 0, showTypingFirst: false };
  }

  if (mood === "bored") {
    // 15% chance: read but take a while to reply
    if (strategies < 0.15) {
      return { readDelay: 0, replyDelay: (2 + Math.random() * 4) * 60 * 1000, showTypingFirst: false };
    }
  }

  // General: 8% chance of "didn't see it for a few minutes"
  if (strategies < 0.08) {
    return { readDelay: (1 + Math.random() * 3) * 60 * 1000, replyDelay: 0, showTypingFirst: false };
  }

  return { readDelay: 0, replyDelay: 0, showTypingFirst: false };
}

// ── LEAVE ON READ ───────────────────────────────────────────────────

/** Check if message is low-effort enough to potentially ignore */
function shouldLeaveOnRead(tier: string, userText: string): boolean {
  const text = userText.trim().toLowerCase();

  // Only for comfortable+ tiers (strangers/acquaintances always get replies)
  if (tier === "stranger" || tier === "acquaintance") return false;

  // Low-effort patterns
  const lowEffort = /^(ok|okay|k|kk|hmm|hm|oh|ah|mm|mhm|acha|accha|thik|theek|haan|ha|ji)$/i;
  if (!lowEffort.test(text)) return false;

  // 20% chance to leave on read for comfortable, 30% for close
  const prob = tier === "close" ? 0.30 : 0.20;
  return Math.random() < prob;
}

// ── DELAYED REPLY QUEUE ─────────────────────────────────────────────

interface DelayedReply {
  chatId: number;
  userId: number;
  userText: string;
  timer: ReturnType<typeof setTimeout>;
}

const delayedReplies = new Map<number, DelayedReply>();

/** Schedule a delayed reply (seen-but-reply-later behavior) */
function scheduleDelayedReply(
  ctx: Context & { message: { text: string } },
  userId: number,
  delayMs: number
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

      // Add context that she's replying late
      const lateContext = Math.random() < 0.5
        ? `(You're replying a bit late — you were busy/sleeping. Don't apologize too much, just reply naturally. Maybe a quick "sorry just saw this" or just answer directly.)`
        : `(You're replying late. Don't mention it unless it feels natural.)`;

      const messages = buildOllamaMessages(
        lateContext + "\n\nTheir message: " + userText,
        history,
        tier,
        user,
        mood
      );
      let reply = await callOllamaWithRotation(ollamaConfig, messages, user.ollamaKeys);
      reply = addDeliberateTypos(reply, mood);

      store.addMessage(userId, "user", userText);
      store.addMessage(userId, "assistant", reply);

      await bot.telegram.sendChatAction(chatId, "typing");
      const delay = Math.min(typingDelay(reply), 3000);
      await new Promise((r) => setTimeout(r, delay));

      await bot.telegram.sendMessage(chatId, reply);
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
async function sendGeminiResponse(ctx: Context, response: GeminiResponse, replyToMsgId?: number) {
  const { audioChunks } = response;
  if (audioChunks.length > 0) {
    const wav = pcmToWav(audioChunks);
    const opts: Record<string, unknown> = {};
    if (replyToMsgId) opts.reply_parameters = { message_id: replyToMsgId };
    await ctx.replyWithVoice({ source: wav, filename: "response.wav" }, opts as any);
    return;
  }
  // Fallback if no audio (shouldn't happen)
  if (response.text.trim()) {
    await sendText(ctx, response.text, replyToMsgId);
  }
}

/** Send text with Markdown fallback, optionally quoting a message */
async function sendText(ctx: Context, text: string, replyToMsgId?: number): Promise<any> {
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
    if (i === 0 && replyToMsgId) opts.reply_parameters = { message_id: replyToMsgId };
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
  // Reaction probability scales with relationship
  const prob =
    msgCount < 5 ? 0.1 : msgCount < 15 ? 0.3 : msgCount < 30 ? 0.5 : 0.7;
  if (Math.random() > prob) return;

  const tier = store.getComfortTier(userId);
  const history = store.getRecentHistory(userId);
  const emoji = await pickReactionEmoji(ollamaConfig, userMessage, history, tier);
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
  // No sticker packs? Skip
  if (!user.stickerPacks.length) return;
  // Probability by tier
  const shouldSend =
    msgCount < 8
      ? false
      : msgCount < 25
        ? Math.random() < 0.04
        : msgCount < 60
          ? Math.random() < 0.12
          : Math.random() < 0.22;
  if (!shouldSend) return;

  const history = store.getRecentHistory(userId);
  const emoji = await pickStickerEmoji(ollamaConfig, aiResponse, history);
  if (!emoji) return;

  // Try to find a sticker matching the emoji in user's packs
  for (const packName of user.stickerPacks) {
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
      "Commands:\n" +
      "/profile — Your profile\n" +
      "/setname — Set your name\n" +
      "/setbio — Set your bio\n" +
      "/tone — Change tone\n" +
      "/talk — Toggle voice-only mode\n" +
      "/addstickers — Add a sticker pack\n" +
      "/stickers — List sticker packs\n" +
      "/removestickers — Remove a sticker pack\n" +
      "/clear — Reset conversation\n" +
      "/addkey — Add your Ollama API key\n" +
      "/keys — List your API keys\n" +
      "/removekey — Remove an API key\n" +
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
      "Profile commands:\n" +
      "/profile /setname /setbio /tone\n" +
      "/replies_short /replies_medium /replies_long\n" +
      "/talk — Toggle voice-only replies\n" +
      "/addstickers /stickers /removestickers\n" +
      "/clear — Reset conversation\n" +
      "/addkey /keys /removekey — Manage API keys"
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
      `Sticker packs: ${user.stickerPacks.length}`,
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
  await ctx.reply("Send me the sticker pack name (you can find it in the sticker pack link):");
});

bot.command("stickers", async (ctx) => {
  const user = store.getUser(ctx.from.id);
  if (!user.stickerPacks.length) {
    await ctx.reply("No sticker packs added yet. Use /addstickers to add one!");
    return;
  }
  await ctx.reply("Your sticker packs:\n" + user.stickerPacks.map((p, i) => `${i + 1}. ${p}`).join("\n"));
});

bot.command("removestickers", async (ctx) => {
  const user = store.getUser(ctx.from.id);
  if (!user.stickerPacks.length) {
    await ctx.reply("No sticker packs to remove.");
    return;
  }
  store.setFsmState(ctx.from.id, "waiting_for_remove_sticker_pack");
  await ctx.reply(
    "Which pack to remove?\n" +
      user.stickerPacks.map((p, i) => `${i + 1}. ${p}`).join("\n") +
      "\n\nSend the number."
  );
});

bot.command("reset", async (ctx) => {
  store.clearHistory(ctx.from.id);
  sessions.resetSession(ctx.from.id);
  await ctx.reply("🔄 Conversation reset!");
});

// ── API KEY COMMANDS ────────────────────────────────────────────────

bot.command("addkey", async (ctx) => {
  store.setFsmState(ctx.from.id, "waiting_for_ollama_key");
  await ctx.reply("Send me your Ollama API key. It will be stored securely and used as a backup when the default key hits its limit.\n\n⚠️ Delete your message after sending to keep it private!");
});

bot.command("keys", async (ctx) => {
  const user = store.getUser(ctx.from.id);
  if (!user.ollamaKeys.length) {
    await ctx.reply("No extra API keys added. Use /addkey to add one!");
    return;
  }
  const masked = user.ollamaKeys.map((k, i) =>
    `${i + 1}. ${k.slice(0, 6)}...${k.slice(-4)}`
  );
  await ctx.reply("Your API keys:\n" + masked.join("\n") + "\n\nUse /removekey to remove one.");
});

bot.command("removekey", async (ctx) => {
  const user = store.getUser(ctx.from.id);
  if (!user.ollamaKeys.length) {
    await ctx.reply("No API keys to remove.");
    return;
  }
  const masked = user.ollamaKeys.map((k, i) =>
    `${i + 1}. ${k.slice(0, 6)}...${k.slice(-4)}`
  );
  store.setFsmState(ctx.from.id, "waiting_for_remove_key");
  await ctx.reply("Which key to remove?\n" + masked.join("\n") + "\n\nSend the number.");
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
        const user = store.getUser(userId);
        const packs = [...user.stickerPacks, text.trim()];
        store.updateUser(userId, { stickerPacks: packs });
        return ctx.reply(`Added sticker pack: ${text.trim()}`).then(() => true);
      }

    case "waiting_for_remove_sticker_pack":
      store.clearFsmState(userId);
      {
        const idx = parseInt(text) - 1;
        const user = store.getUser(userId);
        if (idx >= 0 && idx < user.stickerPacks.length) {
          const removed = user.stickerPacks[idx];
          const packs = user.stickerPacks.filter((_, i) => i !== idx);
          store.updateUser(userId, { stickerPacks: packs });
          return ctx.reply(`Removed: ${removed}`).then(() => true);
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
function getReplyContext(ctx: Context): string {
  const replyMsg = (ctx.message as any)?.reply_to_message;
  if (!replyMsg) return "";

  // Get text from the replied-to message
  const replyText = replyMsg.text || replyMsg.caption || "";
  if (!replyText) return "";

  // Figure out who sent the replied-to message
  const botId = (ctx as any).botInfo?.id;
  const isFromBot = replyMsg.from?.id === botId;
  const sender = isFromBot ? "you (Meera)" : "the user";

  return `(The user is replying to a specific message that ${sender} sent earlier: "${replyText.slice(0, 300)}")\n\n`;
}

// ── RAPID-FIRE MESSAGE BATCHING ─────────────────────────────────────
// When user sends multiple messages quickly, batch them into one reply.

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

  // Need sticker packs and comfortable+ tier
  if (!user.stickerPacks.length) return false;
  if (tier === "stranger" || tier === "acquaintance") return false;

  const text = userText.trim().toLowerCase();

  // Higher chance for reaction-worthy messages
  const isReactionable = /^(haha|hehe|lol|lmao|😂|🤣|ok|okay|nice|cool|wow|omg|bruh|💀|😭)+$/i.test(text);
  const prob = isReactionable ? 0.15 : 0.05;
  if (Math.random() > prob) return false;

  // Pick a sticker emoji based on the message
  const history = store.getRecentHistory(userId);
  const emoji = await pickStickerEmoji(ollamaConfig, userText, history);
  if (!emoji) return false;

  // Find matching sticker
  for (const packName of user.stickerPacks) {
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
    captionPrompt = `You randomly want to share a meme/video you found titled "${post.title}". Write a SHORT message (1 line) like a girl would when forwarding content: "LMAOO 😭", "bro look at this", "i can't 💀💀", "ye dekh 😂", "this sent me". Don't describe it. Match chat language.`;
  }

  const messages = buildOllamaMessages(captionPrompt, history, tier, user, mood);
  let caption: string;
  try {
    caption = await callOllamaWithRotation(ollamaConfig, messages, user.ollamaKeys);
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

  // ── Conversation pace detection
  const paceMult = paceMultiplier(userId);

  // ── Reply context: what message is the user replying to?
  const replyContext = getReplyContext(ctx);

  // ── Status-aware: detect gap since last interaction
  const gapMs = Date.now() - prevLastInteraction;
  const gapContext = buildGapAwareContext(gapMs, tier);

  // ── Offline schedule — she might be "sleeping"
  const offlineDelay = offlineScheduleDelay();
  if (offlineDelay > 0) {
    if (isBatched) {
      for (const t of batchedTexts!) store.addMessage(userId, "user", t);
    } else {
      store.addMessage(userId, "user", text);
    }
    console.log(`[Offline] User ${userId} messaged while Meera is "sleeping", reply in ${Math.round(offlineDelay / 60000)}min`);
    scheduleDelayedReply(ctx, userId, offlineDelay);
    return;
  }

  // ── Leave on read? (comfortable+ only, low-effort messages) — only for single messages
  if (!isBatched && shouldLeaveOnRead(tier, text)) {
    store.addMessage(userId, "user", text);
    console.log(`[Bot] Left on read: user ${userId} ("${text.slice(0, 20)}")`);
    return;
  }

  // ── Read receipt gaming — advanced seen/not-seen behavior
  const receiptStrategy = readReceiptStrategy(tier, mood);
  if (receiptStrategy.readDelay > 0) {
    if (isBatched) {
      for (const t of batchedTexts!) store.addMessage(userId, "user", t);
    } else {
      store.addMessage(userId, "user", text);
    }
    const totalDelay = receiptStrategy.readDelay + receiptStrategy.replyDelay;
    console.log(`[ReadReceipt] Delayed read for user ${userId}, ${Math.round(totalDelay / 60000)}min`);
    scheduleDelayedReply(ctx, userId, totalDelay);
    return;
  }
  if (receiptStrategy.replyDelay > 0) {
    if (isBatched) {
      for (const t of batchedTexts!) store.addMessage(userId, "user", t);
    } else {
      store.addMessage(userId, "user", text);
    }
    if (receiptStrategy.showTypingFirst) {
      await ctx.sendChatAction("typing").catch(() => {});
      await new Promise((r) => setTimeout(r, 800 + Math.random() * 1500));
    }
    console.log(`[ReadReceipt] Read but delayed reply for user ${userId}, ${Math.round(receiptStrategy.replyDelay / 60000)}min`);
    scheduleDelayedReply(ctx, userId, receiptStrategy.replyDelay);
    return;
  }

  // ── Seen but reply later? (late night / random delay)
  const nightDelay = lateNightDelay();
  if (nightDelay > 0) {
    if (isBatched) {
      for (const t of batchedTexts!) store.addMessage(userId, "user", t);
    } else {
      store.addMessage(userId, "user", text);
    }
    await ctx.sendChatAction("typing").catch(() => {});
    await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));
    scheduleDelayedReply(ctx, userId, nightDelay);
    return;
  }

  // ── Random "seen but reply later" (5% chance during day, comfortable+)
  if ((tier === "comfortable" || tier === "close") && Math.random() < 0.05) {
    if (isBatched) {
      for (const t of batchedTexts!) store.addMessage(userId, "user", t);
    } else {
      store.addMessage(userId, "user", text);
    }
    await ctx.sendChatAction("typing").catch(() => {});
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));
    const delayMs = (5 + Math.random() * 15) * 60 * 1000;
    scheduleDelayedReply(ctx, userId, delayMs);
    return;
  }

  // ── Sticker-only reply? (comfortable+ only, for short/reactive messages)
  if (!isBatched && await maybeStickerOnlyReply(ctx, userId, text)) {
    return;
  }

  // ── Emoji-only reply? (only for single non-batched messages)
  if (!isBatched) {
    const emojiOnly = shouldSendEmojiOnly(tier, text);
    if (emojiOnly) {
      store.addMessage(userId, "user", text);
      store.addMessage(userId, "assistant", emojiOnly);
      const readTime = readDelay(text) * paceMult;
      await new Promise((r) => setTimeout(r, readTime));
      await ctx.reply(emojiOnly);
      return;
    }
  }

  // React to message (async, don't await)
  maybeReact(ctx, userId, text).catch(() => {});

  // Time-of-day multiplier for delays
  const todMultiplier = timeOfDayMultiplier();

  // ── Typing fake-out? (start typing, stop, resume) — skip in rapid-fire
  if (paceMult >= 0.7) {
    await maybeTypingFakeout(ctx, tier);
  }

  // ── Voice note tease? (show record_voice then switch to text) — skip in rapid-fire
  let didVoiceTease = false;
  if (paceMult >= 0.7) {
    didVoiceTease = await maybeVoiceNoteTease(ctx, tier);
  }

  // ── Voice timing awareness: factor time of day into voice probability
  const voiceTimeMod = voiceTimeModifier();
  const useVoice = !didVoiceTease && !isBatched && shouldSendVoice(tier, text, voiceTimeMod);

  // ── Should Meera quote-reply this message?
  const quoteReplyId = batchQuoteId
    ?? (shouldQuoteReply(tier, text) ? (ctx.message as any).message_id : undefined);

  // ── Build enriched context for LLM prompts
  const history = store.getRecentHistory(userId);
  const lengthHint = getLengthMirrorHint(text);
  const styleHints = getStyleHints(text, history);
  const emojiHint = getEmojiEvolutionHint(tier);
  const batchHint = isBatched
    ? `\n\n(The user sent ${batchedTexts!.length} messages in quick succession. Address ALL of them naturally in one reply — don't ignore any. Their messages were:\n${batchedTexts!.map((t, i) => `${i + 1}. "${t}"`).join("\n")}\n)`
    : "";

  if (useVoice) {
    // Voice reply via Gemini Live
    try {
      const readTime = readDelay(text) * todMultiplier * paceMult;
      await new Promise((r) => setTimeout(r, readTime));

      const stopTyping = typingIndicator(ctx, "record_voice");
      sessions.resetSession(userId);
      const session = await sessions.getSession(userId);
      const response = await session.send([{
        text: replyContext + (gapContext ? gapContext + "\n\n" : "") + batchHint + lengthHint + text
      }]);

      stopTyping();
      await sendGeminiResponse(ctx, response, quoteReplyId);

      // Save to history
      if (isBatched) {
        for (const t of batchedTexts!) store.addMessage(userId, "user", t);
      } else {
        store.addMessage(userId, "user", text);
      }
      if (response.text.trim()) {
        store.addMessage(userId, "assistant", response.text);
      }

      if (response.text.trim()) {
        maybeSendSticker(ctx, userId, response.text).catch(() => {});
      }
    } catch (err) {
      console.error("[Bot] Gemini voice error:", err);
      sessions.resetSession(userId);
      await ctx.reply("wait something messed up lol try again");
    }
  } else {
    // Text reply via Ollama
    try {
      const readTime = readDelay(text) * todMultiplier * paceMult;
      await new Promise((r) => setTimeout(r, readTime));

      const stopTyping = typingIndicator(ctx, "typing");
      const user = store.getUser(userId);

      // Build message with all context hints
      const userMsg = replyContext
        + (gapContext ? gapContext + "\n\n" : "")
        + batchHint
        + lengthHint
        + styleHints
        + emojiHint
        + "\n\n" + text;
      const messages = buildOllamaMessages(userMsg, history, tier, user, mood);

      let reply = await callOllamaWithRotation(ollamaConfig, messages, user.ollamaKeys);

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

      // Simulate typing delay (scaled by time of day and conversation pace)
      const delay = typingDelay(reply) * todMultiplier * paceMult;
      await new Promise((r) => setTimeout(r, Math.min(delay, 8000)));

      stopTyping();

      // Send reply as bubbles (may split into multiple messages)
      const sentMsgId = await sendAsBubbles(ctx, reply, quoteReplyId);
      if (sentMsgId) lastSentMessageIds.set(userId, sentMsgId);

      // Maybe self-correct — try editing the message first, fall back to "*that" follow-up
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
    } catch (err) {
      console.error("[Bot] Ollama error:", err);
      await ctx.reply("omg my brain just glitched 😭 say that again?");
    }
  }

  // ── Mid-chat content sharing: maybe share a meme/video alongside the reply
  const { shouldShare, reason } = shouldShareContentMidChat(tier, text, mood);
  if (shouldShare) {
    // Small delay — she replies first, then "finds" the meme
    const shareDelay = reason === "asked"
      ? 1500 + Math.random() * 2000      // Quick when asked
      : 3000 + Math.random() * 5000;     // Natural delay when spontaneous
    setTimeout(async () => {
      try {
        const post = await getRandomContentAny(userId);
        if (post) {
          // Show typing while "finding" the content
          await ctx.sendChatAction("typing").catch(() => {});
          await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));
          await sendContentToChat(ctx, userId, post, reason);
        }
      } catch (err) {
        console.error(`[Content] Mid-chat share failed for ${userId}:`, err);
      }
    }, shareDelay);
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
  store.updateUser(userId, {
    lastInteraction: Date.now(),
    chatId: ctx.chat!.id,
    firstName: ctx.from!.first_name,
    telegramUsername: (ctx.from as any).username,
    proactiveSent: false,
  });

  const tier = store.getComfortTier(userId);
  const mood = store.getMood(userId);
  const useAudio = shouldSendVoiceForMedia(tier);

  // ── Photo reaction differentiation: classify what type of media this is
  const mediaType = classifyMedia(ctx);
  const mediaHint = getMediaReactionHint(mediaType, tier);

  // ── Reply context: what message is the user replying to with this media?
  const replyContext = getReplyContext(ctx);
  if (replyContext) {
    // Prepend the reply context as a text part so Gemini/Ollama sees it
    parts.unshift({ text: replyContext });
  }

  // ── Add media reaction hint as a text part
  if (mediaHint) {
    parts.unshift({ text: mediaHint });
  }

  // ── Offline schedule — she might be "sleeping"
  const offlineDelay = offlineScheduleDelay();
  if (offlineDelay > 0) {
    store.addMessage(userId, "user", "[sent media]");
    console.log(`[Offline] User ${userId} sent media while Meera is "sleeping"`);
    // Can't schedule delayed media processing easily, so just delay a text acknowledgment
    setTimeout(async () => {
      try {
        const user = store.getUser(userId);
        const history = store.getRecentHistory(userId);
        const messages = buildOllamaMessages(
          "(You just woke up and saw they sent you a photo/video/audio while you were sleeping. React naturally — maybe 'omg what did i miss' or 'wait let me see what you sent' or just address it casually.)",
          history, tier, user, mood
        );
        const reply = await callOllamaWithRotation(ollamaConfig, messages, user.ollamaKeys);
        store.addMessage(userId, "assistant", reply);
        await bot.telegram.sendMessage(ctx.chat!.id, reply);
      } catch (err) {
        console.error(`[Offline] Delayed media reply failed for ${userId}:`, err);
      }
    }, offlineDelay);
    return;
  }

  // React to media message (async, don't block)
  maybeReact(ctx, userId, "[sent media]").catch(() => {});

  // Typing fake-out before processing
  await maybeTypingFakeout(ctx, tier);

  // ── Should Meera quote-reply this media message?
  const quoteReplyId = shouldQuoteReply(tier, "[sent media]") ? (ctx.message as any).message_id : undefined;

  const stopTyping = typingIndicator(ctx, useAudio ? "record_voice" : "typing");
  try {
    // Reset session so it picks up latest tier/persona/mood
    sessions.resetSession(userId);
    const session = await sessions.getSession(userId);
    const response = await session.send(parts as any);

    if (useAudio) {
      // Comfortable+ → send audio response directly from Gemini Live
      await sendGeminiResponse(ctx, response, quoteReplyId);

      // Save to history
      store.addMessage(userId, "user", "[sent media]");
      if (response.text.trim()) {
        store.addMessage(userId, "assistant", response.text);
      }

      // Maybe send a sticker after
      if (response.text.trim()) {
        maybeSendSticker(ctx, userId, response.text).catch(() => {});
      }
    } else {
      // Text response → rephrase Gemini's raw output through Ollama for natural girl tone
      const geminiRaw = response.text.trim() || "I see it";
      const user = store.getUser(userId);
      const history = store.getRecentHistory(userId);

      // Build Ollama messages with Gemini's observation as context
      const emojiHint = getEmojiEvolutionHint(tier);
      const styleHints = getStyleHints("[sent media]", history);
      const rephrasePrompt =
        `The user sent you a photo/video/audio. Here's what you observed about it: "${geminiRaw}"\n\n` +
        (mediaHint ? mediaHint + "\n\n" : "") +
        `Now respond to the user naturally as yourself (Meera) about what they sent. ` +
        `Don't say "I observed" or quote the observation — just react naturally like a real girl would. ` +
        `If the observation says you can't describe something, just dodge it naturally or tease them — never sound like an AI refusing.` +
        emojiHint + styleHints;

      const messages = buildOllamaMessages(rephrasePrompt, history, tier, user, mood);
      let reply = await callOllamaWithRotation(ollamaConfig, messages, user.ollamaKeys);

      // Add deliberate typos
      reply = addDeliberateTypos(reply, mood);

      // Save to history
      store.addMessage(userId, "user", "[sent media]");
      store.addMessage(userId, "assistant", reply);

      const delay = typingDelay(reply) * timeOfDayMultiplier();
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

// ── PROACTIVE MESSAGING ─────────────────────────────────────────────

async function proactiveLoop() {
  const now = Date.now();
  for (const userId of store.allUserIds()) {
    const user = store.getUser(userId);
    if (!user.chatId || user.proactiveSent) continue;

    const tier = store.getComfortTier(userId);
    const threshold = INACTIVITY_THRESHOLDS[tier];
    if (!threshold) continue;

    const elapsed = now - user.lastInteraction;
    if (elapsed < threshold) continue;

    // Add some randomness — don't always ping exactly at threshold
    // 30% chance to skip this cycle (makes timing feel less robotic)
    if (Math.random() < 0.3) continue;

    // Don't send proactive pings at weird hours (2-7 AM IST)
    const hour = getISTHour();
    if (hour >= 2 && hour < 7) continue;

    const mood = store.getMood(userId);

    // ── Content sharing: 20% chance to share random content instead of a ping (comfortable+)
    const shareContent = (tier === "comfortable" || tier === "close") && Math.random() < 0.20;
    const prompt = shareContent
      ? (CONTENT_SHARE_PROMPTS[tier] ?? INITIATE_PROMPTS[tier])
      : INITIATE_PROMPTS[tier];
    if (!prompt) continue;

    try {
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
            store.updateUser(userId, { proactiveSent: true });

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
      const reply = await callOllamaWithRotation(ollamaConfig, messages, user.ollamaKeys);

      // Simulate typing delay before sending
      await bot.telegram.sendChatAction(user.chatId, "typing");
      const delay = Math.min(typingDelay(reply), 3000);
      await new Promise((r) => setTimeout(r, delay));

      await bot.telegram.sendMessage(user.chatId, reply);
      store.addMessage(userId, "assistant", reply);

      // Double-text: 25% chance for comfortable+, send a follow-up
      if ((tier === "comfortable" || tier === "close") && Math.random() < 0.25) {
        const followUps = tier === "close"
          ? ["hellooo", "😤", "🙄", "answer me", "oye", "uff", "👀", "rude"]
          : ["?", "👀", "helloo", "😶"];
        const followUp = followUps[Math.floor(Math.random() * followUps.length)];
        const gap = 3000 + Math.random() * 8000; // 3-11s later
        await new Promise((r) => setTimeout(r, gap));
        await bot.telegram.sendMessage(user.chatId, followUp);
        store.addMessage(userId, "assistant", followUp);
      }

      store.updateUser(userId, { proactiveSent: true });
      console.log(`[Proactive] Sent to user ${userId} (${tier}, mood=${mood}${shareContent ? ", content-share" : ""})`);
    } catch (err) {
      console.error(`[Proactive] Failed for user ${userId}:`, err);
    }
  }
}

// ── LAUNCH ──────────────────────────────────────────────────────────

console.log(`Starting ${botName} Telegram bot...`);

bot.launch().then(() => {
  console.log(`🤖 ${botName} Telegram bot is running!`);
  // Check for proactive messages every 5 minutes
  setInterval(() => proactiveLoop().catch(console.error), 5 * 60 * 1000);
}).catch((err) => {
  console.error("Failed to launch bot:", err);
  process.exit(1);
});

process.once("SIGINT", async () => {
  bot.stop("SIGINT");
  sessions.destroy();
  await store.destroy();
});
process.once("SIGTERM", async () => {
  bot.stop("SIGTERM");
  sessions.destroy();
  await store.destroy();
});
