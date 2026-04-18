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
} from "./config.js";
import {
  callOllama,
  callOllamaWithRotation,
  pickReactionEmoji,
  pickStickerEmoji,
  type OllamaConfig,
} from "./ollama-service.js";
import { UserStore } from "./user-store.js";
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
  return {
    apiKey: GEMINI_API_KEY!,
    model: MODEL,
    systemInstruction: buildGeminiSystemInstruction(tier, user),
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

/** Send split bubbles with natural delays between them */
async function sendAsBubbles(ctx: Context, text: string) {
  const bubbles = splitIntoBubbles(text);
  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) {
      // Small delay between bubbles (0.5-1.5s)
      const gap = 500 + Math.random() * 1000;
      await new Promise((r) => setTimeout(r, gap));
      await ctx.sendChatAction("typing").catch(() => {});
      // Extra tiny delay for "typing" between bubbles
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
    }
    await sendText(ctx, bubbles[i]);
  }
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

      // Add context that she's replying late
      const lateContext = Math.random() < 0.5
        ? `(You're replying a bit late — you were busy/sleeping. Don't apologize too much, just reply naturally. Maybe a quick "sorry just saw this" or just answer directly.)`
        : `(You're replying late. Don't mention it unless it feels natural.)`;

      const messages = buildOllamaMessages(
        lateContext + "\n\nTheir message: " + userText,
        history,
        tier,
        user
      );
      const reply = await callOllamaWithRotation(ollamaConfig, messages, user.ollamaKeys);

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

/** Send Gemini's audio-only response */
async function sendGeminiResponse(ctx: Context, response: GeminiResponse) {
  const { audioChunks } = response;
  if (audioChunks.length > 0) {
    const wav = pcmToWav(audioChunks);
    await ctx.replyWithVoice({ source: wav, filename: "response.wav" });
    return;
  }
  // Fallback if no audio (shouldn't happen)
  if (response.text.trim()) {
    await sendText(ctx, response.text);
  }
}

/** Send text with Markdown fallback */
async function sendText(ctx: Context, text: string) {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, 4000));
    remaining = remaining.slice(4000);
  }
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(chunk);
    }
  }
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
function shouldSendVoice(tier: string, userText: string): boolean {
  // Strangers: never voice
  if (tier === "stranger") return false;

  // Acquaintance: very rare voice (5%)
  if (tier === "acquaintance") return Math.random() < 0.05;

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

  return Math.random() < voiceProb;
}

/** Handle text messages — Meera decides naturally when to voice vs text */
async function handleTextMessage(ctx: Context & { message: { text: string } }) {
  const userId = ctx.from!.id;
  const text = ctx.message.text;

  // Update user data
  store.updateUser(userId, {
    lastInteraction: Date.now(),
    chatId: ctx.chat!.id,
    firstName: ctx.from!.first_name,
    telegramUsername: (ctx.from as any).username,
    proactiveSent: false,
  });

  const tier = store.getComfortTier(userId);

  // ── Leave on read? (comfortable+ only, low-effort messages)
  if (shouldLeaveOnRead(tier, text)) {
    store.addMessage(userId, "user", text);
    console.log(`[Bot] Left on read: user ${userId} ("${text.slice(0, 20)}")`);
    return;
  }

  // ── Seen but reply later? (late night / random delay)
  const nightDelay = lateNightDelay();
  if (nightDelay > 0) {
    store.addMessage(userId, "user", text);
    // Show brief typing then stop (she "saw" it)
    await ctx.sendChatAction("typing").catch(() => {});
    await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));
    scheduleDelayedReply(ctx, userId, nightDelay);
    return;
  }

  // ── Random "seen but reply later" (5% chance during day, comfortable+)
  if ((tier === "comfortable" || tier === "close") && Math.random() < 0.05) {
    store.addMessage(userId, "user", text);
    await ctx.sendChatAction("typing").catch(() => {});
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));
    const delayMs = (5 + Math.random() * 15) * 60 * 1000; // 5-20 min
    scheduleDelayedReply(ctx, userId, delayMs);
    return;
  }

  // ── Emoji-only reply?
  const emojiOnly = shouldSendEmojiOnly(tier, text);
  if (emojiOnly) {
    store.addMessage(userId, "user", text);
    store.addMessage(userId, "assistant", emojiOnly);
    const readTime = readDelay(text);
    await new Promise((r) => setTimeout(r, readTime));
    await ctx.reply(emojiOnly);
    return;
  }

  // React to message (async, don't await)
  maybeReact(ctx, userId, text).catch(() => {});

  // Time-of-day multiplier for delays
  const todMultiplier = timeOfDayMultiplier();

  const useVoice = shouldSendVoice(tier, text);

  if (useVoice) {
    // Voice reply via Gemini Live
    try {
      // Simulate reading the message first (no indicator yet)
      const readTime = readDelay(text) * todMultiplier;
      await new Promise((r) => setTimeout(r, readTime));

      // Now start "recording voice"
      const stopTyping = typingIndicator(ctx, "record_voice");
      sessions.resetSession(userId);
      const session = await sessions.getSession(userId);
      const response = await session.send([{ text }]);

      stopTyping();
      await sendGeminiResponse(ctx, response);

      // Save to Ollama history
      store.addMessage(userId, "user", text);
      if (response.text.trim()) {
        store.addMessage(userId, "assistant", response.text);
      }

      // Maybe send a sticker after
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
      // Simulate reading the message first (no typing indicator yet)
      const readTime = readDelay(text) * todMultiplier;
      await new Promise((r) => setTimeout(r, readTime));

      // Now start "typing"
      const stopTyping = typingIndicator(ctx, "typing");
      const user = store.getUser(userId);
      const history = store.getRecentHistory(userId);
      const messages = buildOllamaMessages(text, history, tier, user);

      const reply = await callOllamaWithRotation(ollamaConfig, messages, user.ollamaKeys);

      // Save to history
      store.addMessage(userId, "user", text);
      store.addMessage(userId, "assistant", reply);

      // Simulate typing delay (scaled by time of day)
      const delay = typingDelay(reply) * todMultiplier;
      await new Promise((r) => setTimeout(r, Math.min(delay, 8000)));

      stopTyping();

      // Send reply as bubbles (may split into multiple messages)
      await sendAsBubbles(ctx, reply);

      // Maybe send a self-correction follow-up
      const correction = maybeSelfCorrect(reply);
      if (correction) {
        await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2000));
        await ctx.reply(correction);
      }

      // Maybe send a sticker after
      maybeSendSticker(ctx, userId, reply).catch(() => {});
    } catch (err) {
      console.error("[Bot] Ollama error:", err);
      await ctx.reply("omg my brain just glitched 😭 say that again?");
    }
  }
}

