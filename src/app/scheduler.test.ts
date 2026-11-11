import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { assert } from "../../tests/support/assert.ts";
import type { AiService } from "../ai/types.ts";
import type { AppConfig } from "../config.ts";
import { bunCron, type CronRegistrar, registerCronJobs } from "./scheduler.ts";
import type { DiscordClient } from "../discord/client.ts";
import type { RateLimitService } from "../services/rate_limit.ts";
import type { StorageService } from "../services/storage.ts";

const SCHEDULES = {
  "Daily Retro Poll": "0 5 * * *",
  "Daily Wellness Check": "0 6 * * *",
  "Weekly Stats Summary": "0 6 * * SUN",
  "Poll Result Collection": "30 * * * *",
  "Autonomous Chat": "* * * * *",
  Maintenance: "15 * * * *",
};

function register(storage: Partial<StorageService> = {}, maintenance?: () => void) {
  const jobs = new Map<string, { schedule: string; handler: () => Promise<void> | void }>();
  const cron: CronRegistrar = (name, schedule, handler) => jobs.set(name, { schedule, handler });
  const discord = {
    postMessage: () => Promise.resolve(Response.json({ id: "message" })),
  } as unknown as DiscordClient;
  registerCronJobs(
    cron,
    {
      config: { channelIds: ["channel"] } as AppConfig,
      discord,
      storage: storage as StorageService,
      ai: {} as AiService,
      rateLimit: {} as RateLimitService,
    },
    maintenance,
  );
  return jobs;
}

afterEach(() => {
  setSystemTime();
});

test("the production registrar runs jobs in UTC and logs a failing job instead of throwing", async () => {
  const cron = spyOn(Bun, "cron").mockImplementation((() => ({})) as never);
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    bunCron("Failing job", "0 5 * * *", () => {
      throw new Error("boom");
    });
    expect(cron).toHaveBeenCalledTimes(1);
    const [schedule, callback, options] = cron.mock.calls[0] as unknown as [
      string,
      () => Promise<void>,
      { tz: string },
    ];
    expect(schedule).toBe("0 5 * * *");
    expect(options).toStrictEqual({ tz: "UTC" });
    await callback();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0][0])).toContain("Failing job failed");
  } finally {
    cron.mockRestore();
    logged.mockRestore();
  }
});

test("the six jobs are registered with their UTC schedules", () => {
  const jobs = register();
  expect(Object.fromEntries([...jobs].map(([name, job]) => [name, job.schedule]))).toStrictEqual(
    SCHEDULES,
  );
});

test("the job schedules give the same run times in any process time zone", () => {
  const savedTz = process.env.TZ;
  const from = Date.parse("2026-03-07T23:59:00Z"); // DST starts in Los Angeles on 2026-03-08
  const nextRuns = (): string[] => {
    const runs: string[] = [];
    for (const schedule of Object.values(SCHEDULES)) {
      let at = from;
      for (let i = 0; i < 3; i++) {
        const next = Bun.cron.parse(schedule, at, { tz: "UTC" });
        assert(next);
        runs.push(next.toISOString());
        at = next.getTime();
      }
    }
    return runs;
  };
  try {
    const results = [];
    for (const tz of [undefined, "UTC", "America/Los_Angeles"]) {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
      results.push(nextRuns());
    }
    expect(results[0]).toContain("2026-03-08T05:00:00.000Z");
    expect(results[0]).toContain("2026-03-08T06:00:00.000Z");
    expect(results[1]).toStrictEqual(results[0]);
    expect(results[2]).toStrictEqual(results[0]);
  } finally {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  }
});

test("the Poll Result Collection job asks storage for expired polls", async () => {
  let asked = 0;
  const jobs = register({
    getExpiredPolls: () => {
      asked++;
      return Promise.resolve([]);
    },
  });
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await jobs.get("Poll Result Collection")!.handler();
  } finally {
    log.mockRestore();
  }
  expect(asked).toBe(1);
});
