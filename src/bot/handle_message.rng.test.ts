import { expect, test } from "bun:test";
import { handleMessage, type BotDependencies } from "./handle_message.ts";
import { isRngCommand } from "./commands.ts";
import type { RngService } from "../features/rng.ts";
import { testConfig, type ConfigOverrides } from "../../tests/support/config.ts";
import { fakeDiscord } from "../../tests/support/discord.ts";
import { captureLogs } from "../../tests/support/logs.ts";

function setup(
  options: {
    config?: ConfigOverrides;
    fresh?: boolean;
    /** The service is still answering this user's previous request. */
    limited?: boolean;
    messageId?: string | null;
    sendOk?: boolean;
    editOk?: boolean;
    /** Each wait really takes this long, as when Discord is slow. */
    waitMs?: number;
    withService?: boolean;
  } = {},
) {
  const sent: string[] = [];
  const edits: Array<{ messageId: string; content: string }> = [];
  const draws: string[] = [];
  const finished: string[] = [];
  const sleeps: number[] = [];
  const unexpected = (name: string) => () => Promise.reject(new Error(`unexpected ${name}`));
  const rngService: RngService = {
    draw(userId) {
      draws.push(userId);
      return options.limited ? null : { number: "135792", fresh: options.fresh ?? true };
    },
    finish: (userId) => void finished.push(userId),
  };
  const deps: BotDependencies = {
    // AI is off: \rng must not need it.
    config: testConfig({ aiEnabled: false }, options.config ?? {}),
    discord: fakeDiscord({
      sent,
      edits,
      sendOk: options.sendOk,
      editOk: options.editOk,
      messageId: options.messageId === null ? undefined : (options.messageId ?? "bot-msg"),
    }),
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
    sleep: (ms) => {
      sleeps.push(ms);
      return Bun.sleep(options.waitMs ?? 0);
    },
    ...(options.withService === false ? {} : { rngService }),
  };
  return { deps, sent, edits, draws, finished, sleeps };
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

test("isRngCommand matches only a bare \\rng, with or without a mention", () => {
  expect(isRngCommand("<@12345> \\rng")).toStrictEqual(true);
  expect(isRngCommand(" <@!12345>  \\RnG ")).toStrictEqual(true);
  expect(isRngCommand("<@12345> \\rng please")).toStrictEqual(true); // extra text is ignored
  expect(isRngCommand("<@12345> roll \\rng")).toStrictEqual(false);
  expect(isRngCommand("<@12345> \\rngs")).toStrictEqual(false);
});

test("a first \\rng of the day fills in one digit per edit, a second apart", async () => {
  const state = setup();
  await handleMessage(mention("<@12345> \\rng"), state.deps);
  expect(state.draws).toStrictEqual(["user-1"]);
  expect(state.sent).toStrictEqual(["🎲1....."]);
  expect(state.edits).toStrictEqual(
    ["🎲13....", "🎲135...", "🎲1357..", "🎲13579.", "🎲**135792**"].map((content) => ({
      messageId: "bot-msg",
      content,
    })),
  );
  expect(state.sleeps).toStrictEqual([1000, 1000, 1000, 1000, 1000]);
  expect(state.finished).toStrictEqual(["user-1"]); // only once the last digit is in
});

test("a repeat \\rng, or any \\rng with no delay, answers with the whole number at once", async () => {
  for (const options of [{ fresh: false }, { config: { rng: { digitDelaySeconds: 0 } } }]) {
    const state = setup(options);
    await handleMessage(mention("<@12345> \\rng"), state.deps);
    expect(state.sent).toStrictEqual(["🎲**135792**"]);
    expect(state.edits).toStrictEqual([]);
    expect(state.sleeps).toStrictEqual([]);
    expect(state.finished).toStrictEqual(["user-1"]);
  }
});

test("a user asking again during a reveal gets no reply at all", async () => {
  const state = setup({ limited: true });
  await handleMessage(mention("<@12345> \\rng"), state.deps);
  expect(state.draws).toStrictEqual(["user-1"]);
  expect(state.sent).toStrictEqual([]);
  expect(state.edits).toStrictEqual([]);
  expect(state.finished).toStrictEqual([]); // that request was never taken on
});

test("without the sent message's id the whole number is sent instead", async () => {
  const state = setup({ messageId: null });
  await handleMessage(mention("<@12345> \\rng"), state.deps);
  expect(state.sent).toStrictEqual(["🎲1.....", "🎲**135792**"]);
  expect(state.edits).toStrictEqual([]);
});

test("a failed first send, or a failed edit, stops the reveal and still finishes the request", async () => {
  const noSend = setup({ sendOk: false });
  await handleMessage(mention("<@12345> \\rng"), noSend.deps);
  expect(noSend.sent).toStrictEqual(["🎲1....."]);
  expect(noSend.edits).toStrictEqual([]);
  expect(noSend.finished).toStrictEqual(["user-1"]);

  const noEdit = setup({ editOk: false });
  await handleMessage(mention("<@12345> \\rng"), noEdit.deps);
  expect(noEdit.sent).toStrictEqual(["🎲1....."]);
  expect(noEdit.edits.length).toStrictEqual(1);
  expect(noEdit.sleeps.length).toStrictEqual(1);
  expect(noEdit.finished).toStrictEqual(["user-1"]);
});

test("a reveal that takes over double its time gives up and still finishes the request", async () => {
  // The deadline is 2 x 5 x 1 ms, which the first 30 ms wait already passes.
  const state = setup({ config: { rng: { digitDelaySeconds: 0.001 } }, waitMs: 30 });
  await handleMessage(mention("<@12345> \\rng"), state.deps);
  expect(state.edits.length).toStrictEqual(1);
  expect(state.finished).toStrictEqual(["user-1"]);
});

test("\\rng says so when it is off here or has no service, and draws nothing", async () => {
  for (const options of [
    { config: { rng: { enabled: false } } },
    { config: { rng: { channelIds: ["elsewhere"] } } },
    { withService: false },
  ]) {
    const state = setup(options);
    await handleMessage(mention("<@12345> \\rng"), state.deps);
    expect(state.sent).toStrictEqual(["Ehehe~ the rng is turned off right now."]);
    expect(state.draws).toStrictEqual([]);
    expect(state.edits).toStrictEqual([]);
  }
});

test("what \\rng did is logged, with the user, channel and number", async () => {
  const { lines, restore } = captureLogs("debug");
  try {
    for (const options of [
      {}, // a reveal
      { fresh: false },
      { limited: true },
      { config: { rng: { enabled: false } } },
      { editOk: false },
    ]) {
      await handleMessage(mention("<@12345> \\rng"), setup(options).deps);
    }
  } finally {
    restore();
  }
  const who = '"userId":"user-1","channelId":"chan-1"';
  const drew = `info rng: Drew a number {${who},"number":"135792"}`;
  expect(lines.map((line) => line.replace(/,"ms":\d+/, ""))).toStrictEqual([
    drew,
    `info rng: Revealed the number {${who},"number":"135792"}`,
    `debug rng: Repeated the number {${who},"number":"135792"}`,
    `debug rng: Ignored a request during a reveal {${who}}`,
    `debug rng: The rng is off here {${who}}`,
    drew,
    `warn rng: Stopped the reveal early {${who},"number":"135792","error":"500"}`,
  ]);
});
