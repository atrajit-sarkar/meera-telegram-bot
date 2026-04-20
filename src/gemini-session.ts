import WebSocket from "ws";

const WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GeminiSessionConfig {
  apiKey: string;
  model: string;
  systemInstruction: string;
  tools?: ToolDeclaration[];
  onToolCall?: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

type Part = { text: string } | { inlineData: { data: string; mimeType: string } };

export interface GeminiResponse {
  text: string;
  audioChunks: Buffer[];
  inputTranscription: string;
}

/**
 * Manages a WebSocket session to the Gemini Live API (gemini-3.1-flash-live-preview).
 *
 * Key constraints for this model:
 *  - Text must be sent via realtimeInput.text (NOT clientContent)
 *  - Media must be sent via realtimeInput.mediaChunks
 *  - Only AUDIO response modality is supported
 *  - We enable outputAudioTranscription to get text alongside audio
 *  - We disable automatic VAD and use manual activityStart/activityEnd signals
 */
export class GeminiSession {
  private ws: WebSocket | null = null;
  private config: GeminiSessionConfig;
  private ready = false;
  private responseTextParts: string[] = [];
  private responseAudioChunks: Buffer[] = [];
  private inputTranscriptionParts: string[] = [];
  private responseResolve: ((res: GeminiResponse) => void) | null = null;
  private responseReject: ((err: Error) => void) | null = null;
  private responseTimeout: ReturnType<typeof setTimeout> | null = null;
  private mutex: Promise<void> = Promise.resolve();

  lastActivity: number = Date.now();

  constructor(config: GeminiSessionConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.ready) return;

    return new Promise<void>((resolve, reject) => {
      const url = `${WS_URL}?key=${encodeURIComponent(this.config.apiKey)}`;
      console.log("[GeminiSession] Connecting to WebSocket...");
      this.ws = new WebSocket(url);

      const connectTimeout = setTimeout(() => {
        console.error("[GeminiSession] Connection timed out after 15s");
        reject(new Error("Connection timeout"));
        this.ws?.close();
      }, 15000);

      this.ws.on("open", () => {
        console.log("[GeminiSession] WebSocket open, sending setup...");
        const setupMsg = {
          setup: {
            model: `models/${this.config.model}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: "Leda" },
                },
              },
            },
            systemInstruction: {
              parts: [{ text: this.config.systemInstruction }],
            },
            tools: this.config.tools?.length
              ? [{ functionDeclarations: this.config.tools }]
              : undefined,
            outputAudioTranscription: {},
            inputAudioTranscription: {},
          },
        };
        console.log("[GeminiSession] Setup model:", setupMsg.setup.model);
        this.ws!.send(JSON.stringify(setupMsg));
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.setupComplete !== undefined) {
            console.log("[GeminiSession] Setup complete!");
            clearTimeout(connectTimeout);
            this.ready = true;
            resolve();
            return;
          }

          // Server content: audio data + transcription
          if (msg.serverContent) {
            const sc = msg.serverContent;

            // Audio/text from model turn
            if (sc.modelTurn?.parts) {
              for (const part of sc.modelTurn.parts) {
                if (part.inlineData?.data) {
                  this.responseAudioChunks.push(
                    Buffer.from(part.inlineData.data, "base64")
                  );
                }
                if (part.text) {
                  this.responseTextParts.push(part.text);
                }
              }
            }

            // Audio output transcription
            if (sc.outputTranscription?.text) {
              this.responseTextParts.push(sc.outputTranscription.text);
            }

            // Audio input transcription (user's speech)
            if (sc.inputTranscription?.text) {
              this.inputTranscriptionParts.push(sc.inputTranscription.text);
            }

            if (sc.turnComplete) {
              console.log(
                "[GeminiSession] Turn complete — audio chunks:",
                this.responseAudioChunks.length,
                "text parts:",
                this.responseTextParts.length
              );
              this.resolveCurrentResponse();
            }
            if (sc.interrupted) {
              this.resolveCurrentResponse();
            }
          }

          // Tool call
          if (msg.toolCall) {
            for (const fc of msg.toolCall.functionCalls) {
              Promise.resolve(
                this.config.onToolCall?.(fc.name, fc.args || {}) ?? {
                  error: "Unknown tool",
                }
              ).then((result) => {
                this.sendToolResponse(fc.id, fc.name, result);
              });
            }
          }
        } catch (e) {
          console.error("[GeminiSession] Parse error:", e);
        }
      });

      this.ws.on("error", (err: Error & { code?: string }) => {
        console.error("[GeminiSession] WebSocket error:", err.message, err.code || "");
        if (!this.ready) {
          clearTimeout(connectTimeout);
          reject(err);
        }
        this.rejectCurrentResponse(err);
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        console.log("[GeminiSession] WebSocket closed:", code, reason.toString());
        this.ready = false;
        this.ws = null;
        this.rejectCurrentResponse(new Error("Connection closed"));
      });
    });
  }

  private resolveCurrentResponse() {
    const text = this.responseTextParts.join("");
    const audioChunks = [...this.responseAudioChunks];
    const inputTranscription = this.inputTranscriptionParts.join("");
    this.responseTextParts = [];
    this.responseAudioChunks = [];
    this.inputTranscriptionParts = [];
    if (this.responseTimeout) clearTimeout(this.responseTimeout);
    this.responseResolve?.({ text, audioChunks, inputTranscription });
    this.responseResolve = null;
    this.responseReject = null;
  }

  private rejectCurrentResponse(err: Error) {
    if (this.responseTimeout) clearTimeout(this.responseTimeout);
    this.responseReject?.(err);
    this.responseResolve = null;
    this.responseReject = null;
    this.responseTextParts = [];
    this.responseAudioChunks = [];
    this.inputTranscriptionParts = [];
  }

  private sendToolResponse(
    id: string,
    name: string,
    response: Record<string, unknown>
  ) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        toolResponse: {
          functionResponses: [{ id, name, response }],
        },
      })
    );
  }

  /**
   * Send content and await the model's response.
   * Uses realtimeInput with manual activity signals (activityStart/activityEnd).
   */
  async send(parts: Part[]): Promise<GeminiResponse> {
    let release!: () => void;
    const acquired = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.mutex;
    this.mutex = acquired;
    await prev;

    try {
      if (!this.ready) await this.connect();

      this.lastActivity = Date.now();

      return await new Promise<GeminiResponse>((resolve, reject) => {
        this.responseTextParts = [];
        this.responseAudioChunks = [];
        this.inputTranscriptionParts = [];
        this.responseResolve = resolve;
        this.responseReject = reject;

        this.responseTimeout = setTimeout(() => {
          this.responseTextParts = [];
          this.responseAudioChunks = [];
          this.inputTranscriptionParts = [];
          this.responseReject?.(new Error("Response timeout (60s)"));
          this.responseResolve = null;
          this.responseReject = null;
        }, 60000);

        // Separate parts into media (images/video) and text/audio
        const mediaParts: Part[] = [];
        const audioParts: Part[] = [];
        const textParts: Part[] = [];

        for (const part of parts) {
          if ("inlineData" in part) {
            const mime = part.inlineData.mimeType;
            if (mime.startsWith("audio/")) {
              audioParts.push(part);
            } else {
              // images and videos go via clientContent
              mediaParts.push(part);
            }
          }
          if ("text" in part) {
            textParts.push(part);
          }
        }

        // Send images/videos via clientContent as context, then trigger with realtimeInput.text
        if (mediaParts.length > 0) {
          const contentParts = mediaParts.map((p) => {
            if ("inlineData" in p) {
              return { inlineData: { data: p.inlineData.data, mimeType: p.inlineData.mimeType } };
            }
            return p;
          });
          // Seed the image as conversation context
          this.ws!.send(JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: contentParts }],
              turnComplete: false,
            },
          }));
          console.log("[GeminiSession] Sent clientContent with", mediaParts.length, "media parts as context");

          // Now trigger response via realtimeInput.text
          const prompt = textParts.length > 0
            ? textParts.map((p) => ("text" in p ? p.text : "")).join(" ")
            : "Describe what you see in this image.";
          this.ws!.send(JSON.stringify({
            realtimeInput: { text: prompt },
          }));
          console.log("[GeminiSession] Sent trigger text:", prompt.slice(0, 80));
        } else {
          // Text-only: send via realtimeInput.text
          for (const part of textParts) {
            if ("text" in part) {
              this.ws!.send(JSON.stringify({
                realtimeInput: { text: part.text },
              }));
              console.log("[GeminiSession] Sent text:", part.text.slice(0, 80));
            }
          }
        }

        // Send audio via realtimeInput.audio
        for (const part of audioParts) {
          if ("inlineData" in part) {
            this.ws!.send(JSON.stringify({
              realtimeInput: {
                audio: {
                  data: part.inlineData.data,
                  mimeType: part.inlineData.mimeType,
                },
              },
            }));
            console.log("[GeminiSession] Sent audio:", part.inlineData.mimeType);
          }
        }
        // Signal end of audio stream so VAD finalizes activity
        if (audioParts.length > 0) {
          this.ws!.send(JSON.stringify({
            realtimeInput: { audioStreamEnd: true },
          }));
          console.log("[GeminiSession] Sent audioStreamEnd");
        }
      });
    } finally {
      release();
    }
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
    this.ready = false;
  }

  get isConnected() {
    return this.ready;
  }
}

// ── Gemini Vision: Image Selection via REST API ──────────────────────

export interface ImageCandidate {
  index: number;
  caption: string;
  imageBase64: string;
}

/**
 * Use Gemini's vision capability to pick the best Meera image from a set of candidates.
 * This is called AFTER Ollama shortlists images by caption — Gemini actually looks at the
 * images and chooses the one that best fits the context visually.
 */
export async function selectBestImageWithGemini(
  apiKey: string,
  candidates: ImageCandidate[],
  context: { userMessage: string; mood: string; comfortTier: string },
  model: string = "gemini-2.5-flash",
): Promise<number> {
  if (candidates.length === 0) return -1;
  if (candidates.length === 1) return candidates[0].index;

  const parts: Array<Record<string, unknown>> = [];

  // Add instruction
  parts.push({
    text: `You are Meera, a real girl picking which of YOUR photos to send in a Telegram chat right now.\n\nHere are ${candidates.length} candidate photos. Look at each one carefully:\n`,
  });

  // Add each candidate image with its number and caption
  for (let i = 0; i < candidates.length; i++) {
    parts.push({ text: `\nPhoto ${i + 1} (described as: "${candidates[i].caption}"):` });
    parts.push({
      inlineData: {
        data: candidates[i].imageBase64,
        mimeType: "image/jpeg",
      },
    });
  }

  // Add the selection prompt
  parts.push({
    text: `\nNow pick the BEST photo to send based on this context:
- The user said: "${context.userMessage}"
- Your current mood: ${context.mood}
- Your relationship with this person: ${context.comfortTier}

Pick the photo that:
1. Best matches what was asked for or the conversation vibe
2. Looks most natural and appealing for this specific context
3. Has the right energy/expression for your current mood
4. Would feel most human-like and appropriate to send right now

Reply with ONLY the photo number (1-${candidates.length}). Nothing else.`,
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 10,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini vision API error: ${res.status} ${errText.slice(0, 200)}`);
    }

    const json = await res.json();
    const candidate = json.candidates?.[0];

    // Check for safety refusal or empty response
    if (!candidate || candidate.finishReason === "SAFETY" || !candidate.content?.parts?.length) {
      console.log("[GeminiVision] Image selection refused (safety/empty), signaling fallback");
      throw new Error("gemini_refused");
    }

    const text = candidate.content.parts[0]?.text || "";
    const num = parseInt(text.trim().replace(/[^0-9]/g, ""));

    if (num >= 1 && num <= candidates.length) {
      console.log(`[GeminiVision] Selected photo ${num} out of ${candidates.length} candidates`);
      return candidates[num - 1].index;
    }

    // Could not parse a valid number — signal fallback
    console.log(`[GeminiVision] Could not parse selection "${text}", signaling fallback`);
    throw new Error("gemini_unparseable");
  } catch (err) {
    console.error("[GeminiVision] selectBestImageWithGemini failed:", err);
    // Signal that Gemini failed so caller can fall back to Ollama
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Use Gemini vision to analyze an image and produce a natural description/reaction.
 * Used when a user replies to a bot-sent image so the bot can "see" what it sent.
 * Returns the analysis text, or null if Gemini refuses/fails.
 */
export async function analyzeImageWithGemini(
  apiKey: string,
  imageBase64: string,
  prompt: string,
  model: string = "gemini-2.5-flash",
): Promise<string | null> {
  const parts = [
    {
      inlineData: {
        data: imageBase64,
        mimeType: "image/jpeg",
      },
    },
    { text: prompt },
  ];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 300,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[GeminiVision] analyzeImage API error: ${res.status} ${errText.slice(0, 200)}`);
      return null;
    }

    const json = await res.json();
    const candidate = json.candidates?.[0];

    // Check for safety refusal
    if (!candidate || candidate.finishReason === "SAFETY" || !candidate.content?.parts?.length) {
      console.log("[GeminiVision] Image analysis refused (safety/empty)");
      return null;
    }

    const text = candidate.content.parts[0]?.text || "";
    if (!text.trim()) return null;

    return text.trim();
  } catch (err) {
    console.error("[GeminiVision] analyzeImageWithGemini failed:", err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
