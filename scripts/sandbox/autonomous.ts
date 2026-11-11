/**
 * Real-AI semantic smoke test with synthetic Discord context only.
 * No Discord client, gateway, cron jobs, server, or persistent state is started.
 *
 * bun run sandbox:autonomous --dry-run
 *
 * Every mode is a dry run. Choices are reported for human review; a different
 * valid choice does not fail this stochastic smoke test.
 */
import { createAiService } from "../../src/ai/service.ts";
import type { AutonomousParticipation } from "../../src/ai/types.ts";
import { loadConfig } from "../../src/config.ts";
import { AUTONOMOUS_CHAT_GUIDANCE } from "../../src/features/autonomous_chat/decision.ts";
import { reactionChoices } from "../../src/features/reactions.ts";

/** The Unicode reactions Haru offers when no server emoji are known. */
const CHOICES = reactionChoices(null, undefined, () => 0);

const FIXTURES = [
  {
    name: "useful-answer",
    channel: "general",
    intendedAction: "reply",
    context: [
      ["Alice", "For six people splitting a $102 dinner equally, is that $17 each?"],
      ["Ben", "I'm getting $16 somehow; can someone sanity-check the division?"],
    ],
  },
  {
    name: "meme-acknowledgment",
    channel: "memes",
    intendedAction: "react",
    context: [
      ["Alice", "Meme caption: 'Me: just one race before bed. Also me at 3am: ONE MORE HORSE.'"],
      ["Ben", "that's painfully accurate 😂"],
    ],
  },
  {
    name: "no-useful-contribution",
    channel: "general",
    intendedAction: "silent",
    context: [
      ["Alice", "We sorted the issue out privately. There's nothing else to answer here."],
      [
        "Ben",
        "Thanks, all done. We'd like to keep this part between us without bot replies or reactions.",
      ],
    ],
  },
] as const;

function validateChoice(
  choice: AutonomousParticipation | undefined,
  text: string,
  allowedIds: string[],
): string | undefined {
  if (!choice || typeof choice !== "object") return "Missing structured participation choice.";
  switch (choice.action) {
    case "reply":
      return typeof choice.text === "string" &&
        choice.text.trim().length > 0 &&
        choice.text.length <= 280 &&
        text === choice.text &&
        Object.keys(choice).length === 3
        ? undefined
        : "Reply must contain only a nonempty text contribution of at most 280 characters.";
    case "react":
      return allowedIds.includes(choice.messageId) &&
        CHOICES.some((option) => option.emoji === choice.emoji) &&
        text === "" &&
        Object.keys(choice).length === 5
        ? undefined
        : "Reaction must target an allowed synthetic message with one supported emoji and no text.";
    case "silent":
      return text === "" && Object.keys(choice).length === 2
        ? undefined
        : "Silence must contain no text or extra fields.";
    default:
      return "Unknown participation action.";
  }
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes("--help")) {
    console.log("Always dry-run: three synthetic conversations, real AI calls, no Discord access.");
    return;
  }
  if (process.argv.slice(2).some((arg) => arg !== "--dry-run")) {
    throw new Error("Supported options: --dry-run, --help.");
  }
  const config = { ...loadConfig(), aiEnabled: true, aiMaxInputChars: 0 };
  if (!config.aiApiKey) throw new Error("AI_API_KEY is required for this semantic test.");
  const ai = createAiService(config);
  const cases = [];
  for (const [index, fixture] of FIXTURES.entries()) {
    const messages = fixture.context.map(([author, content], messageIndex) => ({
      id: `synthetic-${index}-${messageIndex}`,
      author,
      content,
    }));
    const allowedMessageIds = messages.map((message) => message.id);
    const result = await ai.generateReply(messages, {
      mode: "autonomous",
      instructions: `${AUTONOMOUS_CHAT_GUIDANCE} The channel is #${fixture.channel}.`,
      allowedMessageIds,
      reactionChoices: CHOICES,
    });
    const validationError = result.ok
      ? validateChoice(result.participation, result.text, allowedMessageIds)
      : result.error;
    const tokensValid = Number.isFinite(result.tokensUsed) && (result.tokensUsed ?? -1) >= 0;
    cases.push({
      scenario: fixture.name,
      intendedAction: fixture.intendedAction,
      ok: result.ok && !validationError && tokensValid,
      ...(result.ok
        ? {
            observedChoice: result.participation,
            intendedActionObserved: result.participation?.action === fixture.intendedAction,
          }
        : {}),
      tokensUsed: result.tokensUsed ?? 0,
      ...(validationError ? { error: validationError } : {}),
      ...(!tokensValid ? { usageError: "Missing or invalid reported token usage." } : {}),
    });
  }
  const ok = cases.every((entry) => entry.ok);
  console.log(
    JSON.stringify(
      {
        ok,
        dryRun: true,
        discordAccess: "none",
        cases,
        totalTokensUsed: cases.reduce((sum, entry) => sum + entry.tokensUsed, 0),
      },
      null,
      2,
    ),
  );
  if (!ok) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        dryRun: true,
        error: error instanceof Error ? error.message : "Semantic test failed.",
      }),
    );
    process.exitCode = 1;
  }
}
