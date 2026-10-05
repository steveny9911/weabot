import { assertEquals, assertStringIncludes } from "@std/assert";
import { createUsageService } from "./usage.ts";
import type { AppConfig } from "../config.ts";
import type { GetCostAndUsageCommandInput } from "@aws-sdk/client-cost-explorer";
import { formatUsageMessage } from "../features/usage/message.ts";

const date = new Date("2026-10-06T13:45:00Z");
const config = { openaiAdminKey: "admin-test", usageOpenaiProjectId: "proj-test" } as AppConfig;
function page(results: unknown[], more = false, next?: string): Response {
  return Response.json({ data: [{ results }], has_more: more, next_page: next });
}
const awsResult = {
  $metadata: {},
  ResultsByTime: [{ Total: { UnblendedCost: { Amount: "12.345", Unit: "USD" } } }],
};

Deno.test("usage queries UTC month through today, scopes both OpenAI endpoints, and paginates", async () => {
  const urls: URL[] = [];
  const awsInputs: GetCostAndUsageCommandInput[] = [];
  const service = createUsageService(config, {
    now: () => date,
    fetch: (input, init) => {
      assertEquals(
        new Headers((init as RequestInit)?.headers).get("Authorization"),
        "Bearer admin-test",
      );
      const url = new URL(String(input));
      urls.push(url);
      const second = url.searchParams.has("page");
      return Promise.resolve(
        url.pathname.endsWith("costs")
          ? page([{ amount: { value: second ? -0.5 : 2, currency: "usd" } }], !second, "next")
          : page(
            [{ input_tokens: 100, input_cached_tokens: 60, output_tokens: 10 }],
            !second,
            "next",
          ),
      );
    },
    awsSend: (input) => {
      awsInputs.push(input);
      return Promise.resolve({
        ...awsResult,
        NextPageToken: awsInputs.length === 1 ? "next" : undefined,
      });
    },
  });
  const report = await service.getMonthToDate();
  assertEquals(report.awsCost, { ok: true, value: { amount: 24.69, currency: "USD" } });
  assertEquals(report.openaiCost, { ok: true, value: { amount: 1.5, currency: "USD" } });
  assertEquals(report.tokens, { ok: true, value: { input: 200, cached: 120, output: 20 } });
  assertEquals(awsInputs[0].TimePeriod, { Start: "2026-10-01", End: "2026-10-07" });
  assertEquals(awsInputs[0].Metrics, ["UnblendedCost"]);
  assertEquals(awsInputs[1].NextPageToken, "next");
  for (const url of urls) {
    assertEquals(url.searchParams.get("start_time"), "1790812800");
    assertEquals(url.searchParams.get("end_time"), String(date.getTime() / 1000));
    assertEquals(url.searchParams.get("project_ids[]"), "proj-test");
    assertEquals(url.searchParams.get("limit"), "31");
  }
});

Deno.test("usage shares in-flight reads, caches for five minutes, and refreshes at UTC month rollover", async () => {
  let time = new Date("2026-10-31T23:59:00Z");
  let reads = 0;
  const service = createUsageService({} as AppConfig, {
    now: () => time,
    awsSend: () => {
      reads++;
      return Promise.resolve(awsResult);
    },
  });
  const [first, duplicate] = await Promise.all([
    service.getMonthToDate(),
    service.getMonthToDate(),
  ]);
  assertEquals(first, duplicate);
  assertEquals(reads, 1);
  time = new Date("2026-10-31T23:59:59Z");
  assertEquals(await service.getMonthToDate(), first);
  time = new Date("2026-11-01T00:00:00Z");
  const next = await service.getMonthToDate();
  assertEquals(next.start, "2026-11-01T00:00:00.000Z");
  assertEquals(reads, 2);
  time = new Date("2026-11-01T00:05:00Z");
  await service.getMonthToDate();
  assertEquals(reads, 3);
});

Deno.test("missing admin key performs no OpenAI reads and preserves AWS data", async () => {
  const report = await createUsageService({} as AppConfig, {
    now: () => date,
    fetch: () => {
      throw new Error("Should not fetch");
    },
    awsSend: () => Promise.resolve(awsResult),
  }).getMonthToDate();
  assertEquals(report.awsCost.ok, true);
  assertEquals(report.openaiCost, { ok: false, reason: "OPENAI_ADMIN_KEY not configured" });
  assertEquals(report.tokens, { ok: false, reason: "OPENAI_ADMIN_KEY not configured" });
});

Deno.test("empty provider results are zero, including on the first day of the month", async () => {
  const report = await createUsageService(config, {
    now: () => new Date("2026-01-01T00:01:00Z"),
    fetch: () => Promise.resolve(page([])),
    awsSend: (input) => {
      assertEquals(input.TimePeriod, { Start: "2026-01-01", End: "2026-01-02" });
      return Promise.resolve({ $metadata: {}, ResultsByTime: [] });
    },
  }).getMonthToDate();
  assertEquals(report.awsCost, { ok: true, value: { amount: 0, currency: "USD" } });
  assertEquals(report.openaiCost, { ok: true, value: { amount: 0, currency: "USD" } });
  assertEquals(report.tokens, { ok: true, value: { input: 0, cached: 0, output: 0 } });
});

Deno.test("provider failure is isolated and never exposes response bodies or keys", async () => {
  const report = await createUsageService(config, {
    now: () => date,
    fetch: (input) =>
      Promise.resolve(
        String(input).includes("/costs?")
          ? new Response("secret-admin-test", { status: 403 })
          : page([{ input_tokens: 5, output_tokens: 2 }]),
      ),
    awsSend: () => {
      throw new Error("secret AWS error");
    },
  }).getMonthToDate();
  assertEquals(report.awsCost.ok, false);
  assertEquals(report.openaiCost.ok, false);
  assertEquals(report.tokens, { ok: true, value: { input: 5, cached: 0, output: 2 } });
  assertEquals(formatUsageMessage(report).includes("secret"), false);
});

