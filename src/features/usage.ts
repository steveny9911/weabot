import type { Money, MonthlyUsage, UsageValue } from "../services/usage.ts";

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

/** Providers without a billing report show what Haru itself counted today. */
export function formatDailyUsageMessage(
  stats: { requestsToday: number; dailyTokensUsed: number },
  requestLimit: number | undefined,
): string {
  const count = (value: number) => value.toLocaleString("en-US");
  return [
    "📊 **Usage — today (Pacific day)**",
    `**Requests:** ${count(stats.requestsToday)}${requestLimit === undefined ? "" : ` / ${count(requestLimit)}`}`,
    `**Tokens:** ${count(stats.dailyTokensUsed)}`,
    "",
    "Counted by Haru only. The day resets at midnight Pacific.",
  ].join("\n");
}
