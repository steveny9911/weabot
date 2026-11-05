import { expect, test } from "bun:test";
import { localSandboxMessage, SANDBOX_ID, TEXT_CHANNEL_ID } from "./discord.ts";

const botId = "1448562887038599168";
const message = {
  id: "1545000000000000000",
  guild_id: SANDBOX_ID,
  channel_id: TEXT_CHANNEL_ID,
  author: { id: "181268251601403905", bot: false },
  content: "Haru local, create a game night event tomorrow at 8pm.",
  mentions: [],
};

test("local runner preserves actual request and adds only a process-local mention", () => {
  expect(localSandboxMessage(message, botId)).toStrictEqual({
    ...message,
    mentions: [{ id: botId }],
  });
  expect(message.mentions).toStrictEqual([]);
});

test("local runner ignores other guilds, channels, DMs, bots, and webhooks", () => {
  for (const change of [
    { guild_id: "another-guild" },
    { guild_id: undefined },
    { channel_id: "another-channel" },
    { author: { id: botId, bot: true } },
    { webhook_id: "webhook" },
    { author: undefined },
    { id: undefined },
  ]) {
    expect(localSandboxMessage({ ...message, ...change }, botId)).toStrictEqual(null);
  }
});

test("local runner ignores ordinary messages and real mentions handled by the production bot", () => {
  for (const change of [
    { content: "create a game night event tomorrow" },
    { content: "Haru local," },
    { content: "Discussing Haru local, create an event" },
    { content: `Haru local, <@${botId}> create an event` },
    { content: `Haru local, <@!${botId}> create an event` },
    { mentions: [{ id: botId }] },
  ]) {
    expect(localSandboxMessage({ ...message, ...change }, botId)).toStrictEqual(null);
  }
});
