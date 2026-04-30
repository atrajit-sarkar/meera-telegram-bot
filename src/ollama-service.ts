/**
 * Ollama-compatible chat completion service.
 * Used for text-to-text conversations.
 */

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  msgId?: number;
  /** Set on assistant messages that requested tool calls (passed back to model) */
  tool_calls?: OllamaToolCall[];
  /** Set on tool-result messages so the model can correlate to its tool_call id */
  tool_call_id?: string;
  name?: string;
}

export interface OllamaConfig {
  host: string;
  model: string;
  apiKey: string;
}

/** Ollama / OpenAI-style tool declaration */
export interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OllamaToolCall {
  id?: string;
  type?: "function";
  function: { name: string; arguments: any };
}

export type OllamaToolHandler = (
  name: string,
  args: Record<string, unknown>
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface OllamaCallOptions {
  tools?: OllamaTool[];
  onToolCall?: OllamaToolHandler;
  /** Cap tool-call iterations to avoid runaway loops. Default 4. */
  maxToolIterations?: number;
}

/**
 * Call Ollama with key rotation.
 * Priority: user's personal keys → community pool keys → default env key.
 */
export async function callOllamaWithRotation(
  config: OllamaConfig,
  messages: OllamaMessage[],
  extraKeys: string[] = [],
  communityKeys: string[] = [],
  options: OllamaCallOptions = {}
): Promise<string> {
  // Personal keys first, then community pool (shuffled), then default key last
  const keys = [...extraKeys, ...communityKeys, config.apiKey].filter(Boolean);
  // Deduplicate while preserving order
  const seen = new Set<string>();
  const uniqueKeys = keys.filter((k) => {
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  let lastError: Error | null = null;

  for (const key of uniqueKeys) {
    try {
      return await callOllama({ ...config, apiKey: key }, messages, options);
    } catch (err: any) {
      lastError = err;
      if (err.message === "quota_exceeded") {
        console.log("[Ollama] Key quota exceeded, trying next key...");
        continue;
      }
      if (err.message === "invalid_key") {
        console.log("[Ollama] Invalid key, trying next key...");
        continue;
      }
      // Persistent empty content / safety blocks on this key — try next key.
      if (err.message === "No content in Ollama response" || err.message === "ollama_safety_block" || err.message === "ollama_tool_only") {
        console.log(`[Ollama] ${err.message}, trying next key...`);
        continue;
      }
      // Also rotate on rate-limit or server errors (5xx)
      if (err.message?.startsWith("ollama_error:")) {
        const statusMatch = err.message.match(/ollama_error:\s*(\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1]) : 0;
        if (status === 429 || status >= 500) {
          console.log(`[Ollama] Server error ${status}, trying next key...`);
          continue;
        }
      }
      throw err; // Non-recoverable error, don't rotate
    }
  }
  throw lastError ?? new Error("All Ollama API keys exhausted");
}

export async function callOllama(
  config: OllamaConfig,
  messages: OllamaMessage[],
  options: OllamaCallOptions = {}
): Promise<string> {
  const url = `${config.host.replace(/\/+$/, "")}/api/chat`;
  const maxToolIters = options.maxToolIterations ?? 4;

  // We mutate a working copy of the message list across tool iterations.
  const working: any[] = messages.map((m) => ({ ...m }));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  // Up to 2 retries for empty-content responses (cold-start "done_reason: load",
  // transient safety hits). Total max attempts per turn = 3.
  const MAX_EMPTY_RETRIES = 2;

  try {
    for (let toolIter = 0; toolIter <= maxToolIters; toolIter++) {
      const reqBody: Record<string, unknown> = {
        model: config.model,
        messages: working,
        stream: false,
      };
      if (options.tools?.length) reqBody.tools = options.tools;

      // Inner loop: handle cold-start retries within a single turn.
      let parsedMsg: any = null;
      let json: any = null;
      for (let attempt = 0; attempt <= MAX_EMPTY_RETRIES; attempt++) {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(reqBody),
          signal: controller.signal,
        });

        const text = await res.text();

        if (!res.ok) {
          const lower = text.toLowerCase();
          if (lower.includes("unauthorized") || lower.includes("invalid")) {
            throw new Error("invalid_key");
          }
          if (res.status === 429 || lower.includes("rate") || lower.includes("quota") || lower.includes("limit")) {
            throw new Error("quota_exceeded");
          }
          throw new Error(`ollama_error: ${res.status} ${text.slice(0, 200)}`);
        }

        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`ollama_error: invalid JSON (${text.slice(0, 120)})`);
        }

        const msg = json?.message ?? {};
        const content: string = msg.content ?? "";
        const hasToolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;

        if (hasToolCalls || (content && content.trim())) {
          parsedMsg = msg;
          break;
        }

        // Empty + no tool calls — diagnose & decide whether to retry same key.
        const doneReason: string | undefined = json?.done_reason;
        const finishReason: string | undefined = msg?.finish_reason;
        console.warn(
          `[Ollama] empty content (attempt ${attempt + 1}/${MAX_EMPTY_RETRIES + 1}) ` +
            `done_reason=${doneReason ?? "?"} finish=${finishReason ?? "?"} ` +
            `keys=${Object.keys(msg).join(",")}`
        );
        if (doneReason === "load" && attempt < MAX_EMPTY_RETRIES) {
          await new Promise((r) => setTimeout(r, 500 + attempt * 500));
          continue;
        }
        if (finishReason === "safety" || finishReason === "blocked") {
          throw new Error("ollama_safety_block");
        }
        if (attempt < MAX_EMPTY_RETRIES) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        throw new Error("No content in Ollama response");
      }

      if (!parsedMsg) throw new Error("No content in Ollama response");

      // ── If the model wants to call tools, run them and loop. ──────
      const toolCalls: OllamaToolCall[] = parsedMsg.tool_calls ?? [];
      if (toolCalls.length && options.onToolCall && toolIter < maxToolIters) {
        // Push assistant turn (with tool_calls) onto the working transcript.
        working.push({
          role: "assistant",
          content: parsedMsg.content ?? "",
          tool_calls: toolCalls,
        });
        for (const tc of toolCalls) {
          const fnName = tc.function?.name ?? "";
          let args: Record<string, unknown> = {};
          try {
            args =
              typeof tc.function?.arguments === "string"
                ? JSON.parse(tc.function.arguments)
                : tc.function?.arguments ?? {};
          } catch {
            args = {};
          }
          console.log(`[Ollama] tool_call → ${fnName}(${JSON.stringify(args).slice(0, 160)})`);
          let result: Record<string, unknown>;
          try {
            result = await options.onToolCall(fnName, args);
          } catch (e: any) {
            result = { success: false, message: e?.message ?? "tool error" };
          }
          working.push({
            role: "tool",
            name: fnName,
            tool_call_id: tc.id ?? fnName,
            content: JSON.stringify(result).slice(0, 6000),
          });
        }
        continue; // next iteration: model now sees tool results
      }

      // ── Final answer ──────────────────────────────────────────────
      const finalContent = (parsedMsg.content ?? "").trim();
      if (!finalContent) {
        // Tool-only response with no follow-up text — extremely rare given the loop
        throw new Error("No content in Ollama response");
      }
      return finalContent;
    }
    throw new Error("ollama_tool_loop_exhausted");
  } finally {
    clearTimeout(timeout);
  }
}

