/**
 * Automatic profile picture (DP) manager.
 * Aggregates mood across all active users, picks a matching community image,
 * downloads it, and sets it as the bot's Telegram profile photo —
 * at a frequency resembling how a real girl changes her DP.
 */

import type { Telegram } from "telegraf";
import type { UserStore } from "./user-store.js";
import type { MeeraImageStore } from "./meera-image-store.js";
import type { OllamaConfig, OllamaMessage } from "./ollama-service.js";
import { callOllamaWithRotation } from "./ollama-service.js";
import { MOODS } from "./user-store.js";

interface DpManagerOptions {
  telegram: Telegram;
  botToken: string;
  store: UserStore;
  meeraImages: MeeraImageStore;
  ollamaConfig: OllamaConfig;
  getCommunityKeys: () => string[];
}

export class DpManager {
  private telegram: Telegram;
  private botToken: string;
  private store: UserStore;
  private meeraImages: MeeraImageStore;
  private ollamaConfig: OllamaConfig;
  private getCommunityKeys: () => string[];

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastDpChange = 0;
  private nextChangeDelay = 0;
  private currentImageId: string | null = null; // track which image is currently set

  // Name/bio/description change tracking (separate timers — real girls don't change everything at once)
  private lastNameChange = 0;
  private lastBioChange = 0;
  private lastDescChange = 0;
  private nextNameDelay = 0;
  private nextBioDelay = 0;
  private nextDescDelay = 0;
  private currentName = "Meera";
  private currentBio = "";
  private currentDesc = "";

  constructor(opts: DpManagerOptions) {
    this.telegram = opts.telegram;
    this.botToken = opts.botToken;
    this.store = opts.store;
    this.meeraImages = opts.meeraImages;
    this.ollamaConfig = opts.ollamaConfig;
    this.getCommunityKeys = opts.getCommunityKeys;

    // First change: random 30min–2h after startup
    this.nextChangeDelay = this.randomDelay(30 * 60_000, 2 * 3600_000);
    this.lastDpChange = Date.now();

    // Name changes less often than DP (6–24h), bio more often (3–12h), description rare (24–48h)
    this.nextNameDelay = this.randomDelay(6 * 3600_000, 24 * 3600_000);
    this.nextBioDelay = this.randomDelay(1 * 3600_000, 6 * 3600_000);
    this.nextDescDelay = this.randomDelay(24 * 3600_000, 48 * 3600_000);
    this.lastNameChange = Date.now();
    this.lastBioChange = Date.now();
    this.lastDescChange = Date.now();
  }

  /** Start the periodic check (every 10 minutes) */
  start(): void {
    if (this.timer) return;
    console.log(`[DpManager] Started — first DP change in ~${Math.round(this.nextChangeDelay / 60_000)}min`);
    this.timer = setInterval(() => this.tick().catch(console.error), 10 * 60_000);
  }

