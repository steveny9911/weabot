/** Discord scheduled events, invites, and the permissions needed to manage them. */

const API_BASE = "https://discord.com/api/v10";

export interface DiscordRole {
  id: string;
  permissions: string;
}

export interface DiscordGuild {
  id: string;
  owner_id: string;
  roles: DiscordRole[];
}

export interface DiscordMember {
  user: { id: string; bot?: boolean };
  roles: string[];
  communication_disabled_until?: string | null;
}

export interface DiscordChannel {
  id: string;
  guild_id?: string;
  name: string;
  type: number;
  permission_overwrites?: { id: string; type: number; allow: string; deny: string }[];
}

export interface DiscordScheduledEvent {
  id: string;
  guild_id: string;
  name: string;
  channel_id: string | null;
  entity_type: number;
  scheduled_start_time: string;
  scheduled_end_time?: string | null;
  entity_metadata?: { location?: string } | null;
  creator_id?: string | null;
  recurrence_rule?: Record<string, unknown> | null;
  status: number;
  description?: string | null;
}

export interface ScheduledEventPayload {
  name: string;
  description?: string;
  privacy_level: 2;
  entity_type: 1 | 2 | 3;
  channel_id?: string | null;
  entity_metadata?: { location: string };
  scheduled_start_time: string;
  scheduled_end_time?: string;
}

export interface ChannelInvitePayload {
  max_age: number;
  max_uses: number;
  unique: boolean;
  temporary: boolean;
}

export interface DiscordInvite {
  code: string;
  guild?: { id: string };
  channel?: { id: string };
}

export interface DiscordEventsClient {
  getGuild(guildId: string): Promise<DiscordGuild>;
  getMember(guildId: string, userId: string): Promise<DiscordMember>;
  getChannels(guildId: string): Promise<DiscordChannel[]>;
  listScheduledEvents(guildId: string): Promise<DiscordScheduledEvent[]>;
  getScheduledEvent(guildId: string, eventId: string): Promise<DiscordScheduledEvent>;
  createScheduledEvent(
    guildId: string,
    payload: ScheduledEventPayload,
    reason?: string,
  ): Promise<DiscordScheduledEvent>;
  cancelScheduledEvent(
    guildId: string,
    eventId: string,
    reason?: string,
  ): Promise<DiscordScheduledEvent>;
  createInvite(
    channelId: string,
    payload: ChannelInvitePayload,
    reason?: string,
  ): Promise<DiscordInvite>;
}

/** Safe to show to a user; raw responses and transport errors may contain secrets. */
export class DiscordApiError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
    public readonly uncertain = false,
    /** Seconds until Discord allows another request, when known. */
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "DiscordApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPermissions(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isGuild(value: unknown): value is DiscordGuild {
  return isRecord(value) && isString(value.id) && isString(value.owner_id) &&
    Array.isArray(value.roles) &&
    value.roles.every((role) =>
      isRecord(role) && isString(role.id) && isPermissions(role.permissions)
    );
}

function isMember(value: unknown): value is DiscordMember {
  return isRecord(value) && isRecord(value.user) && isString(value.user.id) &&
    (value.user.bot === undefined || typeof value.user.bot === "boolean") &&
    Array.isArray(value.roles) && value.roles.every(isString) &&
    isOptionalString(value.communication_disabled_until);
}

function isChannel(value: unknown): value is DiscordChannel {
  return isRecord(value) && isString(value.id) && typeof value.name === "string" &&
    Number.isInteger(value.type) &&
    (value.guild_id === undefined || isString(value.guild_id)) &&
    (value.permission_overwrites === undefined ||
      (Array.isArray(value.permission_overwrites) &&
        value.permission_overwrites.every((overwrite) =>
          isRecord(overwrite) && isString(overwrite.id) &&
          (overwrite.type === 0 || overwrite.type === 1) &&
          isPermissions(overwrite.allow) && isPermissions(overwrite.deny)
        )));
}

function isScheduledEvent(value: unknown): value is DiscordScheduledEvent {
  return isRecord(value) && isString(value.id) && isString(value.guild_id) &&
    isString(value.name) && (value.channel_id === null || isString(value.channel_id)) &&
    Number.isInteger(value.entity_type) && Number.isInteger(value.status) &&
    isString(value.scheduled_start_time) && isOptionalString(value.scheduled_end_time) &&
    isOptionalString(value.description) &&
    (value.creator_id === undefined || value.creator_id === null || isString(value.creator_id)) &&
    (value.recurrence_rule === undefined || value.recurrence_rule === null ||
      isRecord(value.recurrence_rule)) &&
    (value.entity_metadata === undefined || value.entity_metadata === null ||
      (isRecord(value.entity_metadata) &&
        (value.entity_metadata.location === undefined ||
          typeof value.entity_metadata.location === "string")));
}

