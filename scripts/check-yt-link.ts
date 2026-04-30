import "dotenv/config";
import { executeGoogleTool } from "../src/google-tools.js";

const url = process.argv[2] ?? "https://youtube.com/shorts/5mgs2z8_2xk";
const info = await executeGoogleTool("youtube_video_info", { url });
console.log(JSON.stringify(info, null, 2));