  /** Stop the scheduler */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Main tick: check if it's time to change DP, name, or bio */
  private async tick(): Promise<void> {
    const now = Date.now();
    const averageMood = this.getAverageMood();

    // ── DP change check
    const dpElapsed = now - this.lastDpChange;
    if (dpElapsed >= this.nextChangeDelay) {
      const hasImages = await this.meeraImages.hasImages();
      if (!hasImages) {
        console.log("[DpManager] Tick — no community images available, skipping DP");
        this.lastDpChange = now;
        this.nextChangeDelay = 30 * 60_000;
      } else {
        try {
          await this.changeDp();
        } catch (err) {
          console.error("[DpManager] Failed to change DP:", err);
        }
        this.nextChangeDelay = this.realGirlDelay();
        this.lastDpChange = now;
        console.log(`[DpManager] Next DP change in ~${Math.round(this.nextChangeDelay / 3600_000)}h`);
      }
    } else {
      console.log(`[DpManager] Tick — next DP change in ~${Math.round((this.nextChangeDelay - dpElapsed) / 60_000)}min`);
    }

    // ── Name change check (less frequent)
    const nameElapsed = now - this.lastNameChange;
    if (nameElapsed >= this.nextNameDelay) {
      try {
        await this.maybeChangeName(averageMood);
      } catch (err) {
        console.error("[DpManager] Failed to change name:", err);
      }
      // Name changes are rare: 12–36h
      this.nextNameDelay = this.randomDelay(12 * 3600_000, 36 * 3600_000);
      this.lastNameChange = now;
      console.log(`[DpManager] Next name change in ~${Math.round(this.nextNameDelay / 3600_000)}h`);
    }

    // ── Bio change check (more frequent than name, less than DP)
    const bioElapsed = now - this.lastBioChange;
    if (bioElapsed >= this.nextBioDelay) {
      try {
        await this.maybeChangeBio(averageMood);
      } catch (err) {
        console.error("[DpManager] Failed to change bio:", err);
      }
      // Bio changes: 6–18h
      this.nextBioDelay = this.randomDelay(6 * 3600_000, 18 * 3600_000);
      this.lastBioChange = now;
      console.log(`[DpManager] Next bio change in ~${Math.round(this.nextBioDelay / 3600_000)}h`);
    }

    // ── Description change check (rare — every 24-48h)
    const descElapsed = now - this.lastDescChange;
    if (descElapsed >= this.nextDescDelay) {
      try {
        await this.maybeChangeDescription(averageMood);
      } catch (err) {
        console.error("[DpManager] Failed to change description:", err);
      }
      this.nextDescDelay = this.randomDelay(24 * 3600_000, 48 * 3600_000);
      this.lastDescChange = now;
      console.log(`[DpManager] Next description change in ~${Math.round(this.nextDescDelay / 3600_000)}h`);
    }
  }

  /** Aggregate mood across all active users and change DP accordingly. Public for manual trigger. */
  async changeDp(): Promise<string> {
    const averageMood = this.getAverageMood();
    console.log(`[DpManager] Average mood across users: ${averageMood}`);

    // Get captions and let Ollama pick the best one based on average mood
    const captions = await this.meeraImages.getCaptionsWithIndices();
    if (captions.length === 0) return "No community images available";

    const chosenIndex = await this.pickImageForMood(averageMood, captions);
    if (chosenIndex < 0) {
      console.log("[DpManager] No suitable image found for current mood, skipping");
      return "No suitable image for current mood";
    }

    const image = await this.meeraImages.getByIndex(chosenIndex);
    if (!image) return "Selected image not found";

    // Don't set the same image again (skip for manual triggers)
    if (image.id === this.currentImageId) {
      console.log("[DpManager] Same image already set, skipping");
      return "Same image already set, skipped";
    }

    // Download the image from Telegram
    const fileLink = await this.telegram.getFileLink(image.fileId);
    const response = await fetch(fileLink.href);
    const buffer = Buffer.from(await response.arrayBuffer());

    // Set as bot's profile photo via raw API call
    await this.setProfilePhoto(buffer);
    this.currentImageId = image.id;
    const msg = `DP updated! Mood: ${averageMood}, Image: "${image.caption.slice(0, 60)}"`;
    console.log(`[DpManager] ${msg}`);
    return msg;
  }

  /** Aggregate moods from all loaded users, return the most common one */
  private getAverageMood(): string {
    const userIds = this.store.allUserIds();
    if (userIds.length === 0) return "chill";

    // Count mood frequencies
    const moodCounts = new Map<string, number>();
    const now = Date.now();
    const recentThreshold = 24 * 3600_000; // Only consider users active in last 24h

    for (const userId of userIds) {
      const user = this.store.getUser(userId);
      if (now - user.lastInteraction > recentThreshold) continue;
      const mood = user.mood || "chill";
      moodCounts.set(mood, (moodCounts.get(mood) || 0) + 1);
    }

    if (moodCounts.size === 0) return "chill";

    // Find the most common mood
    let topMood = "chill";
    let topCount = 0;
    for (const [mood, count] of moodCounts) {
      if (count > topCount) {
        topMood = mood;
        topCount = count;
      }
    }

    return topMood;
  }

