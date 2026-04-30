import "dotenv/config";
import { executeGoogleTool } from "../src/google-tools.js";

const url = process.argv[2] ?? "https://youtube.com/shorts/5mgs2z8_2xk";
const channelId = process.argv[3];
const comment = process.argv[4] ?? "this is so cute, the vibes are unreal 🥹💛";

const results: Record<string, unknown> = {};
results.like = await executeGoogleTool("youtube_like_video", { url }).catch((e: any) => ({ error: e?.message ?? String(e) }));
results.mark_watched = await executeGoogleTool("youtube_mark_watched", { url, note: "soft couple short, instant smile" }).catch((e: any) => ({ error: e?.message ?? String(e) }));
results.comment = await executeGoogleTool("youtube_comment", { url, text: comment }).catch((e: any) => ({ error: e?.message ?? String(e) }));
if (channelId) {
  results.subscribe = await executeGoogleTool("youtube_subscribe", { channelId }).catch((e: any) => ({ error: e?.message ?? String(e) }));
}
console.log(JSON.stringify(results, null, 2));
