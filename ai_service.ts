/**
 * AI Service
 *
 * Handles OpenAI Responses API calls with safety controls.
 * Uses dependency injection for testability and configuration.
 */

import type { AppConfig } from "./src/config.ts";

const OPENAI_URL = "https://api.openai.com/v1/responses";
const OPENAI_CHAT_BUILDER_PROMPT = {
  id: "pmpt_6971ba873da4819097808c4de837bbfd0c33418debd7844b",
} as const;
const MAX_CONTEXT_IMAGES = 6;
const MAX_TOOL_RESPONSES = 6;
const MAX_TOOL_CALLS = 8;
const RESPONSE_TIMEOUT_MS = 60_000;
const TOOL_LOOP_TIMEOUT_MS = 120_000;

/** Bound both receiving headers and consuming the response body. */
async function withResponseDeadline<T>(
  timeoutMs: number,
  timeoutMessage: string,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([request(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Successful AI response with token usage */
export interface AiSuccessResult {
  ok: true;
  text: string;
  tokensUsed: number;
}

/** Failed AI response */
export interface AiErrorResult {
  ok: false;
  error: string;
  /** Tokens consumed before a tool-enabled request failed. */
  tokensUsed?: number;
}

export type AiResult = AiSuccessResult | AiErrorResult;

/** Action capabilities scoped to one explicitly requested reply. */
export interface AiReplyOptions {
  instructions: string;
  /** Latest human request, separate from untrusted conversation/reference context. */
  currentUserMessage?: string;
  tools: Array<Record<string, unknown>>;
  executeTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** AI service interface for dependency injection */
export interface AiService {
  /** Generate a reply from conversation messages */
  generateReply(
    messages: Array<Record<string, unknown>>,
    options?: AiReplyOptions,
  ): Promise<AiResult>;
}

/**
 * Extracts assistant text from OpenAI Responses API payloads.
 * Handles both `output_text` and structured `output[].content[]` shapes.
 */
function szExtractResponseText(data: Record<string, unknown>): string | null {
  const top_level_output_text = data.output_text;
  if (typeof top_level_output_text === "string" && top_level_output_text.trim().length > 0) {
    return top_level_output_text;
  }

  const output = data.output;
  if (!Array.isArray(output)) return null;

  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const part_obj = part as Record<string, unknown>;

      // Common shape: { type: "output_text", text: "..." }
      if (typeof part_obj.text === "string" && part_obj.text.trim().length > 0) {
        chunks.push(part_obj.text);
        continue;
      }

      // Alternate shape: { type: "output_text", text: { value: "..." } }
      if (
        part_obj.text && typeof part_obj.text === "object" &&
        typeof (part_obj.text as Record<string, unknown>).value === "string"
      ) {
        const value = (part_obj.text as Record<string, unknown>).value as string;
        if (value.trim().length > 0) chunks.push(value);
      }
    }
  }

  if (chunks.length === 0) return null;
  return chunks.join("\n").trim();
}

function bIsHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function aszGetImageUrlsFromContextMessage(message: Record<string, unknown>): string[] {
  const raw_urls = message["imageUrls"] ?? message["images"];
  if (!Array.isArray(raw_urls)) return [];

  const urls: string[] = [];
  for (const raw_url of raw_urls) {
    if (typeof raw_url !== "string") continue;
    const trimmed = raw_url.trim();
    if (!trimmed || !bIsHttpUrl(trimmed)) continue;
    urls.push(trimmed);
  }
  return urls;
}

function oGetReplyReference(
  message: Record<string, unknown>,
): Record<string, unknown> | null {
  const reference = message["repliedTo"];
  return reference && typeof reference === "object" ? reference as Record<string, unknown> : null;
}

function aszCollectImageUrls(
  messages: Array<Record<string, unknown>>,
  max_images: number,
): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const message of messages) {
    const reference = oGetReplyReference(message);
    const candidates = [
      ...aszGetImageUrlsFromContextMessage(message),
      ...(reference ? aszGetImageUrlsFromContextMessage(reference) : []),
    ];
    for (const url of candidates) {
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
      if (urls.length >= max_images) {
        return urls;
      }
    }
  }

  return urls;
}

/**
 * Truncates a string to the specified max length, adding ellipsis if needed.
 */
function vTruncateText(text: string, max_chars: number): string {
  if (text.length <= max_chars) return text;
  return text.slice(0, max_chars - 3) + "...";
}

/**
 * Creates an AI service with the given configuration.
 */
export function createAiService(
  config: AppConfig,
  runtime: {
    requestTimeoutMs?: number;
    toolLoopTimeoutMs?: number;
    now?: () => number;
  } = {},
): AiService {
  const requestTimeoutMs = runtime.requestTimeoutMs ?? RESPONSE_TIMEOUT_MS;
  const toolLoopTimeoutMs = runtime.toolLoopTimeoutMs ?? TOOL_LOOP_TIMEOUT_MS;
  const now = runtime.now ?? (() => performance.now());
  /**
   * Applies light UwU-style text transformation if enabled.
   */
  function szUwuify(text: string): string {
    if (!config.aiEnableUwu) return text;

    let out = text;
    // Soften punctuation with tildes
    out = out.replace(/!+/g, "!~");
    out = out.replace(/\?+/g, "?~");

    // For short replies without emoji/uwu, append a mild " uwu"
    const has_emoji_or_uwu = /\p{Emoji}/u.test(out) || /uwu|owo|UwU/i.test(out);
    if (out.length <= 80 && !has_emoji_or_uwu) {
      out = out + " uwu";
    }

    return out;
  }

  /**
   * Sanitizes the AI response text.
   */
  function szSanitizeReply(raw: string): string {
    // Remove apologetic/failure phrases
    let sanitized = raw.replace(
      /\b(I(')?m sorry|I cannot|I can't|I couldn't|unable to)\b/gi,
      "",
    ).trim();

    // Remove generic leading greetings
    sanitized = sanitized.replace(
      /^(?:hey(?: there)?|hello(?: there)?|hi(?: there)?|yo|greetings)[,!.\s-]*/i,
      "",
    ).trim();

    return sanitized;
  }

  return {
    async generateReply(
      messages: Array<Record<string, unknown>>,
      options?: AiReplyOptions,
    ): Promise<AiResult> {
      // Check if AI is enabled
      if (!config.aiEnabled) {
        return { ok: false, error: "AI is disabled" };
      }

      // Check if API key is configured
      if (!config.openaiApiKey) {
        return { ok: false, error: "OPENAI_API_KEY not set" };
      }

      // Build prompt from messages (no truncation unless explicitly configured)
      const lines = messages.map((m) => {
        const author = (m.author as string) ?? "unknown";
        const raw_text = (m.content as string) ?? "";
        const max_input_chars = config.aiMaxInputChars;
        const text = max_input_chars > 0 ? vTruncateText(raw_text, max_input_chars) : raw_text;
        const image_count = aszGetImageUrlsFromContextMessage(m).length;
        const image_hint = image_count > 0
          ? (image_count === 1 ? " [attached 1 image]" : ` [attached ${image_count} images]`)
          : "";
        const reference = oGetReplyReference(m);
        if (!reference) return `${author}: ${text}${image_hint}`;

        const reference_author = (reference["author"] as string) ?? "unknown";
        const raw_reference_text = (reference["content"] as string) ?? "";
        const reference_text = max_input_chars > 0
          ? vTruncateText(raw_reference_text, max_input_chars)
          : raw_reference_text;
        const reference_image_count = aszGetImageUrlsFromContextMessage(reference).length;
        const reference_image_hint = reference_image_count > 0
          ? (reference_image_count === 1
            ? " [attached 1 image]"
            : ` [attached ${reference_image_count} images]`)
          : "";
        return `${author} (replying to ${reference_author}: ${reference_text}${reference_image_hint}): ${text}${image_hint}`;
      });
      const image_urls = aszCollectImageUrls(messages, MAX_CONTEXT_IMAGES);

      const user_content = `Here is the recent conversation (oldest->newest):\n\n${
        lines.join("\n")
      }\n\nRespond in-character as the assistant described in the system instructions.`;

      const input_content: Array<Record<string, unknown>> = [{
        type: "input_text",
        text: user_content,
      }];
      for (const image_url of image_urls) {
        input_content.push({
          type: "input_image",
          image_url,
        });
      }

      const input: unknown[] = [
        ...(options ? [{ role: "developer", content: options.instructions }] : []),
        { role: "user", content: input_content },
        ...(options?.currentUserMessage
          ? [{ role: "user", content: options.currentUserMessage }]
          : []),
      ];
      const allowed_tools = new Set(
        (options?.tools ?? [])
          .filter((tool) => tool.type === "function" && typeof tool.name === "string")
          .map((tool) => tool.name as string),
      );
      const tool_results = new Map<string, string>();
      let tokens_used = 0;
      let tool_calls_used = 0;
      const failure = (error: string): AiErrorResult => ({
        ok: false,
        error,
        ...(options ? { tokensUsed: tokens_used } : {}),
      });
      const toolDeadline = now() + toolLoopTimeoutMs;
      const toolTimeExpired = () => Boolean(options && now() >= toolDeadline);

      try {
        const max_responses = options ? MAX_TOOL_RESPONSES : 1;
        for (let response_index = 0; response_index < max_responses; response_index++) {
          if (toolTimeExpired()) return failure("AI tool time limit reached");
          const remainingMs = options ? toolDeadline - now() : requestTimeoutMs;
          const response = await withResponseDeadline(
            Math.min(requestTimeoutMs, remainingMs),
            options && remainingMs <= requestTimeoutMs
              ? "AI tool time limit reached"
              : "OpenAI response timed out",
            async (signal) => {
              const res = await fetch(OPENAI_URL, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${config.openaiApiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  prompt: OPENAI_CHAT_BUILDER_PROMPT,
                  text: { format: { type: "text" } },
                  store: true,
                  input,
                  ...(options
                    ? { tools: options.tools, parallel_tool_calls: false }
                    : { tool_choice: "none" }),
                }),
                signal,
              });
              if (!res.ok) {
                return { error: `OpenAI error ${res.status}: ${await res.text()}` };
              }
              return { data: await res.json() as Record<string, unknown> };
            },
          );
          if (response.error !== undefined) return failure(response.error);
          const data = response.data!;
          const usage = data.usage as
            | { total_tokens?: number; input_tokens?: number; output_tokens?: number }
            | undefined;
          tokens_used += usage?.total_tokens ?? 0;
          if (toolTimeExpired()) return failure("AI tool time limit reached");
          if (options && (data.status === "incomplete" || data.status === "failed")) {
            return failure(`OpenAI response ${data.status}`);
          }

          const output = Array.isArray(data.output) ? data.output : [];
          const calls = output.filter((item): item is Record<string, unknown> =>
            item !== null && typeof item === "object" && item.type === "function_call"
          );
          if (options && calls.length > 0) {
            // Leave a response available to report results before permitting any writes.
            if (response_index + 1 >= max_responses) {
              return failure("AI tool response limit reached");
            }
            if (tool_calls_used + calls.length > MAX_TOOL_CALLS) {
              return failure("AI tool call limit reached");
            }
            if (calls.some((call) => typeof call.call_id !== "string" || !call.call_id.trim())) {
              return failure("AI tool call is missing a call_id");
            }
            tool_calls_used += calls.length;

            // Reasoning and every other output item must survive manual continuation.
            input.push(...output);
            for (const call of calls) {
              // Count tool execution time in the overall budget, but await an
              // in-flight mutation so its verified receipt is never lost to a race.
              if (toolTimeExpired()) return failure("AI tool time limit reached");
              const call_id = call.call_id as string;
              let result = tool_results.get(call_id);
              if (result === undefined) {
                try {
                  if (typeof call.name !== "string" || !allowed_tools.has(call.name)) {
                    throw new Error(`Unknown tool: ${String(call.name)}`);
                  }
                  if (typeof call.arguments !== "string") {
                    throw new Error("Tool arguments must be a JSON object");
                  }
                  const args: unknown = JSON.parse(call.arguments);
                  if (args === null || typeof args !== "object" || Array.isArray(args)) {
                    throw new Error("Tool arguments must be a JSON object");
                  }
                  result = JSON.stringify(
                    await options.executeTool(call.name, args as Record<string, unknown>),
                  );
                } catch (error) {
                  result = JSON.stringify({ ok: false, error: String(error) });
                }
                tool_results.set(call_id, result);
              }
              input.push({ type: "function_call_output", call_id, output: result });
            }
            continue;
          }

          const text = szExtractResponseText(data);
          if (!text) return failure("No text in OpenAI response");

          const raw = String(text).trim();
          // Action outcomes and links must retain their exact meaning and punctuation.
          const final_text = options ? raw : szUwuify(szSanitizeReply(raw));
          console.log("[AI] tokens used:", tokens_used);
          console.log("[AI] raw reply:", raw);
          console.log("[AI] final reply:", final_text);
          return { ok: true, text: final_text, tokensUsed: tokens_used };
        }
        return failure("AI tool response limit reached");
      } catch (err) {
        return failure(String(err));
      }
    },
  };
}

// Legacy export for backwards compatibility during migration
export async function generateReplyFromMessages(
  messages: Array<Record<string, unknown>>,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  // Create a minimal config from environment for legacy callers
  const web_search_api_key = Deno.env.get("BRAVE_SEARCH_API_KEY");
  const web_search_enabled = (Deno.env.get("WEB_SEARCH_ENABLED") ??
    (web_search_api_key ? "true" : "false")).toLowerCase() !== "false";
  const link_open_enabled = (Deno.env.get("LINK_OPEN_ENABLED") ?? "true").toLowerCase() !==
    "false";
  const channel_ids_raw = Deno.env.get("CHANNEL_IDS");
  const channel_id_single = Deno.env.get("CHANNEL_ID") ?? "";
  const channel_ids = channel_ids_raw
    ? channel_ids_raw.split(",").map((id) => id.trim()).filter(Boolean)
    : (channel_id_single ? [channel_id_single] : []);

  const legacy_config: AppConfig = {
    discordToken: Deno.env.get("DISCORD_TOKEN") ?? "",
    channelId: Deno.env.get("CHANNEL_ID") ?? "",
    channelIds: channel_ids.length > 0 ? channel_ids : [channel_id_single],
    timeZone: Deno.env.get("TIME_ZONE") ?? "America/Los_Angeles",
    glueAlertThreshold: 7,
    aiEnabled: true,
    openaiApiKey: Deno.env.get("OPENAI_API_KEY"),
    aiRateLimitPerUser: 5,
    aiDailyTokenBudget: 10000000,
    aiMaxInputChars: 0,
    aiEnableUwu: (Deno.env.get("ENABLE_UWU") ?? "true").toLowerCase() !== "false",
    aiContextMaxMessages: 40,
    aiContextInactivityMinutes: 20,
    webSearchEnabled: web_search_enabled,
    webSearchApiKey: web_search_api_key,
    webSearchMaxResults: parseInt(Deno.env.get("WEB_SEARCH_MAX_RESULTS") ?? "3", 10),
    linkOpenEnabled: link_open_enabled,
    autonomousChatEnabled: false,
    autonomousChatChannelIds: channel_ids.length > 0 ? channel_ids : [channel_id_single],
    autonomousChatMinHumanMessages: 4,
    autonomousChatActivityWindowMinutes: 20,
    autonomousChatCooldownMinutes: 1,
    autonomousChatReplyChance: 0.35,
    autonomousChatMaxContextMessages: 40,
  };

  const service = createAiService(legacy_config);
  const result = await service.generateReply(messages);

  // Convert to legacy format (without tokensUsed)
  if (result.ok) {
    return { ok: true, text: result.text };
  }
  return result;
}

export default { generateReplyFromMessages, createAiService };
