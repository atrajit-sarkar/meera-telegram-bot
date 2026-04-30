/**
 * Quick sanity check: call each Google tool exactly the way Gemini Live
 * and Ollama would call it. Prints real data from Meera's account.
 *
 * Usage: npm run check:google
 */
import "dotenv/config";
import { executeGoogleTool, getMeeraLifeSnapshot, warmGoogleSnapshot } from "../src/google-tools.js";
import { getAccountInfo } from "../src/google-account.js";

function header(title: string) {
  console.log("\n──────────────────────────────────────────────");
  console.log(` ${title}`);
  console.log("──────────────────────────────────────────────");
}

function pretty(v: unknown) {
  console.log(JSON.stringify(v, null, 2).slice(0, 1400));
}

async function main() {
  const acct = getAccountInfo();
  header(`Account: ${acct.name} <${acct.email}>  (${acct.timezone})`);
  if (!acct.configured) {
    console.error("❌ Not configured — fill GOOGLE_* in .env");
    process.exit(1);
  }

  header("google_account_info");
  pretty(await executeGoogleTool("google_account_info", {}));

  header("gmail_check_inbox  (max=3, onlyUnread=false)");
  pretty(await executeGoogleTool("gmail_check_inbox", { max: 3, onlyUnread: false }));

  header("calendar_today");
  pretty(await executeGoogleTool("calendar_today", {}));

  header("calendar_upcoming  (days=14)");
  pretty(await executeGoogleTool("calendar_upcoming", { days: 14, max: 5 }));

  header("tasks_list");
  pretty(await executeGoogleTool("tasks_list", { max: 5 }));

  header("contacts_search  (query='a')");
  pretty(await executeGoogleTool("contacts_search", { query: "a", max: 3 }));

  header("drive_recent");
  pretty(await executeGoogleTool("drive_recent", { max: 3 }));

  header("calendar_find_free_slot  (30min within 3 days)");
  pretty(await executeGoogleTool("calendar_find_free_slot", { durationMinutes: 30, withinDays: 3 }));

  header("photos_list_albums  (Photos write scope check)");
  pretty(await executeGoogleTool("photos_list_albums", { max: 3 }));

  header("photos_recent  (Photos read scope check)");
  pretty(await executeGoogleTool("photos_recent", { max: 3 }));

  header("Life snapshot (this is what gets injected into the system prompt)");
  warmGoogleSnapshot();
  // Snapshot is async on first call — poll for up to 8s while it fills.
  let snap = "";
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 500));
    snap = getMeeraLifeSnapshot();
    if (snap) break;
  }
  console.log(snap || "(empty — no calendar events / unread mail / tasks)");

  console.log("\n✅ All tools reachable. Meera can use her Google account end-to-end.\n");
}

main().catch((e) => {
  console.error("\n❌ FAIL:", e?.message ?? e);
  process.exit(1);
});
