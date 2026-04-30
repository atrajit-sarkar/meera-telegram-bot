import "dotenv/config";
import { getAccessToken } from "../src/google-account.js";

const t = await getAccessToken();
const r = await fetch("https://oauth2.googleapis.com/tokeninfo?access_token=" + t);
const j: any = await r.json();
console.log("Granted scopes (",(j.scope?.split(" ") ?? []).length,"):");
for (const s of (j.scope ?? "").split(" ")) console.log("  ✓", s);
console.log("\nExpected (from REQUIRED_SCOPES):");
const { REQUIRED_SCOPES } = await import("../src/google-tools.js");
const granted = new Set((j.scope ?? "").split(" "));
for (const s of REQUIRED_SCOPES) console.log(granted.has(s) ? "  ✓" : "  ✗ MISSING:", s);
