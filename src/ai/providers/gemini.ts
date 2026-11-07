/** Google Gemini through @google/genai for every AI feature. Haru's persona comes from a prompt file. */
import { readFileSync } from "node:fs";
import { ApiError, type Content, FinishReason, GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { AppConfig } from "../../config.ts";
import type { Fetcher } from "../../types/fetch.ts";
import { AUTONOMOUS_PARTICIPATION_FORMAT } from "../participation.ts";
import type { AiProvider, ProviderStep } from "./types.ts";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_IMAGE_BYTES = 5_000_000;
const TIMEOUT_MS = 8_000;
/** Errors that retrying another model cannot fix. */
const STOP_STATUSES = [400, 401, 403];

export function createGeminiProvider(
  config: AppConfig,
  deps: { fetch?: Fetcher; attemptTimeoutMs?: number } = {},
): AiProvider {
  if (!config.aiModel) throw new Error("FATAL: AI_MODEL is required for the gemini provider");
  if (!config.aiSystemPromptFile) {
    throw new Error("FATAL: AI_SYSTEM_PROMPT_FILE is required for the gemini provider");
  }
  const models = [
    ...new Set(
      config.aiModel
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
  if (models.length === 0) throw new Error("FATAL: AI_MODEL has no model names");
  const persona = readFileSync(config.aiSystemPromptFile, "utf8").trim();
  if (!persona) throw new Error(`FATAL: ${config.aiSystemPromptFile} is empty`);

  const fetchImpl: Fetcher = deps.fetch ?? ((input, init) => fetch(input, init));
  const attemptMs = deps.attemptTimeoutMs ?? TIMEOUT_MS;
  const client = new GoogleGenAI({
    apiKey: config.aiApiKey ?? "",
    httpOptions: { fetch: fetchImpl },
  });

  return {
    label: "Gemini",
    missingKeyError: "AI_API_KEY not set",
    capabilities: { tools: true, autonomous: true },
    start(request) {
      let calls = 0;
      let contents: Content[] | undefined;
      let reply: Content | undefined;
      // Tool results only make sense to the model that asked for them.
      let pinned: string | undefined;
      const tools = request.tools?.flatMap((tool) =>
        typeof tool.name === "string"
          ? [
              {
                name: tool.name,
                description: String(tool.description ?? ""),
                parametersJsonSchema: tool.parameters,
              },
            ]
          : [],
      );
      const systemInstruction = [persona, request.instructions].filter(Boolean).join("\n\n");
      const participation = request.format === "participation";
      return {
        get calls() {
          return calls;
        },
        async step(signal): Promise<ProviderStep> {
          if (!contents) {
            const images = await Promise.all(
              request.imageUrls.map((url) =>
                inlineImage(
                  fetchImpl,
                  url,
                  AbortSignal.any([signal, AbortSignal.timeout(attemptMs)]),
                ),
              ),
            );
            contents = [
              {
                role: "user",
                parts: [
                  { text: request.userText },
                  ...images.filter((image) => image !== null),
                  ...(request.currentUserMessage ? [{ text: request.currentUserMessage }] : []),
                ],
              },
            ];
          }
          let lastError = "";
          for (const model of pinned ? [pinned] : models) {
            calls++;
            try {
              const response = await client.models.generateContent({
                model,
                contents,
                config: {
                  systemInstruction,
                  ...(tools ? { tools: [{ functionDeclarations: tools }] } : {}),
                  ...(participation
                    ? {
                        responseMimeType: "application/json",
                        responseJsonSchema: AUTONOMOUS_PARTICIPATION_FORMAT.schema,
                      }
                    : {}),
                  ...(config.aiThinking
                    ? {}
                    : { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } }),
                  abortSignal: AbortSignal.any([signal, AbortSignal.timeout(attemptMs)]),
                  automaticFunctionCalling: { disable: true },
                },
              });
              reply = response.candidates?.[0]?.content;
              const parts = reply?.parts ?? [];
              const text = parts
                .filter((part) => !part.thought)
                .map((part) => part.text ?? "")
                .join("")
                .trim();
              const toolCalls = parts.flatMap((part, index) =>
                part.functionCall?.name
                  ? [
                      {
                        id: part.functionCall.id ?? `call_${calls}_${index}`,
                        name: part.functionCall.name,
                        arguments: JSON.stringify(part.functionCall.args ?? {}),
                      },
                    ]
                  : [],
              );
              if (toolCalls.length > 0) pinned = model;
              // A decision cut short or filtered is no decision, even if its JSON parses.
              const finished =
                !participation || response.candidates?.[0]?.finishReason === FinishReason.STOP;
              console.log("[AI] model:", model);
              return {
                ok: true,
                text: finished ? text || null : null,
                toolCalls,
                tokens: response.usageMetadata?.totalTokenCount ?? 0,
              };
            } catch (error) {
              // The caller gave up, so stop rather than spend calls on more models.
              if (signal.aborted) throw error;
              const status = error instanceof ApiError ? error.status : 0;
              lastError = `Gemini error ${status || "no response"}: ${(error as Error).message}`;
              // A model that cannot think this little may be followed by one that can.
              const thinkingRejected = status === 400 && /thinking/i.test(lastError);
              if (STOP_STATUSES.includes(status) && !thinkingRejected) {
                return { ok: false, error: lastError, tokens: 0 };
              }
              console.warn(
                `[AI] ${model} failed (${status || "no response"}); trying the next model`,
              );
            }
          }
          return { ok: false, error: lastError, tokens: 0 };
        },
        addToolResults(toolCalls, results) {
          if (!contents || !reply) throw new Error("No tool calls to answer");
          // Keep the model's own turn: Gemini 3 needs its thought signatures back.
          contents.push(reply, {
            role: "user",
            parts: toolCalls.map((call, index) => ({
              functionResponse: { name: call.name, response: toResponse(results[index]!) },
            })),
          });
        },
      };
    },
  };
}

/** A function response must be an object; tool results are JSON text. */
function toResponse(result: string): Record<string, unknown> {
  const value: unknown = JSON.parse(result);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { result: value };
}

/** Gemini cannot fetch Discord links itself, so images go inline; unusable ones are skipped. */
async function inlineImage(
  fetchImpl: Fetcher,
  url: string,
  signal: AbortSignal,
): Promise<{ inlineData: { mimeType: string; data: string } } | null> {
  try {
    const res = await fetchImpl(url, { signal });
    const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!res.ok || !IMAGE_TYPES.includes(mimeType)) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) return null;
    return { inlineData: { mimeType, data: bytes.toBase64() } };
  } catch {
    return null;
  }
}
