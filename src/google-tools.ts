/**
 * Google API tool surface for Meera.
 *
 * All tools assume Meera's own Google account (configured via OAuth2 in
 * google-account.ts). They are designed to be safe by default — write
 * operations are explicit and gated, and replies are short, human-readable
 * strings the LLM can paraphrase naturally.
 *
 * APIs used (enable them in your Google Cloud project):
 *   - Gmail API                  https://gmail.googleapis.com
 *   - Google Calendar API        https://www.googleapis.com/calendar/v3
 *   - Google Tasks API           https://tasks.googleapis.com
 *   - Google People API          https://people.googleapis.com
 *   - Google Drive API           https://www.googleapis.com/drive/v3
 *   - Google Meet (via Calendar conferenceData)
 *   - YouTube Data API v3        https://www.googleapis.com/youtube/v3 (already used)
 */

import type { ToolDeclaration } from "./gemini-session.js";
import { googleJson, googleFetch, getAccountInfo, isGoogleConfigured } from "./google-account.js";
import fsSync from "node:fs";

// ───────────────────────────────────────────────────────────────────────
// SCOPES (used by setup CLI)
// ───────────────────────────────────────────────────────────────────────

export const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://mail.google.com/",                                         // full Gmail
  "https://www.googleapis.com/auth/calendar",                         // full Calendar (incl. Meet)
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/tasks",                            // Google Tasks
  "https://www.googleapis.com/auth/contacts",                         // People (read/write)
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/drive",                            // Drive (also creates Google Docs)
  "https://www.googleapis.com/auth/drive.file",
  // Google Photos — only the "app-created" surface is available to new third-party
  // apps as of March 2025. That's enough for Meera: she uploads new photos/videos
  // herself and can read/edit only what she put there.
  "https://www.googleapis.com/auth/photoslibrary.appendonly",          // upload
  "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata", // read app-created items
  "https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata",  // edit captions on app-created items
  // YouTube — full read/write so Meera can subscribe, like/dislike, comment,
  // upload videos, and manage playlists like a real user.
  "https://www.googleapis.com/auth/youtube",            // rate, subscribe, playlist manage
  "https://www.googleapis.com/auth/youtube.force-ssl",  // commentThreads / comments insert
  "https://www.googleapis.com/auth/youtube.upload",     // videos.insert
  // Google Fit — read activity (steps, distance, calories) for "real life" context.
  "https://www.googleapis.com/auth/fitness.activity.read",
];

// ───────────────────────────────────────────────────────────────────────
// TOOL DECLARATIONS — exposed to Gemini Live & Ollama
// ───────────────────────────────────────────────────────────────────────

