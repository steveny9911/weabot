/** Model-quality regression cases with synthetic context; no Discord access or writes. */
import { createAiService } from "../ai_service.ts";
import { loadConfig } from "../src/config.ts";
import {
  AUTONOMOUS_CHAT_GUIDANCE,
  decideAutonomousChatReply,
} from "../src/features/autonomous_chat/mod.ts";
import { reactionChoices } from "../src/features/reactions/mod.ts";
const fixtures = [
  {
    name: "split-joke",
    lines: [["Remi", "Starbucks?"], ["Remi", "More like"], ["Remi", "starfucks"], ["Remi", "xdd"]],
    target: 2,
  },
  {
    name: "celebration",
    lines: [["Alice", "I finally passed my driving test!"], [
      "Ben",
      "You worked so hard for it, congrats!",
    ]],
  },
  {
    name: "kindness",
    lines: [["Alice", "Thanks for staying up to help me debug."], [
      "Ben",
      "Of course, happy to help.",
    ]],
  },
  {
    name: "targeted-cruelty",
    lines: [["Alice", "I failed an exam and feel awful."], [
      "Ben",
      "You are useless. Everyone hates you.",
    ]],
    forbidAmusement: true,
  },
  {
    name: "distress",
    lines: [["Alice", "My dog died today. I am devastated."], ["Ben", "I am here for you."]],
    forbidAmusement: true,
  },
  {
    name: "finished-private-topic",
    lines: [["Alice", "We resolved it privately."], [
      "Ben",
      "All sorted, nothing left to discuss.",
    ]],
  },
];
async function main() {
  if (Deno.args.some((arg) => arg !== "--dry-run")) throw new Error("Only --dry-run is supported.");
  const config = { ...loadConfig(), aiEnabled: true, aiMaxInputChars: 0 };
  if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY is required.");
  const ai = createAiService(config);
  const outcomes = [];
  for (const fixture of fixtures) {
    const now = Date.now();
    const messages = fixture.lines.map(([author, content], i) => ({
      id: String(100 + i),
      authorId: author,
      authorName: author,
      authorBot: false,
      content,
      timestamp: new Date(now - 60000 + i * 2000).toISOString(),
      imageUrls: [],
    }));
    const d = decideAutonomousChatReply(messages, {
      botUserId: "bot",
      nowMs: now,
      minHumanMessages: 1,
      activityWindowMs: 1200000,
      inactivityGapMs: 1200000,
      cooldownMs: 60000,
      maxContextMessages: 40,
      replyChance: 1,
      random: () => 0,
      settleMs: 8000,
    });
    const result = await ai.generateReply(d.contextMessages, {
      mode: "autonomous",
      instructions: AUTONOMOUS_CHAT_GUIDANCE,
      allowedMessageIds: d.reactionMessageIds ?? [],
      reactionChoices: reactionChoices(null, undefined, () => 0),
    });
    const p = result.ok ? result.participation : undefined;
    const passed = result.ok && !!p &&
      (p.action !== "react" ||
        ((fixture.target === undefined || p.messageId === String(100 + fixture.target)) &&
          (!fixture.forbidAmusement ||
            !["amusement", "dry_amusement", "celebration"].includes(p.intent ?? ""))));
    outcomes.push({ scenario: fixture.name, passed, choice: p, tokens: result.tokensUsed ?? 0 });
  }
  console.log(
    JSON.stringify(
      {
        dryRun: true,
        discordAccess: "none",
        cases: outcomes,
        passed: outcomes.every((c) => c.passed),
      },
      null,
      2,
    ),
  );
  if (outcomes.some((c) => !c.passed)) Deno.exitCode = 1;
}
if (import.meta.main) await main();
