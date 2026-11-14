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
    discord: fakeDiscord({ sent, images, sendOk: options.sendOk }),
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
  return { deps, sent, images, pulls };
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
  expect(isGachaCommand("<@12345> \\gacha 50")).toStrictEqual(true); // extra text is ignored
  expect(isGachaCommand("<@12345> do a \\gacha")).toStrictEqual(false);
  expect(isGachaCommand("<@12345> \\gachas")).toStrictEqual(false);
});

test("\\gacha replies to the message with the image, with AI off", async () => {
  const state = setup();
  await handleMessage(mention("<@12345> \\gacha"), state.deps);
  expect(state.pulls).toStrictEqual(["user-1"]);
  expect(state.images).toStrictEqual([
    { channelId: "chan-1", filename: "gacha.png", altText: "alt", replyTo: "msg-1" },
  ]);
  expect(state.sent).toStrictEqual([]);
});

test("\\gacha says so when it is off here or has no service, and pulls nothing", async () => {
  for (const options of [
    { config: { gacha: { enabled: false } } },
    { config: { gacha: { channelIds: ["elsewhere"] } } },
    { withService: false },
  ]) {
    const state = setup(options);
    await handleMessage(mention("<@12345> \\gacha"), state.deps);
    expect(state.sent).toStrictEqual(["Ehehe~ the gacha is turned off right now."]);
    expect(state.pulls).toStrictEqual([]);
    expect(state.images).toStrictEqual([]);
  }
});

test("\\gacha explains each refusal and sends no image", async () => {
  const cases = [
    [{ ok: false, reason: "cooldown", retryInMs: 12_000 }, "Easy there~ try again in 12 seconds~"],
    [
      { ok: false, reason: "busy" },
      "Ehehe~ I'm drawing someone else's pull! Try again in a moment~",
    ],
    [{ ok: false, reason: "failed" }, "Eep... the gacha machine jammed. Try again in a moment~"],
  ] as const;
  for (const [result, text] of cases) {
    const state = setup({ result });
    await handleMessage(mention("<@12345> \\gacha"), state.deps);
    expect(state.sent).toStrictEqual([text]);
    expect(state.images).toStrictEqual([]);
  }
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
