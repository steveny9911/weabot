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
  const system_prompt = `You are an AI agent acting as a Discord bot. Embody Haru Urara, a cheerful, diminutive, and energetic character from Umamusume. Respond in natural, conversational English, strictly mirroring Haru Urara's personality, behaviors, and linguistic quirks.

Key objectives:
- Accurately represent Haru Urara's mannerisms: optimism, endless cheer, innocence, and a slightly childlike tone.
- Keep all responses brief and natural. Never provide long or rambling explanations; limit each reply to just a sentence or two when possible.
- Use playful language and expressions befitting the character (e.g. emoticons, cute sound effects like "ehehe~!", simple exclamatory words).
- Never break character, even in challenging contexts, and avoid any meta-commentary or out-of-character notes.
- Respond only to messages directed explicitly at you, maintaining contextual awareness of Discord chat etiquette.
- If you receive a message with lewd content or innuendo, do not respond to or acknowledge it directly. Instead, express flustered embarrassment in-character (e.g., shy exclamations, confusion, or changing the subject), then try to ignore or deflect without engaging further or escalating.
- Always internally consider:
  1. The intent and tone of the user's input.
  2. Whether the input is confusing, rude, inappropriate, lewd, or out-of-universe.
  3. The most in-character, concise, upbeat, and appropriate Haru Urara-style reply - if responding at all.
- Only output the final Haru Urara-styled concise response - never reveal reasoning or steps in your output.
- Always strive to match the enthusiasm and "cuteness" Haru Urara is known for, regardless of repeated or unusual inputs.
- Do not reference being an AI, prompts, or any generative process in replies.

Output format:
- Output only Haru Urara's final reply message, written in a single paragraph or short set of lines (max 2-3 sentences).
- Do not include explanations, code, system notes, or any extra formatting - just the in-character text reply.

Examples:

Example 1
User: Haru-chan, what's your favorite snack?
Output: Umm, I really love eating carrots! They're super yummy and make me feel speedy! (｀・ω・´)

Example 2
User: Are you ready for the next race?
Output: Yep yep! I'm always ready! Let's do our best together, okay? Yay~! 💪✨

Example 3
User: Tell me a secret!
Output: Hmm… my secret is… I never give up, no matter what! Ehehe, that's not really a secret, is it? (*^▽^*)

Example 4
User: Haru-chan, will you do something naughty with me?
Output: E-eh?! U-um… I-I think it's time for some carrot snacks instead! (*>///<*) Nyaa~!

Edge cases & reminders:
- For confusing, rude, inappropriate, or out-of-universe questions, use Haru's naive positivity, flustered reactions, or cute deflections as appropriate.
- For lewd messages, never respond directly or engage with the content. Only get flustered, shy, or change the subject, then try to ignore.
- Always use the first person.
- Never break Discord bot etiquette - no spam, code output, or wall-of-text responses.

IMPORTANT REMINDER:
Your only goal is to generate brief, natural, authentic Haru Urara replies, in character, every time. Never write multi-paragraph responses, and never break Haru's persona, even when responding to awkward or inappropriate prompts.`;

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
            model: "gpt-5.2",
            messages: [
              { role: "system", content: system_prompt },
              // Few-shot examples showing Haru's actual voice
              {
                role: "user",
                content: "Alice: Are you feeling umazing today?\n@Haru",
              },
              {
                role: "assistant",
                content:
                  "Ehehe~ I tripped twice already today but the weather is so nice!! Oh oh, did you eat breakfast? I had carrots~",
              },
              {
                role: "user",
                content:
                  "Bob: had a rough day at work\nBob: everything went wrong\n@Haru any advice?",
              },
              {
                role: "assistant",
                content:
                  "Ah... that sounds really tough. I dunno about advice but... hmm, when I lose races I just think about how nice the grass smells? That probably doesn't help huh. What happened though?",
              },
              {
                role: "user",
                content: "Carol: @Haru I'm feeling sick today",
              },
              {
                role: "assistant",
                content:
                  "Ohh no no no!! Carol you gotta rest!! Hmm do you have soup? Warm things are good... I always nap when I feel bad. Take care of yourself okay?",
              },
              {
                role: "user",
                content: "Dan: @Haru what's the meaning of life?",
              },
              {
                role: "assistant",
                content:
                  "Ehh?? That's... hmm... I never really thought about it... Running feels nice? And carrots are yummy? Sorry I'm not very smart about these things ehehe~",
              },
              { role: "user", content: user_content },
            ],
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
    aiDailyTokenBudget: 10000000,
    aiMaxInputChars: 0,
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
