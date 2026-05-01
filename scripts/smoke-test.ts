/**
 * Smoke test: verify every external service Meera depends on.
 * Run: npx tsx scripts/smoke-test.ts
 */
import "dotenv/config";

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];

function pad(s: string, n: number) { return s + " ".repeat(Math.max(0, n - s.length)); }

async function check(name: string, fn: () => Promise<string>) {
  process.stdout.write(`  ${pad(name, 28)} ... `);
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`OK   ${detail}`);
  } catch (e: any) {
    results.push({ name, ok: false, detail: e?.message || String(e) });
    console.log(`FAIL ${e?.message || e}`);
  }
}

// 1. Google Calendar Indian holidays
await check("Google Indian Holidays", async () => {
  const { isGoogleConfigured } = await import("../src/google-account.js");
  if (!isGoogleConfigured()) return "skipped (not configured)";
  const { refreshFestivals, getFestivalContext } = await import("../src/meera-context.js");
  await refreshFestivals();
  const ctx = getFestivalContext();
  return ctx ? `loaded; sample: ${ctx.split("\n").slice(0, 2).join(" | ").slice(0, 80)}` : "loaded (none in window)";
});

// 2. AQICN (Kolkata AQI)
await check("AQICN (Kolkata AQI)", async () => {
  const token = process.env.WAQI_TOKEN;
  if (!token) return "skipped (no WAQI_TOKEN)";
  const r = await fetch(`https://api.waqi.info/feed/kolkata/?token=${token}`);
  const j: any = await r.json();
  if (j?.status !== "ok") throw new Error(j?.data || "bad response");
  return `AQI=${j.data.aqi}`;
});

// 3. NDTV RSS
await check("NDTV RSS", async () => {
  const r = await fetch("https://feeds.feedburner.com/ndtvnews-top-stories");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const t = await r.text();
  const m = t.match(/<item>/g);
  return `${m?.length ?? 0} items`;
});

// 4. The Hindu RSS
await check("The Hindu RSS", async () => {
  const r = await fetch("https://www.thehindu.com/news/national/feeder/default.rss");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const t = await r.text();
  const m = t.match(/<item>/g);
  return `${m?.length ?? 0} items`;
});

// 5. TheSportsDB cricket
await check("TheSportsDB cricket", async () => {
  const r = await fetch("https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php?id=4344");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j: any = await r.json();
  const n = Array.isArray(j?.events) ? j.events.length : 0;
  return `${n} upcoming events`;
});

// 6. TMDB
await check("TMDB", async () => {
  const key = process.env.TMDB_API_KEY;
  if (!key) return "skipped (no TMDB_API_KEY)";
  const r = await fetch(`https://api.themoviedb.org/3/discover/movie?api_key=${key}&region=IN&sort_by=popularity.desc`);
  const j: any = await r.json();
  if (j?.status_code) throw new Error(j.status_message);
  return `${j?.results?.length ?? 0} movies`;
});

// 7. Giphy
await check("Giphy", async () => {
  const key = process.env.GIPHY_API_KEY;
  if (!key) return "skipped (no GIPHY_API_KEY)";
  const r = await fetch(`https://api.giphy.com/v1/gifs/search?q=hello&api_key=${key}&limit=3`);
  const j: any = await r.json();
  if (j?.meta?.status !== 200) throw new Error(JSON.stringify(j?.meta));
  return `${j?.data?.length ?? 0} gifs`;
});

// 8. Gemini text-embedding
await check("Gemini embeddings", async () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return "skipped (no GEMINI_API_KEY)";
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: { parts: [{ text: "smoke test" }] }, outputDimensionality: 768 }),
    }
  );
  const j: any = await r.json();
  if (j?.error) throw new Error(j.error.message);
  const dims = j?.embedding?.values?.length ?? 0;
  return `${dims} dims`;
});

// 9. Telegram bot getMe
await check("Telegram bot", async () => {
  const tok = process.env.TELEGRAM_BOT_TOKEN;
  if (!tok) return "skipped";
  const r = await fetch(`https://api.telegram.org/bot${tok}/getMe`);
  const j: any = await r.json();
  if (!j?.ok) throw new Error(j?.description);
  return `@${j.result.username}`;
});

// Summary
console.log("\n" + "=".repeat(60));
const passed = results.filter(r => r.ok).length;
console.log(`${passed}/${results.length} passed`);
const failed = results.filter(r => !r.ok);
if (failed.length) {
  console.log("\nFailures:");
  failed.forEach(f => console.log(`  - ${f.name}: ${f.detail}`));
  process.exit(1);
}
process.exit(0);