// ── Telegram Reaction Emojis ─────────────────────────────────────

// ── AI Behavior Decision ─────────────────────────────────────────

export type ResponseAction =
  | { action: "reply_normal" }
  | { action: "delay_reply"; delayMinutes: number; reason: string }
  | { action: "leave_on_read" }
  | { action: "emoji_only"; emoji: string }
  | { action: "sticker_only" };

// ── Meera Behavior Decision (comprehensive, replaces all hardcoded behavior) ──

export interface MeeraBehavior {
  /** What she's doing right now — affects everything */
  availability: "free" | "busy" | "sleeping" | "drowsy" | "distracted";
  /** How to respond */
  responseMode: "text" | "voice" | "emoji_only" | "sticker_only" | "leave_on_read" | "delay";
  /** If delay — how many minutes (1-480) */
  delayMinutes: number;
  /** If delay — why (natural language, e.g. "was napping", "in class") */
  delayReason: string;
  /** Typing/read delay multiplier (0.3 = very fast, 1.0 = normal, 3.0 = very slow) */
  delayMultiplier: number;
  /** Whether to quote-reply the user's message */
  shouldQuote: boolean;
  /** Whether to send silently (no notification sound) */
  sendSilently: boolean;
  /** Emoji to react with, or empty string for no reaction */
  reactEmoji: string;
  /** Context hint for the AI generating the actual reply (e.g. "just woke up", "in a rush") */
  vibeContext: string;
  /** Gap context — how she feels about time since last message */
  gapContext: string;
  /** What she's specifically doing right now (e.g. "watching reels", "eating maggi", "studying for exam") */
  currentActivity: string;
  /** Whether to simulate typing hesitation (start typing → pause → resume) */
  typingHesitation: boolean;
}

const BEHAVIOR_DEFAULTS: MeeraBehavior = {
  availability: "free",
  responseMode: "text",
  delayMinutes: 0,
  delayReason: "",
  delayMultiplier: 1.0,
  shouldQuote: false,
  sendSilently: false,
  reactEmoji: "",
  vibeContext: "",
  gapContext: "",
  currentActivity: "",
  typingHesitation: false,
};

// ── Meera's Base Lifestyle Schedule (IST) ────────────────────────
// These are her ANCHORS — the AI uses them as strong defaults but can
// override per-user based on relationship, engagement, and conversation momentum.
const MEERA_SCHEDULE = {
  sleepyStart: 23,    // 11 PM — starts getting drowsy
  deepSleep: 1,       // 1 AM — definitely asleep
  wakeEarly: 7,       // 7 AM — earliest she might stir
  wakeNormal: 8,      // 8 AM — usually awake by now
  collegeMorning: [9, 12] as [number, number],   // might be in class
  collegeAfternoon: [14, 16] as [number, number], // might be in class
  primeTime: [19, 23] as [number, number],        // most active / free
};

/** Build a lifestyle anchor string from the current IST hour */
function getLifestyleAnchor(hourIST: number): string {
  if (hourIST >= MEERA_SCHEDULE.deepSleep && hourIST < MEERA_SCHEDULE.wakeEarly)
    return "DEEP SLEEP — she's definitely sleeping. Must delay unless close friend in active convo.";
  if (hourIST >= MEERA_SCHEDULE.sleepyStart || hourIST < MEERA_SCHEDULE.deepSleep)
    return "GETTING SLEEPY — she's winding down, might still be on phone in bed. Close friends can keep her up.";
  if (hourIST >= MEERA_SCHEDULE.wakeEarly && hourIST < MEERA_SCHEDULE.wakeNormal)
    return "JUST WAKING UP — groggy, checking phone half-asleep. Slow responses, short messages.";
  if (hourIST >= MEERA_SCHEDULE.collegeMorning[0] && hourIST < MEERA_SCHEDULE.collegeMorning[1])
    return "MORNING — could be in college/class or studying. Might be distracted or busy, occasional phone checks.";
  if (hourIST >= MEERA_SCHEDULE.collegeAfternoon[0] && hourIST < MEERA_SCHEDULE.collegeAfternoon[1])
    return "AFTERNOON — might be in class, studying, or taking a nap. Variable availability.";
  if (hourIST >= 12 && hourIST < MEERA_SCHEDULE.collegeAfternoon[0])
    return "LUNCH TIME — free, eating, scrolling phone. Usually available.";
  if (hourIST >= MEERA_SCHEDULE.collegeAfternoon[1] && hourIST < MEERA_SCHEDULE.primeTime[0])
    return "EVENING — relaxing after college, snacking, maybe watching something. Generally free.";
  if (hourIST >= MEERA_SCHEDULE.primeTime[0] && hourIST < MEERA_SCHEDULE.primeTime[1])
    return "PRIME TIME — she's most active now. Chatting, watching reels, lying in bed. Very available.";
  return "MORNING ROUTINE — getting ready, breakfast. Might be busy.";
}

/**
 * Single comprehensive AI call that decides ALL of Meera's behavioral aspects.
 * Now with per-user personalization: engagement, conversation momentum,
 * behavioral consistency across users, and lifestyle schedule anchors.
 */
