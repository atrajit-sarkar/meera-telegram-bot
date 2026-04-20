/**
 * Community-contributed Meera video database.
 *
 * Users upload videos with captions describing the context/mood/content.
 * Since videos can't be processed by Gemini Live, only the captions are used
 * by Ollama to decide which video to send based on comfort tier and context.
 * Videos can also be sent as video notes (circle videos) for close-tier users.
 */

import { type Firestore } from "firebase-admin/firestore";

export interface MeeraVideo {
  id: string;                // Firestore document ID
  fileId: string;            // Telegram file_id (persistent across bot restarts)
  caption: string;           // Description of the video (context, mood, content)
  contributedBy: number;     // Telegram user ID of contributor
  contributorName: string;   // Display name of contributor
  addedAt: number;           // Timestamp
}

const COLLECTION = "meera_videos";

export class MeeraVideoStore {
  private videos: MeeraVideo[] = [];
  private loaded = false;
  private db: Firestore;

  constructor(db: Firestore) {
    this.db = db;
  }

  /** Load all community Meera videos from Firestore (once) */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const snap = await this.db.collection(COLLECTION).get();
      this.videos = snap.docs.map((d) => ({
        id: d.id,
        fileId: d.data().fileId as string,
        caption: d.data().caption as string,
        contributedBy: d.data().contributedBy as number,
        contributorName: (d.data().contributorName as string) || "",
        addedAt: d.data().addedAt as number,
      }));
      console.log(`[MeeraVideos] Loaded ${this.videos.length} community videos`);
    } catch (err) {
      console.error("[MeeraVideos] Failed to load:", err);
    }
  }

  /** Add a new community Meera video */
  async addVideo(
    fileId: string,
    caption: string,
    contributedBy: number,
    contributorName: string,
  ): Promise<MeeraVideo> {
    await this.load();
    const entry = {
      fileId,
      caption,
      contributedBy,
      contributorName,
      addedAt: Date.now(),
    };
    const docRef = await this.db.collection(COLLECTION).add(entry);
    const video: MeeraVideo = { id: docRef.id, ...entry };
    this.videos.push(video);
    console.log(`[MeeraVideos] Added video by ${contributorName}: "${caption.slice(0, 60)}"`);
    return video;
  }

  /** Remove a community Meera video by index (0-based). Only contributor or admin can remove. */
  async removeVideo(
    index: number,
    requestedBy: number,
  ): Promise<{ removed: boolean; video?: MeeraVideo; notOwner?: boolean }> {
    await this.load();
    if (index < 0 || index >= this.videos.length) return { removed: false };
    const video = this.videos[index];
    const adminId = process.env.ADMIN_USER_ID ? parseInt(process.env.ADMIN_USER_ID) : 0;
    if (video.contributedBy !== requestedBy && requestedBy !== adminId) {
      return { removed: false, notOwner: true };
    }
    this.videos.splice(index, 1);
    try {
      await this.db.collection(COLLECTION).doc(video.id).delete();
    } catch (err) {
      console.error("[MeeraVideos] Failed to delete:", err);
    }
    return { removed: true, video };
  }

  /** Get all videos */
  async getAll(): Promise<MeeraVideo[]> {
    await this.load();
    return [...this.videos];
  }

  /** Get count */
  async getCount(): Promise<number> {
    await this.load();
    return this.videos.length;
  }

  /** Get video info for display */
  async getInfo(): Promise<Array<{ caption: string; contributorName: string; index: number }>> {
    await this.load();
    return this.videos.map((vid, i) => ({
      caption: vid.caption.length > 60 ? vid.caption.slice(0, 57) + "..." : vid.caption,
      contributorName: vid.contributorName,
      index: i,
    }));
  }

  /** Get all captions (for Ollama selection) */
  async getCaptionsWithIndices(): Promise<Array<{ index: number; caption: string }>> {
    await this.load();
    return this.videos.map((vid, i) => ({ index: i, caption: vid.caption }));
  }

  /** Get video by index */
  async getByIndex(index: number): Promise<MeeraVideo | null> {
    await this.load();
    if (index < 0 || index >= this.videos.length) return null;
    return this.videos[index];
  }

  /** Check if there are any videos available */
  async hasVideos(): Promise<boolean> {
    await this.load();
    return this.videos.length > 0;
  }
}
