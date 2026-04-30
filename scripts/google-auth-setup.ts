/**
 * One-time interactive Google OAuth2 setup for Meera.
 *
 * Run:    npm run auth:google
 *
 * Steps:
 *  1. Make sure GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are set in .env
 *     (create OAuth credentials of type "Desktop app" in Google Cloud Console).
 *  2. This script spins up a tiny localhost server on http://localhost:53682,
 *     opens the consent URL, and captures the resulting refresh_token.
 *  3. Copy the printed values into your .env.
 *
 * No external SDKs required — uses Node's http + global fetch.
 */

import "dotenv/config";
import http from "node:http";
import { URL } from "node:url";
import crypto from "node:crypto";
import { REQUIRED_SCOPES } from "../src/google-tools.js";

const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

function fail(msg: string): never {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  fail(
    "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env first.\n" +
      "   Create OAuth 2.0 Client (type: Desktop app) at:\n" +
      "   https://console.cloud.google.com/apis/credentials"
  );
}

const state = crypto.randomBytes(16).toString("hex");

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");
authUrl.searchParams.set("include_granted_scopes", "true");
authUrl.searchParams.set("state", state);
authUrl.searchParams.set("scope", REQUIRED_SCOPES.join(" "));

console.log("\n🪄  Open this URL in your browser and approve access for Meera's account:\n");
console.log(authUrl.toString());
console.log(`\nWaiting for redirect on ${REDIRECT_URI} ...`);

const server = http.createServer(async (req, res) => {
  if (!req.url) return;
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const err = url.searchParams.get("error");

  const reply = (status: number, body: string) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<html><body style="font-family:system-ui;padding:32px"><h2>${body}</h2><p>You can close this tab.</p></body></html>`);
  };

  if (err) {
    reply(400, `Authorization failed: ${err}`);
    server.close();
    fail(`OAuth error: ${err}`);
  }
  if (!code || returnedState !== state) {
    reply(400, "Invalid response.");
    return;
  }

  try {
    const body = new URLSearchParams({
      code,
      client_id: clientId!,
      client_secret: clientSecret!,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    });
    const tokRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const tokens = (await tokRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!tokRes.ok || !tokens.refresh_token) {
      reply(500, "Token exchange failed.");
      server.close();
      fail(
        `Token exchange failed: ${tokens.error_description ?? tokens.error ?? "no refresh_token returned"}.\n` +
          "   Tip: revoke prior consent at https://myaccount.google.com/permissions and retry."
      );
    }

    // Fetch the email this token belongs to.
    let email = "";
    try {
      const ui = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const j = (await ui.json()) as { email?: string };
      email = j.email ?? "";
    } catch {
      /* ignore */
    }

    reply(200, "✅ Meera is connected to Google. You can close this tab.");

    // Verify which scopes were actually granted (Google silently drops ones
    // not enabled in Cloud Console / not ticked in granular consent).
    let grantedScopes: string[] = [];
    try {
      const ti = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${tokens.access_token}`
      );
      const tj = (await ti.json()) as { scope?: string };
      grantedScopes = (tj.scope ?? "").split(/\s+/).filter(Boolean);
    } catch {
      /* ignore */
    }
    const expanded = new Set(grantedScopes);
    // tokeninfo collapses these — accept either form
    if (expanded.has("email")) expanded.add("https://www.googleapis.com/auth/userinfo.email");
    if (expanded.has("profile")) expanded.add("https://www.googleapis.com/auth/userinfo.profile");
    const missing = REQUIRED_SCOPES.filter((s) => !expanded.has(s));

    console.log("\n✅ Success! Add the following to your .env:\n");
    console.log(`GOOGLE_CLIENT_ID=${clientId}`);
    console.log(`GOOGLE_CLIENT_SECRET=${clientSecret}`);
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    if (email) console.log(`GOOGLE_USER_EMAIL=${email}`);
    console.log(`GOOGLE_USER_TIMEZONE=Asia/Kolkata`);
    console.log(`GOOGLE_USER_NAME=Meera\n`);

    if (missing.length) {
      console.log("⚠️  Some requested scopes were NOT granted by Google:");
      for (const s of missing) console.log("    ✗", s);
      console.log(
        "\n   Likely fixes:\n" +
          "   1. Enable the corresponding API in Google Cloud Console.\n" +
          "   2. Add the scope under OAuth consent screen → Scopes.\n" +
          "   3. Re-run this script and tick every permission box.\n"
      );
    } else {
      console.log("✅ All requested scopes were granted.\n");
    }
    server.close();
    process.exit(0);
  } catch (e: any) {
    reply(500, "Unexpected error.");
    server.close();
    fail(e?.message ?? String(e));
  }
});

server.listen(REDIRECT_PORT);
