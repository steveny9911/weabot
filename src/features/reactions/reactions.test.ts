import { assert, assertEquals } from "@std/assert";
import {
  availableReactions,
  isAllowedReaction,
  reactionChoices,
  type ReactionContext,
} from "./mod.ts";

function context(guildId = "589723496473690132"): ReactionContext {
  return {
    guildId,
    channelId: "channel",
    canReact: true,
    memberRoles: ["member"],
    emojis: [
      { id: "1559742515698081933", name: "BocchiSip", available: true, roles: [] },
      { id: "1559742624347328553", name: "RyoDisgust", available: true, roles: [] },
      { id: "1559742646656835637", name: "Madge", available: true, roles: [] },
      { id: "1559742668941041795", name: "UwU", available: true, roles: [] },
      { id: "1559742933555478630", name: "shyggers", available: true, roles: [] },
    ],
  };
}
Deno.test("server repertoire resolves reviewed IDs only within that server", () => {
  assert(
    reactionChoices(context(), undefined, () => 0).some((c) =>
      c.emoji === "BocchiSip:1559742515698081933"
    ),
  );
  assert(availableReactions(context("782856078907277332")).every((c) => !c.emoji.includes(":")));
  assert(availableReactions(context("unknown")).every((c) => !c.emoji.includes(":")));
});
Deno.test("role restrictions, availability, and missing inventory choose fitting Unicode", () => {
  const c = context();
  c.emojis[0].available = false;
  c.emojis[1].roles = ["other"];
  c.emojis[2].roles = ["other"];
  const choices = reactionChoices(c, undefined, () => 0);
  assertEquals(choices.find((c) => c.intent === "dry_amusement")?.emoji, "😅");
  assertEquals(choices.find((c) => c.intent === "disapproval")?.emoji, "😒");
  c.emojis[1].roles = ["member"];
  assert(reactionChoices(c, undefined, () => 0).some((c) => c.emoji.startsWith("RyoDisgust:")));
});
Deno.test("no channel reaction permissions expose no expressions", () => {
  assertEquals(reactionChoices({ ...context(), canReact: false }), []);
});
Deno.test("variation excludes last expression within a meaning and never changes stance", () => {
  const first = reactionChoices(context(), undefined, () => 0).find((c) =>
    c.intent === "appreciation"
  )!;
  const next = reactionChoices(context(), first.emoji, () => 0).find((c) =>
    c.intent === "appreciation"
  )!;
  assert(first.emoji !== next.emoji);
  assertEquals(next.intent, first.intent);
  assert(!isAllowedReaction(next.emoji, "amusement", [next]));
  assertEquals(reactionChoices(null, undefined, () => NaN).length, 6);
});
Deno.test("a renamed reviewed ID keeps its meaning but an unreviewed same-name ID does not", () => {
  const c = context();
  c.emojis[0].name = "SipRename";
  assert(availableReactions(c).some((c) => c.emoji === "SipRename:1559742515698081933"));
  c.emojis[0].id = "unreviewed";
  c.emojis[0].name = "BocchiSip";
  assert(
    availableReactions(c).filter((c) => c.intent === "dry_amusement").every((c) =>
      !c.emoji.includes(":")
    ),
  );
});
