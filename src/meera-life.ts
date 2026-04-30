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

// ── Auto-reschedule on conflict ────────────────────────────────────────
//
// When two events overlap on her calendar, propose a new free slot for
// the *non-routine* event (we never move yoga / college / dinner) and add
// a [meera-life:proposed] tag in the description so we don't propose
// twice. We only mutate her own events that don't have attendees (moving
// a meeting with someone else without notice is rude).

async function autoRescheduleConflicts(): Promise<void> {
  const now = new Date();
  const horizon = new Date(now.getTime() + 3 * 86400000);
  const events = (await listEventsForRange(now.toISOString(), horizon.toISOString())) as any[];

  // Sort and detect overlap pairs.
  const ranged = events
    .map((e: any) => ({
      id: e.id,
      title: (e.summary ?? "").trim(),
      desc: e.description ?? "",
      start: new Date(e.start?.dateTime ?? e.start?.date ?? 0).getTime(),
      end: new Date(e.end?.dateTime ?? e.end?.date ?? 0).getTime(),
      attendees: (e.attendees ?? []).length,
    }))
    .filter((x) => x.start && x.end && x.end > now.getTime())
    .sort((a, b) => a.start - b.start);

  for (let i = 0; i < ranged.length; i++) {
    for (let j = i + 1; j < ranged.length; j++) {
      const a = ranged[i];
      const b = ranged[j];
      if (b.start >= a.end) break;
      // Decide which one to move: prefer moving the non-routine, no-attendee event.
      const moveCandidate = !b.desc.includes(MARKER) && b.attendees === 0
        ? b
        : !a.desc.includes(MARKER) && a.attendees === 0
        ? a
        : null;
      if (!moveCandidate) continue;
      if (moveCandidate.desc.includes("[meera-life:proposed]")) continue;
      // Find next free slot of equal length.
      const dur = Math.round((moveCandidate.end - moveCandidate.start) / 60_000);
      try {
        const free: any = await executeGoogleTool("calendar_find_free_slot", {
          durationMinutes: dur,
          withinDays: 5,
        });
        if (!free?.success) continue;
        await executeGoogleTool("calendar_update_event", {
          eventId: moveCandidate.id,
          startISO: free.startISO,
          endISO: free.endISO,
          description: `${moveCandidate.desc}\n[meera-life:proposed] auto-moved from conflict`,
        });
        console.log(`[meera-life] auto-rescheduled "${moveCandidate.title}" to ${free.startISO}`);
      } catch (e: any) {
        console.warn("[meera-life] reschedule failed:", e?.message ?? e);
      }
    }
  }
}

// ── Morning email triage ───────────────────────────────────────────────
//
// Once per IST day, around `MEERA_TRIAGE_HOUR_IST` (default 8), scan the
// last 24h of unread inbox; star any obvious "important" matches (boss,
// dad, bank, doctor, college) and append a one-line summary line per
// email to her notes doc.

let lastTriageDay = "";
const IMPORTANT_PATTERNS = [
  /\bdad\b/i,
  /\bmom\b/i,
  /\bboss\b/i,
  /bank|hdfc|sbi|icici|axis|kotak/i,
  /college|university|professor|prof\./i,
  /doctor|appointment|hospital|clinic/i,
  /interview|offer letter/i,
];

async function morningTriageIfDue(): Promise<void> {
  const targetHour = parseInt(process.env.MEERA_TRIAGE_HOUR_IST ?? "8", 10);
  if (istHour() < targetHour) return;
  const today = istDayKey();
  if (today === lastTriageDay) return;
  try {
    const inbox: any = await executeGoogleTool("gmail_search", {
      query: "is:unread newer_than:1d",
      max: 15,
    });
    if (!inbox?.success || !inbox.emails?.length) {
      lastTriageDay = today;
      return;
    }
    const summaryLines: string[] = [`Morning triage ${today}:`];
    for (const e of inbox.emails) {
      const subject = String(e.subject ?? "");
      const from = String(e.from ?? "");
      const blob = `${from} ${subject}`;
      const important = IMPORTANT_PATTERNS.some((re) => re.test(blob));
      if (important) {
        try {
          await executeGoogleTool("gmail_label", { messageId: e.id, action: "star" });
        } catch { /* ignore */ }
      }
      summaryLines.push(`- ${important ? "⭐ " : ""}${from} — ${subject}`);
    }
    await executeGoogleTool("notes_add", { text: summaryLines.join("\n") });
    lastTriageDay = today;
    console.log(`[meera-life] morning triage done (${inbox.emails.length} emails)`);
  } catch (e: any) {
    console.warn("[meera-life] triage failed:", e?.message ?? e);
  }
}

// ── Birthday guard ─────────────────────────────────────────────────────
//
// Twice a day, scan contacts for any whose birthday falls within the next
// 2 days, and add a one-time [meera-life:bday] task so Meera "remembers".

let lastBirthdayCheckDay = "";