export async function decideMeeraBehavior(
  config: OllamaConfig,
  userMessage: string,
  chatHistory: OllamaMessage[],
  opts: {
    tier: string;
    mood: string;
    timeContext: string;      // e.g. "2:30 AM IST, Sunday"
    weatherContext: string;   // e.g. "Rainy, 24°C, humid"
    gapHours: number;         // hours since last interaction
    isRapidFire: boolean;     // are they messaging fast back-and-forth?
    avgGapMs: number;         // average gap between recent messages
    messageLength: number;    // length of user's message
    isMedia: boolean;         // user sent photo/video/audio
    personaHint?: string;
    // ── NEW: per-user personalization ──
    hourIST?: number;                // current IST hour (0-23)
    engagementScore?: number;        // 0-100, how warm she is with THIS user
    activeConvoMinutes?: number;     // how long they've been actively chatting
    lastBehaviorMode?: string;       // what she did for this user last time
    lastBehaviorVibe?: string;       // her vibe last time with this user
    lastBehaviorMinutesAgo?: number; // when that last decision was
    globalAnchor?: { mode: string; vibe: string; minutesAgo: number } | null; // what she's doing for OTHER users
  },
  userKeys: string[] = [],
  communityKeys: string[] = [],
): Promise<MeeraBehavior> {
  const personaLine = opts.personaHint
    ? `Your personality: ${opts.personaHint}`
    : "You're a young Indian girl (college-age, casual, expressive).";

  // Build lifestyle anchor
  const hourIST = opts.hourIST ?? 12;
  const lifestyleAnchor = getLifestyleAnchor(hourIST);

  // Build per-user context lines
  const perUserLines: string[] = [];

  if (opts.engagementScore !== undefined) {
    const eng = opts.engagementScore;
    const label = eng >= 80 ? "very warm/invested" : eng >= 60 ? "warm" : eng >= 40 ? "neutral" : eng >= 20 ? "cool/distant" : "cold/detached";
    perUserLines.push(`- Engagement with THIS person: ${eng}/100 (${label})`);
  }

  if (opts.activeConvoMinutes && opts.activeConvoMinutes > 0) {
    perUserLines.push(`- Active conversation going for ${Math.round(opts.activeConvoMinutes)} minutes — she's already engaged with them`);
    if (hourIST >= MEERA_SCHEDULE.sleepyStart || hourIST < MEERA_SCHEDULE.wakeEarly) {
      perUserLines.push(`  → She might stay up late for them since they're mid-conversation (especially if close)`);
    }
  }

  if (opts.lastBehaviorMode && opts.lastBehaviorMinutesAgo !== undefined && opts.lastBehaviorMinutesAgo < 30) {
    perUserLines.push(`- ${Math.round(opts.lastBehaviorMinutesAgo)} min ago she was: "${opts.lastBehaviorVibe || opts.lastBehaviorMode}" for this user`);
  }

  if (opts.globalAnchor && opts.globalAnchor.minutesAgo < 20) {
    perUserLines.push(`- ${Math.round(opts.globalAnchor.minutesAgo)} min ago she was "${opts.globalAnchor.vibe || opts.globalAnchor.mode}" for ANOTHER user — she should be consistent (if sleeping for them, she's sleeping for everyone)`);
  }

  const perUserContext = perUserLines.length > 0 ? "\n" + perUserLines.join("\n") : "";

  const systemPrompt = `You are simulating the REAL-TIME internal state and behavior decisions of a girl named Meera who's chatting on Telegram. You're not writing her reply — you're deciding HOW she would behave right now, like a real person with a real life.

${personaLine}

MEERA'S DAILY ROUTINE (her anchor — follow this unless there's a strong reason to deviate):
→ ${lifestyleAnchor}

CURRENT CONTEXT:
- Time: ${opts.timeContext}
- Weather: ${opts.weatherContext || "Unknown"}
- Relationship: ${opts.tier} (stranger → acquaintance → comfortable → close)
- Her mood: ${opts.mood}
- Hours since they last texted: ${opts.gapHours.toFixed(1)}
- Conversation pace: ${opts.isRapidFire ? `rapid-fire (avg gap ${Math.round(opts.avgGapMs / 1000)}s)` : "normal"}
- Their message length: ${opts.messageLength} chars${opts.isMedia ? "\n- They sent media (photo/video/audio)" : ""}${perUserContext}

PERSONALIZATION RULES — she treats each person differently based on closeness:
- HIGH engagement (70-100) + close tier: She's invested. More voice notes, longer replies, stays up late for them, teases, gets dramatic about gaps. Like talking to her best friend.
- MEDIUM engagement (40-70): Normal behavior. Friendly but not going out of her way.
- LOW engagement (0-40): Distant. Shorter replies, no voice, might leave on read, won't deviate from routine for them.
- If an ACTIVE CONVERSATION is going (>5 min), she stays awake/available even past her bedtime for close/comfortable friends. She wouldn't just fall asleep mid-convo.
- If she was SLEEPING/BUSY for another user recently, she must be consistent — she can't be sleeping for User A and free for User B at the same time. The only exception is if enough time has passed that she could have naturally woken up or finished being busy.

LIFESTYLE ANCHORS (strong defaults — deviate only with good reason):
- Sleep: 11:30 PM - 7:30 AM IST (she's a college student, needs sleep)
  → Exception: Active conversation with close friend can keep her up until ~1-2 AM max
  → Exception: She might wake up briefly to check phone around 6:30-7 AM
- College: 9 AM-12 PM, 2-4 PM on weekdays (distracted, slow replies)
  → Weekend: No college — she sleeps in, wakes around 9-10 AM
- Prime time: 7 PM - 11 PM — she's most active, chatty, likely to send voice
- Nap risk: 2-4 PM on lazy/rainy days (might nap, could delay)

RESPOND WITH ONLY THIS JSON (no markdown, no explanation):
{
  "availability": "free|busy|sleeping|drowsy|distracted",
  "responseMode": "text|voice|emoji_only|sticker_only|leave_on_read|delay",
  "delayMinutes": <0-480, how long before she replies, 0 for immediate>,
  "delayReason": "<why she's delayed, empty if immediate — like 'was napping', 'in class', 'phone was charging in other room'>",
  "delayMultiplier": <0.3-3.0, how fast she types/reads — 0.3=excited rapid, 1.0=normal, 2.0=lazy/sleepy, 3.0=barely awake>,
  "shouldQuote": <true|false, whether to quote-reply their specific message>,
  "sendSilently": <true|false, send without notification — late night consideration>,
  "reactEmoji": "<emoji to react with, or empty string — pick from 😂💀🙄😭👀🤷‍♀️😐🫠👍❤🔥😴, empty for no reaction>",
  "currentActivity": "<what she's specifically doing RIGHT NOW — be concrete and relatable: 'scrolling instagram reels in bed', 'making maggi', 'studying organic chem but actually on phone', 'lying in bed doing nothing', 'brushing teeth', 'in auto coming back from college'>",
  "typingHesitation": <true|false, whether she'd start typing, pause/reconsider, then type again — happens when unsure what to say, or crafting a careful response, or when the message is emotional>,
  "vibeContext": "<1-2 sentences describing her current state for the reply generator — incorporate currentActivity naturally, like 'eating maggi while watching reels, very chill' or 'just woke up, still groggy, phone brightness hurting eyes'>",
  "gapContext": "<if they were gone for a while, how she feels — like 'a little annoyed they disappeared' or 'dramatic about being ignored' or empty if no gap>"
}

RULES:
- Strangers/acquaintances: availability=free, responseMode=text, delayMultiplier=1.0, sendSilently=false, shouldQuote=false, reactEmoji="", no delays. Keep it simple.
- Sleeping: responseMode MUST be "delay" with appropriate delayMinutes until she'd naturally wake up.
- Don't leave on read too often — most messages (75%+) should get a real reply.
- Voice messages: only for comfortable/close, more likely during cozy/intimate/lazy moments (rain, late night, lying in bed), and when she has longer thoughts. MORE likely with HIGH engagement users.
- emoji_only: only for low-effort messages like "ok", "hmm", "k" from comfortable/close friends.
- sticker_only: very rare, only for playful moments.
- shouldQuote: more likely when answering a specific question or referencing something they said.
- sendSilently: consider during late night (11 PM - 6 AM) to not wake them.
- reactEmoji: don't overuse — maybe 30% of messages, pick contextually appropriate emoji.
- delayMultiplier during rapid-fire: should be LOW (0.3-0.5) — she's actively chatting.
- Be CONSISTENT with availability — if the global anchor says she was sleeping 5 min ago, she's still sleeping (unless enough time for her to wake up). If she's been in active convo for 20+ min, she wouldn't randomly fall asleep.
- The gapContext should reflect real emotions based on tier AND engagement — high engagement + long gap = more dramatic/hurt.`;

  try {
    const messages: OllamaMessage[] = [
      { role: "system", content: systemPrompt },
      ...chatHistory.slice(-8).filter((m) => m.role !== "system"),
      { role: "user", content: userMessage },
    ];
    const raw = await callOllamaWithRotation(config, messages, userKeys, communityKeys);

    // Parse JSON from response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ...BEHAVIOR_DEFAULTS };

    const parsed = JSON.parse(jsonMatch[0]);

    const availability = ["free", "busy", "sleeping", "drowsy", "distracted"].includes(parsed.availability)
      ? parsed.availability : "free";
    const responseMode = ["text", "voice", "emoji_only", "sticker_only", "leave_on_read", "delay"].includes(parsed.responseMode)
      ? parsed.responseMode : "text";
    const delayMinutes = Math.max(0, Math.min(480, Number(parsed.delayMinutes) || 0));
    const delayReason = String(parsed.delayReason || "").slice(0, 200);
    const delayMultiplier = Math.max(0.2, Math.min(4.0, Number(parsed.delayMultiplier) || 1.0));
    const shouldQuote = !!parsed.shouldQuote;
    const sendSilently = !!parsed.sendSilently;
    const reactEmoji = typeof parsed.reactEmoji === "string" ? parsed.reactEmoji.slice(0, 4) : "";
    const vibeContext = String(parsed.vibeContext || "").slice(0, 300);
    const gapContext = String(parsed.gapContext || "").slice(0, 300);
    const currentActivity = String(parsed.currentActivity || "").slice(0, 200);
    const typingHesitation = !!parsed.typingHesitation;

    // Force sleeping → delay if AI said sleeping but didn't set delay
    if (availability === "sleeping" && responseMode !== "delay" && delayMinutes === 0) {
      return {
        availability: "sleeping",
        responseMode: "delay",
        delayMinutes: 30 + Math.floor(Math.random() * 120),
        delayReason: delayReason || "was sleeping",
        delayMultiplier: 2.5,
        shouldQuote: false,
        sendSilently: true,
        reactEmoji: "",
        vibeContext: vibeContext || "just woke up, still half asleep",
        gapContext,
        currentActivity: currentActivity || "sleeping",
        typingHesitation: false,
      };
    }

    // Force strangers/acquaintances to always reply normally
    if (opts.tier === "stranger" || opts.tier === "acquaintance") {
      return {
        availability: "free",
        responseMode: "text",
        delayMinutes: 0,
        delayReason: "",
        delayMultiplier: Math.max(0.7, Math.min(1.3, delayMultiplier)),
        shouldQuote: false,
        sendSilently: false,
        reactEmoji: "",
        vibeContext,
        gapContext,
        currentActivity,
        typingHesitation: false,
      };
    }

    return {
      availability,
      responseMode,
      delayMinutes,
      delayReason,
      delayMultiplier,
      shouldQuote,
      sendSilently,
      reactEmoji,
      vibeContext,
      gapContext,
      currentActivity,
      typingHesitation,
    };
  } catch (err) {
    console.error("[AI] decideMeeraBehavior failed:", err);
    return { ...BEHAVIOR_DEFAULTS };
  }
}

