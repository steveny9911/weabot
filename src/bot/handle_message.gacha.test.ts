import { expect, test } from "bun:test";
import { handleMessage, type BotDependencies } from "./handle_message.ts";
import { isGachaCommand } from "./commands.ts";
import type { GachaResult, GachaService } from "../features/gacha.ts";
import { testConfig, type ConfigOverrides } from "../../tests/support/config.ts";
import { fakeDiscord } from "../../tests/support/discord.ts";

const image = new Uint8Array([1, 2, 3]);

function setup(
  options: {
    config?: ConfigOverrides;
    result?: GachaResult;
    sendOk?: boolean;
    withService?: boolean;
  } = {},
) {
  const sent: string[] = [];
  const images: Array<{ channelId: string; filename: string; altText?: string; replyTo: string }> =
    [];
  const typing: string[] = [];
  const pulls: string[] = [];
  const unexpected = (name: string) => () => Promise.reject(new Error(`unexpected ${name}`));
  const gachaService: GachaService = {
    pull(userId) {
      pulls.push(userId);
      return Promise.resolve(options.result ?? { ok: true, image, altText: "alt" });
    },
  };
  const deps: BotDependencies = {
    // AI is off: \gacha must not need it.
    config: testConfig({ aiEnabled: false }, options.config ?? {}),
    discord: fakeDiscord({ sent, images, typing, sendOk: options.sendOk }),
    aiService: { generateReply: unexpected("generateReply") },
    rateLimitService: {
      admitRequest: unexpected("admitRequest"),
      recordModelCalls: unexpected("recordModelCalls"),
      recordTokenUsage: unexpected("recordTokenUsage"),
      getUsageStats: unexpected("getUsageStats"),
    },
    linkOpenService: { open: unexpected("open") },
    storageService: {
      setContextReset: unexpected("setContextReset"),
      getContextReset: unexpected("getContextReset"),
    },
    ...(options.withService === false ? {} : { gachaService }),
  };
  return { deps, sent, images, typing, pulls };
}

function mention(content: string, channelId = "chan-1"): Record<string, unknown> {
  return {
    id: "msg-1",
    channel_id: channelId,
    content,
    author: { id: "user-1", username: "alice", bot: false },
    mentions: [{ id: "12345", username: "Haru" }],
    timestamp: "2026-03-01T12:00:00.000Z",
  };
}

test("isGachaCommand matches only a bare \\gacha, with or without a mention", () => {
  expect(isGachaCommand("<@12345> \\gacha")).toStrictEqual(true);
  expect(isGachaCommand(" <@!12345>  \\GaCha ")).toStrictEqual(true);
  expect(isGachaCommand("\\gacha")).toStrictEqual(true);
  expect(isGachaCommand("<@12345> \\gacha 50")).toStrictEqual(false);
  expect(isGachaCommand("<@12345> do a \\gacha")).toStrictEqual(false);
  expect(isGachaCommand("<@12345> \\gachas")).toStrictEqual(false);
});

test("\\gacha replies to the message with the image, with AI off", async () => {
  const state = setup();
  await handleMessage(mention("<@12345> \\gacha"), state.deps);
  expect(state.pulls).toStrictEqual(["user-1"]);
  expect(state.typing).toStrictEqual(["chan-1"]);
  expect(state.images).toStrictEqual([
    { channelId: "chan-1", filename: "gacha.png", altText: "alt", replyTo: "msg-1" },
  ]);
  expect(state.sent).toStrictEqual([]);
});

test("\\gacha says so when the feature is off in the channel, and pulls nothing", async () => {
  for (const config of [{ gacha: { enabled: false } }, { gacha: { channelIds: ["elsewhere"] } }]) {
    const state = setup({ config });
    await handleMessage(mention("<@12345> \\gacha"), state.deps);
    expect(state.sent).toStrictEqual(["Ehehe~ the gacha is turned off right now."]);
    expect(state.pulls).toStrictEqual([]);
    expect(state.images).toStrictEqual([]);
  }
});

test("\\gacha says it is off when the bot has no gacha service", async () => {
  const state = setup({ withService: false });
  await handleMessage(mention("<@12345> \\gacha"), state.deps);
  expect(state.sent).toStrictEqual(["Ehehe~ the gacha is turned off right now."]);
});

test("\\gacha tells a user on cooldown how long to wait", async () => {
  const state = setup({ result: { ok: false, reason: "cooldown", retryInMs: 12_000 } });
  await handleMessage(mention("<@12345> \\gacha"), state.deps);
  expect(state.sent).toStrictEqual(["Easy there~ try again in 12 seconds~"]);
  expect(state.images).toStrictEqual([]);
});

test("\\gacha answers a failed render with an apology and sends no image", async () => {
  const state = setup({ result: { ok: false, reason: "failed", error: "boom" } });
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    await handleMessage(mention("<@12345> \\gacha"), state.deps);
  } finally {
    console.error = original;
  }
  expect(state.sent).toStrictEqual(["Eep... the gacha machine jammed. Try again in a moment~"]);
  expect(state.images).toStrictEqual([]);
  expect(errors).toStrictEqual([["[GACHA] Failed: boom"]]);
});

test("\\gacha apologises when the upload is refused", async () => {
  const state = setup({ sendOk: false });
  await handleMessage(mention("<@12345> \\gacha"), state.deps);
  expect(state.images.length).toStrictEqual(1);
  expect(state.sent).toStrictEqual(["Eep... I couldn't send the picture. Try again in a moment~"]);
});

test("\\gacha without a mention is ignored", async () => {
  const state = setup();
  await handleMessage({ ...mention("\\gacha"), mentions: [] }, state.deps);
  expect(state.pulls).toStrictEqual([]);
  expect(state.sent).toStrictEqual([]);
});
