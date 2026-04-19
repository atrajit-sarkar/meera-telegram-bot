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

  /** Main tick: check if it's time to change DP */
  private async tick(): Promise<void> {
    const elapsed = Date.now() - this.lastDpChange;
    const remaining = Math.max(0, this.nextChangeDelay - elapsed);
    if (elapsed < this.nextChangeDelay) {
      console.log(`[DpManager] Tick — next DP change in ~${Math.round(remaining / 60_000)}min`);
      return;
    }

    const hasImages = await this.meeraImages.hasImages();
    if (!hasImages) {
      console.log("[DpManager] Tick — no community images available, skipping");
      // Re-check in 30 min instead of waiting full delay
      this.lastDpChange = Date.now();
      this.nextChangeDelay = 30 * 60_000;
      return;
    }

    try {
      await this.changeDp();
    } catch (err) {
      console.error("[DpManager] Failed to change DP:", err);
    }

    // Schedule next change: real-girl frequency (4–18 hours with randomness)
    this.nextChangeDelay = this.realGirlDelay();
    this.lastDpChange = Date.now();
    console.log(`[DpManager] Next DP change in ~${Math.round(this.nextChangeDelay / 3600_000)}h`);
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
    const hour = new Date().getHours();
    const timeOfDay =
      hour < 6 ? "late night" :
      hour < 10 ? "early morning" :
      hour < 13 ? "morning/noon" :
      hour < 17 ? "afternoon" :
      hour < 21 ? "evening" : "night";

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