/** Decide if Meera voice-replies to media — slightly higher chance since media is more expressive */
function shouldSendVoiceForMedia(tier: string): boolean {
  if (tier === "stranger") return false;
  if (tier === "acquaintance") return Math.random() < 0.10;
  if (tier === "comfortable") return Math.random() < 0.40;
  return Math.random() < 0.55; // close
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
  const useAudio = shouldSendVoiceForMedia(tier);

  // React to media message (async, don't block)
  maybeReact(ctx, userId, "[sent media]").catch(() => {});

  const stopTyping = typingIndicator(ctx, useAudio ? "record_voice" : "typing");
  try {
    // Reset session so it picks up latest tier/persona
    sessions.resetSession(userId);
    const session = await sessions.getSession(userId);
    const response = await session.send(parts as any);

    if (useAudio) {
      // Comfortable+ → send audio response directly from Gemini Live
      await sendGeminiResponse(ctx, response);

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
      const rephrasePrompt =
        `The user sent you a photo/video/audio. Here's what you observed about it: "${geminiRaw}"\n\n` +
        `Now respond to the user naturally as yourself (Meera) about what they sent. ` +
        `Don't say "I observed" or quote the observation — just react naturally like a real girl would. ` +
        `If the observation says you can't describe something, just dodge it naturally or tease them — never sound like an AI refusing.`;

      const messages = buildOllamaMessages(rephrasePrompt, history, tier, user);
      const reply = await callOllamaWithRotation(ollamaConfig, messages, user.ollamaKeys);

      // Save to history
      store.addMessage(userId, "user", "[sent media]");
      store.addMessage(userId, "assistant", reply);

      const delay = typingDelay(reply) * timeOfDayMultiplier();
      await new Promise((r) => setTimeout(r, Math.min(delay, 6000)));
      await sendAsBubbles(ctx, reply);

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

  await handleTextMessage(ctx);
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

// Videos
bot.on(message("video"), async (ctx) => {
  const fileSize = ctx.message.video.file_size ?? 0;
  if (fileSize > 15 * 1024 * 1024) {
    await ctx.reply("⚠️ Video is too large (max 15 MB). Send a shorter clip.");
    return;
  }
  const base64 = await downloadFile(ctx.message.video.file_id);
  const parts: Record<string, unknown>[] = [];
  if (ctx.message.caption) parts.push({ text: ctx.message.caption });
  parts.push({ inlineData: { data: base64, mimeType: "video/mp4" } });
  await handleMediaMessage(ctx, parts);
});

// Video notes (circle videos)
bot.on(message("video_note"), async (ctx) => {
  const fileSize = ctx.message.video_note.file_size ?? 0;
  if (fileSize > 15 * 1024 * 1024) {
    await ctx.reply("⚠️ Video note is too large.");
    return;
  }
  const base64 = await downloadFile(ctx.message.video_note.file_id);
  await handleMediaMessage(ctx, [
    { inlineData: { data: base64, mimeType: "video/mp4" } },
  ]);
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
  const base64 = await downloadFile(ctx.message.document.file_id);
  const parts: Record<string, unknown>[] = [];
  if (ctx.message.caption) parts.push({ text: ctx.message.caption });
  parts.push({ inlineData: { data: base64, mimeType: mime } });
  await handleMediaMessage(ctx, parts);
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

    const prompt = INITIATE_PROMPTS[tier];
    if (!prompt) continue;

    try {
      const history = store.getRecentHistory(userId);
      const messages = buildOllamaMessages(prompt, history, tier, user);
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
      console.log(`[Proactive] Sent to user ${userId} (${tier})`);
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
