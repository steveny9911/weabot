/** The weekly and monthly landmine leaderboard: who stepped on the most landmines. */
import type { EmbedMessagePayload } from "./stats.ts";

export type ReportPeriod = "week" | "month";

/** The most people listed, so a long list cannot outgrow a Discord embed. */
const MAX_LISTED = 20;

const DAY_MS = 86_400_000;

/** When the period ending `now` began: 7 days ago, or the same moment a month ago (UTC). */
export function reportStart(period: ReportPeriod, now: number): number {
  if (period === "week") return now - 7 * DAY_MS;
  const start = new Date(now);
  // Shorter months have no 31st: stop at the last day of the previous one.
  const daysInPreviousMonth = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 0),
  ).getUTCDate();
  start.setUTCDate(Math.min(start.getUTCDate(), daysInPreviousMonth));
  start.setUTCMonth(start.getUTCMonth() - 1);
  return start.getTime();
}

/** `steppers` is most steps first. Equal counts share a rank, and the next rank skips (1, 2, 2, 4). */
export function buildLandmineReport(
  period: ReportPeriod,
  steppers: Array<{ userId: string; steps: number }>,
  remaining: number,
): EmbedMessagePayload {
  const label = period === "week" ? "week" : "month";
  let rank = 0;
  const lines = steppers.slice(0, MAX_LISTED).map(({ userId, steps }, index) => {
    if (steps !== steppers[index - 1]?.steps) rank = index + 1;
    return `${rank}. <@${userId}> — ${steps}`;
  });
  const total = steppers.reduce((sum, { steps }) => sum + steps, 0);
  const description = [
    lines.length ? lines.join("\n") : `Nobody stepped on a landmine this ${label}.`,
    "",
    ...(total ? [`Stepped on this ${label}: ${total.toLocaleString("en-US")}`] : []),
    `Landmines remaining: ${remaining.toLocaleString("en-US")}`,
  ].join("\n");
  const title = period === "week" ? "💥 Weekly Landmine Report" : "💥 Monthly Landmine Report";
  return { embeds: [{ title, description }] };
}
