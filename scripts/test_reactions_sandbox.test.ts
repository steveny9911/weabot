import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  REACTION_SANDBOX_CHANNEL,
  sandboxDiscord,
  sandboxOptions,
} from "./test_reactions_sandbox.ts";
import type { DiscordClient } from "../src/services/discord.ts";
Deno.test("sandbox requires one explicit message boundary and never accepts arbitrary destination flags", () => {
  assertEquals(sandboxOptions(["--after=100"]), { send: false, after: "100" });
  assertEquals(sandboxOptions(["--send", "--after=100"]), { send: true, after: "100" });
  for (
    const args of [[], ["--send"], ["--after=100", "--after=200"], [
      "--after=100",
      "--channel=production",
    ], ["--send", "--dry-run", "--after=100"]]
  ) assertThrows(() => sandboxOptions(args));
});
Deno.test("sandbox transport refuses other channels, DMs, and targets before its boundary", async () => {
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
  assertThrows(() => scoped.postMessage("production", { content: "hello" }));
  assertThrows(() => scoped.addReaction("production", "101", "😂"));
  assertThrows(() => scoped.addReaction(REACTION_SANDBOX_CHANNEL, "100", "😂"));
  await assertRejects(() => scoped.sendDM("user", { content: "hello" }));
  assertEquals(writes, 0);
  await scoped.addReaction(REACTION_SANDBOX_CHANNEL, "101", "😂");
  assertEquals(writes, 1);
});
