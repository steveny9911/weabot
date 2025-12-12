// Simple AI service wrapper that calls OpenAI Chat Completions (ChatGPT)

const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export async function generateReplyFromMessages(
  messages: Array<Record<string, unknown>>,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (!OPENAI_KEY) return { ok: false, error: "OPENAI_API_KEY not set" };

  // Build a single prompt from the cached messages (chronological oldest->newest)
  const lines = messages.map((m) => {
    const author = (m.author as string) ?? "unknown";
    const text = (m.content as string) ?? "";
    return `${author}: ${text}`;
  });
  const userContent = `Here is the recent conversation (oldest->newest):\n\n${lines.join("\n")}\n\nRespond in-character as the assistant described in the system instructions.`;

  const ENABLE_UWU = (Deno.env.get("ENABLE_UWU") ?? "true").toLowerCase() !== "false";

  // stronger instruction to avoid repetitive generic greetings
  const systemPrompt = `You are Mambo, a cheerful and energetic Umamusume (horse girl) character. Speak like a friendly teammate and racer: be playful, upbeat, and encouraging. Use casual language, contractions, short sentences. Do NOT use emoji or emoticons in replies. Never mention OpenAI, API, errors, or say you "can't" or "cannot". Never apologize for failures or discuss technical details. If asked to do something you cannot, offer a fun alternative or a helpful suggestion instead, staying fully in-character. Keep replies concise (one to three sentences) and avoid explicit or offensive content. Do NOT begin responses with a generic greeting such as "hey", "hello", "hi", or "hey there" — start directly in-character. When appropriate, use a light, cute "UwU"-style voice (textual only): sprinkle small playful modifiers and gentle "w"-style sounds, but avoid making the reply unreadable.`; 

  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: systemPrompt },
          // few-shot examples to guide voice and brevity
          { role: "user", content: "User: Who wants ramen tonight?" },
          { role: "assistant", content: "I am so in! Ramen party tonight? Count me in!" },
          { role: "user", content: "User: How should I train for a race?" },
          { role: "assistant", content: "Short sprints and good rest — push hard, then recover. You got this!" },
          { role: "user", content: userContent },
        ],
        max_tokens: 350,
        temperature: 0.8,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `OpenAI error ${res.status}: ${body}` };
    }
    const data = await res.json();
    const choice = data.choices && data.choices[0];
    const text = choice?.message?.content ?? choice?.text ?? null;
    if (!text) return { ok: false, error: "No text in OpenAI response" };
    const raw = String(text).trim();

    // simple sanitization: remove obvious apologetic/failure phrases the model might output
    const sanitized = raw.replace(/\b(I(')?m sorry|I cannot|I can't|I couldn't|unable to)\b/gi, "").trim();

    // remove generic leading greetings that the model may habitually add
    const noGreeting = sanitized.replace(/^(?:hey(?: there)?|hello(?: there)?|hi(?: there)?|yo|greetings)[,!.\s-]*/i, "").trim();

    // lightweight uwuifier (optional) — keep it mild to avoid unreadable text
    const uwuify = (s: string): string => {
      if (!ENABLE_UWU) return s;
      // Keep text highly readable. Apply only light, cosmetic changes:
      // - soften trailing punctuation (!, ?) with a tilde
      // - for short replies, optionally append a small "uwu" marker (only if no emoji present)
      let out = s;
      // soften punctuation
      out = out.replace(/!+/g, "!~");
      out = out.replace(/\?+/g, "?~");

      // If the reply is short and doesn't already contain emoji or uwu-like tokens,
      // append a mild " uwu" to give a cute flavour while preserving readability.
  const hasEmojiOrUwU = /\p{Emoji}/u.test(out) || /uwu|owo|UwU/i.test(out);
      if (out.length <= 80 && !hasEmojiOrUwU) {
        out = out + " uwu";
      }

      return out;
    };

  const finalText = uwuify(noGreeting);
  // also log sanitized intermediate for debugging
  console.log("[AI sanitized reply]:", noGreeting);
    // log raw + final for easier iteration (these go to stdout)
    console.log("[AI raw reply]:", raw);
    console.log("[AI final reply]:", finalText);

    return { ok: true, text: finalText };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export default { generateReplyFromMessages };