async function birthdayGuardIfDue(): Promise<void> {
  const today = istDayKey();
  if (today === lastBirthdayCheckDay) return;

  try {
    // Pull all connections with birthdays. People API doesn't sort by upcoming birthday,
    // so we list and filter client-side. Cap at 200.
    const params = new URLSearchParams({
      pageSize: "200",
      personFields: "names,birthdays",
    });
    const data = await googleJson<{
      connections?: { resourceName?: string; names?: { displayName?: string }[]; birthdays?: { date?: { month?: number; day?: number } }[] }[];
    }>(`https://people.googleapis.com/v1/people/me/connections?${params}`);

    const now = new Date();
    const todayMonth = now.getMonth() + 1;
    const todayDay = now.getDate();
    const tomorrow = new Date(now.getTime() + 86400000);
    const tomMonth = tomorrow.getMonth() + 1;
    const tomDay = tomorrow.getDate();
    const dayAfter = new Date(now.getTime() + 2 * 86400000);
    const daMonth = dayAfter.getMonth() + 1;
    const daDay = dayAfter.getDate();

    const matches: { name: string; when: string }[] = [];
    for (const c of data.connections ?? []) {
      const name = c.names?.[0]?.displayName ?? "";
      if (!name) continue;
      for (const b of c.birthdays ?? []) {
        const d = b.date;
        if (!d?.month || !d?.day) continue;
        if (d.month === todayMonth && d.day === todayDay) matches.push({ name, when: "today" });
        else if (d.month === tomMonth && d.day === tomDay) matches.push({ name, when: "tomorrow" });
        else if (d.month === daMonth && d.day === daDay) matches.push({ name, when: "day after tomorrow" });
      }
    }

    if (matches.length) {
      // Add a single grouped task; check existing first to avoid dupes.
      const tasksResp: any = await executeGoogleTool("tasks_list", { max: 30 });
      const existingTitles = new Set<string>(
        (tasksResp.tasks ?? []).map((t: any) => String(t.title || ""))
      );
      for (const m of matches) {
        const title = `🎂 ${m.name}'s birthday ${m.when}`;
        if (existingTitles.has(title)) continue;
        try {
          await executeGoogleTool("tasks_add", {
            title,
            notes: `Don't forget to wish them. ${MARKER}:bday`,
          });
        } catch { /* ignore */ }
      }
      console.log(`[meera-life] birthday guard: ${matches.length} upcoming`);
    }
    lastBirthdayCheckDay = today;
  } catch (e: any) {
    console.warn("[meera-life] birthday guard failed:", e?.message ?? e);
  }
}

// ── Weekly photo recap (Sunday night) ──────────────────────────────────

let lastPhotoRecapWeek = "";

function isoWeek(d: Date): string {
  const year = d.getFullYear();
  const start = new Date(year, 0, 1);
  const days = Math.floor((d.getTime() - start.getTime()) / 86400000);
  const week = Math.ceil((days + start.getDay() + 1) / 7);
  return `${year}-W${week.toString().padStart(2, "0")}`;
}

async function photoRecapIfDue(): Promise<void> {
  const now = new Date();
  if (now.getDay() !== 0) return; // Sundays only
  if (istHour() < 21) return;
  const wk = isoWeek(now);
  if (wk === lastPhotoRecapWeek) return;
  try {
    const recent: any = await executeGoogleTool("photos_recent", { max: 10 });
    if (!recent?.success || !recent.photos?.length) {
      lastPhotoRecapWeek = wk;
      return;
    }
    const lines = [`Photo recap (${wk}):`, ...recent.photos.slice(0, 5).map((p: any) => `- ${p.filename ?? p.id}`)];
    await executeGoogleTool("notes_add", { text: lines.join("\n") });
    lastPhotoRecapWeek = wk;
    console.log(`[meera-life] photo recap noted (${recent.photos.length} items)`);
  } catch (e: any) {
    console.warn("[meera-life] photo recap failed:", e?.message ?? e);
  }
}

// ── Receipt auto-file ──────────────────────────────────────────────────
//
// Every life tick, scan unread mail tagged invoice/receipt/bill from the
// last 7 days. For each, label "Receipts/<YYYY-MM>" (created if missing)
// and archive (remove INBOX). Lightweight — no attachment parsing.

