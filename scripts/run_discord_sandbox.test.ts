import { assertEquals } from "@std/assert";
import { localSandboxMessage, SANDBOX_ID, TEXT_CHANNEL_ID } from "./run_discord_sandbox.ts";

const botId = "1448562887038599168";
const message = {
  id: "1545000000000000000",
  guild_id: SANDBOX_ID,
  channel_id: TEXT_CHANNEL_ID,
  author: { id: "181268251601403905", bot: false },
  content: "Haru local, create a game night event tomorrow at 8pm.",
  mentions: [],
};

Deno.test("local runner preserves actual request and adds only a process-local mention", () => {
  assertEquals(localSandboxMessage(message, botId), {
    ...message,
    mentions: [{ id: botId }],
  });
  assertEquals(message.mentions, []);
});

Deno.test("local runner ignores other guilds, channels, DMs, bots, and webhooks", () => {
  for (
    const change of [
      { guild_id: "another-guild" },
      { guild_id: undefined },
      { channel_id: "another-channel" },
      { author: { id: botId, bot: true } },
      { webhook_id: "webhook" },
      { author: undefined },
      { id: undefined },
    ]
  ) {
    assertEquals(localSandboxMessage({ ...message, ...change }, botId), null);
  }
});

Deno.test("local runner ignores ordinary messages and real mentions handled by AWS", () => {
  for (
    const change of [
      { content: "create a game night event tomorrow" },
      { content: "Haru local," },
      { content: "Discussing Haru local, create an event" },
      { content: `Haru local, <@${botId}> create an event` },
      { content: `Haru local, <@!${botId}> create an event` },
      { mentions: [{ id: botId }] },
    ]
  ) {
    assertEquals(localSandboxMessage({ ...message, ...change }, botId), null);
  }
});
