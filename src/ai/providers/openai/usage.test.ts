import { expect, test } from "bun:test";
import { createUsageService, formatUsageMessage } from "./usage.ts";

const date = new Date("2026-10-06T13:45:00Z");
const config = { adminKey: "admin-test", projectId: "proj-test" };
function page(results: unknown[], more = false, next?: string): Response {
  return Response.json({ data: [{ results }], has_more: more, next_page: next });
}

test("usage queries UTC month through today, scopes both OpenAI endpoints, and paginates", async () => {
  const urls: URL[] = [];
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
  });
  const report = await service.getMonthToDate();
  expect(report.openaiCost).toStrictEqual({ ok: true, value: { amount: 1.5, currency: "USD" } });
  expect(report.tokens).toStrictEqual({ ok: true, value: { input: 200, cached: 120, output: 20 } });
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
  // Each load reads the costs and the completions endpoint once.
  const service = createUsageService(config, {
    now: () => time,
    fetch: () => {
      reads++;
      return Promise.resolve(page([]));
    },
  });
  const [first, duplicate] = await Promise.all([
    service.getMonthToDate(),
    service.getMonthToDate(),
  ]);
  expect(first).toStrictEqual(duplicate);
  expect(reads).toStrictEqual(2);
  time = new Date("2026-10-31T23:59:59Z");
  expect(await service.getMonthToDate()).toStrictEqual(first);
  time = new Date("2026-11-01T00:00:00Z");
  const next = await service.getMonthToDate();
  expect(next.start).toStrictEqual("2026-11-01T00:00:00.000Z");
  expect(reads).toStrictEqual(4);
  time = new Date("2026-11-01T00:05:00Z");
  await service.getMonthToDate();
  expect(reads).toStrictEqual(6);
});

test("missing admin key performs no OpenAI reads", async () => {
  const report = await createUsageService(
    {},
    {
      now: () => date,
      fetch: () => {
        throw new Error("Should not fetch");
      },
    },
  ).getMonthToDate();
  expect(report.openaiCost).toStrictEqual({ ok: false, reason: "OPENAI_ADMIN_KEY not configured" });
  expect(report.tokens).toStrictEqual({ ok: false, reason: "OPENAI_ADMIN_KEY not configured" });
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
  }).getMonthToDate();
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
    }).getMonthToDate();
    expect(report.openaiCost.ok).toStrictEqual(false);
    expect(report.tokens.ok).toStrictEqual(false);
  }
  const report = await createUsageService(config, {
    now: () => date,
    fetch: () => Promise.resolve(page([], true, "repeat")),
  }).getMonthToDate();
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
  }).getMonthToDate();
  const message = formatUsageMessage(report);
  expect(message).toContain("October 2026 (month to date)");
  expect(message).toContain("2026-10-01 → 2026-10-06 13:45 UTC");
  expect(message).toContain("**OpenAI API cost:** $3.50");
  expect(message).toContain("**Input tokens:** 1,234,567");
  expect(message).toContain("**Cache tokens:** 123,000");
  expect(message).toContain("**Output tokens:** 8,000");
  expect(message).toContain("OpenAI project");
  expect(message).toContain("Cache tokens are included in input tokens");
});
