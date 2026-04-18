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
  onToolCall?: (name: string, args: Record<string, unknown>) => Record<string, unknown>;
}

type Part = { text: string } | { inlineData: { data: string; mimeType: string } };

export interface GeminiResponse {
  text: string;
  audioChunks: Buffer[];
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
              const result =
                this.config.onToolCall?.(fc.name, fc.args || {}) ?? {
                  error: "Unknown tool",
                };
              this.sendToolResponse(fc.id, fc.name, result);
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
    this.responseTextParts = [];
    this.responseAudioChunks = [];
    if (this.responseTimeout) clearTimeout(this.responseTimeout);
    this.responseResolve?.({ text, audioChunks });
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
        this.responseResolve = resolve;
        this.responseReject = reject;

        this.responseTimeout = setTimeout(() => {
          this.responseTextParts = [];
          this.responseAudioChunks = [];
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