Deno.test("malformed data and repeated cursors fail rather than showing partial or zero totals", async () => {
  for (
    const result of [
      { input_tokens: "100", output_tokens: 1 },
      { input_tokens: -1, output_tokens: 1 },
      { input_tokens: 1, output_tokens: 0.5 },
      { input_tokens: 1, output_tokens: 1, input_cached_tokens: "2" },
      {},
    ]
  ) {
    const report = await createUsageService(config, {
      now: () => date,
      fetch: (input) =>
        Promise.resolve(
          String(input).includes("/costs?")
            ? page([{ amount: { value: "2", currency: "usd" } }])
            : page([result]),
        ),
      awsSend: () => Promise.resolve({ $metadata: {}, ResultsByTime: [{}] }),
    }).getMonthToDate();
    assertEquals(report.awsCost.ok, false);
    assertEquals(report.openaiCost.ok, false);
    assertEquals(report.tokens.ok, false);
  }
  const report = await createUsageService(config, {
    now: () => date,
    fetch: () => Promise.resolve(page([], true, "repeat")),
    awsSend: () => Promise.resolve({ ...awsResult, NextPageToken: "repeat" }),
  }).getMonthToDate();
  assertEquals(report.awsCost.ok, false);
  assertEquals(report.openaiCost.ok, false);
  assertEquals(report.tokens.ok, false);
});

Deno.test("usage message formats money and exact token counts with scope and cache semantics", async () => {
  const report = await createUsageService(config, {
    now: () => date,
    fetch: (input) =>
      Promise.resolve(
        String(input).includes("/costs?")
          ? page([{ amount: { value: 3.5, currency: "usd" } }])
          : page([{ input_tokens: 1234567, input_cached_tokens: 123000, output_tokens: 8000 }]),
      ),
    awsSend: () => Promise.resolve(awsResult),
  }).getMonthToDate();
  const message = formatUsageMessage(report);
  assertStringIncludes(message, "October 2026 (month to date)");
  assertStringIncludes(message, "2026-10-01 → 2026-10-06 13:45 UTC");
  assertStringIncludes(message, "**AWS cost:** $12.35");
  assertStringIncludes(message, "**OpenAI API cost:** $3.50");
  assertStringIncludes(message, "**Input tokens:** 1,234,567");
  assertStringIncludes(message, "**Cache tokens:** 123,000");
  assertStringIncludes(message, "**Output tokens:** 8,000");
  assertStringIncludes(message, "OpenAI project");
  assertStringIncludes(message, "Cache tokens are included in input tokens");
});

Deno.test("usage aborts stalled provider requests at the shared deadline", async () => {
  let aborted = 0;
  const stalled = (signal: AbortSignal) =>
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted++;
        reject(signal.reason);
      }, { once: true });
    });
  const report = await createUsageService(config, {
    now: () => date,
    fetch: (_input, init) => stalled((init as RequestInit).signal!),
    awsSend: (_input, signal) => stalled(signal),
  }).getMonthToDate();
  assertEquals(aborted, 3);
  assertEquals(report.awsCost.ok, false);
  assertEquals(report.openaiCost.ok, false);
  assertEquals(report.tokens.ok, false);
});

Deno.test("a failed later OpenAI page discards earlier partial totals", async () => {
  const report = await createUsageService(config, {
    now: () => date,
    fetch: (input) =>
      Promise.resolve(
        new URL(String(input)).searchParams.has("page")
          ? new Response("failure", { status: 500 })
          : page(
            [{ amount: { value: 1, currency: "usd" }, input_tokens: 1, output_tokens: 1 }],
            true,
            "next",
          ),
      ),
    awsSend: () => Promise.resolve(awsResult),
  }).getMonthToDate();
  assertEquals(report.awsCost.ok, true);
  assertEquals(report.openaiCost.ok, false);
  assertEquals(report.tokens.ok, false);
});

Deno.test("real AWS client signs and reads costs without system or filesystem permissions", async () => {
  const keys = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];
  const previous = keys.map((key) => Deno.env.get(key));
  Deno.env.set(keys[0], "AKIDEXAMPLE");
  Deno.env.set(keys[1], "dummy-secret");
  Deno.env.delete(keys[2]);
  let requests = 0;
  try {
    const report = await createUsageService({} as AppConfig, {
      now: () => date,
      awsRequestHandler: {
        handle(request: { hostname: string; headers: Record<string, string>; body?: unknown }) {
          requests++;
          assertEquals(request.hostname, "ce.us-east-1.amazonaws.com");
          assertStringIncludes(request.headers.authorization, "AWS4-HMAC-SHA256");
          assertStringIncludes(request.headers.authorization, "/us-east-1/ce/aws4_request");
          assertEquals(request.headers["x-amz-target"], "AWSInsightsIndexService.GetCostAndUsage");
          const body = request.body instanceof Uint8Array
            ? new TextDecoder().decode(request.body)
            : String(request.body);
          assertEquals(JSON.parse(body).TimePeriod, {
            Start: "2026-10-01",
            End: "2026-10-07",
          });
          return Promise.resolve({
            response: {
              statusCode: 200,
              headers: { "content-type": "application/x-amz-json-1.1" },
              body: new TextEncoder().encode(JSON.stringify(awsResult)),
            },
          });
        },
      },
    }).getMonthToDate();
    assertEquals(requests, 1);
    assertEquals(report.awsCost, { ok: true, value: { amount: 12.345, currency: "USD" } });
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) Deno.env.delete(key);
      else Deno.env.set(key, previous[i]!);
    });
  }
});
