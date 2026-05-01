/**
 * Tenor GIF reactions.
 * Free tier: needs TENOR_API_KEY (free from Google Cloud Console / Tenor v2).
 * If not configured, all calls are no-ops.
 */

const TENOR_BASE = "https://tenor.googleapis.com/v2";

interface CachedSearch { ts: number; gifs: string[] }
const cache = new Map<string, CachedSearch>();
const CACHE_TTL = 30 * 60 * 1000;

export function isTenorConfigured(): boolean {
  return !!process.env.TENOR_API_KEY;
}

export async function searchTenorGif(query: string): Promise<string | null> {
  const key = process.env.TENOR_API_KEY;
  if (!key) return null;
  const q = query.trim().toLowerCase();
  if (!q) return null;

  const cached = cache.get(q);
  let pool: string[];
  if (cached && Date.now() - cached.ts < CACHE_TTL && cached.gifs.length) {
    pool = cached.gifs;
  } else {
    const url = `${TENOR_BASE}/search?q=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}&limit=15&media_filter=gif&contentfilter=medium`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const data: any = await res.json();
      const results: any[] = Array.isArray(data?.results) ? data.results : [];
      const gifs = results
        .map(r => r?.media_formats?.gif?.url || r?.media_formats?.tinygif?.url)
        .filter((u): u is string => !!u);
      if (!gifs.length) return null;
      cache.set(q, { ts: Date.now(), gifs });
      pool = gifs;
    } catch {
      return null;
    }
  }

  return pool[Math.floor(Math.random() * pool.length)];
}

/** Pick a search query keyword from message intent. */
export function inferGifQuery(text: string, mood: string): string | null {
  const t = text.toLowerCase();
  const map: { match: RegExp; query: string }[] = [
    { match: /\b(lol|lmao|haha|funny)\b/i, query: "laugh" },
    { match: /\b(love|miss you|i love)\b/i, query: "cute love" },
    { match: /\b(angry|annoyed|gussa)\b/i, query: "annoyed" },
    { match: /\b(tired|sleepy|so done)\b/i, query: "tired sleepy" },
    { match: /\b(yes|yass|finally)\b/i, query: "yes excited" },
    { match: /\b(no|nope|nahi)\b/i, query: "no shake head" },
    { match: /\b(ok|okay|fine)\b/i, query: "okay shrug" },
    { match: /\b(eat|food|hungry|biryani)\b/i, query: "eating food" },
    { match: /\b(dance|party)\b/i, query: "dance party" },
    { match: /\b(cute|aww)\b/i, query: "aww cute" },
    { match: /\b(thanks|thank you|thx)\b/i, query: "thank you cute" },
    { match: /\b(sorry|sry)\b/i, query: "sorry puppy" },
  ];
  for (const m of map) if (m.match.test(t)) return m.query;

  // Fallback to mood-based
  const moodMap: Record<string, string> = {
    happy: "happy cute",
    excited: "excited yay",
    sassy: "sassy attitude",
    annoyed: "eye roll",
    tired: "tired sleepy",
    bored: "bored",
    clingy: "miss you",
    sad: "sad cry",
    chill: "chilling",
  };
  return moodMap[mood] ?? null;
}
