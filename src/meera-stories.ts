/**
 * Story-style updates posted to a Telegram channel (or back to a target chat).
 *
 * Optional feature: if `MEERA_STORY_CHANNEL_ID` is set, Meera posts a "story"
 * (text + occasionally a Meera community image) to that channel ~3 times per
 * day at random times during awake hours. Mimics an Instagram-style story.
 *
 * Channel must already exist and the bot must be admin.
 *
 * If channel id is not set, this module is a no-op.
 */

import type { Telegraf, Context } from "telegraf";
import type { OllamaConfig } from "./ollama-service.js";
import { callOllamaWithRotation, type OllamaMessage } from "./ollama-service.js";
import { getCurrentDriftMood } from "./meera-mood-drift.js";
import { getFriendsContextSync } from "./meera-friends.js";
import { getNowPlaying } from "./meera-music.js";
import { getMeeraWorldContext } from "./meera-context.js";

const SLOTS_IST = [10, 14, 18, 22]; // candidate hours
const PER_DAY = parseInt(process.env.MEERA_STORY_PER_DAY ?? "3", 10);

interface StoryOpts {
  bot: Telegraf<Context>;
  ollamaConfig: OllamaConfig;
}

let lastStoryDay = "";
let postedToday = 0;

function getISTHour(): number {
  return parseInt(
    new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }).format(new Date()),
    10
  );
}
function todayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

async function generateStoryText(config: OllamaConfig): Promise<string | null> {
  const mood = getCurrentDriftMood() ?? "chill";
  const track = getNowPlaying(mood);
  const friends = getFriendsContextSync();
  const world = getMeeraWorldContext();

  const sysPrompt = `You are Meera. Write ONE short Instagram-story-style caption that captures what you're doing / feeling RIGHT NOW.
Mood: ${mood}. Currently listening: "${track.title}" by ${track.artist}.
${friends}${world}

Style:
- 1-2 lines max, max 80 characters
- Casual, real-girl voice
- Hindi-English code mix is welcome
- Can include 1 emoji
- No quotes, no preamble
- Examples: "kolkata rain hits different 🌧️", "library grind day", "Park Street walks >>", "biryani > everything"

Output only the caption.`;

  const messages: OllamaMessage[] = [
    { role: "system", content: sysPrompt },
    { role: "user", content: "(write the story now)" },
  ];

  try {
    const res = await callOllamaWithRotation(config, messages, []);
    if (!res) return null;
    const text = res.trim().replace(/^["'`]+|["'`]+$/g, "").split("\n")[0].trim();
    if (!text || text.length > 140) return null;
    return text;
  } catch {
    return null;
  }
}

export async function maybePostStory(opts: StoryOpts): Promise<void> {
  const channel = process.env.MEERA_STORY_CHANNEL_ID;
  if (!channel) return;
  const today = todayKey();
  if (today !== lastStoryDay) {
    lastStoryDay = today;
    postedToday = 0;
  }
  if (postedToday >= PER_DAY) return;

  const hour = getISTHour();
  if (!SLOTS_IST.includes(hour)) return;
  // 50% chance to fire on any matching slot tick — randomizes posting time
  if (Math.random() > 0.5) return;

  const text = await generateStoryText(opts.ollamaConfig);
  if (!text) return;

  try {
    await opts.bot.telegram.sendMessage(channel, text);
    postedToday++;
    console.log(`[story] posted (${postedToday}/${PER_DAY}): "${text}"`);
  } catch (err) {
    console.warn("[story] post failed:", (err as Error).message);
  }
}

export function startStoriesLoop(opts: StoryOpts): void {
  if (!process.env.MEERA_STORY_CHANNEL_ID) {
    console.log("[story] disabled (set MEERA_STORY_CHANNEL_ID to enable)");
    return;
  }
  console.log("[story] enabled");
  // Tick every 30 minutes — only fires when on a slot hour and randomly
  setInterval(() => {
    maybePostStory(opts).catch(err => console.warn("[story] tick error:", err));
  }, 30 * 60 * 1000).unref?.();
}
