import type { OllamaMessage } from "./ollama-service.js";
import { initializeApp, cert, type ServiceAccount } from "firebase-admin/app";
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";

/**
 * Per-user data stored in memory + persisted to Firestore.
 */
export interface UserData {
  telegramUsername?: string;
  firstName?: string;
  profileName?: string;
  profileBio?: string;
  tone: "casual" | "formal";
  replyLength: "short" | "medium" | "long";
  voiceOnly: boolean;
  lastInteraction: number;
  chatId: number;
  stickerPacks: string[];
  proactiveSent: boolean;
  totalMessages: number;
  ollamaKeys: string[];
  mood: string;
  lastMoodChange: number;
  customPersona?: string;
}

export const MOODS = ["happy", "bored", "clingy", "sassy", "tired", "excited", "chill", "annoyed"] as const;
export type Mood = typeof MOODS[number];

export function defaultUserData(): UserData {
  return {
    tone: "casual",
    replyLength: "medium",
    voiceOnly: false,
    lastInteraction: Date.now(),
    chatId: 0,
    stickerPacks: [],
    proactiveSent: false,
    totalMessages: 0,
    ollamaKeys: [],
    mood: "chill",
    lastMoodChange: 0,
  };
}

/**
 * Manages per-user chat history and user data.
 * In-memory cache backed by Firestore for persistence.
 */
export class UserStore {
  private users = new Map<number, UserData>();
  private history = new Map<number, OllamaMessage[]>();
  private fsmState = new Map<number, string>();
  private maxHistory: number;
  private db: Firestore;
  private loadedUsers = new Set<number>();
  private saveQueue = new Set<number>();
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  // Community key pool — shared across all users
  private communityKeys: Array<{ key: string; contributedBy: number; contributorName: string; addedAt: number }> = [];
  private communityKeysLoaded = false;

  constructor(maxHistory = 50, databaseId?: string) {
    this.maxHistory = maxHistory;

    // Initialize Firebase
    const credsB64 = process.env.FIREBASE_CREDENTIALS_BASE64;
    if (!credsB64) {
      throw new Error("FIREBASE_CREDENTIALS_BASE64 not set in .env");
    }
    const creds = JSON.parse(
      Buffer.from(credsB64, "base64").toString("utf-8")
    ) as ServiceAccount;

    const app = initializeApp({ credential: cert(creds) });
    this.db = getFirestore(app, databaseId || "(default)");

    // Flush dirty users to Firestore every 10 seconds
    this.saveTimer = setInterval(() => this.flushAll(), 10_000);
    console.log("[UserStore] Firebase Firestore initialized");
  }

  /** Load user data + history from Firestore if not yet loaded */
  private async loadUser(userId: number): Promise<void> {
    if (this.loadedUsers.has(userId)) return;
    this.loadedUsers.add(userId);

    try {
      const userDoc = await this.db
        .collection("users")
        .doc(String(userId))
        .get();
      if (userDoc.exists) {
        const data = userDoc.data()!;
        const user = { ...defaultUserData(), ...data } as UserData;
        this.users.set(userId, user);
        console.log(`[UserStore] Loaded user ${userId} from Firestore (${user.totalMessages} msgs)`);
      }

      const histSnap = await this.db
        .collection("users")
        .doc(String(userId))
        .collection("history")
        .orderBy("ts", "asc")
        .get();
      if (!histSnap.empty) {
        const msgs: OllamaMessage[] = histSnap.docs.map((d) => ({
          role: d.data().role,
          content: d.data().content,
        }));
        this.history.set(userId, msgs);
        console.log(`[UserStore] Loaded ${msgs.length} history messages for user ${userId}`);
      }
    } catch (err) {
      console.error(`[UserStore] Failed to load user ${userId}:`, err);
    }
  }

  /** Ensure user is loaded before access (call from handlers) */
  async ensureLoaded(userId: number): Promise<void> {
    await this.loadUser(userId);
  }

  getUser(userId: number): UserData {
    let user = this.users.get(userId);
    if (!user) {
      user = defaultUserData();
      this.users.set(userId, user);
    }
    return user;
  }

