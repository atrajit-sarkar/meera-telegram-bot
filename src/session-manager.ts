import { GeminiSession, GeminiSessionConfig } from "./gemini-session.js";

const SESSION_TIMEOUT = 10 * 60 * 1000; // 10 minutes of inactivity

/**
 * Manages one GeminiSession per Telegram user.
 * Automatically creates sessions on demand and cleans up inactive ones.
 */
export class SessionManager {
  private sessions = new Map<number, GeminiSession>();
  private configFactory: (userId: number) => GeminiSessionConfig;
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(configFactory: (userId: number) => GeminiSessionConfig) {
    this.configFactory = configFactory;
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  /** Get or create a connected session for a user */
  async getSession(userId: number): Promise<GeminiSession> {
    let session = this.sessions.get(userId);
    if (session?.isConnected) return session;

    // Discard stale session
    session?.disconnect();

    // Create fresh session with user-specific config
    session = new GeminiSession(this.configFactory(userId));
    await session.connect();
    this.sessions.set(userId, session);
    return session;
  }

  /** Disconnect and remove a user's session */
  resetSession(userId: number) {
    const session = this.sessions.get(userId);
    session?.disconnect();
    this.sessions.delete(userId);
  }

  private cleanup() {
    const now = Date.now();
    for (const [userId, session] of this.sessions) {
      if (now - session.lastActivity > SESSION_TIMEOUT) {
        console.log(`[SessionManager] Cleaning up idle session for user ${userId}`);
        session.disconnect();
        this.sessions.delete(userId);
      }
    }
  }

  destroy() {
    clearInterval(this.cleanupInterval);
    for (const session of this.sessions.values()) {
      session.disconnect();
    }
    this.sessions.clear();
  }
}
