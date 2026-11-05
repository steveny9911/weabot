import { expect, test } from "bun:test";
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

test("usage queries UTC month through today, scopes both OpenAI endpoints, and paginates", async () => {
  const urls: URL[] = [];
  const awsInputs: GetCostAndUsageCommandInput[] = [];
  const service = createUsageService(config, {
    now: () => date,
    fetch: (input, init) => {
      expect(new Headers((init as RequestInit)?.headers).get("Authorization")).toStrictEqual(
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
  expect(report.awsCost).toStrictEqual({ ok: true, value: { amount: 24.69, currency: "USD" } });
  expect(report.openaiCost).toStrictEqual({ ok: true, value: { amount: 1.5, currency: "USD" } });
  expect(report.tokens).toStrictEqual({ ok: true, value: { input: 200, cached: 120, output: 20 } });
  expect(awsInputs[0].TimePeriod).toStrictEqual({ Start: "2026-10-01", End: "2026-10-07" });
  expect(awsInputs[0].Metrics).toStrictEqual(["UnblendedCost"]);
  expect(awsInputs[1].NextPageToken).toStrictEqual("next");
  for (const url of urls) {
    expect(url.searchParams.get("start_time")).toStrictEqual("1790812800");
    expect(url.searchParams.get("end_time")).toStrictEqual(String(date.getTime() / 1000));
    expect(url.searchParams.get("project_ids[]")).toStrictEqual("proj-test");
    expect(url.searchParams.get("limit")).toStrictEqual("31");
  }
});

test("usage shares in-flight reads, caches for five minutes, and refreshes at UTC month rollover", async () => {
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
  expect(first).toStrictEqual(duplicate);
  expect(reads).toStrictEqual(1);
  time = new Date("2026-10-31T23:59:59Z");
  expect(await service.getMonthToDate()).toStrictEqual(first);
  time = new Date("2026-11-01T00:00:00Z");
  const next = await service.getMonthToDate();
  expect(next.start).toStrictEqual("2026-11-01T00:00:00.000Z");
  expect(reads).toStrictEqual(2);
  time = new Date("2026-11-01T00:05:00Z");
  await service.getMonthToDate();
  expect(reads).toStrictEqual(3);
});

test("missing admin key performs no OpenAI reads and preserves AWS data", async () => {
  const report = await createUsageService({} as AppConfig, {
    now: () => date,
    fetch: () => {
      throw new Error("Should not fetch");
    },
    awsSend: () => Promise.resolve(awsResult),
  }).getMonthToDate();
  expect(report.awsCost.ok).toStrictEqual(true);
  expect(report.openaiCost).toStrictEqual({ ok: false, reason: "OPENAI_ADMIN_KEY not configured" });
  expect(report.tokens).toStrictEqual({ ok: false, reason: "OPENAI_ADMIN_KEY not configured" });
});

test("empty provider results are zero, including on the first day of the month", async () => {
  const report = await createUsageService(config, {
    now: () => new Date("2026-01-01T00:01:00Z"),
    fetch: () => Promise.resolve(page([])),
    awsSend: (input) => {
      expect(input.TimePeriod).toStrictEqual({ Start: "2026-01-01", End: "2026-01-02" });
      return Promise.resolve({ $metadata: {}, ResultsByTime: [] });
    },
  }).getMonthToDate();
  expect(report.awsCost).toStrictEqual({ ok: true, value: { amount: 0, currency: "USD" } });
  expect(report.openaiCost).toStrictEqual({ ok: true, value: { amount: 0, currency: "USD" } });
  expect(report.tokens).toStrictEqual({ ok: true, value: { input: 0, cached: 0, output: 0 } });
});

test("provider failure is isolated and never exposes response bodies or keys", async () => {
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
  expect(report.awsCost.ok).toStrictEqual(false);
  expect(report.openaiCost.ok).toStrictEqual(false);
  expect(report.tokens).toStrictEqual({ ok: true, value: { input: 5, cached: 0, output: 2 } });
  expect(formatUsageMessage(report).includes("secret")).toStrictEqual(false);
});

test("malformed data and repeated cursors fail rather than showing partial or zero totals", async () => {
  for (const result of [
    { input_tokens: "100", output_tokens: 1 },
    { input_tokens: -1, output_tokens: 1 },
    { input_tokens: 1, output_tokens: 0.5 },
    { input_tokens: 1, output_tokens: 1, input_cached_tokens: "2" },
    {},
  ]) {
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
    expect(report.awsCost.ok).toStrictEqual(false);
    expect(report.openaiCost.ok).toStrictEqual(false);
    expect(report.tokens.ok).toStrictEqual(false);
  }
  const report = await createUsageService(config, {
    now: () => date,
    fetch: () => Promise.resolve(page([], true, "repeat")),
    awsSend: () => Promise.resolve({ ...awsResult, NextPageToken: "repeat" }),
  }).getMonthToDate();
  expect(report.awsCost.ok).toStrictEqual(false);
  expect(report.openaiCost.ok).toStrictEqual(false);
  expect(report.tokens.ok).toStrictEqual(false);
});

test("usage message formats money and exact token counts with scope and cache semantics", async () => {
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
  expect(message).toContain("October 2026 (month to date)");
  expect(message).toContain("2026-10-01 → 2026-10-06 13:45 UTC");
  expect(message).toContain("**AWS cost:** $12.35");
  expect(message).toContain("**OpenAI API cost:** $3.50");
  expect(message).toContain("**Input tokens:** 1,234,567");
  expect(message).toContain("**Cache tokens:** 123,000");
  expect(message).toContain("**Output tokens:** 8,000");
  expect(message).toContain("OpenAI project");
  expect(message).toContain("Cache tokens are included in input tokens");
});

test("usage aborts stalled provider requests at the shared deadline", async () => {
  let aborted = 0;
  const stalled = (signal: AbortSignal) =>
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted++;
          reject(signal.reason);
        },
        { once: true },
      );
    });
  const report = await createUsageService(config, {
    now: () => date,
    fetch: (_input, init) => stalled((init as RequestInit).signal!),
    awsSend: (_input, signal) => stalled(signal),
    timeoutMs: 50,
  }).getMonthToDate();
  expect(aborted).toStrictEqual(3);
  expect(report.awsCost.ok).toStrictEqual(false);
  expect(report.openaiCost.ok).toStrictEqual(false);
  expect(report.tokens.ok).toStrictEqual(false);
});