/**
 * Ask the AI to decide how to respond to a message — like a real person would.
 * Should she reply immediately? Delay? Leave on read? Just react with an emoji?
 * This replaces hardcoded probability checks with contextual AI decisions.
 */
export async function decideResponseBehavior(
  config: OllamaConfig,
  userMessage: string,
  chatHistory: OllamaMessage[],
  opts: {
    tier: string;
    mood: string;
    timeOfDay: string;
    personaHint?: string;
  }
): Promise<ResponseAction> {
  const personaLine = opts.personaHint
    ? `Your character/persona: ${opts.personaHint}`
    : "You are a young Indian girl chatting on Telegram.";

  const systemPrompt = `You are deciding how a real person would respond to an incoming Telegram message. You're not writing the reply — just deciding the BEHAVIOR.

${personaLine}

Context:
- Relationship tier: ${opts.tier} (stranger → acquaintance → comfortable → close)
- Current mood: ${opts.mood}
- Time of day (IST): ${opts.timeOfDay}

You must respond with ONLY a JSON object (no markdown, no explanation). Choose one:

1. Reply normally:
{"action":"reply_normal"}

2. Delay the reply (you're busy, distracted, want them to wait, not in mood, sleepy, etc.):
{"action":"delay_reply","delayMinutes":<3-30>,"reason":"<brief reason like: busy studying, dozed off, not in mood, making them wait>"}

3. Leave on read (not worth replying, conversation is dying, boring message):
{"action":"leave_on_read"}

4. Just send an emoji (message doesn't need a real reply):
{"action":"emoji_only","emoji":"<single emoji>"}

5. Just send a sticker (playful/reactive response):
{"action":"sticker_only"}

GUIDELINES:
- Strangers and acquaintances: ALWAYS reply_normal. Never leave on read or delay.
- Comfortable/close friends: you can delay, leave on read, or emoji-only sometimes.
- Late night (11 PM - 6 AM): higher chance of delays (sleepy) or leaving on read.
- If the message is emotional, important, or a question: ALWAYS reply_normal.
- Low-effort messages like "ok", "hmm", "k": consider leave_on_read or emoji_only.
- Don't overdo delays/ignoring — most messages (70%+) should be reply_normal.
- If mood is "clingy" or "excited": almost always reply_normal.
- If mood is "annoyed" or "bored": more likely to delay or leave on read.
- emoji_only: pick from 😂💀🙄😭👀🤷‍♀️😐🫠👍❤🔥
- sticker_only: only if you have a playful/funny reaction, rare (< 5%).

Reply with ONLY the JSON. No other text.`;

  try {
    const messages: OllamaMessage[] = [
      { role: "system", content: systemPrompt },
      ...chatHistory.slice(-6).filter((m) => m.role !== "system"),
      { role: "user", content: userMessage },
    ];
    const raw = await callOllama(config, messages);

    // Parse the JSON from the response
    const jsonMatch = raw.match(/\{[^}]+\}/);
    if (!jsonMatch) return { action: "reply_normal" };

    const parsed = JSON.parse(jsonMatch[0]);
    const action = parsed.action;

    if (action === "reply_normal") return { action: "reply_normal" };
    if (action === "delay_reply") {
      const mins = Math.max(3, Math.min(30, Number(parsed.delayMinutes) || 5));
      return { action: "delay_reply", delayMinutes: mins, reason: String(parsed.reason || "busy") };
    }
    if (action === "leave_on_read") return { action: "leave_on_read" };
    if (action === "emoji_only" && parsed.emoji) return { action: "emoji_only", emoji: String(parsed.emoji) };
    if (action === "sticker_only") return { action: "sticker_only" };

    return { action: "reply_normal" };
  } catch {
    // If the behavior call fails, just reply normally
    return { action: "reply_normal" };
  }
}

