import { expect, test } from "bun:test";
import { testConfig, type ConfigOverrides } from "../../tests/support/config.ts";
import { fakeDiscord } from "../../tests/support/discord.ts";
import type { MessagePayload } from "../discord/client.ts";
import type { LandmineService } from "../features/landmine.ts";
import type { ReportPeriod } from "../features/landmine_report.ts";
import { parseLandmineReportCommand } from "./commands.ts";
import { handleMessage, type BotDependencies } from "./handle_message.ts";

function setup(config: ConfigOverrides = {}, withService = true) {
  const sent: string[] = [];
  const replyTos: Array<string | undefined> = [];
  const posts: Array<{ channelId: string; payload: MessagePayload }> = [];
  const periods: ReportPeriod[] = [];
  const unexpected = (name: string) => () => Promise.reject(new Error(`unexpected ${name}`));
  const landmineService = {
    step: () => Promise.resolve(),
    report: (period: ReportPeriod) => (periods.push(period), { embeds: [{ title: period }] }),
  } as LandmineService;
  const deps: BotDependencies = {
    config: testConfig({ aiEnabled: false }, config),
    discord: fakeDiscord({ sent, replyTos, posts }),
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
    ...(withService ? { landmineService } : {}),
  };
  return { deps, sent, replyTos, posts, periods };
}

const mention = (content: string) => ({
  id: "msg-1",
  channel_id: "chan-1",
  content,
  author: { id: "user-1", username: "alice", bot: false },
  mentions: [{ id: "12345", username: "Haru" }],
  timestamp: "2026-03-01T12:00:00.000Z",
});

test("\\landmines is the last week, \\landmines month is the last month, other text is not it", () => {
  expect(parseLandmineReportCommand("<@12345> \\landmines")).toBe("week");
  expect(parseLandmineReportCommand("\\LANDMINES  Month")).toBe("month");
  expect(parseLandmineReportCommand("\\landmines week")).toBe("week");
  expect(parseLandmineReportCommand("\\landmines2")).toBeNull();
  expect(parseLandmineReportCommand("tell me about \\landmines")).toBeNull();
});

test("\\landmines posts the leaderboard in the channel", async () => {
  const { deps, posts, periods } = setup({ landmine: { enabled: true, channelIds: "all" } });
  await handleMessage(mention("<@12345> \\landmines month"), deps);
  expect(periods).toStrictEqual(["month"]);
  expect(posts).toStrictEqual([{ channelId: "chan-1", payload: { embeds: [{ title: "month" }] } }]);
});

test("\\landmines says the landmines are off where they are not on", async () => {
  const off = setup({ landmine: { enabled: false } });
  await handleMessage(mention("<@12345> \\landmines"), off.deps);
  const noService = setup({ landmine: { enabled: true, channelIds: "all" } }, false);
  await handleMessage(mention("<@12345> \\landmines"), noService.deps);
  for (const { sent, replyTos, posts } of [off, noService]) {
    expect(sent).toStrictEqual(["Ehehe~ the landmines are turned off right now."]);
    expect(replyTos).toStrictEqual(["msg-1"]);
    expect(posts).toHaveLength(0);
  }
});