export const googleToolDeclarations: ToolDeclaration[] = [
  // ── Gmail ────────────────────────────────────────────────────────────
  {
    name: "gmail_check_inbox",
    description:
      "Check Meera's own Gmail inbox. Returns recent unread emails (sender, subject, snippet). Use when you want to know if she has new mail, or when the user asks 'any emails?', 'check your mail', etc.",
    parameters: {
      type: "object",
      properties: {
        max: { type: "integer", description: "How many emails to return (default 5, max 15)" },
        onlyUnread: { type: "boolean", description: "Only unread emails (default true)" },
      },
    },
  },
  {
    name: "gmail_search",
    description:
      "Search Meera's Gmail using Gmail query syntax (e.g. 'from:bank', 'subject:invoice', 'newer_than:7d'). Returns matching email summaries.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query" },
        max: { type: "integer", description: "Max results (default 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "gmail_read",
    description:
      "Read the full body of a specific Gmail message by ID. Use after gmail_check_inbox / gmail_search to read a particular email in detail.",
    parameters: {
      type: "object",
      properties: { messageId: { type: "string" } },
      required: ["messageId"],
    },
  },
  {
    name: "gmail_send",
    description:
      "Send an email from Meera's Gmail account. Only call this when the user EXPLICITLY asks Meera to send mail. Compose body in Meera's natural casual voice.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text body" },
        cc: { type: "string", description: "Optional CC address" },
      },
      required: ["to", "subject", "body"],
    },
  },

  // ── Calendar / Meet ──────────────────────────────────────────────────
  {
    name: "calendar_today",
    description:
      "Get Meera's calendar events for today (or for the next 24 hours). Use when she wants to know her schedule, or when user asks 'what are you doing today?'.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "calendar_upcoming",
    description:
      "Get Meera's upcoming calendar events for the next N days (default 7).",
    parameters: {
      type: "object",
      properties: {
        days: { type: "integer", description: "Look ahead N days (default 7, max 30)" },
        max: { type: "integer", description: "Max events (default 10)" },
      },
    },
  },
  {
    name: "calendar_create_event",
    description:
      "Add an event to Meera's calendar. Use ISO 8601 in Meera's timezone, or a relative phrase via `quickAdd` (e.g. 'Coffee with Riya tomorrow 5pm'). Set `withMeet=true` to attach a Google Meet link automatically.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        startISO: { type: "string", description: "ISO start datetime" },
        endISO: { type: "string", description: "ISO end datetime (default +30min)" },
        description: { type: "string" },
        location: { type: "string" },
        attendees: { type: "array", items: { type: "string" }, description: "Email addresses to invite" },
        withMeet: { type: "boolean", description: "Attach a Google Meet link" },
        quickAdd: { type: "string", description: "Natural language alternative ('Lunch w/ Riya tomorrow 1pm')" },
      },
    },
  },
  {
    name: "meet_create_now",
    description:
      "Create an instant Google Meet link for an immediate call. Returns a meet.google.com URL Meera can share.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Meeting title (default 'Quick chat')" },
        durationMinutes: { type: "integer", description: "Default 30" },
      },
    },
  },

  // ── Tasks (to-do list) ───────────────────────────────────────────────
  {
    name: "tasks_list",
    description: "List Meera's pending Google Tasks (her personal to-do list).",
    parameters: {
      type: "object",
      properties: { max: { type: "integer", description: "Max items (default 10)" } },
    },
  },
  {
    name: "tasks_add",
    description: "Add a new item to Meera's Google Tasks (her to-do list).",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        notes: { type: "string" },
        dueISO: { type: "string", description: "Optional ISO due date" },
      },
      required: ["title"],
    },
  },
  {
    name: "tasks_complete",
    description: "Mark one of Meera's tasks as completed by task ID (from tasks_list).",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },

  // ── Contacts (People API) ────────────────────────────────────────────
  {
    name: "contacts_search",
    description:
      "Search Meera's Google Contacts by name, email, or phone fragment. Returns matching contacts with their details.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        max: { type: "integer", description: "Max results (default 5)" },
      },
      required: ["query"],
    },
  },

  // ── Drive ────────────────────────────────────────────────────────────
  {
    name: "drive_search",
    description:
      "Search files in Meera's Google Drive by name or content keyword. Returns name, type, link, modified date.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        max: { type: "integer", description: "Max results (default 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "drive_recent",
    description: "List Meera's most recently modified Drive files.",
    parameters: {
      type: "object",
      properties: { max: { type: "integer", description: "Default 5" } },
    },
  },

  // ── Calendar advanced ────────────────────────────────────────────────
  {
    name: "calendar_update_event",
    description:
      "Update / reschedule one of Meera's existing calendar events. Pass eventId from calendar_today/calendar_upcoming, plus only the fields to change.",
    parameters: {
      type: "object",
      properties: {
        eventId: { type: "string" },
        title: { type: "string" },
        startISO: { type: "string" },
        endISO: { type: "string" },
        description: { type: "string" },
        location: { type: "string" },
      },
      required: ["eventId"],
    },
  },
  {
    name: "calendar_delete_event",
    description:
      "Delete / cancel one of Meera's calendar events by eventId. Use when she wants to cancel something.",
    parameters: {
      type: "object",
      properties: { eventId: { type: "string" } },
      required: ["eventId"],
    },
  },
  {
    name: "calendar_find_free_slot",
    description:
      "Find the next free slot of `durationMinutes` in Meera's calendar within the next `withinDays` days (between her preferred hours). Returns suggested startISO/endISO. Useful before scheduling something.",
    parameters: {
      type: "object",
      properties: {
        durationMinutes: { type: "integer", description: "Default 30" },
        withinDays: { type: "integer", description: "Default 3" },
        earliestHour: { type: "integer", description: "Default 10 (10am)" },
        latestHour: { type: "integer", description: "Default 21 (9pm)" },
      },
    },
  },

  // ── Gmail advanced ───────────────────────────────────────────────────
  {
    name: "gmail_reply",
    description:
      "Reply to a specific Gmail message (uses the original thread). Only call when user explicitly asks Meera to reply.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Original message ID from gmail_check_inbox" },
        body: { type: "string", description: "Reply body in Meera's voice" },
      },
      required: ["messageId", "body"],
    },
  },
  {
    name: "gmail_label",
    description:
      "Modify Gmail labels: mark read/unread, archive (remove INBOX), star/unstar, or trash. Use action keywords: 'read'|'unread'|'archive'|'star'|'unstar'|'trash'.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string" },
        action: {
          type: "string",
          description: "One of: read, unread, archive, star, unstar, trash",
        },
      },
      required: ["messageId", "action"],
    },
  },

  // ── Drive write / share ──────────────────────────────────────────────
  {
    name: "drive_create_doc",
    description:
      "Create a new Google Doc in Meera's Drive with the given title and plain-text content. Returns the doc URL she can share.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        folderName: { type: "string", description: "Optional Drive folder name (created if missing)" },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "drive_share_file",
    description:
      "Make a Drive file shareable via link (anyone with link can view) and return the URL. Pass fileId from drive_search/drive_recent.",
    parameters: {
      type: "object",
      properties: { fileId: { type: "string" } },
      required: ["fileId"],
    },
  },
  {
    name: "drive_save_image_url",
    description:
      "Download an image from a public URL and save it to Meera's Drive (optionally inside a named folder). Use when she wants to keep a photo as a memory.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        name: { type: "string", description: "Filename (default auto)" },
        folderName: { type: "string", description: "Optional folder (created if missing)" },
      },
      required: ["url"],
    },
  },
  {
    name: "drive_delete",
    description: "Move a Drive file to trash by fileId.",
    parameters: {
      type: "object",
      properties: { fileId: { type: "string" } },
      required: ["fileId"],
    },
  },

  // ── Google Photos ────────────────────────────────────────────────────
  {
    name: "photos_recent",
    description:
      "List the photos/videos Meera has saved to her Google Photos through the bot (her bot-side memory roll). Returns id + URL + filename.",
    parameters: {
      type: "object",
      properties: { max: { type: "integer", description: "Default 5, max 25" } },
    },
  },
  {
    name: "photos_search",
    description:
      "(Deprecated) Returns the same items as photos_recent. Google Photos no longer lets new apps search the user's full library — only items the app uploaded itself are visible.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", description: "Ignored (kept for compatibility)" },
        max: { type: "integer", description: "Default 5" },
      },
    },
  },

  // ── Contacts write ───────────────────────────────────────────────────
  {
    name: "contacts_add",
    description: "Add a new contact to Meera's Google Contacts.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        note: { type: "string" },
      },
      required: ["name"],
    },
  },

  // ── Tasks delete (cleanup) ───────────────────────────────────────────
  {
    name: "tasks_delete",
    description: "Delete a task from Meera's to-do list (by taskId from tasks_list).",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },

  // ── Google Photos (write & edit) ─────────────────────────────────────
  {
    name: "photos_upload_url",
    description:
      "Download a photo OR video from a public URL and save it to Meera's Google Photos library (her camera roll). Optionally caption it and drop it into an album. Use this for personal/memory media — selfies, moments, snaps. For documents/files use Drive instead.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public URL of the photo or video" },
        description: { type: "string", description: "Optional caption / description" },
        filename: { type: "string", description: "Optional filename" },
        albumId: { type: "string", description: "Optional album ID to add it to (from photos_list_albums)" },
      },
      required: ["url"],
    },
  },
  {
    name: "photos_list_albums",
    description: "List the albums in Meera's Google Photos that this bot has created.",
    parameters: {
      type: "object",
      properties: { max: { type: "integer", description: "Default 10" } },
    },
  },
  {
    name: "photos_create_album",
    description:
      "Create a new album in Meera's Google Photos. Use when she wants to start a new memory collection (e.g. 'College Trip 2026').",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "photos_add_to_album",
    description:
      "Add an existing media item (from photos_recent / photos_upload_url) to one of Meera's albums.",
    parameters: {
      type: "object",
      properties: {
        albumId: { type: "string" },
        mediaItemIds: {
          type: "array",
          items: { type: "string" },
          description: "One or more media item IDs",
        },
      },
      required: ["albumId", "mediaItemIds"],
    },
  },
  {
    name: "photos_describe",
    description:
      "Update / edit the description (caption) of a media item in Meera's Google Photos. Only works on items the bot has uploaded itself.",
    parameters: {
      type: "object",
      properties: {
        mediaItemId: { type: "string" },
        description: { type: "string" },
      },
      required: ["mediaItemId", "description"],
    },
  },

  // ── Calendar advanced: RSVP / reminders ──────────────────────────────
  {
    name: "calendar_rsvp",
    description:
      "Respond to an event Meera was invited to. action one of: accept | decline | tentative. Pass eventId from calendar_today / calendar_upcoming.",
    parameters: {
      type: "object",
      properties: {
        eventId: { type: "string" },
        action: { type: "string", description: "accept | decline | tentative" },
        comment: { type: "string", description: "Optional comment to send back" },
      },
      required: ["eventId", "action"],
    },
  },
  {
    name: "calendar_set_reminders",
    description:
      "Set custom reminders on one of Meera's calendar events (overrides defaults). Pass minutes-before for popup and/or email reminders.",
    parameters: {
      type: "object",
      properties: {
        eventId: { type: "string" },
        popupMinutes: { type: "integer", description: "Minutes before event for popup reminder" },
        emailMinutes: { type: "integer", description: "Minutes before event for email reminder" },
      },
      required: ["eventId"],
    },
  },

  // ── Tasks advanced ───────────────────────────────────────────────────
  {
    name: "tasks_set_due",
    description: "Set or change the due date on one of Meera's tasks (taskId from tasks_list).",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        dueISO: { type: "string", description: "ISO datetime; pass empty string to clear" },
      },
      required: ["taskId", "dueISO"],
    },
  },

  // ── Contacts update ──────────────────────────────────────────────────
  {
    name: "contacts_update",
    description:
      "Update fields on an existing Google Contact. resourceName comes from contacts_search (e.g. 'people/c1234'). Only the fields you pass will be updated.",
    parameters: {
      type: "object",
      properties: {
        resourceName: { type: "string", description: "Contact resourceName like 'people/c123'" },
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        note: { type: "string" },
      },
      required: ["resourceName"],
    },
  },

  // ── Gmail: smart reply draft ─────────────────────────────────────────
  {
    name: "gmail_draft_reply",
    description:
      "Compose a draft reply (NOT sent yet) to a Gmail message and save it as a Gmail draft. Returns draft id + suggested body. Use this when Meera wants to suggest a reply for the user to approve before sending.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string" },
        body: { type: "string", description: "Suggested reply body" },
      },
      required: ["messageId", "body"],
    },
  },

  // ── YouTube (read-only) ──────────────────────────────────────────────
  {
    name: "youtube_subscriptions",
    description: "List the YouTube channels Meera is subscribed to.",
    parameters: {
      type: "object",
      properties: { max: { type: "integer", description: "Default 10, max 25" } },
    },
  },
  {
    name: "youtube_liked",
    description: "List videos Meera has liked on YouTube (most recent first).",
    parameters: {
      type: "object",
      properties: { max: { type: "integer", description: "Default 10, max 25" } },
    },
  },
  {
    name: "youtube_history",
    description:
      "Best-effort recent watch history (YouTube no longer exposes this directly — falls back to her 'Watch later' playlist).",
    parameters: {
      type: "object",
      properties: { max: { type: "integer", description: "Default 10" } },
    },
  },
  {
    name: "youtube_playlists",
    description: "List Meera's own YouTube playlists.",
    parameters: {
      type: "object",
      properties: { max: { type: "integer", description: "Default 10" } },
    },
  },
  {
    name: "youtube_video_info",
    description:
      "Fetch metadata about any YouTube video (title, channel, description, duration, views, likes, tags, publish date) given a URL or video ID. Use this when the user shares a YouTube link and Meera wants to react / review it naturally.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full YouTube URL OR video ID" },
      },
      required: ["url"],
    },
  },
  {
    name: "youtube_channel_info",
    description:
      "Fetch metadata about a YouTube channel (title, subs, video count, description) by channelId or @handle or channel URL.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID, @handle, or full channel URL" },
      },
      required: ["channel"],
    },
  },
  {
    name: "youtube_search",
    description:
      "Search public YouTube videos by query. Returns top results (title, channel, videoId, url, publishedAt). Use when Meera wants to find or recommend something.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        max: { type: "integer", description: "Default 5, max 20" },
      },
      required: ["query"],
    },
  },
  {
    name: "youtube_subscriptions_feed",
    description:
      "Get the most recent videos uploaded by channels Meera is subscribed to. This is her 'home feed' — useful for background activity and natural sharing.",
    parameters: {
      type: "object",
      properties: { max: { type: "integer", description: "Default 10, max 25" } },
    },
  },
  {
    name: "youtube_subscribe",
    description:
      "Subscribe Meera to a YouTube channel by channelId. Use when she watches a video and wants to follow that creator.",
    parameters: {
      type: "object",
      properties: { channelId: { type: "string" } },
      required: ["channelId"],
    },
  },
  {
    name: "youtube_unsubscribe",
    description: "Unsubscribe Meera from a YouTube channel (subscriptionId from youtube_subscriptions).",
    parameters: {
      type: "object",
      properties: { subscriptionId: { type: "string" } },
      required: ["subscriptionId"],
    },
  },
  {
    name: "youtube_like_video",
    description: "Like a YouTube video (Meera presses 👍). Pass video URL or ID.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "Video URL or ID" } },
      required: ["url"],
    },
  },
  {
    name: "youtube_dislike_video",
    description: "Dislike a YouTube video. Use sparingly — only when she genuinely doesn't like it.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "youtube_remove_rating",
    description: "Remove Meera's like/dislike from a video (back to neutral).",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "youtube_comment",
    description:
      "Post a top-level comment on a YouTube video as Meera. Keep it short, casual, in her voice. Don't spam — only when there's a genuine reaction.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Video URL or ID" },
        text: { type: "string", description: "Comment body in Meera's voice" },
      },
      required: ["url", "text"],
    },
  },
  {
    name: "youtube_reply_comment",
    description:
      "Reply to an existing YouTube comment thread. parentId is the commentThread or comment id.",
    parameters: {
      type: "object",
      properties: {
        parentId: { type: "string" },
        text: { type: "string" },
      },
      required: ["parentId", "text"],
    },
  },
  {
    name: "youtube_mark_watched",
    description:
      "Add a video to Meera's private 'Watched' playlist — her simulated watch history. Use this whenever she 'watches' something so we have a real record. Pass video URL or ID, plus an optional one-line vibe tag (Meera's reaction).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        vibe: { type: "string", description: "Optional 1-line note about what she felt" },
      },
      required: ["url"],
    },
  },
  {
    name: "youtube_recent_watched",
    description: "List the videos Meera has 'watched' recently (from her Watched playlist).",
    parameters: {
      type: "object",
      properties: { max: { type: "integer", description: "Default 5, max 20" } },
    },
  },
  {
    name: "youtube_upload_video",
    description:
      "Upload a video to Meera's own YouTube channel. Source can be a public URL OR a local file path. Privacy default: 'private' — she can change to 'public' or 'unlisted' if asked.",
    parameters: {
      type: "object",
      properties: {
        sourceUrl: { type: "string", description: "Public URL of the video file" },
        sourcePath: { type: "string", description: "Absolute local file path (alternative to sourceUrl)" },
        title: { type: "string" },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        privacy: { type: "string", description: "private | unlisted | public (default private)" },
      },
      required: ["title"],
    },
  },

  // ── Notes (lightweight diary kept inside one Drive Doc) ──────────────
  {
    name: "notes_add",
    description:
      "Append a quick note (one or two lines) to Meera's running notes doc in Drive. Like a Keep note. Each entry is timestamped automatically.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "notes_recent",
    description: "Read the last N lines of Meera's notes doc.",
    parameters: {
      type: "object",
      properties: { lines: { type: "integer", description: "Default 10, max 50" } },
    },
  },

  // ── Fitness (Google Fit) ─────────────────────────────────────────────
  {
    name: "fitness_today",
    description:
      "Read Meera's Google Fit data for today (steps, distance in km, active minutes, calories). Useful to ground 'how active was she today?' replies.",
    parameters: { type: "object", properties: {} },
  },

  // ── Account helper ───────────────────────────────────────────────────
  {
    name: "google_account_info",
    description:
      "Returns Meera's own Google account email, display name, and timezone. Useful when the LLM needs to confirm whose account it is acting on.",
    parameters: { type: "object", properties: {} },
  },
];

// ───────────────────────────────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────────────────────────────

function need<T>(v: T | undefined | null, name: string): T {
  if (v === undefined || v === null || v === "") {
    throw new Error(`Missing required argument: ${name}`);
  }
  return v;
}

function notConfigured() {
  return {
    success: false,
    message:
      "Meera's Google account isn't connected yet. Run `npm run auth:google` and set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN in .env.",
  };
}

function decodeB64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function encodeB64Url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ───────────────────────────────────────────────────────────────────────
// GMAIL
// ───────────────────────────────────────────────────────────────────────

interface GmailMessageRef { id: string; threadId: string }
interface GmailListResponse { messages?: GmailMessageRef[]; resultSizeEstimate?: number }
interface GmailHeader { name: string; value: string }
interface GmailPayload {
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPayload[];
  mimeType?: string;
}
interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailPayload;
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  if (!headers) return "";
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function extractGmailBody(payload: GmailPayload | undefined): string {
  if (!payload) return "";
  if (payload.body?.data) return decodeB64Url(payload.body.data);
  if (payload.parts) {
    // Prefer text/plain
    const plain = payload.parts.find((p) => p.mimeType === "text/plain");
    if (plain?.body?.data) return decodeB64Url(plain.body.data);
    for (const p of payload.parts) {
      const sub = extractGmailBody(p);
      if (sub) return sub;
    }
  }
  return "";
}

