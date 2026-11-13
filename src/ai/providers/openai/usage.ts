/** OpenAI month-to-date billing and token usage: the report behind `\usage` with this provider. */
import type { AppConfig } from "../../../config.ts";
import type { Fetcher } from "../../../types/fetch.ts";

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
  openaiCost: UsageValue<Money>;
  tokens: UsageValue<TokenTotals>;
}
export interface UsageService {
  getMonthToDate(): Promise<MonthlyUsage>;
}
interface UsageDependencies {
  now?: () => Date;
  fetch?: Fetcher;
  /** Shared deadline for all provider requests (default 15 s); tests use a short one. */
  timeoutMs?: number;
}

const CACHE_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;

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

export function createUsageService(config: AppConfig, deps: UsageDependencies = {}): UsageService {
  const now = deps.now ?? (() => new Date());
  const fetcher: Fetcher = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
        data.has_more !== true ||
        typeof data.next_page !== "string" ||
        !data.next_page ||
        seen.has(data.next_page)
      )
        throw new Error("Invalid pagination");
      seen.add(data.next_page);
      url.searchParams.set("page", data.next_page);
    }
    throw new Error("Too many pages");
  }

  async function load(start: Date, end: Date): Promise<MonthlyUsage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = controller.signal;
    const missing = { ok: false as const, reason: "OPENAI_ADMIN_KEY not configured" };
    try {
      const [cost, tokens] = await Promise.all([
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
              return results.reduce<TokenTotals>(
                (total, result) => ({
                  input: tokenCount(total.input + tokenCount(result.input_tokens)),
                  cached: tokenCount(total.cached + tokenCount(result.input_cached_tokens ?? 0)),
                  output: tokenCount(total.output + tokenCount(result.output_tokens)),
                }),
                { input: 0, cached: 0, output: 0 },
              );
            })
          : Promise.resolve(missing),
      ]);
      return {
        start: start.toISOString(),
        asOf: end.toISOString(),
        openaiScope: config.usageOpenaiProjectId ? "project" : "organization",
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

function money(result: UsageValue<Money>): string {
  if (!result.ok) return `Unavailable (${result.reason})`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: result.value.currency,
  }).format(result.value.amount);
}

/** Compact Discord text, readable on mobile without a wide table. */
export function formatUsageMessage(report: MonthlyUsage): string {
  const month = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(report.start));
  const count = (value: number) => value.toLocaleString("en-US");
  const unavailable = report.tokens.ok ? "" : `Unavailable (${report.tokens.reason})`;
  return [
    `📊 **Usage — ${month} (month to date)**`,
    `${report.start.slice(0, 10)} → ${report.asOf.slice(0, 16).replace("T", " ")} UTC`,
    "",
    `**OpenAI API cost:** ${money(report.openaiCost)}`,
    "",
    `**Input tokens:** ${report.tokens.ok ? count(report.tokens.value.input) : unavailable}`,
    `**Cache tokens:** ${report.tokens.ok ? count(report.tokens.value.cached) : unavailable}`,
    `**Output tokens:** ${report.tokens.ok ? count(report.tokens.value.output) : unavailable}`,
    "",
    `OpenAI ${report.openaiScope}`,
    "Cache tokens are included in input tokens. Provider totals may lag.",
  ].join("\n");
}
