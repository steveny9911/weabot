import { expect, test } from "bun:test";
import { rejects, throws } from "../../tests/support/assert.ts";
import { REACTION_SANDBOX_CHANNEL, sandboxDiscord, sandboxOptions } from "./reactions.ts";
import type { DiscordClient } from "../../src/discord/client.ts";
test("sandbox requires one explicit message boundary and never accepts arbitrary destination flags", () => {
  expect(sandboxOptions(["--after=100"])).toStrictEqual({ send: false, after: "100" });
  expect(sandboxOptions(["--send", "--after=100"])).toStrictEqual({ send: true, after: "100" });
  for (const args of [
    [],
    ["--send"],
    ["--after=100", "--after=200"],
    ["--after=100", "--channel=production"],
    ["--send", "--dry-run", "--after=100"],
  ])
    throws(() => sandboxOptions(args), Error, "Use [--send | --dry-run] --after=<message ID>.");
});
test("sandbox transport refuses other channels, DMs, and targets before its boundary", async () => {
  let writes = 0;
  const real = {
    postMessage: () => {
      writes++;
      return Promise.resolve(new Response(null, { status: 204 }));
    },
    addReaction: () => {
      writes++;
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  } as unknown as DiscordClient;
  const scoped = sandboxDiscord(real, "100");
  throws(() => scoped.postMessage("production", { content: "hello" }), Error, "Only Bot Sandbox");
  throws(() => scoped.addReaction("production", "101", "😂"), Error, "Only Bot Sandbox");
  throws(
    () => scoped.addReaction(REACTION_SANDBOX_CHANNEL, "100", "😂"),
    Error,
    "predates the test boundary",
  );
  await rejects(() => scoped.sendDM("user", { content: "hello" }), Error, "cannot send DMs");
  expect(writes).toBe(0);
  await scoped.addReaction(REACTION_SANDBOX_CHANNEL, "101", "😂");
  expect(writes).toBe(1);
});
