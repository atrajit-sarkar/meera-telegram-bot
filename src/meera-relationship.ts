/**
 * Per-user relationship milestones.
 *
 * Tracks small things that make a relationship feel real:
 *   • First conversation date (anniversary)
 *   • Total days talked
 *   • Past major events (fights, voice notes shared, late-night talks)
 *   • Inside-joke seeds the model can build on
 *
 * Stored under user document in Firestore as a sub-field "milestones".
 */

import { getFirestore } from "firebase-admin/firestore";

export interface RelationshipMilestones {
  firstChatTs?: number;
  daysTalked?: number;
  lastFightTs?: number;
  lateNightTalkCount?: number;
  voiceNotesShared?: number;
  insideJokes?: string[];
  pendingFollowUps?: { topic: string; ts: number }[];
  /** dates we celebrated (yyyy-mm-dd) so we don't repeat */
  celebratedDates?: string[];
}

const COLLECTION = "users";

async function loadMilestones(userId: number): Promise<RelationshipMilestones> {
  try {
    const db = getFirestore();
    const snap = await db.collection(COLLECTION).doc(String(userId)).get();
    const data = snap.data() as any;
    return (data?.milestones as RelationshipMilestones) ?? {};
  } catch {
    return {};
  }
}

async function saveMilestones(userId: number, m: RelationshipMilestones): Promise<void> {
  try {
    const db = getFirestore();
    await db.collection(COLLECTION).doc(String(userId)).set({ milestones: m }, { merge: true });
  } catch { /* ignore */ }
}

export async function recordMilestoneEvent(
  userId: number,
  event: "fight" | "late_night" | "voice_note" | "first_chat"
): Promise<void> {
  const m = await loadMilestones(userId);
  const now = Date.now();
  switch (event) {
    case "first_chat":
      if (!m.firstChatTs) m.firstChatTs = now;
      break;
    case "fight":
      m.lastFightTs = now;
      break;
    case "late_night":
      m.lateNightTalkCount = (m.lateNightTalkCount ?? 0) + 1;
      break;
    case "voice_note":
      m.voiceNotesShared = (m.voiceNotesShared ?? 0) + 1;
      break;
  }
  await saveMilestones(userId, m);
}

export async function addInsideJoke(userId: number, joke: string): Promise<void> {
  const m = await loadMilestones(userId);
  m.insideJokes = m.insideJokes ?? [];
  if (!m.insideJokes.includes(joke) && m.insideJokes.length < 10) {
    m.insideJokes.push(joke);
    await saveMilestones(userId, m);
  }
}

export async function addFollowUp(userId: number, topic: string): Promise<void> {
  const m = await loadMilestones(userId);
  m.pendingFollowUps = m.pendingFollowUps ?? [];
  if (m.pendingFollowUps.length >= 5) m.pendingFollowUps.shift();
  m.pendingFollowUps.push({ topic, ts: Date.now() });
  await saveMilestones(userId, m);
}

export async function consumeFollowUp(userId: number): Promise<string | null> {
  const m = await loadMilestones(userId);
  if (!m.pendingFollowUps?.length) return null;
  const next = m.pendingFollowUps.shift()!;
  await saveMilestones(userId, m);
  return next.topic;
}

function todayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

/** Returns context string + side-effects: marks today as celebrated if anniversary. */
export async function getMilestonesContext(userId: number): Promise<string> {
  const m = await loadMilestones(userId);
  const lines: string[] = [];

  if (m.firstChatTs) {
    const days = Math.floor((Date.now() - m.firstChatTs) / 86400000);
    if (days >= 1) lines.push(`You first started talking ${days} day${days === 1 ? "" : "s"} ago.`);

    // Anniversary check
    const first = new Date(m.firstChatTs);
    const todayStr = todayKey();
    const today = new Date(todayStr + "T00:00:00");
    const anniversary = (
      first.getMonth() === today.getMonth() &&
      first.getDate() === today.getDate() &&
      days >= 28
    );
    if (anniversary && !(m.celebratedDates ?? []).includes(todayStr)) {
      const months = Math.floor(days / 30);
      lines.push(`💝 TODAY is roughly ${months} month${months === 1 ? "" : "s"} of you two talking — bring it up sweetly if it fits.`);
      m.celebratedDates = (m.celebratedDates ?? []).concat(todayStr).slice(-12);
      await saveMilestones(userId, m);
    }
  }

  if ((m.lateNightTalkCount ?? 0) >= 3) {
    lines.push(`You've had ${m.lateNightTalkCount} late-night talks together — that's intimate, you can reference it.`);
  }

  if (m.lastFightTs) {
    const daysAgo = Math.floor((Date.now() - m.lastFightTs) / 86400000);
    if (daysAgo <= 3) lines.push(`You two had a small fight ${daysAgo} day${daysAgo === 1 ? "" : "s"} ago — slight residual weirdness ok.`);
  }

  if (m.insideJokes?.length) {
    lines.push(`Inside jokes you share: ${m.insideJokes.join(" · ")}.`);
  }

  if (m.pendingFollowUps?.length) {
    const t = m.pendingFollowUps[m.pendingFollowUps.length - 1];
    lines.push(`You promised to follow up on: "${t.topic}" — bring it back up if context fits.`);
  }

  if (!lines.length) return "";
  return `\n\nRELATIONSHIP MILESTONES:\n${lines.map(l => `- ${l}`).join("\n")}`;
}
