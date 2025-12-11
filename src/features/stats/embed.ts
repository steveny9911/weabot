/**
 * Stats Embed Builder
 *
 * Creates Discord embeds for displaying poll statistics.
 */

import type { DailyStats } from "../../types/storage.ts";

/** Discord embed structure */
export interface DiscordEmbed {
  title: string;
  description?: string;
  color?: number;
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  footer?: {
    text: string;
  };
  timestamp?: string;
}

/** Message payload with embed */
export interface EmbedMessagePayload {
  embeds: DiscordEmbed[];
}

/**
 * Builds a stats embed showing mood distribution over time.
 */
export function buildStatsEmbed(
  stats: DailyStats[],
  title: string = "📊 Mood Stats",
): EmbedMessagePayload {
  // Calculate totals
  const totals = stats.reduce(
    (acc, day) => ({
      umazing: acc.umazing + day.umazing,
      ok: acc.ok + day.ok,
      glue: acc.glue + day.glue,
      total: acc.total + day.total,
    }),
    { umazing: 0, ok: 0, glue: 0, total: 0 },
  );

  // Build percentage bars
  const buildBar = (count: number, total: number): string => {
    if (total === 0) return "No data";
    const pct = Math.round((count / total) * 100);
    const filled = Math.round(pct / 10);
    const bar = "█".repeat(filled) + "░".repeat(10 - filled);
    return `${bar} ${pct}% (${count})`;
  };

  // Create fields for each mood
  const fields = [
    {
      name: "🌟 Umazing",
      value: buildBar(totals.umazing, totals.total),
      inline: false,
    },
    {
      name: "😐 Ok",
      value: buildBar(totals.ok, totals.total),
      inline: false,
    },
    {
      name: "🩹 Glue",
      value: buildBar(totals.glue, totals.total),
      inline: false,
    },
  ];

  // Add daily breakdown if we have multiple days
  if (stats.length > 1) {
    const recentDays = stats.slice(-7).map((day) => {
      const emoji = day.umazing >= day.ok && day.umazing >= day.glue
        ? "🌟"
        : day.glue > day.ok
        ? "🩹"
        : "😐";
      return `${day.date}: ${emoji} (${day.total} votes)`;
    });

    fields.push({
      name: "📅 Recent Days",
      value: recentDays.join("\n") || "No data",
      inline: false,
    });
  }

  // Color based on overall mood
  // Green for mostly umazing, yellow for ok, red for glue
  let color = 0x808080; // Gray default
  if (totals.total > 0) {
    if (totals.umazing >= totals.ok && totals.umazing >= totals.glue) {
      color = 0x00ff00; // Green
    } else if (totals.glue > totals.ok) {
      color = 0xff6b6b; // Red
    } else {
      color = 0xffcc00; // Yellow
    }
  }

  return {
    embeds: [
      {
        title,
        description: `Total responses: ${totals.total}`,
        color,
        fields,
        footer: {
          text: "Weabot • Mood Tracker",
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/**
 * Builds an alert embed for users at risk.
 */
export function buildAlertEmbed(
  userName: string,
  consecutiveDays: number,
): EmbedMessagePayload {
  return {
    embeds: [
      {
        title: "💙 Wellness Check",
        description: `Hey **${userName}**, we noticed you've been feeling "glue" ` +
          `for ${consecutiveDays} days in a row. ` +
          `Just wanted to check in and remind you that it's okay to have tough days. ` +
          `Your friends are here for you. 💪`,
        color: 0x5865f2, // Discord blurple
        fields: [
          {
            name: "Resources",
            value: "• Talk to someone you trust\n" +
              "• Take a break if you need it\n" +
              "• Remember: this too shall pass",
            inline: false,
          },
        ],
        footer: {
          text: "This is an automated wellness check • Weabot",
        },
      },
    ],
  };
}
