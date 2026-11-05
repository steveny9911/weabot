import type { Money, MonthlyUsage, UsageValue } from "../../services/usage.ts";

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
    `**AWS cost:** ${money(report.awsCost)}`,
    `**OpenAI API cost:** ${money(report.openaiCost)}`,
    "",
    `**Input tokens:** ${report.tokens.ok ? count(report.tokens.value.input) : unavailable}`,
    `**Cache tokens:** ${report.tokens.ok ? count(report.tokens.value.cached) : unavailable}`,
    `**Output tokens:** ${report.tokens.ok ? count(report.tokens.value.output) : unavailable}`,
    "",
    `AWS account • OpenAI ${report.openaiScope}`,
    "Cache tokens are included in input tokens. Provider totals may lag; AWS costs are estimated.",
  ].join("\n");
}
