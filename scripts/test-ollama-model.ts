/**
 * Quickly test which Ollama Cloud models are reachable with your OLLAMA_API_KEY.
 *
 * Usage:
 *   npx tsx scripts/test-ollama-model.ts                       # tests default list
 *   npx tsx scripts/test-ollama-model.ts <model> [<model> ...] # tests given models
 *
 * Examples:
 *   npx tsx scripts/test-ollama-model.ts deepseek-v4-pro:cloud
 *   npx tsx scripts/test-ollama-model.ts gpt-oss:120b-cloud qwen3-coder:480b-cloud
 *
 * Reads OLLAMA_HOST and OLLAMA_API_KEY from .env (falls back to https://ollama.com).
 */

import "dotenv/config";

const HOST = (process.env.OLLAMA_HOST ?? "https://ollama.com").replace(/\/+$/, "");
const KEY = process.env.OLLAMA_API_KEY ?? "";

const DEFAULT_MODELS = [
  "gpt-oss:120b-cloud",
  "gemini-3-flash-preview:cloud",
  "deepseek-v4-pro:cloud",
  "deepseek-v4-flash:cloud",
  "qwen3-coder:480b-cloud",
  "kimi-k2.6:cloud",
  "glm-5.1:cloud",
];

const PROMPT = "Reply with exactly one short sentence.";

interface Result {
  model: string;
  status: number | string;
  ok: boolean;
  ms: number;
  preview: string;
}

async function testModel(model: string): Promise<Result> {
  const url = `${HOST}/api/chat`;
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: PROMPT }],
    stream: false,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  const t0 = Date.now();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${KEY}`,
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    const ms = Date.now() - t0;

    if (!res.ok) {
      return {
        model,
        status: res.status,
        ok: false,
        ms,
        preview: text.slice(0, 200) || "(empty body)",
      };
    }

    let content = "";
    try {
      const json = JSON.parse(text);
      content = json?.message?.content ?? "";
    } catch {
      content = text.slice(0, 200);
    }
    return {
      model,
      status: res.status,
      ok: true,
      ms,
      preview: (content || "(empty content)").replace(/\s+/g, " ").slice(0, 160),
    };
  } catch (err: any) {
    return {
      model,
      status: err?.name === "AbortError" ? "TIMEOUT" : "ERROR",
      ok: false,
      ms: Date.now() - t0,
      preview: err?.message ?? String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (!KEY) {
    console.error("ERROR: OLLAMA_API_KEY missing in .env");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const models = args.length ? args : DEFAULT_MODELS;

  console.log(`Host:   ${HOST}`);
  console.log(`Key:    ${KEY.slice(0, 6)}…${KEY.slice(-4)}`);
  console.log(`Models: ${models.length}\n`);

  const results: Result[] = [];
  for (const m of models) {
    process.stdout.write(`Testing ${m} … `);
    const r = await testModel(m);
    results.push(r);
    const tag = r.ok ? "OK " : "FAIL";
    console.log(`[${tag}] ${r.status} (${r.ms}ms)  ${r.preview}`);
  }

  console.log("\n── Summary ───────────────────────────────────");
  for (const r of results) {
    const mark = r.ok ? "✓" : "✗";
    console.log(`${mark} ${r.status.toString().padEnd(8)} ${r.model}`);
  }
  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n${okCount}/${results.length} models working.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
