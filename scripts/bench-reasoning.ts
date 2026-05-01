/**
 * Reasoning benchmark across working free-tier Ollama Cloud models.
 * Sends a multi-step logic puzzle and rates correctness + speed.
 */
import "dotenv/config";

const HOST = (process.env.OLLAMA_HOST ?? "https://ollama.com").replace(/\/+$/, "");
const KEY = process.env.OLLAMA_API_KEY ?? "";

const MODELS = [
  "gpt-oss:120b-cloud",
  "cogito-2.1:671b-cloud",
  "qwen3-next:80b-cloud",
  "qwen3-coder:480b-cloud",
  "minimax-m2.5:cloud",
  "devstral-2:123b-cloud",
  "nemotron-3-nano:30b-cloud",
  "gemma4:31b-cloud",
];

// Classic multi-step reasoning puzzle with a single correct answer.
const PROMPT = `Solve step-by-step, then state ONLY the final numeric answer on the last line prefixed with "ANSWER: ".

Alice, Bob, and Carol each have a different number of marbles.
- The total is 60.
- Alice has twice as many marbles as Bob.
- Carol has 5 more marbles than Alice.
How many marbles does Carol have?`;

// Correct answer: A=2B, C=A+5=2B+5, A+B+C=5B+5=60 -> B=11, A=22, C=27
const EXPECTED = "27";

interface Row {
  model: string;
  status: number | string;
  ms: number;
  correct: boolean;
  preview: string;
  thinkingChars: number;
}

async function run(model: string): Promise<Row> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  const t0 = Date.now();
  try {
    const res = await fetch(`${HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: PROMPT }], stream: false }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) {
      return { model, status: res.status, ms, correct: false, preview: text.slice(0, 140), thinkingChars: 0 };
    }
    const json: any = JSON.parse(text);
    const content: string = json?.message?.content ?? "";
    const thinking: string = json?.message?.thinking ?? "";
    const m = content.match(/ANSWER:\s*([\d]+)/i);
    const got = m?.[1] ?? "";
    return {
      model,
      status: res.status,
      ms,
      correct: got === EXPECTED,
      preview: content.replace(/\s+/g, " ").slice(0, 140),
      thinkingChars: thinking.length,
    };
  } catch (e: any) {
    return { model, status: "ERROR", ms: Date.now() - t0, correct: false, preview: e?.message ?? String(e), thinkingChars: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (!KEY) { console.error("OLLAMA_API_KEY missing"); process.exit(1); }
  console.log(`Reasoning benchmark — expected answer: ${EXPECTED}\n`);
  const rows: Row[] = [];
  for (const m of MODELS) {
    process.stdout.write(`${m.padEnd(32)} `);
    const r = await run(m);
    rows.push(r);
    const tag = r.correct ? "✓" : "✗";
    console.log(`${tag} ${String(r.status).padEnd(6)} ${(r.ms + "ms").padEnd(7)} think=${r.thinkingChars}  ${r.preview}`);
  }
  console.log("\n── Ranking (correct, by speed) ──");
  rows
    .filter((r) => r.correct)
    .sort((a, b) => a.ms - b.ms)
    .forEach((r, i) => console.log(`${i + 1}. ${r.model}  (${r.ms}ms, thinking=${r.thinkingChars} chars)`));
  console.log("\n── Failed ──");
  rows.filter((r) => !r.correct).forEach((r) => console.log(`✗ ${r.model}  status=${r.status}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
