import { expect, spyOn, test } from "bun:test";
import { testConfig, type ConfigOverrides } from "../../tests/support/config.ts";
import { openDatabase } from "../db/database.ts";
import { createLandmineQueries } from "../db/landmines.ts";
import { createLandmineService } from "./landmine.ts";

function setup(
  overrides: NonNullable<ConfigOverrides["landmine"]> = {},
  options: { random?: number; timeoutOk?: boolean } = {},
) {
  const db = openDatabase(":memory:");
  const mines = createLandmineQueries(db);
  const timeouts: unknown[][] = [];
  const sent: string[] = [];
  const service = createLandmineService({
    config: testConfig({ landmine: { enabled: true, chance: 0.5 } }, { landmine: overrides }),
    mines,
    random: () => options.random ?? 0,
    timeout: async (_config, ...args) => {
      timeouts.push(args);
      return options.timeoutOk === false ? { ok: false, error: "403" } : { ok: true };
    },
    send: async (_config, channelId, content) => {
      sent.push(`${channelId}: ${content}`);
      return { ok: true, text: content };
    },
  });
  return { db, mines, service, timeouts, sent };
}

const message = (extra: Record<string, unknown> = {}) => ({
  guild_id: "guild-1",
  channel_id: "test-channel",
  author: { id: "user-1" },
  ...extra,
});

test("a message that is a landmine times out its author and announces it", async () => {
  const { service, timeouts, sent } = setup();
  await service.step(message());
  expect(timeouts).toStrictEqual([["guild-1", "user-1", 60, "Stepped on a landmine"]]);
  expect(sent).toStrictEqual([
    "test-channel: 💥<@user-1>💥 stepped on a landmine and has been timed out for 1 minute! " +
      "(99,999 landmines remaining)",
  ]);
});

test("with timeouts off a landmine only announces, and the user is not timed out", async () => {
  const { service, timeouts, sent, mines } = setup({ timeout: { enabled: false } });
  await service.step(message());
  expect(timeouts).toHaveLength(0);
  expect(sent).toStrictEqual([
    "test-channel: 💥<@user-1>💥 stepped on a landmine! (99,999 landmines remaining)",
  ]);
  expect(mines.claim()).toBe(99_998);
});

test("the announcement ends with a GIF picked from the list", async () => {
  const gifs = ["https://a.gif", "https://b.gif"];
  const first = setup({ gifs }, { random: 0 });
  await first.service.step(message());
  expect(first.sent[0]).toEndWith("landmines remaining)\nhttps://a.gif");
  // 0.6 is below the 90% chance, and 0.6 * 2 rounds down to the second GIF
  const second = setup({ gifs, chance: 0.9 }, { random: 0.6 });
  await second.service.step(message());
  expect(second.sent[0]).toEndWith("\nhttps://b.gif");
});

test("the announcement uses the configured timeout", async () => {
  const { service, sent } = setup({ timeout: { seconds: 30 } });
  await service.step(message());
  expect(sent[0]).toContain("timed out for 30 seconds!");
});

test("a message that rolls at or above the chance is safe", async () => {
  const { service, timeouts, sent } = setup({}, { random: 0.5 });
  await service.step(message());
  expect(timeouts).toHaveLength(0);
  expect(sent).toHaveLength(0);
});

test("nothing happens when landmines are disabled", async () => {
  const { service, timeouts } = setup({ enabled: false });
  await service.step(message());
  expect(timeouts).toHaveLength(0);
});

test("only landmine channels in a server have landmines", async () => {
  const { service, timeouts } = setup({ channelIds: ["other"] });
  await service.step(message());
  await service.step(message({ channel_id: "other", guild_id: undefined }));
  expect(timeouts).toHaveLength(0);
  await service.step(message({ channel_id: "other" }));
  expect(timeouts).toHaveLength(1);
});

test("a failed timeout puts the landmine back and announces nothing", async () => {
  const { service, mines, sent } = setup({}, { timeoutOk: false });
  await service.step(message());
  expect(sent).toHaveLength(0);
  expect(mines.claim()).toBe(99_999);
});

test("only normal messages and replies are landmines, not system messages", async () => {
  const { service, timeouts } = setup();
  for (const type of [7, 6, 8, 18]) await service.step(message({ type }));
  expect(timeouts).toHaveLength(0);
  await service.step(message({ type: 0 }));
  await service.step(message({ type: 19 }));
  expect(timeouts).toHaveLength(2);
});

test("a chance of 0 is never a landmine", async () => {
  const { service, timeouts } = setup({ chance: 0 });
  await service.step(message());
  expect(timeouts).toHaveLength(0);
});

test("a failed announcement does not put the landmine back", async () => {
  const { db, mines } = setup();
  const failing = createLandmineService({
    config: testConfig({ landmine: { enabled: true, chance: 0.5 } }),
    mines,
    random: () => 0,
    timeout: async () => ({ ok: true }),
    send: async () => {
      throw new Error("send failed");
    },
  });
  await failing.step(message());
  expect(mines.claim()).toBe(99_998);
  db.close();
});

test("no timeout happens once the landmines run out", async () => {
  const { db, service, timeouts, sent } = setup();
  db.run("UPDATE landmines SET remaining = 0");
  await service.step(message());
  expect(timeouts).toHaveLength(0);
  expect(sent).toHaveLength(0);
});

test("\\ commands are never landmines", async () => {
  const { service, timeouts } = setup();
  for (const content of ["\\usage", "<@123> \\open https://example.com", "<@123> hi \\reset"]) {
    await service.step(message({ content }));
  }
  expect(timeouts).toHaveLength(0);
  await service.step(message({ content: "an a\\b message" }));
  expect(timeouts).toHaveLength(1);
});

test("a safe roll and a failed announcement are logged", async () => {
  const logs: string[] = [];
  const log = spyOn(console, "log").mockImplementation((m) => void logs.push(String(m)));
  const error = spyOn(console, "error").mockImplementation((m) => void logs.push(String(m)));
  try {
    await setup({}, { random: 0.9 }).service.step(message());
    const { mines } = setup();
    await createLandmineService({
      config: testConfig({ landmine: { enabled: true, chance: 0.5 } }),
      mines,
      random: () => 0,
      timeout: async () => ({ ok: true }),
      send: async () => ({ ok: false, error: "403" }),
    }).step(message());
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  expect(logs.some((l) => l.includes("Safe: user-1") && l.includes("0.900"))).toBe(true);
  expect(logs.some((l) => l.includes("Could not announce") && l.includes("403"))).toBe(true);
});
