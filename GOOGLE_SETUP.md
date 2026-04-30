# Meera — Google Cloud + Workspace Setup Guide

This is the full re-setup checklist after switching from a consumer Gmail account to a **Google Workspace** account (recommended after the previous account was suspended for bot-pattern activity).

The bot uses a wide tool surface: Gmail, Calendar, Meet, Tasks, Contacts/People, Drive, Photos, YouTube Data, and Google Fit (steps + heart rate + sleep + weight + body-fat + hydration). All of these need to be enabled and authorized once.

---

## 0 · Prerequisites

- A Google **Workspace** subscription with a verified domain (Business Starter is enough — it's the cheapest tier and lifts most consumer-account anti-abuse pressure).
- A new Workspace user that *is* Meera, e.g. `meera@yourdomain.com`.
- Admin access to the Google Cloud Console for that org.

---

## 1 · Create the Workspace user

1. Go to <https://admin.google.com> → **Directory → Users → Add new user**.
2. Create the user (`meera@yourdomain.com`). Set a real first/last name and a profile photo.
3. **Sign in once interactively** in a normal browser:
   - Open Gmail, accept the welcome screens.
   - Open YouTube, watch one or two videos to completion, like one, subscribe to one channel.
   - Open Calendar, create one manual event.
   - Install the Google Fit app on a phone (even briefly) and pair it once if possible — this gives Fit a "real device" history before any synthetic writes.
   This 5-10 min of organic activity seeds human behavioral history *before* the bot turns on, and it dramatically reduces auto-suspension risk.

---

## 2 · Create / select the Google Cloud project

1. Open <https://console.cloud.google.com>.
2. Top bar → project picker → **New Project**. Name it `meera-life` (or anything). **Make sure the project is created inside your Workspace organization**, not "No organization".
3. Switch to the new project.

---

## 3 · Enable the required APIs

Open <https://console.cloud.google.com/apis/library> and enable each of these (search by name, click **Enable**):

| API | Why |
|---|---|
| **Gmail API** | Read / search / send / reply / label mail |
| **Google Calendar API** | Schedule, free-slot search, RSVP, reminders |
| **Google Tasks API** | To-do list |
| **People API** | Contacts read / add / update |
| **Google Drive API** | Search, recent, create Doc, share, save image, delete |
| **Google Docs API** | Write the journal Doc, Notes |
| **Photos Library API** | Recent / search / upload / albums / captions |
| **YouTube Data API v3** | Subs, liked, history, search, like, subscribe, comment, upload, video info |
| **Fitness API** | Steps, distance, calories, active minutes, heart rate, weight, body-fat, hydration, sleep sessions |

(There is no separate "Meet API" — Meet links are generated through Calendar.)

---

## 4 · Configure the OAuth consent screen

Open <https://console.cloud.google.com/auth/overview>.

1. **User Type → Internal.** (Critical. Internal apps under a Workspace org skip Google's verification process and can use any scope without review or quotas. External apps with sensitive scopes require app verification, which is a multi-week process and a hard blocker.)
2. App name: `Meera Life` (or anything).
3. User support email: your admin email.
4. Developer contact: your admin email.
5. Save.

---

## 5 · Add scopes to the consent screen

Open <https://console.cloud.google.com/auth/scopes> → **Add or remove scopes**. Paste each of these and tick them:

```
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
openid

https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/gmail.send

https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/calendar.events

https://www.googleapis.com/auth/tasks

https://www.googleapis.com/auth/contacts
https://www.googleapis.com/auth/contacts.readonly

https://www.googleapis.com/auth/drive
https://www.googleapis.com/auth/drive.file
https://www.googleapis.com/auth/documents

https://www.googleapis.com/auth/photoslibrary
https://www.googleapis.com/auth/photoslibrary.appendonly
https://www.googleapis.com/auth/photoslibrary.sharing

https://www.googleapis.com/auth/youtube
https://www.googleapis.com/auth/youtube.force-ssl
https://www.googleapis.com/auth/youtube.upload
https://www.googleapis.com/auth/youtube.readonly

https://www.googleapis.com/auth/fitness.activity.read
https://www.googleapis.com/auth/fitness.activity.write
https://www.googleapis.com/auth/fitness.location.read
https://www.googleapis.com/auth/fitness.location.write
https://www.googleapis.com/auth/fitness.heart_rate.read
https://www.googleapis.com/auth/fitness.heart_rate.write
https://www.googleapis.com/auth/fitness.sleep.read
https://www.googleapis.com/auth/fitness.sleep.write
https://www.googleapis.com/auth/fitness.body.read
https://www.googleapis.com/auth/fitness.body.write
https://www.googleapis.com/auth/fitness.nutrition.read
https://www.googleapis.com/auth/fitness.nutrition.write
```

Click **Update**. (If a scope is greyed out, the corresponding API isn't enabled yet — go back to step 3.)

The exact list the bot requires lives in `REQUIRED_SCOPES` inside [src/google-tools.ts](src/google-tools.ts). If you change either side, keep them in sync.

---

## 6 · Create the OAuth client credentials

Open <https://console.cloud.google.com/auth/clients> → **Create client**.

- **Application type:** Desktop app
- **Name:** `meera-life-cli`
- Click **Create**, then download the JSON or copy the **Client ID** + **Client secret**.

(Desktop app type is what `npm run auth:google` expects — it spins up a local loopback redirect at `http://localhost:PORT`.)

---

## 7 · Update `.env`

In the project root `.env`:

```env
GOOGLE_CLIENT_ID=<from step 6>
GOOGLE_CLIENT_SECRET=<from step 6>
GOOGLE_REFRESH_TOKEN=        # leave empty for now — step 8 fills it
```

(Other unrelated env vars — Telegram token, Gemini key, Ollama config — stay as-is.)

---

## 8 · Get the refresh token

```powershell
npm run auth:google
```

This opens a browser. **Sign in as the Meera Workspace user** (not your personal account). Approve every scope. The script writes the refresh token back into `.env` automatically.

---

## 9 · Verify everything works

```powershell
npm run check:google
```

You should see all sections come back green:

- account info shows `meera@yourdomain.com`
- gmail / calendar / tasks / contacts / drive / photos / youtube / fitness all return success
- life snapshot prints at the bottom

If a section fails with `403 insufficient_scope`, you missed that scope on step 5 — re-add it, revoke at <https://myaccount.google.com/permissions>, and re-run step 8.

---

## 10 · (Optional but strongly recommended) Tone down YouTube autonomy

YouTube spam detection got the previous account flagged hardest. Even on Workspace, mass auto-commenting / auto-subscribing from a server is risky. Two safer modes:

- **Reactive only:** disable `youtubeAutonomousIfDue` in [src/meera-life.ts](src/meera-life.ts) and only let Meera react to videos the user shares.
- **Watch-only autonomy:** keep `youtube_mark_watched` + `youtube_like_video` but skip `youtube_comment` and `youtube_subscribe` in the Ollama plan.

Synthetic Fit writes are far less risky on Workspace, but keep them at 3-6 slices per day — not dozens.

---

## 11 · Re-deploy

```powershell
npm run build
npm run start    # or your usual deploy step
```

Watch the logs for the first hour to confirm:

- `[meera-life] yt:` lines fire only after the 30-min cooldown.
- `[meera-life] fit:` line fires once after 21:00 IST.
- No `403` or `401` from any Google call.

---

## Troubleshooting cheatsheet

| Symptom | Fix |
|---|---|
| `403 PERMISSION_DENIED` on a Fit call | Scope missing. Re-add on step 5, revoke at myaccount.google.com/permissions, redo step 8. |
| `invalid_grant` on token refresh | Refresh token was revoked (you signed out, changed password, or someone clicked "Remove" on the permissions page). Redo step 8. |
| YouTube uploads fail with `youtubeSignupRequired` | The Workspace user has never created a YouTube channel. Sign in to YouTube once in a browser as that user → click your avatar → **Create a channel**. |
| Photos returns empty | Photos Library API not enabled, or the user has never opened Google Photos once interactively. |
| Account suddenly disabled again | Stop autonomous YouTube comments/subscribes immediately. File an appeal. Don't share the same client across multiple accounts. |

---

## Long-term hygiene

- Don't reuse the same OAuth client across multiple Workspace users — each Meera-style account should have its own Cloud project + client.
- Don't run multiple bot accounts off the same residential IP simultaneously.
- Keep autonomous write volume realistic for one human (10-100 actions/day across all products combined, not thousands).
- Sign in interactively as the Workspace user once a month from a real browser — keeps the account looking active to Google.