function isInvite(value: unknown): value is DiscordInvite {
  return isRecord(value) && isString(value.code) && /^[\w-]+$/.test(value.code) &&
    (value.guild === undefined || (isRecord(value.guild) && isString(value.guild.id))) &&
    (value.channel === undefined || (isRecord(value.channel) && isString(value.channel.id)));
}

function isArrayOf<T>(guard: (value: unknown) => value is T) {
  return (value: unknown): value is T[] => Array.isArray(value) && value.every(guard);
}

function getRetryAfter(response: Response, data: unknown): number | undefined {
  const body_value = isRecord(data) ? data.retry_after : undefined;
  const header_value = response.headers.get("Retry-After");
  if (typeof body_value === "number" && Number.isFinite(body_value) && body_value >= 0) {
    return body_value;
  }
  const value = header_value?.trim() ? Number(header_value) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function responseError(response: Response, data: unknown, mutation: boolean): DiscordApiError {
  if (response.status === 429) {
    const retry_after = getRetryAfter(response, data);
    return new DiscordApiError(
      retry_after === undefined
        ? "Discord is rate limiting requests. Please wait before trying again."
        : `Discord is rate limiting requests. Please try again in ${
          Math.ceil(retry_after)
        } seconds.`,
      429,
      false,
      retry_after,
    );
  }
  const uncertain = mutation && (response.status >= 500 || response.status === 408);
  const message = uncertain
    ? "Discord did not confirm the result. Check Discord before trying again; the action may have succeeded."
    : response.status === 401
    ? "Discord rejected the bot credentials. The bot administrator needs to check its token."
    : response.status === 403
    ? "Discord denied this request. Check the bot's server and channel permissions."
    : response.status === 404
    ? "The Discord server, channel, member, or event could not be found or is inaccessible."
    : response.status === 400
    ? "Discord rejected the request details. Check the event or invite settings."
    : "Discord could not complete this request. Please try again later.";
  return new DiscordApiError(message, response.status, uncertain);
}

/**
 * Reads may retry a confirmed 429 twice, waiting Discord's advertised delay
 * (at most 15 seconds per wait). Every attempt has its own request timeout.
 * Mutations are never retried: an ambiguous failure may already have changed something.
 */
export function createDiscordEventsClient(
  token: string,
  options: {
    fetch?: typeof fetch;
    timeoutMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): DiscordEventsClient {
  const request_fetch = options.fetch ?? globalThis.fetch;
  const timeout_ms = options.timeoutMs ?? 15_000;
  const sleep = options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  async function requestOnce<T>(
    path: string,
    guard: (value: unknown) => value is T,
    payload?: ScheduledEventPayload | ChannelInvitePayload | { status: 4 },
    reason?: string,
    mutationMethod: "POST" | "PATCH" = "POST",
  ): Promise<T> {
    const mutation = payload !== undefined;
    const headers: Record<string, string> = {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    };
    if (reason) {
      headers["X-Audit-Log-Reason"] = encodeURIComponent(Array.from(reason).slice(0, 512).join(""));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout_ms);
    let response: Response | undefined;
    try {
      response = await request_fetch(`${API_BASE}${path}`, {
        method: mutation ? mutationMethod : "GET",
        headers,
        body: mutation ? JSON.stringify(payload) : undefined,
        signal: controller.signal,
        redirect: "error",
      });
      // Keep the timeout active while receiving/parsing the response body.
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        if (!response.ok) throw responseError(response, undefined, mutation);
        throw new DiscordApiError(
          mutation
            ? "Discord returned an unreadable result. Check Discord before trying again; the action may have succeeded."
            : "Discord returned an unreadable response. Please try again later.",
          response.status,
          mutation,
        );
      }
      if (!response.ok) throw responseError(response, data, mutation);
      if (!guard(data)) {
        throw new DiscordApiError(
          mutation
            ? "Discord returned an incomplete result. Check Discord before trying again; the action may have succeeded."
            : "Discord returned incomplete data. Please try again later.",
          response.status,
          mutation,
        );
      }
      return data;
    } catch (error) {
      if (error instanceof DiscordApiError) throw error;
      // Do not expose an underlying error or the request, which may contain tokens.
      throw new DiscordApiError(
        mutation
          ? "Discord did not confirm the result. Check Discord before trying again; the action may have succeeded."
          : "Discord could not be reached. Please try again later.",
        response?.status ?? 0,
        mutation,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function request<T>(
    path: string,
    guard: (value: unknown) => value is T,
    payload?: ScheduledEventPayload | ChannelInvitePayload | { status: 4 },
    reason?: string,
    mutationMethod: "POST" | "PATCH" = "POST",
  ): Promise<T> {
    for (let retries = 0;; retries++) {
      try {
        return await requestOnce(path, guard, payload, reason, mutationMethod);
      } catch (error) {
        if (
          payload !== undefined || retries >= 2 || !(error instanceof DiscordApiError) ||
          error.status !== 429 || error.uncertain || error.retryAfter === undefined ||
          error.retryAfter > 15
        ) {
          throw error;
        }
        // Respect Discord's delay without keeping an attempt's abort timer alive.
        // Longer limits are surfaced to the caller instead of holding the reply open.
        await sleep(Math.ceil(error.retryAfter * 1000));
      }
    }
  }

  return {
    getGuild: (guildId) => request(`/guilds/${encodeURIComponent(guildId)}`, isGuild),
    getMember: (guildId, userId) =>
      request(
        `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}`,
        isMember,
      ),
    getChannels: (guildId) =>
      request(`/guilds/${encodeURIComponent(guildId)}/channels`, isArrayOf(isChannel)),
    listScheduledEvents: (guildId) =>
      request(
        `/guilds/${encodeURIComponent(guildId)}/scheduled-events`,
        isArrayOf(isScheduledEvent),
      ),
    getScheduledEvent: (guildId, eventId) =>
      request(
        `/guilds/${encodeURIComponent(guildId)}/scheduled-events/${encodeURIComponent(eventId)}`,
        (value): value is DiscordScheduledEvent =>
          isScheduledEvent(value) && value.id === eventId && value.guild_id === guildId,
      ),
    createScheduledEvent: (guildId, payload, reason) =>
      request(
        `/guilds/${encodeURIComponent(guildId)}/scheduled-events`,
        isScheduledEvent,
        payload,
        reason,
      ),
    cancelScheduledEvent: (guildId, eventId, reason) =>
      request(
        `/guilds/${encodeURIComponent(guildId)}/scheduled-events/${encodeURIComponent(eventId)}`,
        (value): value is DiscordScheduledEvent =>
          isScheduledEvent(value) && value.id === eventId && value.guild_id === guildId &&
          value.status === 4,
        { status: 4 },
        reason,
        "PATCH",
      ),
    createInvite: (channelId, payload, reason) =>
      request(`/channels/${encodeURIComponent(channelId)}/invites`, isInvite, payload, reason),
  };
}

/** https://docs.discord.com/developers/topics/permissions */
export const DiscordPermissions = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  VIEW_CHANNEL: 1n << 10n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  CONNECT: 1n << 20n,
  MUTE_MEMBERS: 1n << 22n,
  MOVE_MEMBERS: 1n << 24n,
  MANAGE_EVENTS: 1n << 33n,
  CREATE_EVENTS: 1n << 44n,
} as const;

// An unbounded all-bits mask lets owners/admins pass checks for future bits too.
const ALL_PERMISSIONS = ~0n;
const TIMEOUT_PERMISSIONS = DiscordPermissions.VIEW_CHANNEL |
  DiscordPermissions.READ_MESSAGE_HISTORY;

function basePermissions(guild: DiscordGuild, member: DiscordMember): bigint {
  if (member.user.id === guild.owner_id) return ALL_PERMISSIONS;
  const role_ids = new Set([guild.id, ...member.roles]);
  let permissions = 0n;
  for (const role of guild.roles) {
    if (role_ids.has(role.id)) permissions |= BigInt(role.permissions);
  }
  return permissions & DiscordPermissions.ADMINISTRATOR ? ALL_PERMISSIONS : permissions;
}

function applyTimeout(permissions: bigint, member: DiscordMember): bigint {
  if (permissions & DiscordPermissions.ADMINISTRATOR) return permissions;
  const timeout = member.communication_disabled_until;
  return timeout && Date.parse(timeout) > Date.now()
    ? permissions & TIMEOUT_PERMISSIONS
    : permissions;
}

export function getGuildPermissions(guild: DiscordGuild, member: DiscordMember): bigint {
  return applyTimeout(basePermissions(guild, member), member);
}

/** Raw channel permissions, including overwrites and timeout restrictions. */
export function getChannelPermissions(
  guild: DiscordGuild,
  member: DiscordMember,
  channel: DiscordChannel,
): bigint {
  let permissions = basePermissions(guild, member);
  if (permissions & DiscordPermissions.ADMINISTRATOR) return permissions;
  const overwrites = channel.permission_overwrites ?? [];
  const everyone = overwrites.find((overwrite) =>
    overwrite.id === guild.id && overwrite.type === 0
  );
  if (everyone) permissions = (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow);

  const role_ids = new Set(member.roles);
  let allow = 0n;
  let deny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type === 0 && overwrite.id !== guild.id && role_ids.has(overwrite.id)) {
      allow |= BigInt(overwrite.allow);
      deny |= BigInt(overwrite.deny);
    }
  }
  permissions = (permissions & ~deny) | allow;
  const personal = overwrites.find((overwrite) =>
    overwrite.id === member.user.id && overwrite.type === 1
  );
  if (personal) permissions = (permissions & ~BigInt(personal.deny)) | BigInt(personal.allow);
  return applyTimeout(permissions, member);
}