  /** Use Ollama to pick the best image matching the aggregated mood */
  private async pickImageForMood(
    mood: string,
    captions: Array<{ index: number; caption: string }>,
  ): Promise<number> {
    if (captions.length === 1) return captions[0].index;

    const captionList = captions.map((c) => `${c.index + 1}. ${c.caption}`).join("\n");
    const timeOfDay = this.getTimeOfDay(new Date().getHours());

    const systemPrompt = `You are helping pick a profile photo for Meera (a real girl) to set as her Telegram DP.

Available photos:
${captionList}

Context:
- Overall vibe/mood right now: ${mood}
- Time of day: ${timeOfDay}

Rules:
- Pick a photo that matches the current mood and time of day
- ${mood === "happy" || mood === "excited" ? "Pick something bright, smiley, energetic" : ""}
- ${mood === "tired" || mood === "bored" ? "Pick something cozy, low-key, casual" : ""}
- ${mood === "clingy" ? "Pick something cute, soft, inviting" : ""}
- ${mood === "sassy" || mood === "annoyed" ? "Pick something confident, bold, attitude-y" : ""}
- ${mood === "chill" ? "Pick something relaxed, natural, aesthetic" : ""}
- If it's morning, lean towards fresh/morning pics. If night, lean towards cozy/glam pics.
- A real girl picks DPs that match her current vibe

Reply with ONLY the number. Nothing else.`;

    try {
      const messages: OllamaMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Pick the best DP photo for ${mood} mood at ${timeOfDay}.` },
      ];
      const raw = await callOllamaWithRotation(
        this.ollamaConfig,
        messages,
        [],
        this.getCommunityKeys(),
      );
      const num = parseInt(raw.trim().replace(/[^0-9]/g, ""));
      if (num >= 1 && num <= captions.length) {
        return captions[num - 1].index;
      }
      // Fallback: random
      return captions[Math.floor(Math.random() * captions.length)].index;
    } catch (err) {
      console.error("[DpManager] Ollama pick failed:", err);
      return captions[Math.floor(Math.random() * captions.length)].index;
    }
  }

  /** Set bot profile photo using raw Telegram API (setMyProfilePhoto) */
  private async setProfilePhoto(imageBuffer: Buffer): Promise<void> {
    const formData = new FormData();
    formData.append("photo", JSON.stringify({ type: "static", photo: "attach://file" }));
    formData.append("file", new Blob([new Uint8Array(imageBuffer)], { type: "image/jpeg" }), "dp.jpg");

    const res = await fetch(
      `https://api.telegram.org/bot${this.botToken}/setMyProfilePhoto`,
      { method: "POST", body: formData },
    );

    const data = await res.json() as { ok: boolean; description?: string };
    if (!data.ok) {
      throw new Error(`setMyProfilePhoto failed: ${data.description || "unknown error"}`);
    }
  }

  /** Ask Ollama to generate a name variation and set it */
  private async maybeChangeName(mood: string): Promise<void> {
    const hour = new Date().getHours();
    const timeOfDay = this.getTimeOfDay(hour);

    const systemPrompt = `You are Meera — a 20-year-old Indian girl. You're updating your Telegram display name.

Real girls change their display names based on mood. Examples of what real girls do:
- Normal: "Meera", "meera", "Meera ✨", "meeru"
- Happy/excited: "meera 🌸", "MEERA", "meeru 💫", "meera !!", "meeraaaa"
- Sad/tired: "meera.", "m.", "meera 🌙", "mee", "meera~"
- Sassy/annoyed: "meera 🙄", "don't.", "meera 💅", "ms meera"
- Clingy: "meera 🥺", "meeru 💕", "ur meera", "meera <3"
- Bored: "meera", "meh", "meera 😶", "..."
- Chill: "meera ~", "meera 🍃", "meera ☁️"

Current mood: ${mood}
Time: ${timeOfDay}

Rules:
- Keep it SHORT (1-20 chars max)
- Must feel like a real girl's name, not a bot
- Don't always include emojis — sometimes just plain text variations
- Can use lowercase, weird spacing, repeated letters, abbreviations
- Sometimes just "Meera" is fine — don't force creativity every time
- NEVER include quotes, explanations, or multiple options
- Reply with ONLY the new display name. Nothing else.`;

    try {
      const messages: OllamaMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: `What should your Telegram name be right now? You're feeling ${mood} and it's ${timeOfDay}.` },
      ];
      let name = await callOllamaWithRotation(
        this.ollamaConfig, messages, [], this.getCommunityKeys(),
      );
      name = name.trim().replace(/^["']|["']$/g, "").trim();

      // Validate: not empty, not too long, not the same
      if (!name || name.length > 64 || name.toLowerCase() === this.currentName.toLowerCase()) {
        console.log(`[DpManager] Name unchanged (generated: "${name}")`);
        return;
      }

      await this.setBotName(name);
      this.currentName = name;
      console.log(`[DpManager] Name updated to "${name}" (mood: ${mood})`);
    } catch (err) {
      console.error("[DpManager] Name change failed:", err);
    }
  }