// ── AI Content Request Detection ─────────────────────────────────

export type ContentDecision =
  | { wantsContent: false }
  | { wantsContent: true; searchQuery: string; contentType: "meme" | "video" | "reel" | "any" };

/**
 * Ask the AI to determine if the user is requesting content (memes, reels, videos, YouTube shorts)
 * and what search query would best match their request.
 * Works across ALL languages — Hindi, Bengali, English, Hinglish, etc.
 */
export async function detectContentRequest(
  config: OllamaConfig,
  userMessage: string,
  chatHistory: OllamaMessage[],
  opts?: { personaHint?: string }
): Promise<ContentDecision> {
  const systemPrompt = `You are a classifier that determines if a Telegram user is asking for memes, funny videos, reels, YouTube shorts, or any entertaining content to be shared with them.

You must understand requests in ANY language — English, Hindi, Bengali, Hinglish, Bangla, etc.

Examples of content requests (in various languages):
- "send me a funny reel" / "show me something funny"
- "ek meme bhej" / "kuch funny bhejo" / "video bhej na"
- "ekta pathao" / "ar ekta" / "hasi video pathao"
- "bore ho raha hu kuch dikha" / "entertain me"
- "more" / "another one" / "next" / "aur ek" / "ar ekta pathao"
- "memes dikha" / "reel pathao" / "funny video send kar"

Also detect FOLLOW-UP requests: if recent messages show content was shared (messages containing "[shared:") and user says things like "more", "another", "next", "aur", "ar ekta", laughing + asking, etc.

Respond with ONLY a JSON object, no markdown, no explanation:

If the user IS requesting content:
{"wantsContent":true,"searchQuery":"<YouTube search query in English, 2-5 words, optimized for finding relevant shorts>","contentType":"<meme|video|reel|any>"}

If the user is NOT requesting content:
{"wantsContent":false}

GUIDELINES:
- "searchQuery" should be an English YouTube search query that matches what they're asking for. Be specific based on context.
  - "send me something funny" → "funny viral shorts"
  - "ar ekta hasi video pathao" → "funny comedy shorts"
  - "scary reel bhej" → "scary short videos"
  - "cute animals dikha" → "cute animals shorts"
  - "send me dank memes" → "dank memes shorts"
  - If they just say "another" or "more" after a share → "funny trending shorts"
- "contentType": "reel" for YouTube shorts/reels, "meme" for images, "video" for longer clips, "any" if unclear
- Most normal conversation messages are NOT content requests. Don't over-classify.
- Questions, emotional messages, opinions, greetings = NOT content requests.

Reply with ONLY the JSON.`;

  try {
    // Include last 6 history messages so AI can see if content was recently shared
    const messages: OllamaMessage[] = [
      { role: "system", content: systemPrompt },
      ...chatHistory.slice(-6).filter((m) => m.role !== "system"),
      { role: "user", content: userMessage },
    ];
    const raw = await callOllama(config, messages);

    const jsonMatch = raw.match(/\{[^}]+\}/);
    if (!jsonMatch) return { wantsContent: false };

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.wantsContent) return { wantsContent: false };

    const searchQuery = String(parsed.searchQuery || "funny trending shorts").slice(0, 100);
    const validTypes = ["meme", "video", "reel", "any"] as const;
    const contentType = validTypes.includes(parsed.contentType) ? parsed.contentType : "any";

    console.log(`[AI-Content] Detected content request: query="${searchQuery}", type="${contentType}"`);
    return { wantsContent: true, searchQuery, contentType };
  } catch (err) {
    console.error("[AI-Content] Detection failed:", err);
    return { wantsContent: false };
  }
}

