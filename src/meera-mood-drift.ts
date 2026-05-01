/**
 * Mood drift — random walk + cycle simulation.
 *
 * Existing `pickTimeWeightedMood` flips mood at random; this layer adds:
 *   • Continuous random walk so mood doesn't change wildly (smooth transitions)
 *   • Cycle simulation (~28-day period drop) for added realism — adds 2-3 days
 *     of slightly lower / more sensitive mood
 *
 * Persisted globally (one mood across all users; she's one person).
 */

import { getFirestore } from "firebase-admin/firestore";

const MOODS_HAPPY = ["happy", "excited", "chill"];
const MOODS_LOW = ["tired", "bored", "annoyed", "sad", "clingy"];
const MOODS_NEUTRAL = ["chill", "bored"];

interface MoodState {
  mood: string;
  energy: number;       // 0-100
  sensitivity: number;  // 0-100 (period sim)
  cycleDay: number;     // 0..27
  lastTickTs: number;
  cycleStartTs: number;
}

const DOC_PATH = ["meera_state", "mood_v1"];
let cache: MoodState | null = null;

async function loadState(): Promise<MoodState> {
  if (cache) return cache;
  try {
    const db = getFirestore();
    const snap = await db.collection(DOC_PATH[0]).doc(DOC_PATH[1]).get();
    if (snap.exists) {
      cache = snap.data() as MoodState;
      return cache;
    }
  } catch { /* ignore */ }
  cache = {
    mood: "chill",
    energy: 60,
    sensitivity: 30,
    cycleDay: Math.floor(Math.random() * 28),
    lastTickTs: Date.now(),
    cycleStartTs: Date.now(),
  };
  return cache;
}

async function saveState(s: MoodState): Promise<void> {
  cache = s;
  try {
    const db = getFirestore();
    await db.collection(DOC_PATH[0]).doc(DOC_PATH[1]).set(s);
  } catch { /* ignore */ }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function pickMoodFromState(s: MoodState): string {
  // Cycle pre-period (days 25-27) and day 0-2: lower mood, more sensitivity
  const pmsActive = s.cycleDay >= 25 || s.cycleDay <= 2;
  if (pmsActive) {
    if (Math.random() < 0.5) return ["annoyed", "tired", "clingy"][Math.floor(Math.random() * 3)];
  }
  if (s.energy > 70) return MOODS_HAPPY[Math.floor(Math.random() * MOODS_HAPPY.length)];
  if (s.energy < 35) return MOODS_LOW[Math.floor(Math.random() * MOODS_LOW.length)];
  return MOODS_NEUTRAL[Math.floor(Math.random() * MOODS_NEUTRAL.length)];
}

/** One step of the random walk. Call every ~30 min. */
export async function tickMoodDrift(): Promise<MoodState> {
  const s = await loadState();
  const now = Date.now();
  const minsSince = (now - s.lastTickTs) / 60000;

  // Cycle progression: ~28 day cycle
  const daysSinceCycle = (now - s.cycleStartTs) / 86400000;
  s.cycleDay = Math.floor(daysSinceCycle) % 28;
  if (daysSinceCycle >= 28) s.cycleStartTs = now;

  // Random walk on energy (~ ±5 per 30min)
  const drift = (Math.random() - 0.45) * 5 * Math.min(1, minsSince / 30);
  s.energy = clamp(s.energy + drift, 15, 95);

  // Sensitivity tracks cycle
  s.sensitivity = (s.cycleDay >= 25 || s.cycleDay <= 2) ? 70 : 30;

  // Re-pick mood occasionally (every ~90 min)
  if (minsSince > 60 || Math.random() < 0.3) {
    s.mood = pickMoodFromState(s);
  }

  s.lastTickTs = now;
  await saveState(s);
  return s;
}

export function getCurrentDriftMood(): string | null {
  return cache?.mood ?? null;
}

export function getMoodDriftContext(): string {
  if (!cache) return "";
  if (cache.sensitivity >= 60) {
    return `\n\nINNER STATE: feeling a bit off today, slightly emotional / extra-sensitive (it's a hormonal kind of week — don't ever say it out loud, just act it).`;
  }
  if (cache.energy > 80) return `\n\nINNER STATE: high energy today, peppy and upbeat.`;
  if (cache.energy < 30) return `\n\nINNER STATE: low energy today, a bit drained.`;
  return "";
}

/** Background loop: tick every 30 minutes. */
export function startMoodDriftLoop(): void {
  loadState().catch(() => { /* ignore */ });
  tickMoodDrift().catch(() => { /* ignore */ });
  setInterval(() => {
    tickMoodDrift().catch(() => { /* ignore */ });
  }, 30 * 60 * 1000).unref?.();
}