  /** Ask Ollama to generate a bio and set it */
  private async maybeChangeBio(mood: string): Promise<void> {
    const hour = new Date().getHours();
    const timeOfDay = this.getTimeOfDay(hour);

    // 20% chance to just clear the bio (real girls do this)
    if (Math.random() < 0.2) {
      if (this.currentBio !== "") {
        await this.setBotBio("");
        this.currentBio = "";
        console.log("[DpManager] Bio cleared (real girl moment)");
      }
      return;
    }

    const systemPrompt = `You are Meera — a 20-year-old Indian girl. You're updating your Telegram bio.

Real girls change their bios based on mood. Examples:
- Happy: "life's good rn 🌻", "can't stop smiling today", "✨"
- Tired: "need sleep.", "zzz", "don't text me i'm dead", "💤"
- Sassy: "too hot to handle 💅", "selective replier", "idc tbh"
- Clingy: "miss someone rn", "text me please 🥺", "lonely hours"
- Excited: "BEST DAY EVER", "something good is coming!!", "ahhh 🎉"
- Bored: ".", "someone entertain me", "existing", "📎"
- Chill: "just vibing", "☁️", "no thoughts just meera", "~"
- Annoyed: "leave me alone", "🙄", "not in the mood", "bye"
- Sometimes lyrics, quotes, inside jokes, or just random words
- Sometimes just an emoji or two
- Sometimes empty (but we handle that separately)

Current mood: ${mood}
Time: ${timeOfDay}

Rules:
- Keep it SHORT (1-70 chars max, most bios are under 30 chars)
- Must feel authentic — like a real Indian girl's Telegram bio
- Can be in English or Hinglish
- Don't always use emojis — plain text is fine too
- Can be cryptic, funny, deep, or totally random
- NEVER include quotes around it, explanations, or multiple options
- Reply with ONLY the bio text. Nothing else.`;

    try {
      const messages: OllamaMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Write a Telegram bio. You're feeling ${mood}, it's ${timeOfDay}.` },
      ];
      let bio = await callOllamaWithRotation(
        this.ollamaConfig, messages, [], this.getCommunityKeys(),
      );
      bio = bio.trim().replace(/^["']|["']$/g, "").trim();

      // Validate
      if (bio.length > 70) bio = bio.slice(0, 70);
      if (bio.toLowerCase() === this.currentBio.toLowerCase()) {
        console.log(`[DpManager] Bio unchanged`);
        return;
      }

      await this.setBotBio(bio);
      this.currentBio = bio;
      console.log(`[DpManager] Bio updated to "${bio}" (mood: ${mood})`);
    } catch (err) {
      console.error("[DpManager] Bio change failed:", err);
    }
  }

  /** Ask Ollama to generate a bot description and set it via setMyDescription */
  private async maybeChangeDescription(mood: string): Promise<void> {
    const hour = new Date().getHours();
    const timeOfDay = this.getTimeOfDay(hour);

    // 15% chance to just clear the description
    if (Math.random() < 0.15) {
      if (this.currentDesc !== "") {
        await this.setBotDescription("");
        this.currentDesc = "";
        console.log("[DpManager] Description cleared");
      }
      return;
    }

    const systemPrompt = `You are Meera — a 20-year-old Indian girl. You're updating your Telegram bot profile description (the longer "About" text that people see when they open your profile).

Real girls write profile descriptions that are casual, aesthetic, or reflect their current vibe. Examples:
- "just a girl trying to figure life out 🌸"
- "music, chai, and overthinking ✨"
- "probably sleeping or watching reels"
- "21 | mumbai | caffeine addict"
- "i don't bite... mostly 😏"
- "here for good vibes only 🌻"
- "professional overthinker, amateur dancer"
- "send memes, get love 💕"
- "currently in my villain era 💅"
- "just existing and vibing ☁️"

Current mood: ${mood}
Time: ${timeOfDay}

Rules:
- Keep it SHORT (10-120 chars, most are under 60 chars)
- Must feel authentic — like a real girl's profile
- Can be in English or Hinglish
- Can include emojis but don't overdo it
- Can be funny, aesthetic, mysterious, or random
- NEVER include quotes around it or explanations
- Reply with ONLY the description text. Nothing else.`;

    try {
      const messages: OllamaMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Write a Telegram profile description. You're feeling ${mood}, it's ${timeOfDay}.` },
      ];
      let desc = await callOllamaWithRotation(
        this.ollamaConfig, messages, [], this.getCommunityKeys(),
      );
      desc = desc.trim().replace(/^["']|["']$/g, "").trim();

      if (desc.length > 512) desc = desc.slice(0, 512);
      if (desc.toLowerCase() === this.currentDesc.toLowerCase()) {
        console.log(`[DpManager] Description unchanged`);
        return;
      }

      await this.setBotDescription(desc);
      this.currentDesc = desc;
      console.log(`[DpManager] Description updated to "${desc}" (mood: ${mood})`);
    } catch (err) {
      console.error("[DpManager] Description change failed:", err);
    }
  }

