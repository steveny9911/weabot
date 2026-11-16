import { expect, spyOn, test } from "bun:test";
import { testConfig } from "../../tests/support/config.ts";
import type { DiscordClient, MessagePayload } from "../discord/client.ts";
import type { LandmineService } from "../features/landmine.ts";
import { postLandmineReport } from "./landmine_report.ts";

function setup(landmine: { enabled: boolean }) {
  const posts: Array<{ channelId: string; payload: MessagePayload }> = [];
  const discord = {
    postMessage(channelId: string, payload: MessagePayload) {
      posts.push({ channelId, payload });
      return Promise.resolve(Response.json({ id: "m1" }));
    },
  } as unknown as DiscordClient;
  const landmines = {
    report: (period: string) => ({ embeds: [{ title: period }] }),
  } as unknown as LandmineService;
  const config = testConfig({}, { landmine: { ...landmine, reportChannelIds: ["a", "b"] } });
  return {
    posts,
    run: (period: "week" | "month") => postLandmineReport({ config, discord }, landmines, period),
  };
}

test("the report goes to every report channel", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const { posts, run } = setup({ enabled: true });
  try {
    await run("month");
  } finally {
    log.mockRestore();
  }
  expect(posts).toStrictEqual([
    { channelId: "a", payload: { embeds: [{ title: "month" }] } },
    { channelId: "b", payload: { embeds: [{ title: "month" }] } },
  ]);
});

test("nothing is posted while landmines are disabled", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const { posts, run } = setup({ enabled: false });
  try {
    expect(await run("week")).toStrictEqual([]);
  } finally {
    log.mockRestore();
  }
  expect(posts).toHaveLength(0);
});
