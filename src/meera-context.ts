/**
 * Meera's ambient world context — gives her real things going on:
 *   • Indian holidays / festivals (hardcoded high-quality list, no API key needed)
 *   • Kolkata AQI (free AQICN API — opt-in via WAQI_TOKEN env)
 *   • Indian news headlines (free RSS feeds — no key needed)
 *   • IPL/cricket fixtures (free TheSportsDB — no key, public)
 *   • Bollywood/movies releases (TMDB — free tier, opt-in via TMDB_API_KEY)
 *
 * Every fetcher is best-effort: failure → returns empty / silent.
 * All output is short and persona-friendly so it can drop into the system prompt.
 */

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
// Curated for the next ~2 years. No API key. Update yearly.
// Format: ISO date "YYYY-MM-DD" → { name, vibe }
type Festival = { name: string; vibe: string; majorDays?: number /* days before to start mentioning */ };

const FESTIVALS: Record<string, Festival> = {
  // 2026
  "2026-01-14": { name: "Makar Sankranti / Pongal", vibe: "kite flying, til ladoo, sun moves north" },
  "2026-01-26": { name: "Republic Day", vibe: "parade vibes, tricolor everywhere", majorDays: 2 },
  "2026-02-15": { name: "Vasant Panchami / Saraswati Puja", vibe: "yellow saree day, books-and-pen pujo (huge in Bengal)", majorDays: 3 },
  "2026-03-04": { name: "Holi", vibe: "colors, gujiya, bhang, total chaos", majorDays: 4 },
  "2026-03-21": { name: "Eid-ul-Fitr (approx)", vibe: "biryani, sevai, festive evening" },
  "2026-04-14": { name: "Bengali New Year (Poila Boishakh)", vibe: "panta-ilish, naba barsha, new red-and-white saree", majorDays: 3 },
  "2026-05-22": { name: "Buddha Purnima", vibe: "calm peaceful day" },
  "2026-08-15": { name: "Independence Day", vibe: "flag hoisting, patriotic songs", majorDays: 2 },
  "2026-08-19": { name: "Janmashtami", vibe: "Krishna's birthday, dahi handi" },
  "2026-08-26": { name: "Raksha Bandhan", vibe: "rakhi day, bhai-behen vibes" },
  "2026-09-05": { name: "Teachers' Day", vibe: "school memories, college tributes" },
  "2026-09-14": { name: "Ganesh Chaturthi", vibe: "modaks, Ganpati bappa morya", majorDays: 3 },
  "2026-10-15": { name: "Mahalaya", vibe: "Bengali pre-Pujo morning, Mahishasura Mardini on radio" },
  "2026-10-19": { name: "Durga Puja Shashthi", vibe: "Pujo starts! Pandal hopping in Kolkata is INSANE", majorDays: 7 },
  "2026-10-20": { name: "Maha Saptami", vibe: "Pujo day 2, new clothes, family time" },
  "2026-10-21": { name: "Maha Ashtami", vibe: "Pujo day 3, anjali, the BIG day" },
  "2026-10-22": { name: "Maha Navami", vibe: "Pujo day 4, last big celebration" },
  "2026-10-23": { name: "Vijaya Dashami / Dussehra", vibe: "sindoor khela, Ravan dahan, bittersweet end of Pujo", majorDays: 1 },
  "2026-10-29": { name: "Karwa Chauth", vibe: "fasting wives, sieve-and-moon ritual" },
  "2026-11-08": { name: "Diwali / Kali Puja", vibe: "lights, mishti, fireworks (in Bengal it's Kali Pujo)", majorDays: 3 },
  "2026-11-09": { name: "Bhai Dooj", vibe: "tilak ceremony, brother-sister day" },
  "2026-11-15": { name: "Children's Day", vibe: "Chacha Nehru, school memories" },
  "2026-12-25": { name: "Christmas", vibe: "Park Street lights are everything in Kolkata!", majorDays: 5 },
  "2026-12-31": { name: "New Year's Eve", vibe: "party vibes, countdown, resolutions", majorDays: 2 },

  // 2027 (rough)
  "2027-01-01": { name: "New Year", vibe: "fresh start", majorDays: 1 },
  "2027-01-14": { name: "Makar Sankranti", vibe: "kite flying" },
  "2027-01-26": { name: "Republic Day", vibe: "parade", majorDays: 2 },
  "2027-02-04": { name: "Saraswati Puja", vibe: "yellow saree day", majorDays: 3 },
  "2027-03-22": { name: "Holi", vibe: "colors", majorDays: 4 },
  "2027-08-15": { name: "Independence Day", vibe: "tricolor", majorDays: 2 },
};

function todayIST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

function daysBetween(isoA: string, isoB: string): number {
  const a = new Date(isoA + "T00:00:00Z").getTime();
  const b = new Date(isoB + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86400000);
}

export function getFestivalContext(): string {
  const today = todayIST();
  const lines: string[] = [];

  // Today
  if (FESTIVALS[today]) {
    const f = FESTIVALS[today];
    lines.push(`🎉 TODAY is ${f.name} — ${f.vibe}. Reference it naturally.`);
  }

  // Upcoming within window
  const sorted = Object.entries(FESTIVALS).filter(([d]) => d >= today).sort();
  for (const [date, f] of sorted.slice(0, 4)) {
    const days = daysBetween(today, date);
    const window = f.majorDays ?? 1;
    if (days > 0 && days <= window) {
      lines.push(`📅 ${f.name} in ${days} day${days === 1 ? "" : "s"} — ${f.vibe}. You're aware, looking forward.`);
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