  updateUser(userId: number, partial: Partial<UserData>) {
    const user = this.getUser(userId);
    Object.assign(user, partial);
    this.saveQueue.add(userId);
  }

  getHistory(userId: number): OllamaMessage[] {
    return this.history.get(userId) ?? [];
  }

  addMessage(userId: number, role: "user" | "assistant", content: string) {
    let hist = this.history.get(userId);
    if (!hist) {
      hist = [];
      this.history.set(userId, hist);
    }
    hist.push({ role, content });

    // Trim in memory to 2x maxHistory
    if (hist.length > this.maxHistory * 2) {
      hist.splice(0, hist.length - this.maxHistory * 2);
    }

    // Increment persistent counter
    if (role === "user") {
      const user = this.getUser(userId);
      user.totalMessages++;
    }

    this.saveQueue.add(userId);
  }

  getRecentHistory(userId: number): OllamaMessage[] {
    const hist = this.getHistory(userId);
    return hist.slice(-this.maxHistory);
  }

  clearHistory(userId: number) {
    this.history.delete(userId);
    this.saveQueue.add(userId);
    // Delete history sub-collection in background
    this.deleteHistoryCollection(userId).catch((err) =>
      console.error(`[UserStore] Failed to clear history for ${userId}:`, err)
    );
  }

  getMessageCount(userId: number): number {
    return this.getUser(userId).totalMessages;
  }

  // ── FSM state for multi-step commands (in-memory only) ──
  getFsmState(userId: number): string | undefined {
    return this.fsmState.get(userId);
  }
  setFsmState(userId: number, state: string) {
    this.fsmState.set(userId, state);
  }
  clearFsmState(userId: number) {
    this.fsmState.delete(userId);
  }

  // ── Comfort tiers ──
  getComfortTier(userId: number): string {
    const count = this.getMessageCount(userId);
    if (count < 8) return "stranger";
    if (count < 25) return "acquaintance";
    if (count < 60) return "comfortable";
    return "close";
  }

  /** Get current mood, rotating every 2-6 hours randomly */
  getMood(userId: number): string {
    const user = this.getUser(userId);
    const now = Date.now();
    const moodDuration = 2 * 3600 * 1000 + Math.random() * 4 * 3600 * 1000; // 2-6h
    if (now - user.lastMoodChange > moodDuration) {
      const newMood = MOODS[Math.floor(Math.random() * MOODS.length)];
      user.mood = newMood;
      user.lastMoodChange = now;
      this.saveQueue.add(userId);
    }
    return user.mood;
  }

  /** All user IDs that are loaded in memory */
  allUserIds(): number[] {
    return [...this.users.keys()];
  }

  // ── Firestore persistence ──

  /** Save a single user's data + history to Firestore */
  private async saveUser(userId: number): Promise<void> {
    try {
      const user = this.users.get(userId);
      if (user) {
        const data = { ...user } as Record<string, unknown>;
        // If customPersona is empty/unset, delete the field from Firestore entirely
        if (!user.customPersona) {
          data.customPersona = FieldValue.delete();
        }
        await this.db
          .collection("users")
          .doc(String(userId))
          .set(data, { merge: true });
      }

      const hist = this.history.get(userId);
      if (hist) {
        // Delete old history, write current
        await this.deleteHistoryCollection(userId);
        const batch = this.db.batch();
        const histRef = this.db
          .collection("users")
          .doc(String(userId))
          .collection("history");
        for (let i = 0; i < hist.length; i++) {
          const docRef = histRef.doc(String(i).padStart(6, "0"));
          batch.set(docRef, {
            role: hist[i].role,
            content: hist[i].content,
            ts: i,
          });
        }
        await batch.commit();
      }
    } catch (err) {
      console.error(`[UserStore] Failed to save user ${userId}:`, err);
    }
  }

  /** Delete all docs in a user's history sub-collection */
  private async deleteHistoryCollection(userId: number): Promise<void> {
    const histRef = this.db
      .collection("users")
      .doc(String(userId))
      .collection("history");
    const snap = await histRef.get();
    if (snap.empty) return;
    const batch = this.db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }

