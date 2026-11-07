/** Google Gemini through @google/genai, for plain replies. Haru's persona comes from a prompt file. */
import { readFileSync } from "node:fs";
import { ApiError, GoogleGenAI } from "@google/genai";
import type { AppConfig } from "../../config.ts";
import type { Fetcher } from "../../types/fetch.ts";
import type { AiProvider, ProviderStep } from "./types.ts";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_IMAGE_BYTES = 5_000_000;
const TIMEOUT_MS = 20_000;
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
    capabilities: { tools: false, autonomous: false },
    start(request) {
      let calls = 0;
      return {
        get calls() {
          return calls;
        },
        async step(signal): Promise<ProviderStep> {
          if (request.tools || request.format === "participation") {
            return { ok: false, error: "Gemini does not support this request yet", tokens: 0 };
          }
          const images = await Promise.all(
            request.imageUrls.map((url) =>
              inlineImage(
                fetchImpl,
                url,
                AbortSignal.any([signal, AbortSignal.timeout(attemptMs)]),
              ),
            ),
          );
          const contents = [
            {
              role: "user",
              parts: [{ text: request.userText }, ...images.filter((image) => image !== null)],
            },
          ];
          const systemInstruction = [persona, request.instructions].filter(Boolean).join("\n\n");
          let lastError = "";
          for (const model of models) {
            calls++;
            try {
              const response = await client.models.generateContent({
                model,
                contents,
                config: {
                  systemInstruction,
                  abortSignal: AbortSignal.any([signal, AbortSignal.timeout(attemptMs)]),
                  automaticFunctionCalling: { disable: true },
                },
              });
              const parts = response.candidates?.[0]?.content?.parts ?? [];
              const text = parts
                .filter((part) => !part.thought)
                .map((part) => part.text ?? "")
                .join("")
                .trim();
              console.log("[AI] model:", model);
              return {
                ok: true,
                text: text || null,
                toolCalls: [],
                tokens: response.usageMetadata?.totalTokenCount ?? 0,
              };
            } catch (error) {
              // The caller gave up, so stop rather than spend calls on more models.
              if (signal.aborted) throw error;
              const status = error instanceof ApiError ? error.status : 0;
              lastError = `Gemini error ${status || "no response"}: ${(error as Error).message}`;
              if (STOP_STATUSES.includes(status)) return { ok: false, error: lastError, tokens: 0 };
              console.warn(
                `[AI] ${model} failed (${status || "no response"}); trying the next model`,
              );
            }
          }
          return { ok: false, error: lastError, tokens: 0 };
        },
        addToolResults() {
          throw new Error("Gemini does not support tools yet");
        },
      };
    },
  };
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
