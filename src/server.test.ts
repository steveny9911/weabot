import { assertEquals } from "@std/assert";
import { createRequestHandler } from "./server.ts";
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

Deno.test("HTTP health remains public while administration defaults to disabled", async () => {
  const { handler, calls } = fixture();
  assertEquals(await (await handler(new Request("http://localhost/health"))).text(), "OK");
  for (const route of [...writes, ...reads]) {
    for (const method of ["GET", "POST"]) {
      assertEquals(
        (await handler(
          new Request(`http://localhost${route}`, {
            method,
            headers: { Authorization: "Bearer anything" },
          }),
        )).status,
        404,
      );
    }
  }
  assertEquals(calls(), 0);
});

Deno.test("every admin route rejects missing, incorrect and query-string tokens without side effects", async () => {
  const { handler, calls } = fixture("test-secret");
  for (const route of [...writes, ...reads]) {
    for (
      const authorization of [
        "",
        "Bearer wrong",
        "Bearer test-secreU",
        "Basic test-secret",
        "test-secret",
      ]
    ) {
      const response = await handler(
        new Request(`http://localhost${route}?token=test-secret`, {
          method: writes.includes(route) ? "POST" : "GET",
          headers: { Authorization: authorization },
        }),
      );
      assertEquals(response.status, 401);
    }
  }
  assertEquals(calls(), 0);
});

Deno.test("authenticated state-changing routes require POST and reads require GET", async () => {
  const { handler, calls } = fixture("test-secret");
  for (const route of writes) {
    for (const method of ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]) {
      const response = await handler(
        new Request(`http://localhost${route}`, {
          method,
          headers: { Authorization: "Bearer test-secret" },
        }),
      );
      assertEquals(response.status, 405);
      assertEquals(response.headers.get("allow"), "POST");
    }
  }
  for (const route of reads) {
    const response = await handler(
      new Request(`http://localhost${route}`, {
        method: "POST",
        headers: { Authorization: "Bearer test-secret" },
      }),
    );
    assertEquals(response.status, 405);
    assertEquals(response.headers.get("allow"), "GET");
  }
  assertEquals(calls(), 0);
});

Deno.test("authorized POST can perform an admin operation and authenticated GET can read", async () => {
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
  assertEquals(
    (await handler(
      new Request("http://localhost/vote?user=123&mood=ok&name=Test&date=2026-09-06", {
        method: "POST",
        headers,
      }),
    )).status,
    200,
  );
  assertEquals(votes, [["sandbox", "123", "Test", "ok", "2026-09-06"]]);
  const response = await handler(new Request("http://localhost/pending-polls", { headers }));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).all_pending, 0);
});