  /** Flush all dirty users to Firestore */
  private async flushAll(): Promise<void> {
    const ids = [...this.saveQueue];
    this.saveQueue.clear();
    for (const id of ids) {
      await this.saveUser(id);
    }
  }

  /** Flush remaining data and stop timer */
  async destroy(): Promise<void> {
    if (this.saveTimer) clearInterval(this.saveTimer);
    await this.flushAll();
    console.log("[UserStore] Flushed all data to Firestore");
  }

  // ── COMMUNITY KEY POOL ──────────────────────────────────────────

  /** Load community keys from Firestore (once) */
  async loadCommunityKeys(): Promise<void> {
    if (this.communityKeysLoaded) return;
    this.communityKeysLoaded = true;
    try {
      const snap = await this.db.collection("community_keys").get();
      this.communityKeys = snap.docs.map((d) => ({
        key: d.data().key as string,
        contributedBy: d.data().contributedBy as number,
        contributorName: (d.data().contributorName as string) || "",
        addedAt: d.data().addedAt as number,
      }));
      console.log(`[UserStore] Loaded ${this.communityKeys.length} community keys`);
    } catch (err) {
      console.error("[UserStore] Failed to load community keys:", err);
    }
  }

  /** Check if a key already exists in community pool or any user's personal keys */
  async isKeyDuplicate(key: string, userId: number): Promise<"community" | "personal" | false> {
    await this.loadCommunityKeys();
    if (this.communityKeys.some((k) => k.key === key)) return "community";
    // Check the requesting user's own personal keys
    const user = this.getUser(userId);
    if (user.ollamaKeys.includes(key)) return "personal";
    return false;
  }

  /** Add a key to the community pool */
  async addCommunityKey(key: string, contributedBy: number, contributorName: string): Promise<boolean> {
    await this.loadCommunityKeys();
    // Check for duplicates
    if (this.communityKeys.some((k) => k.key === key)) return false;
    const entry = { key, contributedBy, contributorName, addedAt: Date.now() };
    this.communityKeys.push(entry);
    try {
      await this.db.collection("community_keys").add(entry);
    } catch (err) {
      console.error("[UserStore] Failed to save community key:", err);
    }
    return true;
  }

  /** Remove a community key by index */
  async removeCommunityKey(index: number, requestedBy: number): Promise<{ removed: boolean; key?: string; notOwner?: boolean }> {
    await this.loadCommunityKeys();
    if (index < 0 || index >= this.communityKeys.length) return { removed: false };
    const entry = this.communityKeys[index];
    // Only the contributor or bot admin can remove
    const adminId = process.env.ADMIN_USER_ID ? parseInt(process.env.ADMIN_USER_ID) : 0;
    if (entry.contributedBy !== requestedBy && requestedBy !== adminId) {
      return { removed: false, notOwner: true };
    }
    this.communityKeys.splice(index, 1);
    // Delete from Firestore
    try {
      const snap = await this.db.collection("community_keys")
        .where("key", "==", entry.key)
        .limit(1)
        .get();
      if (!snap.empty) await snap.docs[0].ref.delete();
    } catch (err) {
      console.error("[UserStore] Failed to delete community key:", err);
    }
    return { removed: true, key: entry.key };
  }

  /** Get all community keys (just the key strings, shuffled for load distribution) */
  getCommunityKeyStrings(): string[] {
    // Shuffle to distribute load across keys
    const keys = this.communityKeys.map((k) => k.key);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    return keys;
  }

  /** Get community keys info for display */
  getCommunityKeysInfo(): Array<{ maskedKey: string; contributedBy: number; contributorName: string }> {
    return this.communityKeys.map((k) => ({
      maskedKey: `${k.key.slice(0, 6)}...${k.key.slice(-4)}`,
      contributedBy: k.contributedBy,
      contributorName: k.contributorName || "",
    }));
  }

  /** Get count of community keys */
  getCommunityKeyCount(): number {
    return this.communityKeys.length;
  }
}
