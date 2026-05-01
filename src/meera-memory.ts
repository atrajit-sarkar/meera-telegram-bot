/**
 * Long-term semantic memory for Meera.
 *
 * Uses Gemini's `gemini-embedding-001` model + Firestore for storage.
 * Per-user memories are extracted from conversations and retrieved by cosine
 * similarity when relevant before each reply.
 *
 * Cost: free tier of Gemini embeddings is generous; storage is tiny.
 *
 * Public API:
 *   • storeMemory(userId, text, kind?)
 *   • findRelevantMemories(userId, query, k?)
 *   • maybeExtractMemoriesFromTurn(userId, userText, meeraText) — called per reply
 */

import { getFirestore } from "firebase-admin/firestore";

interface MemoryDoc {
  userId: number;
  text: string;
  kind: string;       // "fact" | "promise" | "anecdote" | "preference" | "milestone"
  ts: number;
  embedding: number[];
}

const COLLECTION = "meera_memories";
const EMBED_MODEL = "gemini-embedding-001";
const EMBED_DIM = 768;

async function embed(text: string): Promise<number[] | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text }] },
        outputDimensionality: EMBED_DIM,
      }),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const v: number[] | undefined = data?.embedding?.values;
    if (Array.isArray(v) && v.length) return v;
    return null;
  } catch {
    return null;
  }
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function storeMemory(userId: number, text: string, kind = "fact"): Promise<void> {
  const trimmed = text.trim().slice(0, 500);
  if (!trimmed) return;
  const vec = await embed(trimmed);
  if (!vec) return;
  try {
    const db = getFirestore();
    await db.collection(COLLECTION).add({
      userId,
      text: trimmed,
      kind,
      ts: Date.now(),
      embedding: vec,
    } as MemoryDoc);
  } catch { /* ignore */ }
}

/** In-memory LRU cache of user memories to avoid hammering Firestore. */
const userCache = new Map<number, { ts: number; docs: MemoryDoc[] }>();
const CACHE_TTL = 5 * 60 * 1000;
const MAX_PER_USER = 200;

async function loadUserMemories(userId: number): Promise<MemoryDoc[]> {
  const cached = userCache.get(userId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.docs;
  try {
    const db = getFirestore();
    const snap = await db.collection(COLLECTION)
      .where("userId", "==", userId)
      .orderBy("ts", "desc")
      .limit(MAX_PER_USER)
      .get();
    const docs: MemoryDoc[] = snap.docs.map(d => d.data() as MemoryDoc);
    userCache.set(userId, { ts: Date.now(), docs });
    return docs;
  } catch {
    return [];
  }
}

export async function findRelevantMemories(userId: number, query: string, k = 3): Promise<MemoryDoc[]> {
  const qVec = await embed(query);
  if (!qVec) return [];
  const docs = await loadUserMemories(userId);
  if (!docs.length) return [];
  const scored = docs.map(d => ({ d, score: cosine(qVec, d.embedding) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.filter(s => s.score > 0.55).slice(0, k).map(s => s.d);
}

/** Heuristic memory extractor — runs cheap regex on user message for fact-like statements. */
export async function maybeExtractMemoriesFromTurn(
  userId: number,
  userText: string,
  _meeraText: string
): Promise<void> {
  if (!userText) return;
  const lower = userText.toLowerCase().trim();
  if (lower.length < 10 || lower.length > 400) return;

  const triggers: { kind: string; pattern: RegExp }[] = [
    { kind: "fact",       pattern: /\b(my name is|i am|i'm|mera naam|main hoon)\b/i },
    { kind: "fact",       pattern: /\b(i live|i stay|i'm from|main rehta|main rahti)\b/i },
    { kind: "fact",       pattern: /\b(i work|i study|i'm a|i am a|naukri|college|class)\b/i },
    { kind: "preference", pattern: /\b(i love|i like|i hate|i don't like|favourite|favorite|pasand)\b/i },
    { kind: "milestone",  pattern: /\b(today|yesterday|tomorrow).*(birthday|exam|interview|wedding|anniversary)/i },
    { kind: "promise",    pattern: /\b(i'?ll tell|i will tell|let me know|tomorrow i|next week)\b/i },
    { kind: "anecdote",   pattern: /\b(my (mom|dad|sister|brother|friend|girlfriend|boyfriend|ex))\b/i },
  ];
  for (const t of triggers) {
    if (t.pattern.test(userText)) {
      await storeMemory(userId, userText.trim(), t.kind);
      // Invalidate cache for this user so next retrieval sees it
      userCache.delete(userId);
      return; // one extraction per turn is enough
    }
  }
}

/** Returns a string ready to drop into the system prompt. */
export async function getMemoryContext(userId: number, recentUserText: string): Promise<string> {
  if (!recentUserText.trim()) return "";
  const mems = await findRelevantMemories(userId, recentUserText, 4);
  if (!mems.length) return "";
  const lines = mems.map(m => `  • [${m.kind}] ${m.text}`).join("\n");
  return `\n\nTHINGS YOU REMEMBER ABOUT THIS PERSON (use naturally if relevant — don't recite):\n${lines}`;
}