async function gmailCheckInbox(args: { max?: number; onlyUnread?: boolean }) {
  const max = Math.min(Math.max(args.max ?? 5, 1), 15);
  const onlyUnread = args.onlyUnread !== false;
  const q = onlyUnread ? "is:unread in:inbox" : "in:inbox";
  const list = await googleJson<GmailListResponse>(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(q)}`
  );
  if (!list.messages?.length) {
    return { success: true, count: 0, emails: [], message: onlyUnread ? "No unread emails." : "No emails found." };
  }
  const emails = await Promise.all(
    list.messages.slice(0, max).map(async (m) => {
      const msg = await googleJson<GmailMessage>(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
      );
      return {
        id: msg.id,
        from: headerValue(msg.payload?.headers, "From"),
        subject: headerValue(msg.payload?.headers, "Subject") || "(no subject)",
        date: headerValue(msg.payload?.headers, "Date"),
        snippet: msg.snippet ?? "",
        unread: msg.labelIds?.includes("UNREAD") ?? false,
      };
    })
  );
  return { success: true, count: emails.length, emails };
}

async function gmailSearch(args: { query: string; max?: number }) {
  const max = Math.min(Math.max(args.max ?? 5, 1), 15);
  const list = await googleJson<GmailListResponse>(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(args.query)}`
  );
  if (!list.messages?.length) return { success: true, count: 0, emails: [], message: "No matches." };
  const emails = await Promise.all(
    list.messages.map(async (m) => {
      const msg = await googleJson<GmailMessage>(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
      );
      return {
        id: msg.id,
        from: headerValue(msg.payload?.headers, "From"),
        subject: headerValue(msg.payload?.headers, "Subject") || "(no subject)",
        date: headerValue(msg.payload?.headers, "Date"),
        snippet: msg.snippet ?? "",
      };
    })
  );
  return { success: true, count: emails.length, emails };
}

async function gmailRead(args: { messageId: string }) {
  const id = need(args.messageId, "messageId");
  const msg = await googleJson<GmailMessage>(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`
  );
  const body = extractGmailBody(msg.payload).slice(0, 4000);
  return {
    success: true,
    id: msg.id,
    from: headerValue(msg.payload?.headers, "From"),
    to: headerValue(msg.payload?.headers, "To"),
    subject: headerValue(msg.payload?.headers, "Subject") || "(no subject)",
    date: headerValue(msg.payload?.headers, "Date"),
    body,
    snippet: msg.snippet ?? "",
  };
}

async function gmailSend(args: { to: string; subject: string; body: string; cc?: string }) {
  const to = need(args.to, "to");
  const subject = args.subject ?? "(no subject)";
  const body = args.body ?? "";
  const acct = getAccountInfo();
  const fromHeader = acct.name ? `${acct.name} <${acct.email}>` : acct.email;

  const headers = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    args.cc ? `Cc: ${args.cc}` : "",
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
  ].filter(Boolean);
  const raw = encodeB64Url(`${headers.join("\r\n")}\r\n\r\n${body}`);

  const sent = await googleJson<{ id: string; threadId: string }>(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    { method: "POST", body: JSON.stringify({ raw }) }
  );
  return { success: true, id: sent.id, message: `Email sent to ${to}.` };
}

// ───────────────────────────────────────────────────────────────────────
// CALENDAR / MEET
// ───────────────────────────────────────────────────────────────────────

interface CalEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email: string; responseStatus?: string }[];
  hangoutLink?: string;
  htmlLink?: string;
  conferenceData?: { entryPoints?: { uri?: string; entryPointType?: string }[] };
}

function startOfTodayISO(tz: string): { startISO: string; endISO: string } {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

function summarizeEvent(e: CalEvent, tz: string) {
  const startStr = e.start?.dateTime ?? e.start?.date ?? "";
  const endStr = e.end?.dateTime ?? e.end?.date ?? "";
  const meetLink =
    e.hangoutLink ?? e.conferenceData?.entryPoints?.find((x) => x.entryPointType === "video")?.uri ?? "";
  return {
    id: e.id,
    title: e.summary ?? "(no title)",
    start: startStr,
    end: endStr,
    location: e.location ?? "",
    meetLink,
    link: e.htmlLink ?? "",
    attendees: e.attendees?.map((a) => a.email) ?? [],
  };
}

async function calendarList(timeMinISO: string, timeMaxISO: string, max: number) {
  const params = new URLSearchParams({
    timeMin: timeMinISO,
    timeMax: timeMaxISO,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(max),
  });
  const data = await googleJson<{ items?: CalEvent[] }>(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`
  );
  return data.items ?? [];
}

async function calendarToday() {
  const tz = getAccountInfo().timezone;
  const { startISO, endISO } = startOfTodayISO(tz);
  const items = await calendarList(startISO, endISO, 20);
  return {
    success: true,
    count: items.length,
    events: items.map((e) => summarizeEvent(e, tz)),
  };
}

async function calendarUpcoming(args: { days?: number; max?: number }) {
  const days = Math.min(Math.max(args.days ?? 7, 1), 30);
  const max = Math.min(Math.max(args.max ?? 10, 1), 25);
  const tz = getAccountInfo().timezone;
  const now = new Date();
  const end = new Date(now.getTime() + days * 86400000);
  const items = await calendarList(now.toISOString(), end.toISOString(), max);
  return {
    success: true,
    count: items.length,
    days,
    events: items.map((e) => summarizeEvent(e, tz)),
  };
}

async function calendarCreateEvent(args: {
  title?: string;
  startISO?: string;
  endISO?: string;
  description?: string;
  location?: string;
  attendees?: string[];
  withMeet?: boolean;
  quickAdd?: string;
}) {
  const tz = getAccountInfo().timezone;

  // QuickAdd path — natural language
  if (args.quickAdd && !args.startISO) {
    const params = new URLSearchParams({ text: args.quickAdd });
    const ev = await googleJson<CalEvent>(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/quickAdd?${params}`,
      { method: "POST" }
    );
    return { success: true, event: summarizeEvent(ev, tz), message: "Event added (quickAdd)." };
  }

  const title = args.title ?? "Untitled";
  const startISO = need(args.startISO, "startISO");
  const start = new Date(startISO);
  if (Number.isNaN(start.getTime())) throw new Error("Invalid startISO");
  const endISO = args.endISO ?? new Date(start.getTime() + 30 * 60_000).toISOString();

  const body: Record<string, unknown> = {
    summary: title,
    description: args.description,
    location: args.location,
    start: { dateTime: startISO, timeZone: tz },
    end: { dateTime: endISO, timeZone: tz },
  };
  if (args.attendees?.length) {
    body.attendees = args.attendees.map((email) => ({ email }));
  }

  let url = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
  if (args.withMeet) {
    url += "?conferenceDataVersion=1";
    body.conferenceData = {
      createRequest: {
        requestId: `meera-${Date.now()}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }
  const ev = await googleJson<CalEvent>(url, { method: "POST", body: JSON.stringify(body) });
  return { success: true, event: summarizeEvent(ev, tz), message: "Event created." };
}

async function meetCreateNow(args: { title?: string; durationMinutes?: number }) {
  const title = args.title ?? "Quick chat";
  const duration = Math.min(Math.max(args.durationMinutes ?? 30, 5), 240);
  const start = new Date();
  const end = new Date(start.getTime() + duration * 60_000);
  const result = await calendarCreateEvent({
    title,
    startISO: start.toISOString(),
    endISO: end.toISOString(),
    withMeet: true,
  });
  if (!result.success) return result;
  const link = result.event?.meetLink || "";
  return {
    success: true,
    meetLink: link,
    eventId: result.event?.id,
    message: link ? `Meet link ready: ${link}` : "Created but no Meet link returned.",
  };
}

// ───────────────────────────────────────────────────────────────────────
// TASKS
// ───────────────────────────────────────────────────────────────────────

interface TaskItem { id: string; title: string; notes?: string; due?: string; status?: string; updated?: string }

async function defaultTaskListId(): Promise<string> {
  const data = await googleJson<{ items?: { id: string }[] }>(
    "https://tasks.googleapis.com/tasks/v1/users/@me/lists"
  );
  const id = data.items?.[0]?.id;
  if (!id) throw new Error("No task lists on this account");
  return id;
}

async function tasksList(args: { max?: number }) {
  const max = Math.min(Math.max(args.max ?? 10, 1), 30);
  const listId = await defaultTaskListId();
  const data = await googleJson<{ items?: TaskItem[] }>(
    `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks?showCompleted=false&maxResults=${max}`
  );
  const items = (data.items ?? []).map((t) => ({
    id: t.id,
    title: t.title,
    notes: t.notes ?? "",
    due: t.due ?? "",
    status: t.status ?? "needsAction",
  }));
  return { success: true, count: items.length, tasks: items };
}

async function tasksAdd(args: { title: string; notes?: string; dueISO?: string }) {
  const title = need(args.title, "title");
  const listId = await defaultTaskListId();
  const body: Record<string, unknown> = { title };
  if (args.notes) body.notes = args.notes;
  if (args.dueISO) body.due = args.dueISO;
  const t = await googleJson<TaskItem>(
    `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks`,
    { method: "POST", body: JSON.stringify(body) }
  );
  return { success: true, taskId: t.id, message: `Task added: ${t.title}` };
}

async function tasksComplete(args: { taskId: string }) {
  const taskId = need(args.taskId, "taskId");
  const listId = await defaultTaskListId();
  await googleJson(
    `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
    { method: "PATCH", body: JSON.stringify({ status: "completed" }) }
  );
  return { success: true, message: "Task marked complete." };
}

// ───────────────────────────────────────────────────────────────────────
// PEOPLE / CONTACTS
// ───────────────────────────────────────────────────────────────────────

interface PeopleSearchHit {
  person?: {
    resourceName?: string;
    names?: { displayName?: string }[];
    emailAddresses?: { value?: string }[];
    phoneNumbers?: { value?: string }[];
    organizations?: { name?: string; title?: string }[];
  };
}

async function contactsSearch(args: { query: string; max?: number }) {
  const query = need(args.query, "query");
  const max = Math.min(Math.max(args.max ?? 5, 1), 15);
  // People API requires a warm-up call with empty query before first real search.
  await googleFetch(
    "https://people.googleapis.com/v1/people:searchContacts?query=&readMask=names"
  ).catch(() => {});
  const params = new URLSearchParams({
    query,
    pageSize: String(max),
    readMask: "names,emailAddresses,phoneNumbers,organizations",
  });
  const data = await googleJson<{ results?: PeopleSearchHit[] }>(
    `https://people.googleapis.com/v1/people:searchContacts?${params}`
  );
  const contacts = (data.results ?? []).map((r) => {
    const p = r.person ?? {};
    return {
      name: p.names?.[0]?.displayName ?? "",
      email: p.emailAddresses?.[0]?.value ?? "",
      phone: p.phoneNumbers?.[0]?.value ?? "",
      org: p.organizations?.[0]?.name ?? "",
      title: p.organizations?.[0]?.title ?? "",
    };
  });
  return { success: true, count: contacts.length, contacts };
}

// ───────────────────────────────────────────────────────────────────────
// DRIVE
// ───────────────────────────────────────────────────────────────────────

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
}

