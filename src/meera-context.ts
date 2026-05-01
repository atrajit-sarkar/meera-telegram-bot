/**
 * Meera's ambient world context — gives her real things going on:
 *   • Indian holidays / festivals (live from Google's public Indian holidays
 *     calendar — falls back to a tiny hardcoded set if Google is unreachable)
 *   • Kolkata AQI (free AQICN API — opt-in via WAQI_TOKEN env)
 *   • Indian news headlines (free RSS feeds — no key needed)
 *   • IPL/cricket fixtures (free TheSportsDB — no key, public)
 *   • Bollywood/movies releases (TMDB — free tier, opt-in via TMDB_API_KEY)
 *
 * Every fetcher is best-effort: failure → returns empty / silent.
 * All output is short and persona-friendly so it can drop into the system prompt.
 */

import { isGoogleConfigured, googleJson } from "./google-account.js";

const FETCH_TIMEOUT_MS = 5000;

async function timedFetch(url: string, opts: RequestInit = {}): Promise<Response | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(t);
    return res;
  } catch {
    return null;
  }
}

// ── 1. INDIAN HOLIDAYS / FESTIVALS ──────────────────────────────────
// Live from Google's public "Holidays in India" calendar.
// Vibes are matched by name keywords — works for any year.

interface FestivalLive {
  date: string;     // YYYY-MM-DD
  name: string;     // from Google
  vibe: string;     // matched from VIBES table; "" if no match
  majorDays: number; // how many days before to start mentioning
}

/** Keyword → vibe map. Keys are lowercase substrings; first match wins. */
const VIBES: Array<{ match: RegExp; vibe: string; majorDays?: number }> = [
  { match: /makar\s*sankranti|pongal|lohri/i, vibe: "kite flying, til ladoo, sun moves north", majorDays: 1 },
  { match: /republic day/i, vibe: "parade vibes, tricolor everywhere", majorDays: 2 },
  { match: /vasant\s*panchami|saraswati\s*puja/i, vibe: "yellow saree day, books-and-pen pujo (huge in Bengal)", majorDays: 3 },
  { match: /maha\s*shivratri|shivratri/i, vibe: "Shiva worship, fasting, late-night jaagran" },
  { match: /holi/i, vibe: "colors, gujiya, bhang, total chaos", majorDays: 4 },
  { match: /good friday|easter/i, vibe: "calm long weekend vibes" },
  { match: /eid\s*ul\s*fitr|eid-ul-fitr|eid$|eid\b/i, vibe: "biryani, sevai, festive evening", majorDays: 1 },
  { match: /ram\s*navami/i, vibe: "Ram Navami, temple visits" },
  { match: /mahavir|baisakhi|vaisakhi|tamil new year/i, vibe: "regional new year energy" },
  { match: /bengali new year|poila boishakh/i, vibe: "panta-ilish, naba barsha, new red-and-white saree", majorDays: 3 },
  { match: /buddha purnima|vesak/i, vibe: "calm peaceful day" },
  { match: /eid\s*ul\s*adha|bakrid|bakri eid/i, vibe: "Bakr-Eid, family meals" },
  { match: /muharram|ashura/i, vibe: "Muharram, somber day" },
  { match: /raksha bandhan|rakhi/i, vibe: "rakhi day, bhai-behen vibes", majorDays: 2 },
  { match: /independence day/i, vibe: "flag hoisting, patriotic songs", majorDays: 2 },
  { match: /janmashtami|krishna janmashtami/i, vibe: "Krishna's birthday, dahi handi" },
  { match: /onam/i, vibe: "Kerala feast day (you'd see insta posts)" },
  { match: /ganesh chaturthi|vinayaka chaturthi/i, vibe: "modaks, Ganpati bappa morya", majorDays: 3 },
  { match: /teacher.?s? day/i, vibe: "school memories, college tributes" },
  { match: /mahalaya/i, vibe: "Bengali pre-Pujo morning, Mahishasura Mardini on radio" },
  { match: /durga\s*puja|durga\s*ashtami|durgashtami|maha\s*ashtami|navami|pujo/i, vibe: "PUJO! pandal hopping in Kolkata is INSANE", majorDays: 7 },
  { match: /dussehra|vijaya dashami|dasara/i, vibe: "sindoor khela, Ravan dahan, bittersweet end of Pujo", majorDays: 1 },
  { match: /gandhi jayanti/i, vibe: "national holiday, dry day" },
  { match: /karva chauth|karwa chauth/i, vibe: "fasting wives, sieve-and-moon ritual" },
  { match: /dhanteras/i, vibe: "buying gold/silver day, Diwali starts" },
  { match: /naraka chaturdashi|chhoti diwali/i, vibe: "Choti Diwali, lights start" },
  { match: /diwali|deepavali|kali puja|kali pujo/i, vibe: "lights, mishti, fireworks (in Bengal it's Kali Pujo)", majorDays: 3 },
  { match: /govardhan|bhai dooj|bhai\s*phonta|bhratri\s*dwitiya/i, vibe: "tilak ceremony, brother-sister day", majorDays: 1 },
  { match: /chhath/i, vibe: "Chhath Puja, sun-god rituals on river ghats" },
  { match: /children.?s? day/i, vibe: "Chacha Nehru, school memories" },
  { match: /guru nanak|guru\s*purab/i, vibe: "Gurpurab, Sikh holiday" },
  { match: /christmas/i, vibe: "Park Street lights are everything in Kolkata!", majorDays: 5 },
  { match: /new year/i, vibe: "party vibes, countdown, resolutions", majorDays: 2 },
];

