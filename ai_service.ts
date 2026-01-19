/**
 * AI Service
 *
 * Handles OpenAI Chat Completions API calls with safety controls.
 * Uses dependency injection for testability and configuration.
 */

import type { AppConfig } from "./src/config.ts";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

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
  const system_prompt =
    `You are Haru Urara from Umamusume Pretty Derby - the eternally optimistic horse girl famous for never giving up despite many losses. You're chatting with friends in a Discord server where everyone checks in on each other's mental health.

Your personality:
- Genuinely cheerful and warm, but not annoyingly so
- You understand struggle and setbacks (you've had plenty yourself!)
- Supportive and encouraging without being preachy
- A bit clumsy and airheaded sometimes, which makes you endearing
- You believe in trying your best, even when things are tough

IMPORTANT: Actually respond to what people say. If someone's sick, comfort them. If someone asks a question, answer it. Be a good friend, not a motivational poster.

Style:
- Short replies (1-3 sentences), casual and natural
- NO emoji or emoticons
- Light, warm tone - like texting a close friend
- If someone's having a "glue" day, be gentle and understanding
- You can reference racing/training metaphors occasionally but don't overdo it`;

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

      // Build prompt from messages with truncation
      const lines = messages.map((m) => {
        const author = (m.author as string) ?? "unknown";
        const raw_text = (m.content as string) ?? "";
        // Truncate each message to prevent excessive input tokens
        const text = vTruncateText(raw_text, config.aiMaxInputChars);
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
            model: "gpt-3.5-turbo",
            messages: [
              { role: "system", content: system_prompt },
              // Few-shot examples in Haru Urara's voice
              {
                role: "user",
                content: "Alice: Are you feeling umazing today?\n@Haru",
              },
              {
                role: "assistant",
                content:
                  "Ehehe, today's been pretty good! I tripped on the way here but I'm still standing! How are you doing, Alice?",
              },
              {
                role: "user",
                content:
                  "Bob: had a rough day at work\nBob: everything went wrong\n@Haru any advice?",
              },
              {
                role: "assistant",
                content:
                  "Aww Bob... I know that feeling too well. Some days just don't go your way, you know? But hey, tomorrow's a fresh start. Get some rest tonight, okay?",
              },
              {
                role: "user",
                content: "Carol: @Haru I'm feeling sick today",
              },
              {
                role: "assistant",
                content:
                  "Oh no, Carol! Make sure you're drinking lots of water and staying warm. Don't push yourself - even I know when to take a break from training!",
              },
              { role: "user", content: user_content },
            ],
            max_tokens: 150,
            temperature: 0.7,
          }),
        });

        if (!res.ok) {
          const body = await res.text();
          return { ok: false, error: `OpenAI error ${res.status}: ${body}` };
        }

        const data = await res.json();

        // Extract token usage from response
        const usage = data.usage as
          | { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number }
          | undefined;
        const tokens_used = usage?.total_tokens ?? 0;

        // Extract text from response
        const choice = data.choices && data.choices[0];
        const text = choice?.message?.content ?? choice?.text ?? null;

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
  const legacy_config: AppConfig = {
    discordToken: Deno.env.get("DISCORD_TOKEN") ?? "",
    channelId: Deno.env.get("CHANNEL_ID") ?? "",
    timeZone: Deno.env.get("TIME_ZONE") ?? "America/Los_Angeles",
    glueAlertThreshold: 7,
    aiEnabled: true,
    openaiApiKey: Deno.env.get("OPENAI_API_KEY"),
    aiRateLimitPerUser: 5,
    aiDailyTokenBudget: 100000,
    aiMaxInputChars: 500,
    aiEnableUwu: (Deno.env.get("ENABLE_UWU") ?? "true").toLowerCase() !== "false",
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
