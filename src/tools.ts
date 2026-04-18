import { ToolDeclaration } from "./gemini-session.js";

export const toolDeclarations: ToolDeclaration[] = [
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
];

export function executeToolCall(
  name: string,
  args: Record<string, unknown>
): Record<string, unknown> {
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
      return {
        success: true,
        time: now.toLocaleTimeString(),
        date: now.toLocaleDateString(),
        iso: now.toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    }

    default:
      return { success: false, message: `Unknown tool: ${name}` };
  }
}
