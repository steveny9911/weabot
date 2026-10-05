/** Provider-reported month-to-date billing and model token usage. */
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type GetCostAndUsageCommandInput,
  type GetCostAndUsageCommandOutput,
} from "@aws-sdk/client-cost-explorer";
import { fromInstanceMetadata } from "@smithy/credential-provider-imds";
import type { AppConfig } from "../config.ts";

export type UsageValue<T> = { ok: true; value: T } | { ok: false; reason: string };
export interface TokenTotals {
  input: number;
  cached: number;
  output: number;
}
export interface Money {
  amount: number;
  currency: string;
}
export interface MonthlyUsage {
  start: string;
  asOf: string;
  openaiScope: "organization" | "project";
  awsCost: UsageValue<Money>;
  openaiCost: UsageValue<Money>;
  tokens: UsageValue<TokenTotals>;
}
export interface UsageService {
  getMonthToDate(): Promise<MonthlyUsage>;
}
interface UsageDependencies {
  now?: () => Date;
  fetch?: typeof fetch;
  awsSend?: (
    input: GetCostAndUsageCommandInput,
    signal: AbortSignal,
  ) => Promise<GetCostAndUsageCommandOutput>;
}

const CACHE_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 15_000;

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid number");
  return value;
}
function tokenCount(value: unknown): number {
  const count = number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid token count");
  return count;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid object");
  }
  return value as Record<string, unknown>;
}

/** No API response bodies or credentials are exposed in Discord or logs. */
async function available<T>(read: () => Promise<T>): Promise<UsageValue<T>> {
  try {
    return { ok: true, value: await read() };
  } catch {
    return { ok: false, reason: "provider request failed" };
  }
}

export function createUsageService(
  config: AppConfig,
  deps: UsageDependencies = {},
): UsageService {
  const now = deps.now ?? (() => new Date());
  const fetcher = deps.fetch ?? fetch;
  // Use env credentials locally and IMDSv2 on EC2 rather than the default
  // credential chain, which can invoke subprocesses or require credential files.
  const roleCredentials = fromInstanceMetadata({
    timeout: 1000,
    maxRetries: 1,
    ec2MetadataV1Disabled: true,
  });
  const client = new CostExplorerClient({
    region: "us-east-1",
    maxAttempts: 2,
    credentials: () => {
      const accessKeyId = Deno.env.get("AWS_ACCESS_KEY_ID");
      const secretAccessKey = Deno.env.get("AWS_SECRET_ACCESS_KEY");
      if (accessKeyId && secretAccessKey) {
        return Promise.resolve({
          accessKeyId,
          secretAccessKey,
          sessionToken: Deno.env.get("AWS_SESSION_TOKEN"),
        });
      }
      return roleCredentials();
    },
  });
  const awsSend = deps.awsSend ??
    ((input, signal) => client.send(new GetCostAndUsageCommand(input), { abortSignal: signal }));
  let cache: { month: string; expires: number; report: Promise<MonthlyUsage> } | undefined;

  async function openaiResults(
    path: string,
    start: Date,
    end: Date,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    const url = new URL(`https://api.openai.com/v1/organization/${path}`);
    url.searchParams.set("start_time", String(Math.floor(start.getTime() / 1000)));
    url.searchParams.set("end_time", String(Math.floor(end.getTime() / 1000)));
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");
    if (config.usageOpenaiProjectId) {
      url.searchParams.append("project_ids[]", config.usageOpenaiProjectId);
    }
    const results: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const response = await fetcher(url, {
        headers: { Authorization: `Bearer ${config.openaiAdminKey}` },
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("OpenAI request failed");
      }
      const data = object(await response.json());
      if (!Array.isArray(data.data)) throw new Error("Missing buckets");
      for (const raw of data.data) {
        const bucket = object(raw);
        if (!Array.isArray(bucket.results)) throw new Error("Missing results");
        results.push(...bucket.results.map(object));
      }
      if (data.has_more === false) return results;
      if (
        data.has_more !== true || typeof data.next_page !== "string" ||
        !data.next_page || seen.has(data.next_page)
      ) throw new Error("Invalid pagination");
      seen.add(data.next_page);
      url.searchParams.set("page", data.next_page);
    }
    throw new Error("Too many pages");
  }

  async function awsCost(start: Date, end: Date, signal: AbortSignal): Promise<Money> {
    const tomorrow = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1),
    );
    let next: string | undefined;
    const seen = new Set<string>();
    let amount = 0;
    let currency: string | undefined;
    for (let page = 0; page < 100; page++) {
      const data = await awsSend({
        TimePeriod: {
          Start: start.toISOString().slice(0, 10),
          End: tomorrow.toISOString().slice(0, 10),
        },
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        ...(next ? { NextPageToken: next } : {}),
      }, signal);
      if (!Array.isArray(data.ResultsByTime)) throw new Error("Missing AWS results");
      for (const bucket of data.ResultsByTime) {
        const metric = bucket.Total?.UnblendedCost;
        if (!metric || typeof metric.Amount !== "string" || !metric.Amount.trim() || !metric.Unit) {
          throw new Error("Missing AWS cost");
        }
        if (currency && currency !== metric.Unit) throw new Error("Mixed currencies");
        currency = metric.Unit;
        amount += number(Number(metric.Amount));
      }
      next = data.NextPageToken;
      if (!next) return { amount, currency: currency ?? "USD" };
      if (seen.has(next)) throw new Error("Invalid pagination");
      seen.add(next);
    }
    throw new Error("Too many pages");
  }

  async function load(start: Date, end: Date): Promise<MonthlyUsage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const signal = controller.signal;
    const missing = { ok: false as const, reason: "OPENAI_ADMIN_KEY not configured" };
    try {
      const [aws, cost, tokens] = await Promise.all([
        available(() => awsCost(start, end, signal)),
        config.openaiAdminKey
          ? available(async () => {
            const results = await openaiResults("costs", start, end, signal);
            let amount = 0;
            for (const result of results) {
              const money = object(result.amount);
              if (money.currency !== "usd") throw new Error("Unexpected currency");
              amount += number(money.value);
            }
            return { amount, currency: "USD" };
          })
          : Promise.resolve(missing),
        config.openaiAdminKey
          ? available(async () => {
            const results = await openaiResults("usage/completions", start, end, signal);
            return results.reduce<TokenTotals>((total, result) => ({
              input: tokenCount(total.input + tokenCount(result.input_tokens)),
              cached: tokenCount(total.cached + tokenCount(result.input_cached_tokens ?? 0)),
              output: tokenCount(total.output + tokenCount(result.output_tokens)),
            }), { input: 0, cached: 0, output: 0 });
          })
          : Promise.resolve(missing),
      ]);
      return {
        start: start.toISOString(),
        asOf: end.toISOString(),
        openaiScope: config.usageOpenaiProjectId ? "project" : "organization",
        awsCost: aws,
        openaiCost: cost,
        tokens,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getMonthToDate() {
      const end = now();
      const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
      const month = start.toISOString();
      if (cache && cache.month === month && end.getTime() < cache.expires) return cache.report;
      const report = load(start, end);
      cache = { month, expires: end.getTime() + CACHE_MS, report };
      return report;
    },
  };
}
