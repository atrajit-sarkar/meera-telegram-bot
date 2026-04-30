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
  "https://www.googleapis.com/auth/drive",                            // Drive
  "https://www.googleapis.com/auth/drive.file",
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
// DISPATCH
// ───────────────────────────────────────────────────────────────────────

const handlers: Record<string, (args: any) => Promise<Record<string, unknown>>> = {
  gmail_check_inbox: gmailCheckInbox,
  gmail_search: gmailSearch,
  gmail_read: gmailRead,
  gmail_send: gmailSend,
  calendar_today: () => calendarToday(),
  calendar_upcoming: calendarUpcoming,
  calendar_create_event: calendarCreateEvent,
  meet_create_now: meetCreateNow,
  tasks_list: tasksList,
  tasks_add: tasksAdd,
  tasks_complete: tasksComplete,
  contacts_search: contactsSearch,
  drive_search: driveSearch,
  drive_recent: driveRecent,
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
}

let snapshotCache: LifeSnapshot | null = null;
let snapshotInFlight: Promise<void> | null = null;
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

async function refreshLifeSnapshot(): Promise<void> {
  if (!isGoogleConfigured()) return;
  try {
    const [inbox, upcoming, tasks] = await Promise.allSettled([
      googleJson<GmailListResponse>(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1&q=is:unread+in:inbox"
      ),
      calendarUpcoming({ days: 1, max: 5 }),
      tasksList({ max: 10 }),
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

    snapshotCache = {
      generatedAt: Date.now(),
      unreadCount,
      pendingTasks,
      nextEventTitle,
      nextEventStartISO,
      todayEventsCount,
      hasMeetSoon,
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

  if (!lines.length) return "";
  return `\n\nYOUR REAL-LIFE CONTEXT (you just know this — like checking your phone subconsciously):
${lines.join("\n")}
Reference any of this naturally ONLY when it organically fits — don't info-dump or recite the list. You also have tools to actually open Gmail, your calendar, tasks, contacts, Drive, and create Meet links if the user asks you to.`;
}