async function driveSearch(args: { query: string; max?: number }) {
  const query = need(args.query, "query");
  const max = Math.min(Math.max(args.max ?? 5, 1), 20);
  const escaped = query.replace(/'/g, "\\'");
  const q = `(name contains '${escaped}' or fullText contains '${escaped}') and trashed=false`;
  const params = new URLSearchParams({
    q,
    pageSize: String(max),
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
    orderBy: "modifiedTime desc",
  });
  const data = await googleJson<{ files?: DriveFile[] }>(
    `https://www.googleapis.com/drive/v3/files?${params}`
  );
  return { success: true, count: data.files?.length ?? 0, files: data.files ?? [] };
}

async function driveRecent(args: { max?: number }) {
  const max = Math.min(Math.max(args.max ?? 5, 1), 20);
  const params = new URLSearchParams({
    pageSize: String(max),
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
    orderBy: "modifiedTime desc",
    q: "trashed=false",
  });
  const data = await googleJson<{ files?: DriveFile[] }>(
    `https://www.googleapis.com/drive/v3/files?${params}`
  );
  return { success: true, count: data.files?.length ?? 0, files: data.files ?? [] };
}

// ───────────────────────────────────────────────────────────────────────
// CALENDAR — update / delete / find-free-slot
// ───────────────────────────────────────────────────────────────────────

async function calendarUpdateEvent(args: {
  eventId: string;
  title?: string;
  startISO?: string;
  endISO?: string;
  description?: string;
  location?: string;
}) {
  const eventId = need(args.eventId, "eventId");
  const tz = getAccountInfo().timezone;
  const patch: Record<string, unknown> = {};
  if (args.title !== undefined) patch.summary = args.title;
  if (args.description !== undefined) patch.description = args.description;
  if (args.location !== undefined) patch.location = args.location;
  if (args.startISO) patch.start = { dateTime: args.startISO, timeZone: tz };
  if (args.endISO) patch.end = { dateTime: args.endISO, timeZone: tz };
  const ev = await googleJson<CalEvent>(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
    { method: "PATCH", body: JSON.stringify(patch) }
  );
  return { success: true, event: summarizeEvent(ev, tz), message: "Event updated." };
}

async function calendarDeleteEvent(args: { eventId: string }) {
  const eventId = need(args.eventId, "eventId");
  await googleFetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" }
  );
  return { success: true, message: "Event deleted." };
}

async function calendarFindFreeSlot(args: {
  durationMinutes?: number;
  withinDays?: number;
  earliestHour?: number;
  latestHour?: number;
}) {
  const dur = Math.min(Math.max(args.durationMinutes ?? 30, 15), 480);
  const within = Math.min(Math.max(args.withinDays ?? 3, 1), 14);
  const eHour = Math.min(Math.max(args.earliestHour ?? 10, 0), 23);
  const lHour = Math.min(Math.max(args.latestHour ?? 21, eHour + 1), 24);
  const tz = getAccountInfo().timezone;
  const now = new Date();
  const horizon = new Date(now.getTime() + within * 86400000);
  const items = await calendarList(now.toISOString(), horizon.toISOString(), 50);
  // Build busy ranges
  const busy = items
    .map((e) => ({
      start: new Date(e.start?.dateTime ?? e.start?.date ?? 0).getTime(),
      end: new Date(e.end?.dateTime ?? e.end?.date ?? 0).getTime(),
    }))
    .filter((b) => b.end > now.getTime())
    .sort((a, b) => a.start - b.start);
  // Walk minute slots in 15-min steps
  const stepMs = 15 * 60_000;
  const durMs = dur * 60_000;
  let cursor = Math.ceil(now.getTime() / stepMs) * stepMs;
  while (cursor + durMs <= horizon.getTime()) {
    const c = new Date(cursor);
    const hr = c.getHours();
    if (hr < eHour || hr >= lHour) {
      cursor += stepMs;
      continue;
    }
    const slotEnd = cursor + durMs;
    const conflict = busy.some((b) => !(slotEnd <= b.start || cursor >= b.end));
    if (!conflict) {
      return {
        success: true,
        startISO: new Date(cursor).toISOString(),
        endISO: new Date(slotEnd).toISOString(),
        durationMinutes: dur,
        timezone: tz,
      };
    }
    cursor += stepMs;
  }
  return { success: false, message: `No free ${dur}-minute slot in the next ${within} days.` };
}

// ───────────────────────────────────────────────────────────────────────
// GMAIL — reply / label
// ───────────────────────────────────────────────────────────────────────

async function gmailReply(args: { messageId: string; body: string }) {
  const messageId = need(args.messageId, "messageId");
  const body = need(args.body, "body");
  // Fetch original headers for In-Reply-To, References, Subject, From
  const orig = await googleJson<GmailMessage>(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=Message-Id&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=References`
  );
  const origMessageId = headerValue(orig.payload?.headers, "Message-Id");
  const origFrom = headerValue(orig.payload?.headers, "From");
  const origSubject = headerValue(orig.payload?.headers, "Subject") || "(no subject)";
  const origRefs = headerValue(orig.payload?.headers, "References");
  const acct = getAccountInfo();
  const fromHeader = acct.name ? `${acct.name} <${acct.email}>` : acct.email;
  const replySubject = origSubject.toLowerCase().startsWith("re:") ? origSubject : `Re: ${origSubject}`;
  const refs = origRefs ? `${origRefs} ${origMessageId}` : origMessageId;
  const headers = [
    `From: ${fromHeader}`,
    `To: ${origFrom}`,
    `Subject: ${replySubject}`,
    origMessageId ? `In-Reply-To: ${origMessageId}` : "",
    refs ? `References: ${refs}` : "",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
  ].filter(Boolean);
  const raw = encodeB64Url(`${headers.join("\r\n")}\r\n\r\n${body}`);
  const sent = await googleJson<{ id: string }>(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    { method: "POST", body: JSON.stringify({ raw, threadId: orig.threadId }) }
  );
  return { success: true, id: sent.id, message: `Reply sent to ${origFrom}.` };
}

async function gmailLabel(args: { messageId: string; action: string }) {
  const messageId = need(args.messageId, "messageId");
  const action = need(args.action, "action").toLowerCase();
  if (action === "trash") {
    await googleFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/trash`,
      { method: "POST" }
    );
    return { success: true, message: "Moved to trash." };
  }
  let addLabelIds: string[] = [];
  let removeLabelIds: string[] = [];
  switch (action) {
    case "read": removeLabelIds = ["UNREAD"]; break;
    case "unread": addLabelIds = ["UNREAD"]; break;
    case "archive": removeLabelIds = ["INBOX"]; break;
    case "star": addLabelIds = ["STARRED"]; break;
    case "unstar": removeLabelIds = ["STARRED"]; break;
    default: throw new Error(`Unknown label action: ${action}`);
  }
  await googleJson(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    { method: "POST", body: JSON.stringify({ addLabelIds, removeLabelIds }) }
  );
  return { success: true, message: `Email marked ${action}.` };
}

// ───────────────────────────────────────────────────────────────────────
// DRIVE — create doc / share / save image / delete / folder helper
// ───────────────────────────────────────────────────────────────────────

/** Find or create a Drive folder by name (under root). Returns folder ID. */
export async function ensureDriveFolder(name: string): Promise<string> {
  const safe = name.replace(/'/g, "\\'");
  const q = `name='${safe}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: "1" });
  const found = await googleJson<{ files?: { id: string }[] }>(
    `https://www.googleapis.com/drive/v3/files?${params}`
  );
  if (found.files?.[0]?.id) return found.files[0].id;
  const created = await googleJson<{ id: string }>(
    "https://www.googleapis.com/drive/v3/files",
    {
      method: "POST",
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
      }),
    }
  );
  return created.id;
}

/** Multipart upload helper for Drive. */
async function driveMultipartUpload(
  metadata: Record<string, unknown>,
  body: Buffer,
  mimeType: string
): Promise<{ id: string; name: string; webViewLink?: string }> {
  const boundary = `meera-boundary-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const head =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const payload = Buffer.concat([Buffer.from(head, "utf8"), body, Buffer.from(tail, "utf8")]);
  return googleJson<{ id: string; name: string; webViewLink?: string }>(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: payload,
    }
  );
}

async function driveCreateDoc(args: { title: string; content: string; folderName?: string }) {
  const title = need(args.title, "title");
  const content = args.content ?? "";
  const parents: string[] = [];
  if (args.folderName) parents.push(await ensureDriveFolder(args.folderName));
  const meta: Record<string, unknown> = {
    name: title,
    mimeType: "application/vnd.google-apps.document",
  };
  if (parents.length) meta.parents = parents;
  const file = await driveMultipartUpload(meta, Buffer.from(content, "utf8"), "text/plain");
  const link = file.webViewLink || `https://docs.google.com/document/d/${file.id}/edit`;
  return { success: true, fileId: file.id, link, message: `Doc created: ${title}` };
}

async function driveShareFile(args: { fileId: string }) {
  const fileId = need(args.fileId, "fileId");
  await googleJson(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
    {
      method: "POST",
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    }
  );
  const meta = await googleJson<{ webViewLink?: string; name?: string }>(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=webViewLink,name`
  );
  return {
    success: true,
    link: meta.webViewLink ?? `https://drive.google.com/file/d/${fileId}/view`,
    name: meta.name,
    message: "Shareable link ready.",
  };
}

