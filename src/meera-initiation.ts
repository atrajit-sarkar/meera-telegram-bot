/**
 * Proactive initiation: Meera occasionally messages users first.
 *
 * Triggers per user when ALL of these align:
 *   • She's awake (not 1-7am IST)
 *   • Last user message was > MEERA_INITIATE_QUIET_HOURS hours ago
 *   • Random gate (so it doesn't fire on every cycle)
 *   • Reasoning model approves with a contextual opener
 *
 * Disabled unless MEERA_INITIATE_ENABLED=true.
 */

import type { Telegraf, Context } from "telegraf";
import { UserStore } from "./user-store.js";
import type { OllamaConfig } from "./ollama-service.js";
import { callOllamaWithRotation, type OllamaMessage } from "./ollama-service.js";
import { getCurrentDriftMood } from "./meera-mood-drift.js";
import { getFriendsContextSync } from "./meera-friends.js";
import { consumeFollowUp } from "./meera-relationship.js";

interface InitiateOpts {
  bot: Telegraf<Context>;
  store: UserStore;
  ollamaConfig: OllamaConfig;
}

const QUIET_HOURS = parseFloat(process.env.MEERA_INITIATE_QUIET_HOURS ?? "8");
const FIRE_PROBABILITY = parseFloat(process.env.MEERA_INITIATE_PROB ?? "0.25");
const MAX_PER_TICK = parseInt(process.env.MEERA_INITIATE_MAX_PER_TICK ?? "2", 10);
const MIN_TIER = process.env.MEERA_INITIATE_MIN_TIER ?? "comfortable";

const TIER_RANK: Record<string, number> = {
  stranger: 0,
  acquaintance: 1,
  comfortable: 2,
  close: 3,
};

function getISTHour(): number {
  return parseInt(
    new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }).format(new Date()),
    10
  );
}

function isAwakeHour(): boolean {
  const h = getISTHour();
  return h >= 8 && h < 24; // awake 8am - midnight IST
}

async function generateOpener(
  config: OllamaConfig,
  user: { profileName?: string; firstName?: string; mood: string; tier: string; followUp?: string | null; recentHistory: OllamaMessage[] }
): Promise<string | null> {
  const name = user.profileName || user.firstName || "him";
  const friendsCtx = getFriendsContextSync();
  const followUpHint = user.followUp ? `\nYou had told them you'd follow up about: "${user.followUp}". USE this as the opener if it fits.` : "";

  const sysPrompt = `You are Meera. You're texting ${name} first, unprompted, like a real friend / girl who suddenly thought of him.
Mood: ${user.mood}. Tier: ${user.tier}.${followUpHint}
${friendsCtx}

Write ONE short message (max 12 words) that feels natural — could be:
- a follow-up question on something you discussed
- a random thought
- something happening in your day
- a "miss you" / "hey" if comfortable tier
- something about a friend's drama
- mention current time/weather/festival if it fits

Output ONLY the message, no quotes, no preamble. Hindi-English code-mix is fine.`;

  const messages: OllamaMessage[] = [
    { role: "system", content: sysPrompt },
    ...user.recentHistory.slice(-6),
    { role: "user", content: "(send the opener now)" },
  ];

  try {
    const res = await callOllamaWithRotation(config, messages, []);
    if (!res) return null;
    const text = res.trim()
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/^assistant[:\s-]+/i, "")
      .replace(/\n.*/s, "")
      .trim();
    if (!text || text.length > 200) return null;
    return text;
  } catch {
    return null;
  }
}

export async function runInitiationTick(opts: InitiateOpts): Promise<void> {
  if (process.env.MEERA_INITIATE_ENABLED !== "true") return;
  if (!isAwakeHour()) return;

  const minRank = TIER_RANK[MIN_TIER] ?? 2;
  const candidates = opts.store.getAllUsersSnapshot()
    .filter(u => {
      const tier = opts.store.getComfortTier(u.userId);
      if ((TIER_RANK[tier] ?? 0) < minRank) return false;
      const last = u.lastInteraction ?? 0;
      const hoursSince = (Date.now() - last) / 3600000;
      if (hoursSince < QUIET_HOURS) return false;
      if (hoursSince > 24 * 14) return false; // don't ping totally cold users
      return true;
    });

  // Shuffle + cap
  const shuffled = candidates.sort(() => Math.random() - 0.5).slice(0, MAX_PER_TICK * 3);

  let sent = 0;
  for (const u of shuffled) {
    if (sent >= MAX_PER_TICK) break;
    if (Math.random() > FIRE_PROBABILITY) continue;
    if (!u.chatId) continue;

    const tier = opts.store.getComfortTier(u.userId);
    const mood = getCurrentDriftMood() ?? u.mood ?? "chill";
    const followUp = await consumeFollowUp(u.userId).catch(() => null);
    const history = opts.store.getRecentHistory(u.userId);

    const opener = await generateOpener(opts.ollamaConfig, {
      profileName: u.profileName,
      firstName: u.firstName,
      mood,
      tier,
      followUp,
      recentHistory: history,
    });
    if (!opener) continue;

    try {
      await opts.bot.telegram.sendChatAction(u.chatId, "typing");
      // Simulate reading + typing time
      await new Promise(r => setTimeout(r, 1200 + Math.random() * 2000));
      await opts.bot.telegram.sendMessage(u.chatId, opener);
      // Append to history so the bot doesn't repeat itself
      opts.store.addMessage(u.userId, "assistant", opener);
      sent++;
      console.log(`[initiate] sent opener to ${u.userId} (${tier}): "${opener}"`);
    } catch (err) {
      console.warn(`[initiate] failed for ${u.userId}:`, (err as Error).message);
    }

    // Stagger
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
  }
}

export function startInitiationLoop(opts: InitiateOpts): void {
  if (process.env.MEERA_INITIATE_ENABLED !== "true") {
    console.log("[initiate] disabled (set MEERA_INITIATE_ENABLED=true to enable)");
    return;
  }
  const intervalMin = parseInt(process.env.MEERA_INITIATE_INTERVAL_MIN ?? "90", 10);
  console.log(`[initiate] enabled, tick every ${intervalMin}min`);
  setInterval(() => {
    runInitiationTick(opts).catch(err => console.warn("[initiate] tick error:", err));
  }, intervalMin * 60 * 1000).unref?.();
}