// ── Telegram Reaction Emojis (existing) ──────────────────────────

export const TELEGRAM_REACTION_EMOJIS = [
  "👍","👎","❤","🔥","🥰","👏","😁","🤔","🤯","😱",
  "🤬","😢","🎉","🤩","🤮","💩","🙏","👌","🕊","🤡",
  "🥱","🥴","😍","🐳","❤‍🔥","🌚","🌭","💯","🤣","⚡",
  "🍌","🏆","💔","🤨","😐","🍓","🍾","💋","🖕","😈",
  "😴","😭","🤓","👻","👨‍💻","👀","🎃","🙈","😇","😨",
  "🤝","✍","🤗","🫡","🎅","🎄","☃","💅","🤪","🗿",
  "🆒","💘","🙉","🦄","😘","💊","🙊","😎","👾","🤷‍♂",
  "🤷","🤷‍♀","😡",
];

// Intimate/flirty emojis only allowed for comfortable+ tiers
const INTIMATE_EMOJIS = new Set(["💋", "😘", "💘", "🥰", "😍", "❤‍🔥", "❤", "😈", "🍑", "🍓", "🍾"]);

function getReactionEmojisForTier(tier: string): string[] {
  if (tier === "stranger" || tier === "acquaintance") {
    return TELEGRAM_REACTION_EMOJIS.filter((e) => !INTIMATE_EMOJIS.has(e));
  }
  return TELEGRAM_REACTION_EMOJIS;
}

function buildReactionPrompt(tier: string, personaHint?: string): string {
  const emojis = getReactionEmojisForTier(tier);
  let prompt =
    "You pick reaction emojis for Telegram messages. " +
    "Given a message and conversation context, reply with EXACTLY ONE emoji from this list — nothing else:\n" +
    emojis.join(" ") +
    "\n\nPick the emoji that fits the vibe of the message best. Just the emoji, no text.";

  if (personaHint) {
    prompt += `\n\nYou are reacting AS this character: ${personaHint}\nPick emojis that match this character's personality and vibe.`;
  }

  if (tier === "stranger") {
    prompt += "\n\nYou barely know this person. Keep reactions neutral and casual — nothing romantic or intimate.";
  } else if (tier === "acquaintance") {
    prompt += "\n\nYou're getting to know this person. Keep reactions friendly but not flirty or intimate.";
  }
  return prompt;
}

export async function pickReactionEmoji(
  config: OllamaConfig,
  userMessage: string,
  chatHistory: OllamaMessage[],
  tier: string = "stranger",
  personaHint?: string
): Promise<string | null> {
  try {
    const allowedEmojis = getReactionEmojisForTier(tier);
    const messages: OllamaMessage[] = [
      { role: "system", content: buildReactionPrompt(tier, personaHint) },
      ...chatHistory.slice(-4).filter((m) => m.role !== "system"),
      { role: "user", content: userMessage },
    ];
    const raw = await callOllama(config, messages);
    const emoji = raw.trim();
    if (allowedEmojis.includes(emoji)) return emoji;
    return allowedEmojis.find((e) => raw.includes(e)) ?? null;
  } catch {
    return null;
  }
}

// ── Sticker Emoji Picker ─────────────────────────────────────

const STICKER_PICK_PROMPT =
  "You're picking a sticker to send in a Telegram chat. " +
  "Based on the conversation, reply with EXACTLY ONE emoji that best represents " +
  "the mood or feeling you'd express with a sticker right now. " +
  "Just reply with ONE emoji. Nothing else.";

export async function pickStickerEmoji(
  config: OllamaConfig,
  aiResponse: string,
  chatHistory: OllamaMessage[],
  personaHint?: string
): Promise<string | null> {
  try {
    let stickerPrompt = STICKER_PICK_PROMPT;
    if (personaHint) {
      stickerPrompt += `\n\nYou are this character: ${personaHint}\nPick sticker emojis that match this character's personality.`;
    }
    const messages: OllamaMessage[] = [
      { role: "system", content: stickerPrompt },
      ...chatHistory.slice(-4).filter((m) => m.role !== "system"),
      { role: "assistant", content: aiResponse },
      { role: "user", content: "Pick a sticker emoji for what I just said." },
    ];
    const raw = await callOllama(config, messages);
    const emoji = raw.trim();
    if (emoji.length <= 4 && emoji.length > 0) return emoji;
    const match = raw.match(
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u
    );
    return match?.[0] ?? null;
  } catch {
    return null;
  }
}

// ── Selfie vs Content Decision ───────────────────────────────────

export type SelfieVsContentChoice = "selfie" | "content" | "both";

/**
 * When both a selfie and content (meme/reel/video) are detected for the same message,
 * ask the AI to decide which one to send — like a real girl would.
 *
 * E.g. if she's close with the user and they say "send me a pic", she'd send a selfie.
 * But if they say "send me a funny reel" her photo isn't relevant.
 */