function vibeForName(name: string): { vibe: string; majorDays: number } {
  for (const v of VIBES) {
    if (v.match.test(name)) return { vibe: v.vibe, majorDays: v.majorDays ?? 1 };
  }
  return { vibe: "", majorDays: 1 };
}

/** Tiny offline fallback so context isn't empty when Google is down/not configured. */
const FALLBACK_FESTIVALS: FestivalLive[] = [
  { date: "2026-03-04", name: "Holi", vibe: "colors, gujiya, bhang, total chaos", majorDays: 4 },
  { date: "2026-08-15", name: "Independence Day", vibe: "flag hoisting, patriotic songs", majorDays: 2 },
  { date: "2026-10-19", name: "Durga Puja begins", vibe: "PUJO! pandal hopping in Kolkata is INSANE", majorDays: 7 },
  { date: "2026-10-23", name: "Dussehra", vibe: "sindoor khela, Ravan dahan, bittersweet end of Pujo", majorDays: 1 },
  { date: "2026-11-08", name: "Diwali", vibe: "lights, mishti, fireworks (in Bengal it's Kali Pujo)", majorDays: 3 },
  { date: "2026-12-25", name: "Christmas", vibe: "Park Street lights are everything in Kolkata!", majorDays: 5 },
];

interface FestivalCache { ts: number; events: FestivalLive[] }
let festivalCache: FestivalCache | null = null;
const FESTIVAL_TTL = 12 * 60 * 60 * 1000; // 12h
const HOLIDAYS_CAL = "en.indian%23holiday%40group.v.calendar.google.com";

export async function refreshFestivals(): Promise<void> {
  if (!isGoogleConfigured()) {
    festivalCache = { ts: Date.now(), events: FALLBACK_FESTIVALS };
    return;
  }
  try {
    const now = new Date();
    const start = new Date(now.getTime() - 1 * 86400000);
    const end = new Date(now.getTime() + 60 * 86400000);
    const params = new URLSearchParams({
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "60",
    });
    const data = await googleJson<{ items?: any[] }>(
      `https://www.googleapis.com/calendar/v3/calendars/${HOLIDAYS_CAL}/events?${params}`
    );
    const items: any[] = data.items ?? [];
    const events: FestivalLive[] = [];
    for (const it of items) {
      const date: string | undefined = it.start?.date ?? (it.start?.dateTime as string)?.slice(0, 10);
      const name: string | undefined = it.summary;
      if (!date || !name) continue;
      const v = vibeForName(name);
      events.push({ date, name, vibe: v.vibe, majorDays: v.majorDays });
    }
    festivalCache = { ts: Date.now(), events };
    console.log(`[festivals] loaded ${events.length} from Google Indian holidays calendar`);
  } catch (err) {
    console.warn("[festivals] google fetch failed, using fallback:", (err as Error).message);
    festivalCache = { ts: Date.now(), events: FALLBACK_FESTIVALS };
  }
}

