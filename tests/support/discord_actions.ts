/** A fake Discord server for the event and invite action tests: one guild, requester and bot. */
import {
  type ChannelInvitePayload,
  DiscordApiError,
  type DiscordChannel,
  type DiscordEventsClient,
  type DiscordGuild,
  type DiscordInvite,
  type DiscordMember,
  type DiscordScheduledEvent,
  type ScheduledEventPayload,
} from "../../src/discord/events.ts";
import type { DiscordActionContext } from "../../src/features/discord_actions/service.ts";

export const GUILD = "100";
export const USER = "200";
export const BOT = "300";
export const TEXT = "400";
export const VOICE = "401";
export const STAGE = "402";
export const EVENT = "550";
export const NOW = Date.parse("2025-01-01T12:00:00Z");

/** The requester's message in the text channel. */
export function actionContext(
  content: string,
  overrides: Partial<DiscordActionContext> = {},
): DiscordActionContext {
  return {
    guildId: GUILD,
    channelId: TEXT,
    userId: USER,
    botId: BOT,
    messageId: "600",
    content,
    ...overrides,
  };
}

/** A voice event Haru created, starting after `NOW`. */
export function existingEvent(
  overrides: Partial<DiscordScheduledEvent> = {},
): DiscordScheduledEvent {
  return {
    id: EVENT,
    guild_id: GUILD,
    channel_id: VOICE,
    creator_id: BOT,
    entity_type: 2,
    status: 1,
    name: "Movie night",
    scheduled_start_time: "2025-09-06T03:00:00.000Z",
    ...overrides,
  };
}

/**
 * Role permissions: `everyone` for all members, `requester` for USER and member 202, `bot` for
 * BOT. Every write is recorded; reads return copies, as Discord does.
 */
export class StubEvents implements DiscordEventsClient {
  guild: DiscordGuild;
  members: Record<string, DiscordMember> = {
    [USER]: { user: { id: USER }, roles: ["201"] },
    [BOT]: { user: { id: BOT, bot: true }, roles: ["301"] },
    "202": { user: { id: "202" }, roles: ["201"] },
  };
  channels: DiscordChannel[] = [
    { id: TEXT, guild_id: GUILD, name: "Bot Sandbox", type: 0 },
    { id: VOICE, guild_id: GUILD, name: "Lounge", type: 2 },
    { id: STAGE, guild_id: GUILD, name: "Stage", type: 13 },
  ];
  events: DiscordScheduledEvent[];
  eventReads: Array<{ guildId: string; eventId: string }> = [];
  eventWrites: Array<{ guildId: string; payload: ScheduledEventPayload; reason?: string }> = [];
  inviteWrites: Array<{ channelId: string; payload: ChannelInvitePayload; reason?: string }> = [];
  cancellationWrites: Array<{ guildId: string; eventId: string; reason?: string }> = [];
  eventFailure: Error | undefined;
  inviteFailure: Error | undefined;
  cancellationFailure: Error | undefined;
  beforeEvent: (() => Promise<void>) | undefined;
  beforeCancellation: (() => Promise<void>) | undefined;
  beforeRead: (() => void) | undefined;

  constructor(
    permissions: { everyone: bigint; requester: bigint; bot: bigint },
    events: DiscordScheduledEvent[] = [],
  ) {
    this.guild = {
      id: GUILD,
      owner_id: "999",
      roles: [
        { id: GUILD, permissions: String(permissions.everyone) },
        { id: "201", permissions: String(permissions.requester) },
        { id: "301", permissions: String(permissions.bot) },
      ],
    };
    this.events = events;
  }

  getGuild(_guildId: string): Promise<DiscordGuild> {
    return Promise.resolve(this.guild);
  }
  getMember(_guildId: string, userId: string): Promise<DiscordMember> {
    return Promise.resolve(this.members[userId]);
  }
  getChannels(_guildId: string): Promise<DiscordChannel[]> {
    return Promise.resolve(this.channels);
  }
  listScheduledEvents(_guildId: string): Promise<DiscordScheduledEvent[]> {
    return Promise.resolve(structuredClone(this.events));
  }
  getScheduledEvent(guildId: string, eventId: string): Promise<DiscordScheduledEvent> {
    this.eventReads.push({ guildId, eventId });
    this.beforeRead?.();
    const event = this.events.find((item) => item.id === eventId);
    return event
      ? Promise.resolve(structuredClone(event))
      : Promise.reject(new DiscordApiError("The event could not be found.", 404));
  }
  async cancelScheduledEvent(
    guildId: string,
    eventId: string,
    reason?: string,
  ): Promise<DiscordScheduledEvent> {
    this.cancellationWrites.push({ guildId, eventId, reason });
    await this.beforeCancellation?.();
    if (this.cancellationFailure) throw this.cancellationFailure;
    const event = this.events.find((item) => item.id === eventId)!;
    event.status = 4;
    return structuredClone(event);
  }
  async createScheduledEvent(
    guildId: string,
    payload: ScheduledEventPayload,
    reason?: string,
  ): Promise<DiscordScheduledEvent> {
    this.eventWrites.push({ guildId, payload, reason });
    await this.beforeEvent?.();
    if (this.eventFailure) throw this.eventFailure;
    const created: DiscordScheduledEvent = {
      ...payload,
      id: String(500 + this.eventWrites.length),
      guild_id: guildId,
      channel_id: payload.channel_id ?? null,
      creator_id: BOT,
      status: 1,
    };
    this.events.push(created);
    return structuredClone(created);
  }
  createInvite(
    channelId: string,
    payload: ChannelInvitePayload,
    reason?: string,
  ): Promise<DiscordInvite> {
    this.inviteWrites.push({ channelId, payload, reason });
    if (this.inviteFailure) return Promise.reject(this.inviteFailure);
    return Promise.resolve({
      code: "sandbox-invite",
      guild: { id: GUILD },
      channel: { id: channelId },
    });
  }
}
