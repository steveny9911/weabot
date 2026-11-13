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
