# Meera's Google Account Setup

Meera now uses a real Google account exactly the way a human would: she reads her Gmail, looks at her calendar, hops on Google Meet, manages a to-do list, searches her contacts, and pokes around her Drive. Both **Ollama** (text brain) and **Gemini Live** (voice / image / video brain) get the same tool surface and the same "real-life" awareness, so her behavior stays consistent across modalities.

---

## 1 · Pick the Google account that will BE Meera

Use a dedicated Google account — this account *is* her digital identity. Avoid using your personal Gmail; create a fresh one (e.g. `meera.somename@gmail.com`) so privacy boundaries stay clean.

## 2 · Enable these APIs in Google Cloud Console

Open https://console.cloud.google.com/apis/library and enable each of these on the project that will own the OAuth client:

| API | Purpose |
|---|---|
| **Gmail API** | Read inbox, search, send mail |
| **Google Calendar API** | Read schedule, create events, attach Google Meet links |
| **Google Tasks API** | Personal to-do list |
| **People API** | Contacts lookup |
| **Google Drive API** | Search & list her files |
| **YouTube Data API v3** | Shorts / video sharing (already in use) |

> Google Meet does **not** need a separate API — Meet links are created via Calendar's `conferenceData`, which is part of the Calendar API.

## 3 · Create an OAuth 2.0 client

1. https://console.cloud.google.com/apis/credentials → **Create Credentials → OAuth client ID**
2. Application type: **Desktop app**
3. Save the **Client ID** and **Client secret**.
4. On the OAuth **consent screen**, add yourself as a **Test user** (and Meera's account if it's different from your owner account). External apps can stay in "Testing" mode for personal use — refresh tokens issued in Testing mode expire after 7 days, so for production you should publish the app.

## 4 · Put credentials in `.env`

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_USER_EMAIL=meera.account@gmail.com
GOOGLE_USER_NAME=Meera
GOOGLE_USER_TIMEZONE=Asia/Kolkata
```

## 5 · Run the one-time auth flow

```powershell
npm run auth:google
```

The script prints a consent URL. Open it in a browser **while signed in as Meera's Google account**, approve the scopes, and the local helper captures the refresh token. Paste the printed `GOOGLE_REFRESH_TOKEN=...` line into your `.env`.

## 6 · Start the bot

```powershell
npm run dev
```

You should see Meera silently warm her snapshot — and her system prompt now contains a line like:

```
YOUR REAL-LIFE CONTEXT (you just know this — like checking your phone subconsciously):
- Next on your calendar: "Yoga class" at Tue 7:00 AM.
- You have 3 unread emails sitting in your Gmail.
- 2 things still on your to-do list.
```

She'll bring these up naturally only when relevant.

---

## What Meera can now do

| Capability | Tool the model calls |
|---|---|
| "Any new emails?" | `gmail_check_inbox` |
| "Look up the invoice from Razorpay last month" | `gmail_search`, then `gmail_read` |
| "Mail Riya the address" | `gmail_send` (only on explicit ask) |
| "What does your day look like?" | `calendar_today` |
| "Free this Friday?" | `calendar_upcoming` |
| "Add coffee with me 5pm tomorrow" | `calendar_create_event` (with optional `withMeet`) |
| "Send me a meet link rn" | `meet_create_now` |
| "What's on your todo?" / "Remind me to buy gifts" | `tasks_list` / `tasks_add` / `tasks_complete` |
| "What's Aarav's number again?" | `contacts_search` |
| "Find that PDF I saved" | `drive_search` / `drive_recent` |

## Safety defaults baked in

- `gmail_send` only runs on explicit user request — the persona prompt forbids unsolicited sends.
- The system prompt explicitly forbids leaking OTPs, passwords, or full sensitive bodies unless asked.
- Access tokens are cached in-memory only and refreshed ~60s before expiry.
- 401 responses trigger a single transparent retry against a freshly-refreshed token.
- A network/API error from any tool returns `{ success: false, message }` instead of crashing the chat.

## Architecture (why it stays unique)

- **One refresh token, two brains.** Both Ollama and Gemini Live are given the exact same tool declarations (via `src/tools.ts`) so Meera behaves identically whether she's typing or speaking.
- **Background life-snapshot** (`getMeeraLifeSnapshot` in `src/google-tools.ts`) runs every 5 minutes, non-blocking, so her persona prompt always carries a tiny dose of "what she just glanced at on her phone" — without spending a tool call on every message.
- **Stateless OAuth.** Tokens are not persisted on disk; refresh tokens live in env only. If you redeploy, Meera reconnects automatically on first call.

That's it — Meera now lives a real Google life.
