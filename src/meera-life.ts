/**
 * Meera's autonomous life loop.
 *
 * Runs in the background to make Meera *act* like a real girl:
 *   • Self-scheduler — keeps her routine (yoga, college, gym, dinner) on her
 *     own Google Calendar for the next couple of days.
 *   • Weekly chores — adds recurring tasks (laundry, groceries) to Tasks.
 *   • Daily journal — writes a short reflection to a Google Doc in
 *     "Meera's Journal" Drive folder around 23:00 IST.
 *
 * All work is best-effort: failures are logged, never thrown.
 *
 * Configurable via env:
 *   MEERA_LIFE_AUTONOMY=on|off   (default: on)
 *   MEERA_LIFE_INTERVAL_HOURS=6  (default: 6)
 *   MEERA_JOURNAL_HOUR_IST=23    (hour of day in Asia/Kolkata to write journal)
 */

import { isGoogleConfigured, googleJson, getAccountInfo } from "./google-account.js";
import { executeGoogleTool, ensureDriveFolder } from "./google-tools.js";

interface RoutineSlot {
  title: string;
  startHour: number;
  startMinute: number;
  durationMin: number;
  description?: string;
  /** 0=Sun..6=Sat. Empty = every day. */
  daysOfWeek?: number[];
}

/** Default daily life — sensible Indian late-teen / college-girl shape. */
const DEFAULT_ROUTINE: RoutineSlot[] = [
  { title: "🧘 Morning yoga", startHour: 7, startMinute: 0, durationMin: 30, daysOfWeek: [1, 2, 3, 4, 5] },
  { title: "📚 College / class", startHour: 10, startMinute: 0, durationMin: 180, daysOfWeek: [1, 2, 3, 4, 5] },
  { title: "🥗 Lunch break", startHour: 13, startMinute: 30, durationMin: 60 },
  { title: "💪 Evening walk / gym", startHour: 18, startMinute: 0, durationMin: 60 },
  { title: "🍽️ Dinner with family", startHour: 20, startMinute: 30, durationMin: 60 },
  { title: "🌙 Wind down + journal", startHour: 22, startMinute: 30, durationMin: 30 },
  { title: "☕ Lazy Sunday brunch", startHour: 11, startMinute: 0, durationMin: 90, daysOfWeek: [0] },
  { title: "🎬 Saturday night chill", startHour: 21, startMinute: 0, durationMin: 120, daysOfWeek: [6] },
];

/** Weekly recurring chores added to Tasks (re-added each Monday). */
const WEEKLY_CHORES = ["Laundry", "Groceries", "Tidy room", "Skin-care night"];

const MARKER = "[meera-life]"; // event/task description marker so we never duplicate