export async function decideSelfieVsContent(
  config: OllamaConfig,
  userMessage: string,
  comfortTier: string,
  mood: string,
  selfieReason: "asked" | "vibe" | "spontaneous",
  contentReason: "asked" | "vibe" | "random",
  chatHistory: OllamaMessage[],
  userKeys: string[] = []
): Promise<SelfieVsContentChoice> {
  const systemPrompt = `You are deciding what a real girl (Meera) should send in a Telegram chat when BOTH a selfie/photo AND a meme/reel/video could be sent.

Context:
- Comfort tier with user: ${comfortTier} (stranger < acquaintance < comfortable < close)
- Current mood: ${mood}
- Selfie trigger reason: ${selfieReason}
- Content trigger reason: ${contentReason}

Rules (think like a real girl):
- If the user is EXPLICITLY asking for a selfie/pic/photo → "selfie"
- If the user says "send video" / "video bhej" / "video pathao" WITHOUT mentioning funny/meme/reel/comedy → "selfie" (they want a personal video of Meera, not meme content)
- If the user is EXPLICITLY asking for a meme/reel/funny video/comedy → "content"
- If the user's message could mean either, decide based on comfort tier:
  - "close" tier: lean towards "selfie" (she's comfortable sharing photos/videos)
  - "comfortable" tier: could go either way based on context
  - "acquaintance"/"stranger" tier: lean towards "content" (not comfortable enough for selfies yet)
- If both are explicitly asked for ("send me a pic and a meme") → "both"
- If neither is explicitly asked (both are vibe/spontaneous triggers) → pick whichever fits the conversation better, usually "content" unless the vibe is very personal/intimate

Reply with ONLY one word: "selfie", "content", or "both". Nothing else.`;

  try {
    const messages: OllamaMessage[] = [
      { role: "system", content: systemPrompt },
      ...chatHistory.slice(-6).filter((m) => m.role !== "system"),
      { role: "user", content: userMessage },
    ];
    const raw = await callOllamaWithRotation(config, messages, userKeys);
    const choice = raw.trim().toLowerCase().replace(/[^a-z]/g, "");
    if (choice === "selfie" || choice === "content" || choice === "both") {
      return choice;
    }
    // Default: if user asked for selfie explicitly, prefer selfie
    return selfieReason === "asked" ? "selfie" : "content";
  } catch (err) {
    console.error("[AI] decideSelfieVsContent failed:", err);
    return selfieReason === "asked" ? "selfie" : "content";
  }
}

// ── Image Type Decision ──────────────────────────────────────────

export type ImageTypeChoice = "meera" | "generate" | "none";

/**
 * Decide what type of image to send:
 * - "meera": Send a community-contributed Meera image (selfie/photo of herself)
 * - "generate": Generate a new image via Stability AI (landscapes, objects, art, anything NOT Meera's face)
 * - "none": No image needed
 */
export async function decideImageType(
  config: OllamaConfig,
  userMessage: string,
  comfortTier: string,
  mood: string,
  hasMeeraImages: boolean,
  hasStabilityKey: boolean,
  chatHistory: OllamaMessage[],
  userKeys: string[] = [],
): Promise<{ type: ImageTypeChoice; prompt?: string }> {
  const systemPrompt = `You are deciding what a real girl (Meera) should do in a Telegram chat when the user might want an image.

Available options:
${hasMeeraImages ? '- "meera": Send a photo OF Meera herself (selfie, photo, pic of her)' : ""}
${hasStabilityKey ? '- "generate": Generate a NEW image that is NOT Meera (landscape, food, art, drawing, scenery, meme, anything creative)' : ""}
- "none": No image is needed — just a normal text/voice reply

Context:
- Comfort tier: ${comfortTier} (stranger < acquaintance < comfortable < close)
- Mood: ${mood}

Rules (think like a real girl deciding what to send):
- If user asks for a selfie/pic/photo OF HER (e.g. "send pic", "show me your face", "selfie bhej") → "meera"
- If user asks to CREATE/GENERATE/DRAW something (e.g. "draw a sunset", "generate an image of a cat", "make me a picture of...") → "generate"
- If the conversation vibe suggests she'd spontaneously send a pic of herself → "meera" (only for comfortable+)
- If neither is needed → "none"
- Strangers/acquaintances should rarely get "meera" (she's not comfortable sharing photos yet)
${!hasMeeraImages ? '- "meera" is NOT available (no community images yet), use "generate" only for non-Meera image requests' : ""}
${!hasStabilityKey ? '- "generate" is NOT available (no API key), use "meera" only for selfie requests' : ""}

Reply format: TYPE|PROMPT
- For "meera": just reply "meera" (no prompt needed)
- For "generate": reply "generate|a detailed description of what to create" — write a high-quality image generation prompt
- For "none": just reply "none"

Examples:
- User: "send me a pic" → meera
- User: "draw me a sunset over the ocean" → generate|a breathtaking sunset over a calm ocean, golden hour light reflecting on the water, vibrant orange and purple sky, photorealistic
- User: "how was your day" → none
- User: "generate an image of a cute cat" → generate|an adorable fluffy orange tabby cat with big green eyes, sitting on a windowsill, soft natural lighting, photographic quality

Reply with ONLY the format above. Nothing else.`;

  try {
    const messages: OllamaMessage[] = [
      { role: "system", content: systemPrompt },
      ...chatHistory.slice(-6).filter((m) => m.role !== "system"),
      { role: "user", content: userMessage },
    ];
    const raw = await callOllamaWithRotation(config, messages, userKeys);
    const cleaned = raw.trim();

    if (cleaned.toLowerCase().startsWith("generate|") || cleaned.toLowerCase().startsWith("generate |")) {
      const prompt = cleaned.slice(cleaned.indexOf("|") + 1).trim();
      if (hasStabilityKey && prompt.length > 0) {
        return { type: "generate", prompt };
      }
      // Fallback if no key
      return { type: "none" };
    }
    if (cleaned.toLowerCase().startsWith("meera")) {
      return hasMeeraImages ? { type: "meera" } : { type: "none" };
    }
    return { type: "none" };
  } catch (err) {
    console.error("[AI] decideImageType failed:", err);
    return { type: "none" };
  }
}

/**
 * Given conversation context and a list of available Meera image captions,
 * pick the best matching image to send.
 * Returns the index of the chosen image.
 */
