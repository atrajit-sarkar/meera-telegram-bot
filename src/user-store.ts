import type { OllamaMessage } from "./ollama-service.js";

/**
 * Per-user data stored in memory.
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
}

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
  };
}

/**
 * Manages per-user chat history and user data (in-memory).
 */
export class UserStore {
  private users = new Map<number, UserData>();
  private history = new Map<number, OllamaMessage[]>();
  private fsmState = new Map<number, string>();
  private maxHistory: number;

  constructor(maxHistory = 20) {
    this.maxHistory = maxHistory;
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
    // Trim to 2x maxHistory in memory, but only send maxHistory to API
    if (hist.length > this.maxHistory * 2) {
      hist.splice(0, hist.length - this.maxHistory * 2);
    }
    // Increment persistent counter (not affected by trim)
    if (role === "user") {
      const user = this.getUser(userId);
      user.totalMessages++;
    }
  }

  getRecentHistory(userId: number): OllamaMessage[] {
    const hist = this.getHistory(userId);
    return hist.slice(-this.maxHistory);
  }

  clearHistory(userId: number) {
    this.history.delete(userId);
  }

  getMessageCount(userId: number): number {
    return this.getUser(userId).totalMessages;
  }

  // ── FSM state for multi-step commands ──
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

  /** All user IDs */
  allUserIds(): number[] {
    return [...this.users.keys()];
  }
}