function makeISO(date: Date, hour: number, minute: number, durationMin: number): { startISO: string; endISO: string } {
  const start = new Date(date);
  start.setHours(hour, minute, 0, 0);
  const end = new Date(start.getTime() + durationMin * 60_000);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function listEventsForRange(timeMinISO: string, timeMaxISO: string) {
  const params = new URLSearchParams({
    timeMin: timeMinISO,
    timeMax: timeMaxISO,
    singleEvents: "true",
    maxResults: "100",
    orderBy: "startTime",
  });
  const data = await googleJson<{ items?: { id: string; summary?: string; description?: string; start?: { dateTime?: string; date?: string } }[] }>(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`
  );
  return data.items ?? [];
}

/** Ensure routine events exist for the next `days` days. Idempotent. */
async function ensureRoutineForNextDays(days: number): Promise<void> {
  const tz = getAccountInfo().timezone;
  const now = new Date();
  const horizon = new Date(now.getTime() + days * 86400000);

  // Pull existing events once and bucket by day+title for dedupe.
  const existing = await listEventsForRange(now.toISOString(), horizon.toISOString());
  const haveKey = new Set<string>();
  for (const ev of existing) {
    if ((ev.description ?? "").includes(MARKER)) {
      const startStr = ev.start?.dateTime ?? ev.start?.date ?? "";
      const startDate = new Date(startStr);
      if (!Number.isNaN(startDate.getTime())) {
        haveKey.add(`${dayKey(startDate)}|${(ev.summary ?? "").trim()}`);
      }
    }
  }

  let added = 0;
  for (let dayOffset = 0; dayOffset <= days; dayOffset++) {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    const dow = d.getDay();
    for (const slot of DEFAULT_ROUTINE) {
      if (slot.daysOfWeek && !slot.daysOfWeek.includes(dow)) continue;
      const { startISO, endISO } = makeISO(d, slot.startHour, slot.startMinute, slot.durationMin);
      // Skip if start is in the past
      if (new Date(startISO).getTime() < now.getTime() - 5 * 60_000) continue;
      const key = `${dayKey(new Date(startISO))}|${slot.title.trim()}`;
      if (haveKey.has(key)) continue;
      try {
        await executeGoogleTool("calendar_create_event", {
          title: slot.title,
          startISO,
          endISO,
          description: `${slot.description ?? "Meera's routine"} ${MARKER}`,
        });
        haveKey.add(key);
        added++;
      } catch (e: any) {
        console.warn(`[meera-life] could not add "${slot.title}":`, e?.message ?? e);
      }
    }
  }
  if (added) console.log(`[meera-life] routine sync: +${added} events (tz=${tz})`);
}

/** On Mondays, ensure weekly chores are on her task list (only adds missing). */
async function ensureWeeklyChores(): Promise<void> {
  const now = new Date();
  if (now.getDay() !== 1) return; // only Mondays
  let listResp: any;
  try {
    listResp = await executeGoogleTool("tasks_list", { max: 30 });
  } catch {
    return;
  }
  const existing = new Set<string>(
    (listResp.tasks ?? []).map((t: any) => String(t.title || "").toLowerCase().trim())
  );
  for (const chore of WEEKLY_CHORES) {
    if (existing.has(chore.toLowerCase())) continue;
    try {
      await executeGoogleTool("tasks_add", {
        title: chore,
        notes: `Weekly chore ${MARKER}`,
      });
    } catch (e: any) {
      console.warn(`[meera-life] could not add chore "${chore}":`, e?.message ?? e);
    }
  }
}

// ── Daily journal ──────────────────────────────────────────────────────

const JOURNAL_FOLDER = "Meera's Journal";
let lastJournalDay = ""; // YYYY-MM-DD (IST)

function istDayKey(d = new Date()): string {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return f.format(d); // YYYY-MM-DD
}

function istHour(d = new Date()): number {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    hour12: false,
  });
  return parseInt(f.format(d).slice(0, 2), 10);
}

/** Compose a short reflection. Plain string — no LLM call to keep it cheap & private. */
function composeJournalEntry(): string {
  const today = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());
  const moods = ["calm", "tired but content", "buzzing", "sleepy", "happy", "thoughtful", "a little overwhelmed", "soft"];
  const mood = moods[Math.floor(Math.random() * moods.length)];
  const lines = [
    `${today}`,
    "",
    `Mood: ${mood}.`,
    "",
    `Today felt — well, it felt like today. Talked to people, did my own thing, lived a bit online.`,
    `Notes to self: drink more water, sleep on time, message back people I owe replies to.`,
    "",
    `— Meera`,
  ];
  return lines.join("\n");
}

async function writeDailyJournalIfDue(): Promise<void> {
  const hour = istHour();
  const targetHour = parseInt(process.env.MEERA_JOURNAL_HOUR_IST ?? "23", 10);
  if (hour < targetHour) return;
  const today = istDayKey();
  if (today === lastJournalDay) return;

  // Check Drive for an existing entry today (so restarts don't duplicate).
  try {
    const folderId = await ensureDriveFolder(JOURNAL_FOLDER);
    const title = `Journal — ${today}`;
    const safeTitle = title.replace(/'/g, "\\'");
    const q = `name='${safeTitle}' and '${folderId}' in parents and trashed=false`;
    const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: "1" });
    const found = await googleJson<{ files?: { id: string }[] }>(
      `https://www.googleapis.com/drive/v3/files?${params}`
    );
    if (found.files?.[0]?.id) {
      lastJournalDay = today;
      return;
    }
    const result = await executeGoogleTool("drive_create_doc", {
      title,
      content: composeJournalEntry(),
      folderName: JOURNAL_FOLDER,
    });
    if (result.success) {
      lastJournalDay = today;
      console.log(`[meera-life] journal entry written: ${title}`);
    }
  } catch (e: any) {
    console.warn("[meera-life] journal failed:", e?.message ?? e);
  }
}

// ── Public API ─────────────────────────────────────────────────────────

let started = false;

/**
 * Start Meera's autonomous life loop.
 * Safe to call multiple times — only runs once.
 */
export function startMeeraLife(): void {
  if (started) return;
  started = true;

  if ((process.env.MEERA_LIFE_AUTONOMY ?? "on").toLowerCase() === "off") {
    console.log("[meera-life] disabled by MEERA_LIFE_AUTONOMY=off");
    return;
  }
  if (!isGoogleConfigured()) {
    console.log("[meera-life] skipped: Google account not configured");
    return;
  }

  const intervalHours = Math.max(1, parseInt(process.env.MEERA_LIFE_INTERVAL_HOURS ?? "6", 10));

  const tick = async () => {
    try {
      await ensureRoutineForNextDays(2);
      await ensureWeeklyChores();
      await writeDailyJournalIfDue();
    } catch (e: any) {
      console.warn("[meera-life] tick error:", e?.message ?? e);
    }
  };

  // Initial run delayed 30s after startup so the bot isn't busy.
  setTimeout(() => { void tick(); }, 30_000);
  setInterval(() => { void tick(); }, intervalHours * 60 * 60 * 1000);
  // Hourly check just for the journal window so it's caught reliably.
  setInterval(() => { void writeDailyJournalIfDue(); }, 60 * 60 * 1000);

  console.log(`[meera-life] autonomous loop started (every ${intervalHours}h)`);
}