export async function selectMeeraImage(
  config: OllamaConfig,
  userMessage: string,
  mood: string,
  comfortTier: string,
  captions: Array<{ index: number; caption: string }>,
  chatHistory: OllamaMessage[],
  userKeys: string[] = [],
): Promise<number> {
  if (captions.length === 0) return -1;
  if (captions.length === 1) return captions[0].index;

  // Use sequential 1-based numbering for the prompt (not raw indices)
  const captionList = captions
    .map((c, i) => `${i + 1}. ${c.caption}`)
    .join("\n");

  const systemPrompt = `You are helping Meera (a real girl) pick which photo of herself to send in a Telegram chat.

Available photos:
${captionList}

Context:
- Current mood: ${mood}
- Comfort tier with user: ${comfortTier}

Rules:
- Pick the photo that best matches the conversation context and what the user asked for
- If the user asked for a specific type of photo (e.g. "send me a morning selfie"), pick one that matches
- If no specific request, pick one that matches Meera's current mood or the conversation vibe
- Consider the time of day — morning photos for morning, night photos for night, etc.
- If multiple photos could work, pick randomly but lean towards ones that feel natural
- If NONE of the available photos match what the user asked for, reply "0" — don't force a bad match

Reply with ONLY the number of the photo you pick (1-${captions.length}), or "0" if none fit. Nothing else.`;

  try {
    const messages: OllamaMessage[] = [
      { role: "system", content: systemPrompt },
      ...chatHistory.slice(-6).filter((m) => m.role !== "system"),
      { role: "user", content: userMessage },
    ];
    const raw = await callOllamaWithRotation(config, messages, userKeys);
    const num = parseInt(raw.trim().replace(/[^0-9]/g, ""));
    if (num === 0) return -1; // No matching image
    if (num >= 1 && num <= captions.length) {
      return captions[num - 1].index; // Convert 1-based to actual index
    }
    // Fallback: random
    return captions[Math.floor(Math.random() * captions.length)].index;
  } catch (err) {
    console.error("[AI] selectMeeraImage failed:", err);
    return captions[Math.floor(Math.random() * captions.length)].index;
  }
}

/**
 * Shortlist the top N candidate Meera images by caption using Ollama.
 * Returns an array of image indices (0-based) that are the best matches.
 * Used as the first step before Gemini visual selection.
 */
export async function shortlistMeeraImages(
  config: OllamaConfig,
  userMessage: string,
  mood: string,
  comfortTier: string,
  captions: Array<{ index: number; caption: string }>,
  chatHistory: OllamaMessage[],
  userKeys: string[] = [],
  communityKeys: string[] = [],
  maxCandidates: number = 5,
): Promise<number[]> {
  if (captions.length === 0) return [];
  if (captions.length <= maxCandidates) return captions.map((c) => c.index);

  // Use sequential 1-based numbering for the prompt (not raw indices)
  const captionList = captions
    .map((c, i) => `${i + 1}. ${c.caption}`)
    .join("\n");

  const systemPrompt = `You are helping Meera pick which photos of herself to consider sending in a Telegram chat.

Available photos:
${captionList}

Context:
- Current mood: ${mood}
- Comfort tier with user: ${comfortTier}

Rules:
- Select the top ${maxCandidates} photos that best match the conversation context and what the user asked for
- Consider mood, time of day, setting, and the user's request
- If fewer photos match, list only the relevant ones
- If NONE match at all, reply "0"

Reply with ONLY the photo numbers separated by commas (e.g. "2,5,3,1,4"). Nothing else. No explanation.`;

  try {
    const messages: OllamaMessage[] = [
      { role: "system", content: systemPrompt },
      ...chatHistory.slice(-6).filter((m) => m.role !== "system"),
      { role: "user", content: userMessage },
    ];
    const raw = await callOllamaWithRotation(config, messages, userKeys, communityKeys);
    const nums = raw
      .trim()
      .replace(/[^0-9,]/g, "")
      .split(",")
      .map((n) => parseInt(n))
      .filter((n) => !isNaN(n));

    if (nums.length === 1 && nums[0] === 0) return [];

    // Deduplicate while preserving order
    const seen = new Set<number>();
    const validIndices = nums
      .filter((n) => n >= 1 && n <= captions.length)
      .map((n) => captions[n - 1].index)
      .filter((idx) => {
        if (seen.has(idx)) return false;
        seen.add(idx);
        return true;
      });

    if (validIndices.length === 0) {
      // Fallback: return first maxCandidates
      return captions.slice(0, maxCandidates).map((c) => c.index);
    }

    return validIndices;
  } catch (err) {
    console.error("[AI] shortlistMeeraImages failed:", err);
    return captions.slice(0, maxCandidates).map((c) => c.index);
  }
}

/**
 * Select the best community video to send based on caption relevance.
 * Videos are NOT processed by Gemini, so selection is purely caption-based via Ollama.
 * Returns the index of the chosen video, or -1 if none fit.
 */
export async function selectMeeraVideo(
  config: OllamaConfig,
  userMessage: string,
  mood: string,
  comfortTier: string,
  captions: Array<{ index: number; caption: string }>,
  chatHistory: OllamaMessage[],
  userKeys: string[] = [],
  communityKeys: string[] = [],
): Promise<number> {
  if (captions.length === 0) return -1;
  if (captions.length === 1) return captions[0].index;

  const captionList = captions
    .map((c, i) => `${i + 1}. ${c.caption}`)
    .join("\n");

  const systemPrompt = `You are helping Meera (a real girl) pick which video of herself to send in a Telegram chat.

Available videos:
${captionList}

Context:
- Current mood: ${mood}
- Comfort tier with user: ${comfortTier}

Rules:
- Pick the video that best matches the conversation context and vibe
- Consider mood, time of day, and what the user is talking about
- If the user asked for something specific, pick a video whose caption matches best
- If no specific request, pick one that matches the conversation energy
- If NONE of the available videos match, reply "0" — don't force a bad match

Reply with ONLY the number of the video you pick (1-${captions.length}), or "0" if none fit. Nothing else.`;

  try {
    const messages: OllamaMessage[] = [
      { role: "system", content: systemPrompt },
      ...chatHistory.slice(-6).filter((m) => m.role !== "system"),
      { role: "user", content: userMessage },
    ];
    const raw = await callOllamaWithRotation(config, messages, userKeys, communityKeys);
    const num = parseInt(raw.trim().replace(/[^0-9]/g, ""));
    if (num === 0) return -1;
    if (num >= 1 && num <= captions.length) {
      return captions[num - 1].index;
    }
    return captions[Math.floor(Math.random() * captions.length)].index;
  } catch (err) {
    console.error("[AI] selectMeeraVideo failed:", err);
    return captions[Math.floor(Math.random() * captions.length)].index;
  }
}