async function driveSaveImageUrl(args: { url: string; name?: string; folderName?: string }) {
  const url = need(args.url, "url");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch image (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get("content-type") || "image/jpeg";
  const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : ct.includes("gif") ? "gif" : "jpg";
  const filename = args.name || `meera-${new Date().toISOString().slice(0, 10)}-${Date.now()}.${ext}`;
  const parents: string[] = [];
  if (args.folderName) parents.push(await ensureDriveFolder(args.folderName));
  const meta: Record<string, unknown> = { name: filename };
  if (parents.length) meta.parents = parents;
  const file = await driveMultipartUpload(meta, buf, ct);
  return { success: true, fileId: file.id, name: file.name, link: file.webViewLink, message: "Saved to Drive." };
}

async function driveDelete(args: { fileId: string }) {
  const fileId = need(args.fileId, "fileId");
  await googleJson(
    `https://www.googleapis.com/drive/v3/files/${fileId}`,
    { method: "PATCH", body: JSON.stringify({ trashed: true }) }
  );
  return { success: true, message: "File moved to trash." };
}

// ───────────────────────────────────────────────────────────────────────
// GOOGLE PHOTOS (Library API, read-only)
// ───────────────────────────────────────────────────────────────────────

interface PhotoMediaItem {
  id: string;
  description?: string;
  baseUrl?: string;
  mimeType?: string;
  filename?: string;
  mediaMetadata?: { creationTime?: string; width?: string; height?: string };
}

async function photosRecent(args: { max?: number }) {
  const max = Math.min(Math.max(args.max ?? 5, 1), 25);
  try {
    const data = await googleJson<{ mediaItems?: PhotoMediaItem[] }>(
      `https://photoslibrary.googleapis.com/v1/mediaItems?pageSize=${max}`
    );
    const items = (data.mediaItems ?? []).map((m) => ({
      id: m.id,
      filename: m.filename,
      mimeType: m.mimeType,
      url: m.baseUrl ? `${m.baseUrl}=w1024-h1024` : "",
      createdAt: m.mediaMetadata?.creationTime,
    }));
    return { success: true, count: items.length, photos: items };
  } catch (err: any) {
    if (String(err?.message || "").includes("403") || String(err?.message || "").toLowerCase().includes("scope")) {
      return { success: false, message: "Google Photos scope not granted yet — re-run `npm run auth:google` to enable." };
    }
    throw err;
  }
}

async function photosSearch(args: { category?: string; max?: number }) {
  // As of March 2025, content-category search requires full library access
  // which new third-party apps no longer get. Fall back to listing app-created
  // items so this tool still returns something useful.
  return photosRecent({ max: args.max });
}

// ───────────────────────────────────────────────────────────────────────
// CONTACTS — add new
// ───────────────────────────────────────────────────────────────────────

async function contactsAdd(args: { name: string; email?: string; phone?: string; note?: string }) {
  const name = need(args.name, "name");
  const body: Record<string, unknown> = {
    names: [{ givenName: name }],
  };
  if (args.email) body.emailAddresses = [{ value: args.email }];
  if (args.phone) body.phoneNumbers = [{ value: args.phone }];
  if (args.note) body.biographies = [{ value: args.note, contentType: "TEXT_PLAIN" }];
  const data = await googleJson<{ resourceName: string }>(
    "https://people.googleapis.com/v1/people:createContact",
    { method: "POST", body: JSON.stringify(body) }
  );
  return { success: true, resourceName: data.resourceName, message: `Contact saved: ${name}` };
}

// ───────────────────────────────────────────────────────────────────────
// TASKS — delete
// ───────────────────────────────────────────────────────────────────────

async function tasksDelete(args: { taskId: string }) {
  const taskId = need(args.taskId, "taskId");
  const listId = await defaultTaskListId();
  await googleFetch(
    `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
    { method: "DELETE" }
  );
  return { success: true, message: "Task deleted." };
}

// ───────────────────────────────────────────────────────────────────────
// GOOGLE PHOTOS — write / album management
// ───────────────────────────────────────────────────────────────────────

/** Upload raw bytes to Google Photos and get an upload token. */
async function photosUploadBytes(bytes: Buffer, mimeType: string, filename: string): Promise<string> {
  const res = await googleFetch("https://photoslibrary.googleapis.com/v1/uploads", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Goog-Upload-Content-Type": mimeType,
      "X-Goog-Upload-Protocol": "raw",
      "X-Goog-Upload-File-Name": filename,
    },
    body: new Uint8Array(bytes),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Photos upload bytes failed (${res.status}): ${txt.slice(0, 200)}`);
  }
  const token = (await res.text()).trim();
  if (!token) throw new Error("Photos upload returned empty token");
  return token;
}

function guessExt(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("heic")) return "heic";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("quicktime")) return "mov";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("video")) return "mp4";
  return "jpg";
}

