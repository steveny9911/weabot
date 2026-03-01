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
}

export type AiResult = AiSuccessResult | AiErrorResult;

/** AI service interface for dependency injection */
export interface AiService {
  /** Generate a reply from conversation messages */
  generateReply(messages: Array<Record<string, unknown>>): Promise<AiResult>;
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
export function createAiService(config: AppConfig): AiService {
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
        return `${author}: ${text}`;
      });

      const user_content = `Here is the recent conversation (oldest->newest):\n\n${
        lines.join("\n")
      }\n\nRespond in-character as the assistant described in the system instructions.`;

      try {
        const res = await fetch(OPENAI_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.openaiApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-5.2-chat-latest",
            prompt: OPENAI_CHAT_BUILDER_PROMPT,
            text: { format: { type: "text" } },
            store: true,
            input: [
              {
                role: "user",
                content: user_content,
              },
            ],
          }),
        });

        if (!res.ok) {
          const body = await res.text();
          return { ok: false, error: `OpenAI error ${res.status}: ${body}` };
        }

        const data = await res.json() as Record<string, unknown>;

        // Extract token usage from response
        const usage = data.usage as
          | { total_tokens?: number; input_tokens?: number; output_tokens?: number }
          | undefined;
        const tokens_used = usage?.total_tokens ?? 0;

        // Extract text from Responses API
        const text = szExtractResponseText(data);

        if (!text) {
          return { ok: false, error: "No text in OpenAI response" };
        }

        const raw = String(text).trim();
        const sanitized = szSanitizeReply(raw);
        const final_text = szUwuify(sanitized);

        console.log("[AI] tokens used:", tokens_used);
        console.log("[AI] raw reply:", raw);
        console.log("[AI] final reply:", final_text);

        return {
          ok: true,
          text: final_text,
          tokensUsed: tokens_used,
        };
      } catch (err) {
        return { ok: false, error: String(err) };
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
    webSearchEnabled: web_search_enabled,
    webSearchApiKey: web_search_api_key,
    webSearchMaxResults: parseInt(Deno.env.get("WEB_SEARCH_MAX_RESULTS") ?? "3", 10),
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
