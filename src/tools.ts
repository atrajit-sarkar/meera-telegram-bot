import { ToolDeclaration } from "./gemini-session.js";
import { googleToolDeclarations, executeGoogleTool, isGoogleTool } from "./google-tools.js";

const baseTools: ToolDeclaration[] = [
  {
    name: "searchGoogle",
    description:
      "Searches Google for a query. Use when the user asks to search or needs current information.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "getCurrentTime",
    description: "Gets the current date and time.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "getWeather",
    description:
      "Gets the current weather for a location. Use when the user asks about weather, or when you want to react to the weather naturally (like complaining about heat, loving the rain, etc). If no city is given, default to Kolkata.",
    parameters: {
      type: "object",
      properties: {
        city: {
          type: "string",
          description: "City name to get weather for (e.g. 'Kolkata', 'Mumbai', 'Delhi'). Defaults to Kolkata if not specified.",
        },
      },
    },
  },
];

/** Combined declarations: built-in + Meera's Google account tools. */
export const toolDeclarations: ToolDeclaration[] = [
  ...baseTools,
  ...googleToolDeclarations,
];

async function fetchWeather(city: string): Promise<Record<string, unknown>> {
  try {
    const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { success: false, message: `Could not get weather for ${city}` };
    const data = await res.json() as Record<string, unknown>;
    const current = (data.current_condition as Record<string, unknown>[])?.[0];
    if (!current) return { success: false, message: "No weather data available" };

    const weatherDesc = (current.weatherDesc as Record<string, string>[])?.[0]?.value || "Unknown";
    const tempC = current.temp_C as string;
    const feelsLikeC = current.FeelsLikeC as string;
    const humidity = current.humidity as string;
    const windSpeedKmph = current.windspeedKmph as string;
    const uvIndex = current.uvIndex as string;

    return {
      success: true,
      city,
      weather: weatherDesc,
      temperature: `${tempC}°C`,
      feelsLike: `${feelsLikeC}°C`,
      humidity: `${humidity}%`,
      wind: `${windSpeedKmph} km/h`,
      uvIndex,
    };
  } catch (err) {
    console.error("[Weather] fetch error:", err);
    return { success: false, message: `Failed to fetch weather for ${city}` };
  }
}

export async function executeToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (isGoogleTool(name)) {
    return executeGoogleTool(name, args);
  }
  switch (name) {
    case "searchGoogle": {
      const query = args.query as string;
      if (!query) return { success: false, message: "No query provided" };
      return {
        success: true,
        url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
        message: `Search link for "${query}"`,
      };
    }

    case "getCurrentTime": {
      const now = new Date();
      const istOptions: Intl.DateTimeFormatOptions = { timeZone: "Asia/Kolkata" };
      return {
        success: true,
        time: now.toLocaleTimeString("en-IN", { ...istOptions, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }),
        date: now.toLocaleDateString("en-IN", { ...istOptions, weekday: "long", year: "numeric", month: "long", day: "numeric" }),
        day: now.toLocaleDateString("en-IN", { ...istOptions, weekday: "long" }),
        iso: now.toISOString(),
        timezone: "Asia/Kolkata (IST)",
      };
    }

    case "getWeather": {
      const city = (args.city as string) || "Kolkata";
      return fetchWeather(city);
    }

    default:
      return { success: false, message: `Unknown tool: ${name}` };
  }
}