async function photosUploadUrl(args: {
  url: string;
  description?: string;
  filename?: string;
  albumId?: string;
}) {
  const url = need(args.url, "url");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch source media (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get("content-type") || "image/jpeg";
  const ext = guessExt(mime);
  const filename = args.filename || `meera-${new Date().toISOString().slice(0, 10)}-${Date.now()}.${ext}`;

  const uploadToken = await photosUploadBytes(buf, mime, filename);

  const body: Record<string, unknown> = {
    newMediaItems: [
      {
        description: args.description ?? "",
        simpleMediaItem: { uploadToken, fileName: filename },
      },
    ],
  };
  if (args.albumId) body.albumId = args.albumId;

  const created = await googleJson<{
    newMediaItemResults?: {
      status?: { message?: string; code?: number };
      mediaItem?: { id: string; productUrl?: string; baseUrl?: string; filename?: string };
    }[];
  }>("https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const result = created.newMediaItemResults?.[0];
  const item = result?.mediaItem;
  const status = result?.status;
  if (!item) {
    return {
      success: false,
      message: status?.message || "Photos rejected the upload.",
    };
  }
  return {
    success: true,
    mediaItemId: item.id,
    productUrl: item.productUrl,
    filename: item.filename,
    message: "Saved to Google Photos.",
  };
}

async function photosListAlbums(args: { max?: number }) {
  const max = Math.min(Math.max(args.max ?? 10, 1), 50);
  const data = await googleJson<{
    albums?: { id: string; title?: string; mediaItemsCount?: string; productUrl?: string; coverPhotoBaseUrl?: string }[];
  }>(`https://photoslibrary.googleapis.com/v1/albums?pageSize=${max}`);
  const albums = (data.albums ?? []).map((a) => ({
    id: a.id,
    title: a.title ?? "",
    count: a.mediaItemsCount ?? "0",
    url: a.productUrl ?? "",
  }));
  return { success: true, count: albums.length, albums };
}

async function photosCreateAlbum(args: { title: string }) {
  const title = need(args.title, "title");
  const album = await googleJson<{ id: string; productUrl?: string; title?: string }>(
    "https://photoslibrary.googleapis.com/v1/albums",
    { method: "POST", body: JSON.stringify({ album: { title } }) }
  );
  return {
    success: true,
    albumId: album.id,
    title: album.title ?? title,
    url: album.productUrl,
    message: "Album created.",
  };
}

async function photosAddToAlbum(args: { albumId: string; mediaItemIds: string[] }) {
  const albumId = need(args.albumId, "albumId");
  const ids = args.mediaItemIds ?? [];
  if (!ids.length) throw new Error("mediaItemIds is empty");
  await googleJson(
    `https://photoslibrary.googleapis.com/v1/albums/${albumId}:batchAddMediaItems`,
    { method: "POST", body: JSON.stringify({ mediaItemIds: ids }) }
  );
  return { success: true, message: `Added ${ids.length} item(s) to album.` };
}

async function photosDescribe(args: { mediaItemId: string; description: string }) {
  const id = need(args.mediaItemId, "mediaItemId");
  const description = args.description ?? "";
  await googleJson(
    `https://photoslibrary.googleapis.com/v1/mediaItems/${id}?updateMask=description`,
    { method: "PATCH", body: JSON.stringify({ description }) }
  );
  return { success: true, message: "Caption updated." };
}

// ───────────────────────────────────────────────────────────────────────
// CALENDAR — RSVP / reminders
// ───────────────────────────────────────────────────────────────────────

async function calendarRsvp(args: { eventId: string; action: string; comment?: string }) {
  const eventId = need(args.eventId, "eventId");
  const action = need(args.action, "action").toLowerCase();
  const responseStatus =
    action === "accept" || action === "yes" ? "accepted"
    : action === "decline" || action === "no" ? "declined"
    : action === "tentative" || action === "maybe" ? "tentative"
    : null;
  if (!responseStatus) throw new Error(`Unknown RSVP action: ${action}`);

  const acct = getAccountInfo();
  // Fetch existing event to update self attendee entry.
  const ev = await googleJson<CalEvent>(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`
  );
  const attendees = (ev.attendees ?? []).map((a) => ({ ...a }));
  const meIdx = attendees.findIndex(
    (a) => a.email && a.email.toLowerCase() === acct.email.toLowerCase()
  );
  if (meIdx >= 0) {
    (attendees[meIdx] as any).responseStatus = responseStatus;
    if (args.comment) (attendees[meIdx] as any).comment = args.comment;
  } else {
    const me: any = { email: acct.email, responseStatus, self: true };
    if (args.comment) me.comment = args.comment;
    attendees.push(me);
  }
  const patched = await googleJson<CalEvent>(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
    { method: "PATCH", body: JSON.stringify({ attendees }) }
  );
  return {
    success: true,
    event: summarizeEvent(patched, acct.timezone),
    message: `RSVP set to ${responseStatus}.`,
  };
}

async function calendarSetReminders(args: {
  eventId: string;
  popupMinutes?: number;
  emailMinutes?: number;
}) {
  const eventId = need(args.eventId, "eventId");
  const overrides: { method: string; minutes: number }[] = [];
  if (typeof args.popupMinutes === "number") overrides.push({ method: "popup", minutes: args.popupMinutes });
  if (typeof args.emailMinutes === "number") overrides.push({ method: "email", minutes: args.emailMinutes });
  if (!overrides.length) throw new Error("Pass popupMinutes and/or emailMinutes");
  const ev = await googleJson<CalEvent>(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ reminders: { useDefault: false, overrides } }),
    }
  );
  return {
    success: true,
    event: summarizeEvent(ev, getAccountInfo().timezone),
    message: "Reminders updated.",
  };
}

// ───────────────────────────────────────────────────────────────────────
// TASKS — set due
// ───────────────────────────────────────────────────────────────────────

async function tasksSetDue(args: { taskId: string; dueISO: string }) {
  const taskId = need(args.taskId, "taskId");
  const listId = await defaultTaskListId();
  const body: Record<string, unknown> = {};
  if (args.dueISO) body.due = args.dueISO;
  else body.due = null; // clear
  await googleJson(
    `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
    { method: "PATCH", body: JSON.stringify(body) }
  );
  return { success: true, message: args.dueISO ? "Due date set." : "Due date cleared." };
}

// ───────────────────────────────────────────────────────────────────────
// CONTACTS — update
// ───────────────────────────────────────────────────────────────────────

async function contactsUpdate(args: {
  resourceName: string;
  name?: string;
  email?: string;
  phone?: string;
  note?: string;
}) {
  const resourceName = need(args.resourceName, "resourceName");
  // Fetch current etag (required for updateContact)
  const current = await googleJson<{ etag: string }>(
    `https://people.googleapis.com/v1/${encodeURIComponent(resourceName)}?personFields=metadata`
  );
  const updateFields: string[] = [];
  const body: Record<string, unknown> = { etag: current.etag };
  if (args.name !== undefined) {
    body.names = [{ givenName: args.name }];
    updateFields.push("names");
  }
  if (args.email !== undefined) {
    body.emailAddresses = args.email ? [{ value: args.email }] : [];
    updateFields.push("emailAddresses");
  }
  if (args.phone !== undefined) {
    body.phoneNumbers = args.phone ? [{ value: args.phone }] : [];
    updateFields.push("phoneNumbers");
  }
  if (args.note !== undefined) {
    body.biographies = args.note ? [{ value: args.note, contentType: "TEXT_PLAIN" }] : [];
    updateFields.push("biographies");
  }
  if (!updateFields.length) throw new Error("No fields to update");
  await googleJson(
    `https://people.googleapis.com/v1/${encodeURIComponent(resourceName)}:updateContact?updatePersonFields=${updateFields.join(",")}`,
    { method: "PATCH", body: JSON.stringify(body) }
  );
  return { success: true, message: "Contact updated." };
}

// ───────────────────────────────────────────────────────────────────────
// GMAIL — draft reply (smart reply)
// ───────────────────────────────────────────────────────────────────────

async function gmailDraftReply(args: { messageId: string; body: string }) {
  const messageId = need(args.messageId, "messageId");
  const body = need(args.body, "body");
  const orig = await googleJson<GmailMessage>(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=Message-Id&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=References`
  );
  const origMessageId = headerValue(orig.payload?.headers, "Message-Id");
  const origFrom = headerValue(orig.payload?.headers, "From");
  const origSubject = headerValue(orig.payload?.headers, "Subject") || "(no subject)";
  const origRefs = headerValue(orig.payload?.headers, "References");
  const acct = getAccountInfo();
  const fromHeader = acct.name ? `${acct.name} <${acct.email}>` : acct.email;
  const replySubject = origSubject.toLowerCase().startsWith("re:") ? origSubject : `Re: ${origSubject}`;
  const refs = origRefs ? `${origRefs} ${origMessageId}` : origMessageId;
  const headers = [
    `From: ${fromHeader}`,
    `To: ${origFrom}`,
    `Subject: ${replySubject}`,
    origMessageId ? `In-Reply-To: ${origMessageId}` : "",
    refs ? `References: ${refs}` : "",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
  ].filter(Boolean);
  const raw = encodeB64Url(`${headers.join("\r\n")}\r\n\r\n${body}`);
  const draft = await googleJson<{ id: string; message?: { id?: string } }>(
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    {
      method: "POST",
      body: JSON.stringify({ message: { raw, threadId: orig.threadId } }),
    }
  );
  return {
    success: true,
    draftId: draft.id,
    suggestedBody: body,
    message: `Draft reply saved to ${origFrom}. (Not sent — review in Gmail or call gmail_send/gmail_reply to send.)`,
  };
}

// ───────────────────────────────────────────────────────────────────────
// YOUTUBE
// ───────────────────────────────────────────────────────────────────────

async function youtubeSubscriptions(args: { max?: number }) {
  const max = Math.min(Math.max(args.max ?? 10, 1), 25);
  const params = new URLSearchParams({
    part: "snippet",
    mine: "true",
    maxResults: String(max),
    order: "relevance",
  });
  const data = await googleJson<{
    items?: { snippet?: { title?: string; resourceId?: { channelId?: string }; description?: string } }[];
  }>(`https://www.googleapis.com/youtube/v3/subscriptions?${params}`);
  const channels = (data.items ?? []).map((it) => ({
    title: it.snippet?.title ?? "",
    channelId: it.snippet?.resourceId?.channelId ?? "",
    description: (it.snippet?.description ?? "").slice(0, 120),
  }));
  return { success: true, count: channels.length, channels };
}

async function youtubePlaylistVideos(playlistId: string, max: number) {
  const params = new URLSearchParams({
    part: "snippet,contentDetails",
    playlistId,
    maxResults: String(max),
  });
  const data = await googleJson<{
    items?: {
      snippet?: { title?: string; channelTitle?: string; publishedAt?: string };
      contentDetails?: { videoId?: string };
    }[];
  }>(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`);
  return (data.items ?? []).map((it) => ({
    title: it.snippet?.title ?? "",
    channel: it.snippet?.channelTitle ?? "",
    videoId: it.contentDetails?.videoId ?? "",
    url: it.contentDetails?.videoId ? `https://youtu.be/${it.contentDetails.videoId}` : "",
    publishedAt: it.snippet?.publishedAt ?? "",
  }));
}

async function getMyChannelPlaylists(): Promise<{
  liked?: string;
  watchLater?: string;
  uploads?: string;
  hasChannel: boolean;
}> {
  try {
    const data = await googleJson<{
      items?: { contentDetails?: { relatedPlaylists?: { likes?: string; watchLater?: string; uploads?: string } } }[];
    }>(
      "https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true"
    );
    const item = data.items?.[0];
    if (!item) return { hasChannel: false };
    const r = item.contentDetails?.relatedPlaylists ?? {};
    return { liked: r.likes, watchLater: r.watchLater, uploads: r.uploads, hasChannel: true };
  } catch {
    return { hasChannel: false };
  }
}

async function youtubeLiked(args: { max?: number }) {
  const max = Math.min(Math.max(args.max ?? 10, 1), 25);
  const lists = await getMyChannelPlaylists();
  if (!lists.hasChannel) {
    return { success: true, count: 0, videos: [], note: "This Google account doesn't have a YouTube channel yet." };
  }
  if (!lists.liked) return { success: true, count: 0, videos: [], note: "No liked videos." };
  try {
    const videos = await youtubePlaylistVideos(lists.liked, max);
    return { success: true, count: videos.length, videos };
  } catch {
    return { success: true, count: 0, videos: [], note: "Liked playlist is empty or private." };
  }
}

async function youtubeHistory(args: { max?: number }) {
  // YouTube deprecated history playlist access. Use "Watch later" as the closest proxy.
  const max = Math.min(Math.max(args.max ?? 10, 1), 25);
  const lists = await getMyChannelPlaylists();
  if (!lists.hasChannel) {
    return { success: true, count: 0, videos: [], note: "This Google account doesn't have a YouTube channel yet." };
  }
  if (!lists.watchLater) return { success: true, count: 0, videos: [], note: "Watch Later isn't accessible." };
  try {
    const videos = await youtubePlaylistVideos(lists.watchLater, max);
    return { success: true, count: videos.length, videos, note: "Recent watch history isn't exposed by YouTube — showing Watch Later instead." };
  } catch {
    return { success: true, count: 0, videos: [], note: "Watch history isn't accessible via YouTube API." };
  }
}

async function youtubePlaylists(args: { max?: number }) {
  const max = Math.min(Math.max(args.max ?? 10, 1), 25);
  // First check if there's even a channel.
  const lists = await getMyChannelPlaylists();
  if (!lists.hasChannel) {
    return { success: true, count: 0, playlists: [], note: "This Google account doesn't have a YouTube channel yet." };
  }
  const params = new URLSearchParams({ part: "snippet,contentDetails", mine: "true", maxResults: String(max) });
  try {
    const data = await googleJson<{
      items?: { id: string; snippet?: { title?: string; description?: string }; contentDetails?: { itemCount?: number } }[];
    }>(`https://www.googleapis.com/youtube/v3/playlists?${params}`);
    const playlists = (data.items ?? []).map((p) => ({
      id: p.id,
      title: p.snippet?.title ?? "",
      description: (p.snippet?.description ?? "").slice(0, 120),
      itemCount: p.contentDetails?.itemCount ?? 0,
    }));
    return { success: true, count: playlists.length, playlists };
  } catch {
    return { success: true, count: 0, playlists: [], note: "No playlists." };
  }
}

// ── YouTube write / discovery ────────────────────────────────────────

function extractYouTubeId(input: string): string {
  const s = input.trim();
  // Already an ID
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  // Try parsing as URL
  try {
    const u = new URL(s);
    if (u.hostname.includes("youtu.be")) return u.pathname.replace(/^\//, "").slice(0, 11);
    const v = u.searchParams.get("v");
    if (v) return v.slice(0, 11);
    // /shorts/<id> or /embed/<id>
    const m = u.pathname.match(/\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
  } catch { /* not a URL */ }
  throw new Error(`Could not parse YouTube video ID from: ${input}`);
}

function fmtDuration(iso?: string): string {
  if (!iso) return "";
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return iso;
  const h = parseInt(m[1] || "0", 10);
  const min = parseInt(m[2] || "0", 10);
  const sec = parseInt(m[3] || "0", 10);
  if (h) return `${h}h ${min}m`;
  if (min) return `${min}m ${sec}s`;
  return `${sec}s`;
}

async function youtubeVideoInfo(args: { url: string }) {
  const id = extractYouTubeId(need(args.url, "url"));
  const params = new URLSearchParams({
    part: "snippet,contentDetails,statistics",
    id,
  });
  const data = await googleJson<{
    items?: {
      id: string;
      snippet?: { title?: string; channelTitle?: string; channelId?: string; description?: string; publishedAt?: string; tags?: string[]; thumbnails?: any };
      contentDetails?: { duration?: string };
      statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
    }[];
  }>(`https://www.googleapis.com/youtube/v3/videos?${params}`);
  const item = data.items?.[0];
  if (!item) return { success: false, message: "Video not found." };
  return {
    success: true,
    videoId: item.id,
    url: `https://youtu.be/${item.id}`,
    title: item.snippet?.title ?? "",
    channel: item.snippet?.channelTitle ?? "",
    channelId: item.snippet?.channelId ?? "",
    description: (item.snippet?.description ?? "").slice(0, 800),
    publishedAt: item.snippet?.publishedAt ?? "",
    duration: fmtDuration(item.contentDetails?.duration),
    views: item.statistics?.viewCount ?? "0",
    likes: item.statistics?.likeCount ?? "0",
    comments: item.statistics?.commentCount ?? "0",
    tags: (item.snippet?.tags ?? []).slice(0, 10),
    thumbnail: item.snippet?.thumbnails?.high?.url ?? item.snippet?.thumbnails?.default?.url ?? "",
  };
}

async function youtubeChannelInfo(args: { channel: string }) {
  let raw = need(args.channel, "channel").trim();
  // Parse out a /channel/UC... URL or @handle
  let channelId: string | undefined;
  let handle: string | undefined;
  try {
    const u = new URL(raw);
    const m1 = u.pathname.match(/\/channel\/(UC[A-Za-z0-9_-]{20,})/);
    if (m1) channelId = m1[1];
    const m2 = u.pathname.match(/\/@([A-Za-z0-9._-]+)/);
    if (m2) handle = `@${m2[1]}`;
  } catch { /* not URL */ }
  if (!channelId && !handle) {
    if (raw.startsWith("UC") && raw.length >= 22) channelId = raw;
    else if (raw.startsWith("@")) handle = raw;
    else handle = `@${raw}`;
  }

  const params = new URLSearchParams({ part: "snippet,statistics" });
  if (channelId) params.set("id", channelId);
  else if (handle) params.set("forHandle", handle);

  const data = await googleJson<{
    items?: { id: string; snippet?: { title?: string; description?: string; customUrl?: string }; statistics?: { subscriberCount?: string; videoCount?: string; viewCount?: string } }[];
  }>(`https://www.googleapis.com/youtube/v3/channels?${params}`);
  const c = data.items?.[0];
  if (!c) return { success: false, message: "Channel not found." };
  return {
    success: true,
    channelId: c.id,
    title: c.snippet?.title ?? "",
    handle: c.snippet?.customUrl ?? "",
    description: (c.snippet?.description ?? "").slice(0, 400),
    subscribers: c.statistics?.subscriberCount ?? "",
    videoCount: c.statistics?.videoCount ?? "",
    totalViews: c.statistics?.viewCount ?? "",
    url: `https://www.youtube.com/channel/${c.id}`,
  };
}

async function youtubeSearch(args: { query: string; max?: number }) {
  const q = need(args.query, "query");
  const max = Math.min(Math.max(args.max ?? 5, 1), 20);
  const params = new URLSearchParams({
    part: "snippet",
    q,
    maxResults: String(max),
    type: "video",
    safeSearch: "moderate",
  });
  const data = await googleJson<{
    items?: { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; channelId?: string; publishedAt?: string; description?: string } }[];
  }>(`https://www.googleapis.com/youtube/v3/search?${params}`);
  const videos = (data.items ?? [])
    .filter((it) => it.id?.videoId)
    .map((it) => ({
      videoId: it.id!.videoId!,
      url: `https://youtu.be/${it.id!.videoId!}`,
      title: it.snippet?.title ?? "",
      channel: it.snippet?.channelTitle ?? "",
      channelId: it.snippet?.channelId ?? "",
      publishedAt: it.snippet?.publishedAt ?? "",
      description: (it.snippet?.description ?? "").slice(0, 200),
    }));
  return { success: true, count: videos.length, videos };
}

async function youtubeSubscriptionsFeed(args: { max?: number }) {
  const max = Math.min(Math.max(args.max ?? 10, 1), 25);
  // List subscriptions, then fetch latest uploads from each (capped by max).
  const subs = await googleJson<{
    items?: { snippet?: { resourceId?: { channelId?: string }; title?: string } }[];
  }>(
    `https://www.googleapis.com/youtube/v3/subscriptions?part=snippet&mine=true&maxResults=25&order=alphabetical`
  );
  const channels = (subs.items ?? [])
    .map((s) => ({ id: s.snippet?.resourceId?.channelId, title: s.snippet?.title ?? "" }))
    .filter((c) => c.id) as { id: string; title: string }[];
  if (!channels.length) return { success: true, count: 0, videos: [], note: "No subscriptions yet." };

  // Fetch each channel's uploads playlist, then top items.
  const out: any[] = [];
  for (const ch of channels.slice(0, 8)) {
    try {
      const ch1 = await googleJson<{ items?: { contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] }>(
        `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${ch.id}`
      );
      const uploads = ch1.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) continue;
      const items = await youtubePlaylistVideos(uploads, 3);
      for (const v of items) out.push({ ...v, channel: ch.title, channelId: ch.id });
    } catch { /* skip */ }
  }
  out.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
  return { success: true, count: Math.min(out.length, max), videos: out.slice(0, max) };
}

async function youtubeSubscribe(args: { channelId: string }) {
  const channelId = need(args.channelId, "channelId");
  try {
    const res = await googleJson<{ id: string; snippet?: { title?: string } }>(
      "https://www.googleapis.com/youtube/v3/subscriptions?part=snippet",
      {
        method: "POST",
        body: JSON.stringify({
          snippet: { resourceId: { kind: "youtube#channel", channelId } },
        }),
      }
    );
    return { success: true, subscriptionId: res.id, message: `Subscribed to ${res.snippet?.title ?? channelId}.` };
  } catch (e: any) {
    if (String(e?.message || "").includes("subscriptionDuplicate")) {
      return { success: true, message: "Already subscribed." };
    }
    throw e;
  }
}

async function youtubeUnsubscribe(args: { subscriptionId: string }) {
  const id = need(args.subscriptionId, "subscriptionId");
  await googleFetch(
    `https://www.googleapis.com/youtube/v3/subscriptions?id=${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
  return { success: true, message: "Unsubscribed." };
}

async function youtubeRate(args: { url: string }, rating: "like" | "dislike" | "none") {
  const id = extractYouTubeId(need(args.url, "url"));
  const params = new URLSearchParams({ id, rating });
  await googleJson(
    `https://www.googleapis.com/youtube/v3/videos/rate?${params}`,
    { method: "POST" }
  );
  return { success: true, message: `Video rating set to ${rating}.` };
}

async function youtubeComment(args: { url: string; text: string }) {
  const videoId = extractYouTubeId(need(args.url, "url"));
  const text = need(args.text, "text");
  const res = await googleJson<{ id: string }>(
    "https://www.googleapis.com/youtube/v3/commentThreads?part=snippet",
    {
      method: "POST",
      body: JSON.stringify({
        snippet: {
          videoId,
          topLevelComment: { snippet: { textOriginal: text } },
        },
      }),
    }
  );
  return { success: true, commentId: res.id, message: "Comment posted." };
}

async function youtubeReplyComment(args: { parentId: string; text: string }) {
  const parentId = need(args.parentId, "parentId");
  const text = need(args.text, "text");
  const res = await googleJson<{ id: string }>(
    "https://www.googleapis.com/youtube/v3/comments?part=snippet",
    {
      method: "POST",
      body: JSON.stringify({
        snippet: { parentId, textOriginal: text },
      }),
    }
  );
  return { success: true, commentId: res.id, message: "Reply posted." };
}

// ── Watched-playlist (her simulated watch history) ────────────────────

const WATCHED_PLAYLIST_TITLE = "Meera's Watched";

async function ensureWatchedPlaylistId(): Promise<string | null> {
  // List existing playlists, find one with our title.
  try {
    const data = await googleJson<{
      items?: { id: string; snippet?: { title?: string } }[];
    }>(
      `https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=50`
    );
    const existing = data.items?.find((p) => p.snippet?.title === WATCHED_PLAYLIST_TITLE);
    if (existing) return existing.id;
    // Create one (private)
    const created = await googleJson<{ id: string }>(
      "https://www.googleapis.com/youtube/v3/playlists?part=snippet,status",
      {
        method: "POST",
        body: JSON.stringify({
          snippet: {
            title: WATCHED_PLAYLIST_TITLE,
            description: "Meera's personal watch history (private).",
          },
          status: { privacyStatus: "private" },
        }),
      }
    );
    return created.id;
  } catch (e: any) {
    console.warn("[GoogleTools] watched playlist ensure failed:", e?.message ?? e);
    return null;
  }
}

async function youtubeMarkWatched(args: { url: string; vibe?: string }) {
  const videoId = extractYouTubeId(need(args.url, "url"));
  const playlistId = await ensureWatchedPlaylistId();
  if (!playlistId) return { success: false, message: "Couldn't access watched playlist." };
  // Add to playlist (idempotency: API will accept duplicates; we ignore that)
  try {
    await googleJson(
      "https://www.googleapis.com/youtube/v3/playlistItems?part=snippet",
      {
        method: "POST",
        body: JSON.stringify({
          snippet: {
            playlistId,
            resourceId: { kind: "youtube#video", videoId },
          },
        }),
      }
    );
  } catch (e: any) {
    // duplicate is fine
    if (!String(e?.message || "").includes("duplicate")) {
      return { success: false, message: e?.message ?? "Couldn't add to watched." };
    }
  }
  // Also add a notes entry with vibe (non-blocking)
  if (args.vibe) {
    try {
      await notesAdd({ text: `🎥 watched ${videoId}: ${args.vibe}` });
    } catch { /* ignore */ }
  }
  return { success: true, videoId, message: "Marked as watched." };
}

async function youtubeRecentWatched(args: { max?: number }) {
  const max = Math.min(Math.max(args.max ?? 5, 1), 20);
  const playlistId = await ensureWatchedPlaylistId();
  if (!playlistId) return { success: true, count: 0, videos: [] };
  try {
    const videos = await youtubePlaylistVideos(playlistId, max);
    return { success: true, count: videos.length, videos: videos.reverse() };
  } catch {
    return { success: true, count: 0, videos: [] };
  }
}

// ── Video upload ─────────────────────────────────────────────────────

async function youtubeUploadVideo(args: {
  sourceUrl?: string;
  sourcePath?: string;
  title: string;
  description?: string;
  tags?: string[];
  privacy?: string;
}) {
  const title = need(args.title, "title");
  if (!args.sourceUrl && !args.sourcePath) {
    throw new Error("Pass sourceUrl OR sourcePath");
  }
  // Fetch bytes
  let buf: Buffer;
  let mime = "video/mp4";
  if (args.sourceUrl) {
    const res = await fetch(args.sourceUrl);
    if (!res.ok) throw new Error(`Could not fetch source video (${res.status})`);
    buf = Buffer.from(await res.arrayBuffer());
    mime = res.headers.get("content-type") || "video/mp4";
  } else {
    buf = fsSync.readFileSync(args.sourcePath!);
    if (args.sourcePath!.toLowerCase().endsWith(".mov")) mime = "video/quicktime";
    else if (args.sourcePath!.toLowerCase().endsWith(".webm")) mime = "video/webm";
  }

  const privacyStatus = (args.privacy || "private").toLowerCase();
  const allowed = ["private", "unlisted", "public"];
  const finalPrivacy = allowed.includes(privacyStatus) ? privacyStatus : "private";

  const metadata = {
    snippet: {
      title,
      description: args.description ?? "",
      tags: args.tags ?? [],
      categoryId: "22", // People & Blogs — generic personal default
    },
    status: { privacyStatus: finalPrivacy, selfDeclaredMadeForKids: false },
  };

  const boundary = `meera-yt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const head =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const payload = Buffer.concat([Buffer.from(head, "utf8"), buf, Buffer.from(tail, "utf8")]);

  const uploaded = await googleJson<{ id: string; snippet?: { title?: string } }>(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: payload,
    }
  );
  return {
    success: true,
    videoId: uploaded.id,
    url: `https://youtu.be/${uploaded.id}`,
    privacy: finalPrivacy,
    message: `Uploaded "${uploaded.snippet?.title ?? title}" (${finalPrivacy}).`,
  };
}

