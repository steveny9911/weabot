import { expect, spyOn, test } from "bun:test";
import { createRequestHandler, createServer, serverError } from "./server.ts";
import { realFetch } from "../test_support/setup.ts";
import type { AppConfig } from "./config.ts";
import type { DiscordClient } from "./services/discord.ts";
import type { StorageService } from "./services/storage.ts";

const writes = [
  "/trigger",
  "/trigger_poll",
  "/trigger_stats",
  "/trigger_alert",
  "/trigger_collect",
  "/vote",
  "/add-pending-poll",
];
const reads = ["/stats", "/check-alerts", "/user-history", "/ai-usage", "/pending-polls", "/"];

function fixture(token?: string) {
  let calls = 0;
  const neverCall = () => {
    calls++;
    throw new Error("unauthorized side effect");
  };
  const discord = new Proxy({}, { get: () => neverCall }) as DiscordClient;
  const storage = new Proxy({}, { get: () => neverCall }) as StorageService;
  const handler = createRequestHandler(
    { adminHttpToken: token } as AppConfig,
    discord,
    storage,
    new Intl.DateTimeFormat("en-US"),
  );
  return { handler, calls: () => calls };
}

test("HTTP health remains public while administration defaults to disabled", async () => {
  const { handler, calls } = fixture();
  expect(await (await handler(new Request("http://localhost/health"))).text()).toStrictEqual("OK");
  for (const route of [...writes, ...reads]) {
    for (const method of ["GET", "POST"]) {
      expect(
        (
          await handler(
            new Request(`http://localhost${route}`, {
              method,
              headers: { Authorization: "Bearer anything" },
            }),
          )
        ).status,
      ).toStrictEqual(404);
    }
  }
  expect(calls()).toStrictEqual(0);
});

test("every admin route rejects missing, incorrect and query-string tokens without side effects", async () => {
  const { handler, calls } = fixture("test-secret");
  for (const route of [...writes, ...reads]) {
    for (const authorization of [
      "",
      "Bearer wrong",
      "Bearer test-secreU",
      "Basic test-secret",
      "test-secret",
    ]) {
      const response = await handler(
        new Request(`http://localhost${route}?token=test-secret`, {
          method: writes.includes(route) ? "POST" : "GET",
          headers: { Authorization: authorization },
        }),
      );
      expect(response.status).toStrictEqual(401);
    }
  }
  expect(calls()).toStrictEqual(0);
});

test("authenticated state-changing routes require POST and reads require GET", async () => {
  const { handler, calls } = fixture("test-secret");
  for (const route of writes) {
    for (const method of ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]) {
      const response = await handler(
        new Request(`http://localhost${route}`, {
          method,
          headers: { Authorization: "Bearer test-secret" },
        }),
      );
      expect(response.status).toStrictEqual(405);
      expect(response.headers.get("allow")).toStrictEqual("POST");
    }
  }
  for (const route of reads) {
    const response = await handler(
      new Request(`http://localhost${route}`, {
        method: "POST",
        headers: { Authorization: "Bearer test-secret" },
      }),
    );
    expect(response.status).toStrictEqual(405);
    expect(response.headers.get("allow")).toStrictEqual("GET");
  }
  expect(calls()).toStrictEqual(0);
});

test("authorized POST can perform an admin operation and authenticated GET can read", async () => {
  const votes: unknown[][] = [];
  const storage = {
    recordVote: (...args: unknown[]) => {
      votes.push(args);
      return Promise.resolve();
    },
    getExpiredPolls: () => Promise.resolve([]),
    getAllPendingPolls: () => Promise.resolve([]),
  } as unknown as StorageService;
  const handler = createRequestHandler(
    { adminHttpToken: "test-secret", channelId: "sandbox" } as AppConfig,
    {} as DiscordClient,
    storage,
    new Intl.DateTimeFormat("en-US"),
  );
  const headers = { Authorization: "Bearer test-secret" };
  expect(
    (
      await handler(
        new Request("http://localhost/vote?user=123&mood=ok&name=Test&date=2026-09-06", {
          method: "POST",
          headers,
        }),
      )
    ).status,
  ).toStrictEqual(200);
  expect(votes).toStrictEqual([["sandbox", "123", "Test", "ok", "2026-09-06"]]);
  const response = await handler(new Request("http://localhost/pending-polls", { headers }));
  expect(response.status).toStrictEqual(200);
  expect(((await response.json()) as { all_pending: number }).all_pending).toStrictEqual(0);
});

test("the production server answers health checks on Bun.serve", async () => {
  const server = createServer(
    {} as AppConfig,
    {} as DiscordClient,
    {} as StorageService,
    new Intl.DateTimeFormat("en-US"),
    undefined,
    0,
  );
  try {
    expect(server.development).toBe(false);
    const response = await realFetch(`http://127.0.0.1:${server.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  } finally {
    await server.stop(true);
  }
});

test("a throwing handler returns a plain 500 without error details", async () => {
  const logged = spyOn(console, "error").mockImplementation(() => {});
  const server = Bun.serve({
    port: 0,
    development: false,
    fetch() {
      throw new Error("secret detail");
    },
    error: serverError,
  });
  try {
    const response = await realFetch(`http://127.0.0.1:${server.port}/`);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(logged).toHaveBeenCalledTimes(1);
  } finally {
    logged.mockRestore();
    await server.stop(true);
  }
});
