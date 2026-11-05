/** Action results shown to the user, in Haru's voice around verified facts. */
import { DiscordApiError, type DiscordScheduledEvent } from "../../discord/events.ts";

export interface ActionResult extends Record<string, unknown> {
  ok: boolean;
  message: string;
  eventId?: string;
  eventUrl?: string;
  inviteUrl?: string;
  uncertain?: boolean;
}
export function errorResult(error: unknown): ActionResult {
  if (error instanceof DiscordApiError && error.uncertain) {
    return {
      ok: false,
      uncertain: true,
      message:
        "Discord did not confirm the result. The action may have succeeded; I have not retried it. Check the server's events/invites before trying again.",
    };
  }
  return {
    ok: false,
    message: error instanceof Error ? error.message : "The Discord action failed.",
  };
}
export function eventResult(event: DiscordScheduledEvent, reused = false): ActionResult {
  const eventUrl = `https://discord.com/events/${event.guild_id}/${event.id}`;
  const start = Math.floor(Date.parse(event.scheduled_start_time) / 1000);
  const end = event.scheduled_end_time
    ? Math.floor(Date.parse(event.scheduled_end_time) / 1000)
    : null;
  return {
    ok: true,
    eventId: event.id,
    eventUrl,
    channelId: event.channel_id,
    message:
      `${
        reused
          ? "Ehehe~ your event is already waiting for you! (｡•ᴗ•｡)"
          : "Ehehe~ I made your event! (｡•ᴗ•｡)"
      }\n${event.name}\n` + `<t:${start}:F>${end ? ` – <t:${end}:F>` : ""}\n${eventUrl}`,
  };
}

/** Keep Haru's voice around verified facts, even if the model fails after a write. */
export function formatActionResults(results: ActionResult[]): string | null {
  if (!results.length) return null;
  const messages = results.map((result) =>
    result.ok || result.needsClarification === true ? result.message : `Eep... ${result.message}`,
  );
  return [...new Set(messages)].join("\n\n");
}