async function receiptAutoFileIfDue(): Promise<void> {
  try {
    const inbox: any = await executeGoogleTool("gmail_search", {
      query: "newer_than:7d (subject:(invoice OR receipt OR bill OR payment) OR from:(billing OR no-reply OR noreply))",
      max: 15,
    });
    if (!inbox?.success || !inbox.emails?.length) return;

    // Get/create label
    const ym = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
    const labelName = `Receipts/${ym}`;
    const labelId = await ensureGmailLabel(labelName);

    let filed = 0;
    for (const e of inbox.emails) {
      try {
        // Add custom label, archive (remove INBOX).
        await googleJson(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${e.id}/modify`,
          {
            method: "POST",
            body: JSON.stringify({ addLabelIds: [labelId], removeLabelIds: ["INBOX"] }),
          }
        );
        filed++;
      } catch { /* ignore */ }
    }
    if (filed) console.log(`[meera-life] filed ${filed} receipts under ${labelName}`);
  } catch (e: any) {
    console.warn("[meera-life] receipt filer failed:", e?.message ?? e);
  }
}

const labelCache = new Map<string, string>();
async function ensureGmailLabel(name: string): Promise<string> {
  if (labelCache.has(name)) return labelCache.get(name)!;
  const data = await googleJson<{ labels?: { id: string; name: string }[] }>(
    "https://gmail.googleapis.com/gmail/v1/users/me/labels"
  );
  const found = data.labels?.find((l) => l.name === name);
  if (found) {
    labelCache.set(name, found.id);
    return found.id;
  }
  const created = await googleJson<{ id: string }>(
    "https://gmail.googleapis.com/gmail/v1/users/me/labels",
    {
      method: "POST",
      body: JSON.stringify({
        name,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      }),
    }
  );
  labelCache.set(name, created.id);
  return created.id;
}

// ── Autonomous YouTube activity ────────────────────────────────────────
//
// Runs every life tick when YOUTUBE_AUTONOMY=on (default). Picks 1-2 fresh
// videos from her subscriptions feed (or from a curated discovery search if
// she has no subs yet), "watches" them (adds to her private Watched playlist),
// and probabilistically likes (~55%) and very rarely comments (skipped in
// background — comments need LLM-quality text, only done when user asks).

const DISCOVERY_QUERIES = [
  "indie music 2026",
  "vlog kolkata",
  "skincare routine",
  "study with me",
  "casual cooking",
  "indie short film",
  "life update vlog",
  "outfit ideas",
  "books recommendation",
  "morning routine india",
];

let lastYoutubeActivity = 0;
const YT_MIN_GAP_MS = 90 * 60 * 1000; // at most one batch every 90 min

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function youtubeAutonomousIfDue(): Promise<void> {
  if ((process.env.YOUTUBE_AUTONOMY ?? "on").toLowerCase() === "off") return;
  if (Date.now() - lastYoutubeActivity < YT_MIN_GAP_MS) return;
  try {
    // Pull her subscription feed; fall back to discovery search if empty.
    let pool: any[] = [];
    try {
      const feed: any = await executeGoogleTool("youtube_subscriptions_feed", { max: 15 });
      if (feed?.success && Array.isArray(feed.videos)) pool = feed.videos;
    } catch { /* ignore */ }
    if (!pool.length) {
      const q = pickRandom(DISCOVERY_QUERIES);
      try {
        const search: any = await executeGoogleTool("youtube_search", { query: q, max: 8 });
        if (search?.success && Array.isArray(search.videos)) pool = search.videos;
      } catch { /* ignore */ }
    }
    if (!pool.length) return;

    // Filter out already-watched.
    const watched: any = await executeGoogleTool("youtube_recent_watched", { max: 20 }).catch(() => ({ videos: [] }));
    const seenIds = new Set<string>(
      ((watched?.videos ?? []) as any[]).map((v) => v.videoId).filter(Boolean)
    );
    const candidates = pool.filter((v: any) => v.videoId && !seenIds.has(v.videoId));
    if (!candidates.length) return;

    // Watch 1-2 randomly.
    const take = candidates.slice(0, Math.min(2, candidates.length));
    for (const v of take) {
      const url = v.url || `https://youtu.be/${v.videoId}`;
      try {
        await executeGoogleTool("youtube_mark_watched", { url });
      } catch { /* ignore */ }
      // ~55% like
      if (Math.random() < 0.55) {
        try { await executeGoogleTool("youtube_like_video", { url }); } catch { /* ignore */ }
      }
      // ~12% subscribe to creator if not already
      if (v.channelId && Math.random() < 0.12) {
        try { await executeGoogleTool("youtube_subscribe", { channelId: v.channelId }); } catch { /* ignore */ }
      }
    }
    lastYoutubeActivity = Date.now();
    console.log(`[meera-life] youtube: watched ${take.length} video(s)`);
  } catch (e: any) {
    console.warn("[meera-life] youtube autonomy failed:", e?.message ?? e);
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
      await autoRescheduleConflicts();
      await morningTriageIfDue();
      await birthdayGuardIfDue();
      await photoRecapIfDue();
      await receiptAutoFileIfDue();
      await youtubeAutonomousIfDue();
    } catch (e: any) {
      console.warn("[meera-life] tick error:", e?.message ?? e);
    }
  };

  // Initial run delayed 30s after startup so the bot isn't busy.
  setTimeout(() => { void tick(); }, 30_000);
  setInterval(() => { void tick(); }, intervalHours * 60 * 60 * 1000);
  // Hourly checks for time-of-day-gated routines.
  setInterval(() => {
    void writeDailyJournalIfDue();
    void morningTriageIfDue();
    void birthdayGuardIfDue();
    void photoRecapIfDue();
  }, 60 * 60 * 1000);

  console.log(`[meera-life] autonomous loop started (every ${intervalHours}h)`);
}