function todayIST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

function daysBetween(isoA: string, isoB: string): number {
  const a = new Date(isoA + "T00:00:00Z").getTime();
  const b = new Date(isoB + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86400000);
}

export function getFestivalContext(): string {
  if (!festivalCache) return "";
  const today = todayIST();
  const lines: string[] = [];
  const events = festivalCache.events;

  for (const f of events) {
    if (f.date === today) {
      const vibe = f.vibe ? ` — ${f.vibe}` : "";
      lines.push(`🎉 TODAY is ${f.name}${vibe}. Reference it naturally.`);
    }
  }

  // Upcoming
  const upcoming = events.filter(e => e.date > today).slice(0, 8);
  for (const f of upcoming) {
    const days = daysBetween(today, f.date);
    if (days > 0 && days <= f.majorDays) {
      const vibe = f.vibe ? ` — ${f.vibe}` : "";
      lines.push(`📅 ${f.name} in ${days} day${days === 1 ? "" : "s"}${vibe}. You're aware, looking forward.`);
    }
  }

  return lines.length ? "\n\nFESTIVALS / OCCASIONS:\n" + lines.join("\n") : "";
}

// ── 2. KOLKATA AQI ──────────────────────────────────────────────────
// AQICN free token: https://aqicn.org/data-platform/token/

interface AqiCache { ts: number; aqi: number | null; level: string }
let aqiCache: AqiCache | null = null;
const AQI_TTL = 60 * 60 * 1000; // 1h

function aqiLevel(aqi: number): string {
  if (aqi <= 50) return "good";
  if (aqi <= 100) return "moderate";
  if (aqi <= 150) return "unhealthy for sensitive";
  if (aqi <= 200) return "unhealthy";
  if (aqi <= 300) return "very unhealthy";
  return "hazardous";
}

export async function refreshAqi(): Promise<void> {
  const token = process.env.WAQI_TOKEN;
  if (!token) return;
  const url = `https://api.waqi.info/feed/kolkata/?token=${encodeURIComponent(token)}`;
  const res = await timedFetch(url);
  if (!res || !res.ok) return;
  try {
    const data: any = await res.json();
    if (data?.status === "ok" && typeof data?.data?.aqi === "number") {
      aqiCache = { ts: Date.now(), aqi: data.data.aqi, level: aqiLevel(data.data.aqi) };
    }
  } catch { /* ignore */ }
}

export function getAqiContext(): string {
  if (!aqiCache) return "";
  if (Date.now() - aqiCache.ts > AQI_TTL) return "";
  if (aqiCache.aqi == null) return "";
  let line = `\n\nKOLKATA AIR TODAY: AQI ${aqiCache.aqi} (${aqiCache.level}).`;
  if (aqiCache.aqi >= 150) line += " You'd notice — eyes burning a bit, hate stepping out without mask.";
  else if (aqiCache.aqi <= 50) line += " Feels fresh, clear sky kind of day.";
  return line;
}

// ── 3. INDIAN NEWS RSS ──────────────────────────────────────────────
// No key needed.
const RSS_FEEDS = [
  { url: "https://feeds.feedburner.com/ndtvnews-top-stories", source: "NDTV" },
  { url: "https://www.thehindu.com/news/national/feeder/default.rss", source: "The Hindu" },
];

interface NewsCache { ts: number; headlines: { title: string; source: string }[] }
let newsCache: NewsCache | null = null;
const NEWS_TTL = 90 * 60 * 1000; // 90min

function parseRssTitles(xml: string, max = 5): string[] {
  const titles: string[] = [];
  const re = /<item[\s\S]*?<title>([\s\S]*?)<\/title>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && titles.length < max) {
    const t = m[1]
      .replace(/<!\[CDATA\[/g, "")
      .replace(/\]\]>/g, "")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (t) titles.push(t);
  }
  return titles;
}

export async function refreshNews(): Promise<void> {
  const all: { title: string; source: string }[] = [];
  for (const f of RSS_FEEDS) {
    const res = await timedFetch(f.url);
    if (!res || !res.ok) continue;
    try {
      const xml = await res.text();
      for (const t of parseRssTitles(xml, 4)) all.push({ title: t, source: f.source });
    } catch { /* ignore */ }
  }
  if (all.length) newsCache = { ts: Date.now(), headlines: all };
}

