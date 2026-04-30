/**
 * Meera's personal Google Account — OAuth2 token manager.
 *
 * Uses a long-lived refresh token (stored in env) to obtain short-lived
 * access tokens for any enabled Google API (Gmail, Calendar, Tasks, People,
 * Drive, Meet via Calendar conferenceData, etc).
 *
 * No external SDK — direct REST calls keep the deploy lean.
 *
 * Required env vars (set after running `npm run auth:google`):
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN
 *   GOOGLE_USER_EMAIL          (Meera's account email — used as "from" / display)
 *
 * Optional:
 *   GOOGLE_USER_TIMEZONE       (default: Asia/Kolkata)
 *   GOOGLE_USER_NAME           (display name on outgoing mail; default: BOT_NAME)
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";

let cachedAccessToken: string | null = null;
let cachedExpiry = 0; // epoch ms

export interface GoogleAccountInfo {
  email: string;
  name: string;
  timezone: string;
  configured: boolean;
}

export function getAccountInfo(): GoogleAccountInfo {
  return {
    email: process.env.GOOGLE_USER_EMAIL ?? "",
    name: process.env.GOOGLE_USER_NAME ?? process.env.BOT_NAME ?? "Meera",
    timezone: process.env.GOOGLE_USER_TIMEZONE ?? "Asia/Kolkata",
    configured: Boolean(
      process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET &&
        process.env.GOOGLE_REFRESH_TOKEN
    ),
  };
}

export function isGoogleConfigured(): boolean {
  return getAccountInfo().configured;
}

/** Get a fresh access token, refreshing it ~60s before expiry. */
export async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedExpiry - 60_000) {
    return cachedAccessToken;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Google account not configured. Run `npm run auth:google` and set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN in your .env."
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google token refresh failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = data.access_token;
  cachedExpiry = Date.now() + data.expires_in * 1000;
  return cachedAccessToken;
}

/** Authenticated fetch helper for Google REST APIs. Auto-retries once on 401. */
export async function googleFetch(
  url: string,
  init: RequestInit = {},
  attempt = 0
): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && init.body && typeof init.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(url, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  if (res.status === 401 && attempt === 0) {
    cachedAccessToken = null;
    cachedExpiry = 0;
    return googleFetch(url, init, 1);
  }
  return res;
}

/** Convenience JSON helper. Throws on non-2xx with descriptive error. */
export async function googleJson<T = unknown>(
  url: string,
  init: RequestInit = {}
): Promise<T> {
  const res = await googleFetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google API ${res.status} ${url}: ${text.slice(0, 400)}`);
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}