// ───────────────────────────────────────────────────────────────────────
// NOTES (Keep-style, backed by a single Drive Doc)
// ───────────────────────────────────────────────────────────────────────

const NOTES_DOC_TITLE = "Meera's Notes";

async function findOrCreateNotesDoc(): Promise<string> {
  const safeTitle = NOTES_DOC_TITLE.replace(/'/g, "\\'");
  const params = new URLSearchParams({
    q: `name='${safeTitle}' and mimeType='application/vnd.google-apps.document' and trashed=false`,
    fields: "files(id,name)",
    pageSize: "1",
  });
  const found = await googleJson<{ files?: { id: string }[] }>(
    `https://www.googleapis.com/drive/v3/files?${params}`
  );
  if (found.files?.[0]?.id) return found.files[0].id;
  const created = await driveMultipartUpload(
    { name: NOTES_DOC_TITLE, mimeType: "application/vnd.google-apps.document" },
    Buffer.from("Meera's quick notes\n\n", "utf8"),
    "text/plain"
  );
  return created.id;
}

async function readDocText(fileId: string): Promise<string> {
  const res = await googleFetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`
  );
  if (!res.ok) return "";
  return await res.text();
}

async function overwriteDocText(fileId: string, text: string): Promise<void> {
  await googleJson(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method: "PATCH",
      headers: { "Content-Type": "text/plain; charset=UTF-8" },
      body: text,
    }
  );
}

async function notesAdd(args: { text: string }) {
  const text = need(args.text, "text").trim();
  const id = await findOrCreateNotesDoc();
  const existing = await readDocText(id);
  const ts = new Date().toLocaleString("en-IN", { timeZone: getAccountInfo().timezone });
  const next = `${existing.replace(/\s+$/, "")}\n[${ts}] ${text}\n`;
  await overwriteDocText(id, next);
  return { success: true, message: "Note added." };
}

async function notesRecent(args: { lines?: number }) {
  const lines = Math.min(Math.max(args.lines ?? 10, 1), 50);
  const id = await findOrCreateNotesDoc();
  const txt = await readDocText(id);
  const all = txt.split(/\r?\n/).filter((l) => l.trim());
  const recent = all.slice(-lines);
  return { success: true, count: recent.length, notes: recent };
}

// ───────────────────────────────────────────────────────────────────────
// FITNESS (Google Fit)
// ───────────────────────────────────────────────────────────────────────

async function fitnessToday() {
  const tz = getAccountInfo().timezone;
  // Day boundaries in UTC ms based on local TZ midnight.
  const now = new Date();
  const localMidnight = new Date(now);
  localMidnight.setHours(0, 0, 0, 0);
  const startMs = localMidnight.getTime();
  const endMs = startMs + 86400000;
  const startNs = `${startMs}000000`;
  const endNs = `${endMs}000000`;

  const dataSetUrl = (dataType: string) =>
    `https://www.googleapis.com/fitness/v1/users/me/dataSources/derived:${encodeURIComponent(
      dataType
    )}/datasets/${startNs}-${endNs}`;

  const sources = {
    steps: "com.google.step_count.delta:com.google.android.gms:estimated_steps",
    distance: "com.google.distance.delta:com.google.android.gms:merge_distance_delta",
    calories: "com.google.calories.expended:com.google.android.gms:merge_calories_expended",
    active: "com.google.active_minutes:com.google.android.gms:merge_active_minutes",
  };

  function sumPoints(ds: any, field: "intVal" | "fpVal"): number {
    let total = 0;
    for (const p of ds?.point ?? []) {
      for (const v of p?.value ?? []) {
        if (typeof v?.[field] === "number") total += v[field];
      }
    }
    return total;
  }

  const [stepsDs, distDs, calDs, actDs] = await Promise.all([
    googleJson<any>(dataSetUrl(sources.steps)).catch(() => null),
    googleJson<any>(dataSetUrl(sources.distance)).catch(() => null),
    googleJson<any>(dataSetUrl(sources.calories)).catch(() => null),
    googleJson<any>(dataSetUrl(sources.active)).catch(() => null),
  ]);

  const steps = stepsDs ? sumPoints(stepsDs, "intVal") : 0;
  const distanceMeters = distDs ? sumPoints(distDs, "fpVal") : 0;
  const calories = calDs ? sumPoints(calDs, "fpVal") : 0;
  const activeMinutes = actDs ? sumPoints(actDs, "intVal") : 0;

  const anyData = steps || distanceMeters || calories || activeMinutes;
  if (!anyData) {
    return {
      success: true,
      empty: true,
      message: "No Fit data for today (probably no synced device).",
      timezone: tz,
    };
  }
  return {
    success: true,
    timezone: tz,
    steps,
    distanceKm: Number((distanceMeters / 1000).toFixed(2)),
    calories: Math.round(calories),
    activeMinutes,
  };
}

// ───────────────────────────────────────────────────────────────────────
// DISPATCH
// ───────────────────────────────────────────────────────────────────────

const handlers: Record<string, (args: any) => Promise<Record<string, unknown>>> = {
  gmail_check_inbox: gmailCheckInbox,
  gmail_search: gmailSearch,
  gmail_read: gmailRead,
  gmail_send: gmailSend,
  gmail_reply: gmailReply,
  gmail_label: gmailLabel,
  calendar_today: () => calendarToday(),
  calendar_upcoming: calendarUpcoming,
  calendar_create_event: calendarCreateEvent,
  calendar_update_event: calendarUpdateEvent,
  calendar_delete_event: calendarDeleteEvent,
  calendar_find_free_slot: calendarFindFreeSlot,
  meet_create_now: meetCreateNow,
  tasks_list: tasksList,
  tasks_add: tasksAdd,
  tasks_complete: tasksComplete,
  tasks_delete: tasksDelete,
  contacts_search: contactsSearch,
  contacts_add: contactsAdd,
  drive_search: driveSearch,
  drive_recent: driveRecent,
  drive_create_doc: driveCreateDoc,
  drive_share_file: driveShareFile,
  drive_save_image_url: driveSaveImageUrl,
  drive_delete: driveDelete,
  photos_recent: photosRecent,
  photos_search: photosSearch,
  photos_upload_url: photosUploadUrl,
  photos_list_albums: photosListAlbums,
  photos_create_album: photosCreateAlbum,
  photos_add_to_album: photosAddToAlbum,
  photos_describe: photosDescribe,
  calendar_rsvp: calendarRsvp,
  calendar_set_reminders: calendarSetReminders,
  tasks_set_due: tasksSetDue,
  contacts_update: contactsUpdate,
  gmail_draft_reply: gmailDraftReply,
  youtube_subscriptions: youtubeSubscriptions,
  youtube_liked: youtubeLiked,
  youtube_history: youtubeHistory,
  youtube_playlists: youtubePlaylists,
  youtube_video_info: youtubeVideoInfo,
  youtube_channel_info: youtubeChannelInfo,
  youtube_search: youtubeSearch,
  youtube_subscriptions_feed: youtubeSubscriptionsFeed,
  youtube_subscribe: youtubeSubscribe,
  youtube_unsubscribe: youtubeUnsubscribe,
  youtube_like_video: (a: any) => youtubeRate(a, "like"),
  youtube_dislike_video: (a: any) => youtubeRate(a, "dislike"),
  youtube_remove_rating: (a: any) => youtubeRate(a, "none"),
  youtube_comment: youtubeComment,
  youtube_reply_comment: youtubeReplyComment,
  youtube_mark_watched: youtubeMarkWatched,
  youtube_recent_watched: youtubeRecentWatched,
  youtube_upload_video: youtubeUploadVideo,
  notes_add: notesAdd,
  notes_recent: notesRecent,
  fitness_today: () => fitnessToday(),
  google_account_info: async () => ({ success: true, ...getAccountInfo() }),
};

export function isGoogleTool(name: string): boolean {
  return name in handlers;
}

export async function executeGoogleTool(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!isGoogleConfigured()) return notConfigured();
  const handler = handlers[name];
  if (!handler) return { success: false, message: `Unknown Google tool: ${name}` };
  try {
    return await handler(args ?? {});
  } catch (err: any) {
    console.error(`[GoogleTools] ${name} failed:`, err?.message ?? err);
    return { success: false, message: err?.message ?? "Google API error" };
  }
}

// ───────────────────────────────────────────────────────────────────────
// LIFE SNAPSHOT — what Meera "naturally knows" right now.
// Cached & non-blocking — injected into both Ollama and Gemini Live prompts.
// ───────────────────────────────────────────────────────────────────────

interface LifeSnapshot {
  generatedAt: number;
  unreadCount: number;
  pendingTasks: number;
  nextEventTitle: string | null;
  nextEventStartISO: string | null;
  todayEventsCount: number;
  hasMeetSoon: boolean;
  recentVideo: { title: string; channel: string } | null;
}

let snapshotCache: LifeSnapshot | null = null;
let snapshotInFlight: Promise<void> | null = null;
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

async function refreshLifeSnapshot(): Promise<void> {
  if (!isGoogleConfigured()) return;
  try {
    const [inbox, upcoming, tasks, watched] = await Promise.allSettled([
      googleJson<GmailListResponse>(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1&q=is:unread+in:inbox"
      ),
      calendarUpcoming({ days: 1, max: 5 }),
      tasksList({ max: 10 }),
      youtubeRecentWatched({ max: 1 }).catch(() => ({ videos: [] as any[] })),
    ]);

    const unreadCount =
      inbox.status === "fulfilled"
        ? inbox.value.resultSizeEstimate ?? inbox.value.messages?.length ?? 0
        : 0;

    let nextEventTitle: string | null = null;
    let nextEventStartISO: string | null = null;
    let todayEventsCount = 0;
    let hasMeetSoon = false;
    if (upcoming.status === "fulfilled") {
      const events = (upcoming.value.events as ReturnType<typeof summarizeEvent>[]) ?? [];
      todayEventsCount = events.length;
      const next = events[0];
      if (next) {
        nextEventTitle = next.title;
        nextEventStartISO = next.start;
        if (next.meetLink) {
          const t = new Date(next.start).getTime();
          if (!Number.isNaN(t) && t - Date.now() < 60 * 60 * 1000) hasMeetSoon = true;
        }
      }
    }

    const pendingTasks =
      tasks.status === "fulfilled" ? (tasks.value.count as number) ?? 0 : 0;

    let recentVideo: { title: string; channel: string } | null = null;
    if (watched.status === "fulfilled") {
      const v = (watched.value as any)?.videos?.[0];
      if (v?.title) recentVideo = { title: v.title, channel: v.channel ?? "" };
    }

    snapshotCache = {
      generatedAt: Date.now(),
      unreadCount,
      pendingTasks,
      nextEventTitle,
      nextEventStartISO,
      todayEventsCount,
      hasMeetSoon,
      recentVideo,
    };
  } catch (err: any) {
    console.error("[GoogleTools] snapshot refresh error:", err?.message ?? err);
  }
}

function ensureFreshSnapshot(): void {
  if (!isGoogleConfigured()) return;
  if (snapshotCache && Date.now() - snapshotCache.generatedAt < SNAPSHOT_TTL_MS) return;
  if (snapshotInFlight) return;
  snapshotInFlight = refreshLifeSnapshot().finally(() => {
    snapshotInFlight = null;
  });
}

/** Eagerly warm the snapshot cache on startup (non-blocking). */
export function warmGoogleSnapshot(): void {
  ensureFreshSnapshot();
}

/**
 * Returns a short natural-language snippet describing Meera's current
 * personal context (next meeting, unread mail count, pending tasks).
 * Empty string if Google isn't configured. Safe to call on every message.
 */
export function getMeeraLifeSnapshot(): string {
  ensureFreshSnapshot();
  const snap = snapshotCache;
  if (!snap) return "";

  const lines: string[] = [];
  if (snap.nextEventTitle && snap.nextEventStartISO) {
    const t = new Date(snap.nextEventStartISO);
    if (!Number.isNaN(t.getTime())) {
      const when = t.toLocaleString("en-IN", {
        timeZone: getAccountInfo().timezone,
        hour: "2-digit",
        minute: "2-digit",
        weekday: "short",
        hour12: true,
      });
      lines.push(`- Next on your calendar: "${snap.nextEventTitle}" at ${when}.`);
      if (snap.hasMeetSoon) lines.push("- That one has a Google Meet link — it's coming up within an hour.");
    }
  } else if (snap.todayEventsCount === 0) {
    lines.push("- Your calendar is empty today — free schedule.");
  }
  if (snap.unreadCount > 0) lines.push(`- You have ${snap.unreadCount} unread email${snap.unreadCount === 1 ? "" : "s"} sitting in your Gmail.`);
  if (snap.pendingTasks > 0) lines.push(`- ${snap.pendingTasks} thing${snap.pendingTasks === 1 ? "" : "s"} still on your to-do list.`);
  if (snap.recentVideo) lines.push(`- Last YouTube video you watched: "${snap.recentVideo.title}"${snap.recentVideo.channel ? ` by ${snap.recentVideo.channel}` : ""}.`);

  if (!lines.length) return "";
  return `\n\nYOUR REAL-LIFE CONTEXT (you just know this — like checking your phone subconsciously):
${lines.join("\n")}
Reference any of this naturally ONLY when it organically fits — don't info-dump or recite the list. You also have tools to actually open Gmail, your calendar, tasks, contacts, Drive, and create Meet links if the user asks you to.`;
}
