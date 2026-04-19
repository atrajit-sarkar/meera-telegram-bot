/**
 * Community-contributed Meera image database.
 *
 * Users generate images externally (e.g. Grok) using a reference photo,
 * then upload them with captions describing the pose/mood/context.
 * When someone asks for Meera's photo, Ollama picks the best match
 * from this pool based on the captions and conversation context.
 */

import { type Firestore } from "firebase-admin/firestore";

export interface MeeraImage {
  id: string;                // Firestore document ID
  fileId: string;            // Telegram file_id (persistent across bot restarts)
  caption: string;           // Description of the image (pose, mood, setting)
  contributedBy: number;     // Telegram user ID of contributor
  contributorName: string;   // Display name of contributor
  addedAt: number;           // Timestamp
}

const COLLECTION = "meera_images";

export class MeeraImageStore {
  private images: MeeraImage[] = [];
  private loaded = false;
  private db: Firestore;

  constructor(db: Firestore) {
    this.db = db;
  }

  /** Load all community Meera images from Firestore (once) */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const snap = await this.db.collection(COLLECTION).get();
      this.images = snap.docs.map((d) => ({
        id: d.id,
        fileId: d.data().fileId as string,
        caption: d.data().caption as string,
        contributedBy: d.data().contributedBy as number,
        contributorName: (d.data().contributorName as string) || "",
        addedAt: d.data().addedAt as number,
      }));
      console.log(`[MeeraImages] Loaded ${this.images.length} community images`);
    } catch (err) {
      console.error("[MeeraImages] Failed to load:", err);
    }
  }

  /** Add a new community Meera image */
  async addImage(
    fileId: string,
    caption: string,
    contributedBy: number,
    contributorName: string,
  ): Promise<MeeraImage> {
    await this.load();
    const entry = {
      fileId,
      caption,
      contributedBy,
      contributorName,
      addedAt: Date.now(),
    };
    const docRef = await this.db.collection(COLLECTION).add(entry);
    const image: MeeraImage = { id: docRef.id, ...entry };
    this.images.push(image);
    console.log(`[MeeraImages] Added image by ${contributorName}: "${caption.slice(0, 60)}"`);
    return image;
  }

  /** Remove a community Meera image by index (0-based). Only contributor or admin can remove. */
  async removeImage(
    index: number,
    requestedBy: number,
  ): Promise<{ removed: boolean; image?: MeeraImage; notOwner?: boolean }> {
    await this.load();
    if (index < 0 || index >= this.images.length) return { removed: false };
    const image = this.images[index];
    const adminId = process.env.ADMIN_USER_ID ? parseInt(process.env.ADMIN_USER_ID) : 0;
    if (image.contributedBy !== requestedBy && requestedBy !== adminId) {
      return { removed: false, notOwner: true };
    }
    this.images.splice(index, 1);
    try {
      await this.db.collection(COLLECTION).doc(image.id).delete();
    } catch (err) {
      console.error("[MeeraImages] Failed to delete:", err);
    }
    return { removed: true, image };
  }

  /** Get all images */
  async getAll(): Promise<MeeraImage[]> {
    await this.load();
    return [...this.images];
  }

  /** Get count */
  async getCount(): Promise<number> {
    await this.load();
    return this.images.length;
  }

  /** Get image info for display */
  async getInfo(): Promise<Array<{ caption: string; contributorName: string; index: number }>> {
    await this.load();
    return this.images.map((img, i) => ({
      caption: img.caption.length > 60 ? img.caption.slice(0, 57) + "..." : img.caption,
      contributorName: img.contributorName,
      index: i,
    }));
  }

  /** Get all captions (for Ollama selection) */
  async getCaptionsWithIndices(): Promise<Array<{ index: number; caption: string }>> {
    await this.load();
    return this.images.map((img, i) => ({ index: i, caption: img.caption }));
  }

  /** Get image by index */
  async getByIndex(index: number): Promise<MeeraImage | null> {
    await this.load();
    if (index < 0 || index >= this.images.length) return null;
    return this.images[index];
  }

  /** Check if there are any images available */
  async hasImages(): Promise<boolean> {
    await this.load();
    return this.images.length > 0;
  }
}