export function getNewsContext(): string {
  if (!newsCache || Date.now() - newsCache.ts > NEWS_TTL) return "";
  const top = newsCache.headlines.slice(0, 4);
  if (!top.length) return "";
  return `\n\nNEWS YOU'VE SEEN TODAY (only mention if user starts a topic that touches it):\n${top.map(h => `- ${h.title} (${h.source})`).join("\n")}`;
}

// ── 4. CRICKET (TheSportsDB free) ───────────────────────────────────

interface CricketCache { ts: number; line: string }
let cricketCache: CricketCache | null = null;
const CRICKET_TTL = 60 * 60 * 1000;

export async function refreshCricket(): Promise<void> {
  // TheSportsDB next 5 events for ICC — free public endpoint
  const url = "https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php?id=4391"; // IPL league id
  const res = await timedFetch(url);
  if (!res || !res.ok) return;
  try {
    const data: any = await res.json();
    const events: any[] = Array.isArray(data?.events) ? data.events : [];
    if (!events.length) {
      cricketCache = { ts: Date.now(), line: "" };
      return;
    }
    const next = events[0];
    const home = next.strHomeTeam ?? "";
    const away = next.strAwayTeam ?? "";
    const date = next.dateEvent ?? "";
    if (home && away) {
      cricketCache = { ts: Date.now(), line: `Next IPL/cricket match: ${home} vs ${away} on ${date}.` };
    }
  } catch { /* ignore */ }
}

export function getCricketContext(): string {
  if (!cricketCache || Date.now() - cricketCache.ts > CRICKET_TTL) return "";
  if (!cricketCache.line) return "";
  return `\n\nCRICKET: ${cricketCache.line} (only bring up if cricket comes up in chat — not unprompted).`;
}

// ── 5. BOLLYWOOD MOVIES (TMDB free) ─────────────────────────────────

interface MovieCache { ts: number; movies: { title: string; release: string }[] }
let movieCache: MovieCache | null = null;
const MOVIE_TTL = 24 * 60 * 60 * 1000;

export async function refreshMovies(): Promise<void> {
  const key = process.env.TMDB_API_KEY;
  if (!key) return;
  // Hindi-language now-playing in India
  const url = `https://api.themoviedb.org/3/discover/movie?api_key=${encodeURIComponent(key)}&with_original_language=hi&region=IN&sort_by=popularity.desc&primary_release_date.gte=${getDateMonthsAgo(1)}`;
  const res = await timedFetch(url);
  if (!res || !res.ok) return;
  try {
    const data: any = await res.json();
    const list: any[] = Array.isArray(data?.results) ? data.results.slice(0, 5) : [];
    movieCache = {
      ts: Date.now(),
      movies: list.map(m => ({ title: m.title || m.original_title, release: m.release_date || "" })).filter(m => m.title),
    };
  } catch { /* ignore */ }
}

function getDateMonthsAgo(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

export function getMoviesContext(): string {
  if (!movieCache || Date.now() - movieCache.ts > MOVIE_TTL) return "";
  if (!movieCache.movies.length) return "";
  const titles = movieCache.movies.slice(0, 4).map(m => m.title).join(", ");
  return `\n\nBOLLYWOOD: Movies in theatres / recently out: ${titles}. (mention only if user talks movies.)`;
}

// ── COMBINED ────────────────────────────────────────────────────────

export function getMeeraWorldContext(): string {
  return [
    getFestivalContext(),
    getAqiContext(),
    getNewsContext(),
    getCricketContext(),
    getMoviesContext(),
  ].filter(Boolean).join("");
}

export async function refreshAllWorldContext(): Promise<void> {
  // Run in parallel, swallow errors
  await Promise.allSettled([
    refreshFestivals(),
    refreshAqi(),
    refreshNews(),
    refreshCricket(),
    refreshMovies(),
  ]);
}

/** Start background refresh loop. Call once at startup. */
export function startWorldContextLoop(): void {
  // Initial load
  refreshAllWorldContext().catch(() => { /* ignore */ });
  // Refresh every 60 minutes
  setInterval(() => {
    refreshAllWorldContext().catch(() => { /* ignore */ });
  }, 60 * 60 * 1000).unref?.();
}