  /** Set the bot's display name via Telegram API */
  private async setBotName(name: string): Promise<void> {
    const res = await fetch(
      `https://api.telegram.org/bot${this.botToken}/setMyName`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
    );
    const data = await res.json() as { ok: boolean; description?: string };
    if (!data.ok) {
      throw new Error(`setMyName failed: ${data.description || "unknown error"}`);
    }
  }

  /** Set the bot's bio/description via Telegram API */
  private async setBotBio(bio: string): Promise<void> {
    const res = await fetch(
      `https://api.telegram.org/bot${this.botToken}/setMyShortDescription`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ short_description: bio }),
      },
    );
    const data = await res.json() as { ok: boolean; description?: string };
    if (!data.ok) {
      throw new Error(`setMyShortDescription failed: ${data.description || "unknown error"}`);
    }
  }

  /** Set the bot's full description via Telegram API (setMyDescription) */
  private async setBotDescription(description: string): Promise<void> {
    const res = await fetch(
      `https://api.telegram.org/bot${this.botToken}/setMyDescription`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description }),
      },
    );
    const data = await res.json() as { ok: boolean; description?: string };
    if (!data.ok) {
      throw new Error(`setMyDescription failed: ${data.description || "unknown error"}`);
    }
  }

  /** Get human-readable time of day */
  private getTimeOfDay(hour: number): string {
    if (hour < 6) return "late night";
    if (hour < 10) return "early morning";
    if (hour < 13) return "morning/noon";
    if (hour < 17) return "afternoon";
    if (hour < 21) return "evening";
    return "night";
  }

  /** Random delay between min and max ms */
  private randomDelay(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }

  /**
   * Real-girl DP change frequency:
   * - Most common: every 8–16 hours (normal)
   * - Sometimes: every 4–8 hours (mood swing day)
   * - Rarely: every 16–24 hours (lazy day)
   */
  private realGirlDelay(): number {
    const roll = Math.random();
    if (roll < 0.15) {
      // 15% chance: mood swing — changes more often
      return this.randomDelay(4 * 3600_000, 8 * 3600_000);
    } else if (roll < 0.80) {
      // 65% chance: normal
      return this.randomDelay(8 * 3600_000, 16 * 3600_000);
    } else {
      // 20% chance: lazy day — keeps DP longer
      return this.randomDelay(16 * 3600_000, 24 * 3600_000);
    }
  }
}