test("a failed later OpenAI page discards earlier partial totals", async () => {
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
  expect(report.awsCost.ok).toStrictEqual(true);
  expect(report.openaiCost.ok).toStrictEqual(false);
  expect(report.tokens.ok).toStrictEqual(false);
});

test("real AWS client signs and reads costs without system or filesystem permissions", async () => {
  const keys = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];
  const previous = keys.map((key) => process.env[key]);
  process.env[keys[0]] = "AKIDEXAMPLE";
  process.env[keys[1]] = "dummy-secret";
  delete process.env[keys[2]];
  let requests = 0;
  try {
    const report = await createUsageService({} as AppConfig, {
      now: () => date,
      awsRequestHandler: {
        handle(request: { hostname: string; headers: Record<string, string>; body?: unknown }) {
          requests++;
          expect(request.hostname).toStrictEqual("ce.us-east-1.amazonaws.com");
          expect(request.headers.authorization).toContain("AWS4-HMAC-SHA256");
          expect(request.headers.authorization).toContain("/us-east-1/ce/aws4_request");
          expect(request.headers["x-amz-target"]).toStrictEqual(
            "AWSInsightsIndexService.GetCostAndUsage",
          );
          const body =
            request.body instanceof Uint8Array
              ? new TextDecoder().decode(request.body)
              : String(request.body);
          expect(JSON.parse(body).TimePeriod).toStrictEqual({
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
    expect(requests).toStrictEqual(1);
    expect(report.awsCost).toStrictEqual({ ok: true, value: { amount: 12.345, currency: "USD" } });
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i]!;
    });
  }
});
