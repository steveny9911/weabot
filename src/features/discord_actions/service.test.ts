import { expect, test } from "bun:test";
import {
  type ChannelInvitePayload,
  DiscordApiError,
  type DiscordChannel,
  type DiscordEventsClient,
  type DiscordGuild,
  type DiscordInvite,
  type DiscordMember,
  DiscordPermissions as P,
  type DiscordScheduledEvent,
  type ScheduledEventPayload,
} from "../../discord/events.ts";
import {
  createDiscordActionService,
  type DiscordActionContext,
  type DiscordActionService,
  type PendingRequest,
} from "./service.ts";
import { hasExplicitActionRequest } from "./intent.ts";
import { formatActionResults } from "./results.ts";
import { type Database, openDatabase } from "../../db/database.ts";
import { TurnStore, turnKey } from "./state.ts";

const GUILD = "100";
const USER = "200";
const BOT = "300";
const TEXT = "400";
const VOICE = "401";
const STAGE = "402";
const CAPABILITIES =
  P.CREATE_EVENTS | P.CREATE_INSTANT_INVITE | P.MANAGE_CHANNELS | P.MUTE_MEMBERS | P.MOVE_MEMBERS;
const NOW = Date.parse("2025-01-01T12:00:00Z");
const REQUEST = "Create Movie night on September 5 at 8pm in Lounge and share an invite.";

class StubDiscord implements DiscordEventsClient {
  guild: DiscordGuild = {
    id: GUILD,
    owner_id: "999",
    roles: [
      { id: GUILD, permissions: String(P.VIEW_CHANNEL | P.CONNECT) },
      { id: "201", permissions: String(CAPABILITIES) },
      { id: "301", permissions: String(CAPABILITIES) },
    ],
  };
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
  events: DiscordScheduledEvent[] = [];
  eventWrites: Array<{ guildId: string; payload: ScheduledEventPayload; reason?: string }> = [];
  inviteWrites: Array<{ channelId: string; payload: ChannelInvitePayload; reason?: string }> = [];
  eventFailure: Error | undefined;
  inviteFailure: Error | undefined;
  beforeEvent: (() => Promise<void>) | undefined;

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
    return Promise.resolve(this.events);
  }
  getScheduledEvent(_guildId: string, eventId: string): Promise<DiscordScheduledEvent> {
    return Promise.resolve(this.events.find((event) => event.id === eventId)!);
  }
  cancelScheduledEvent(_guildId: string, _eventId: string): Promise<DiscordScheduledEvent> {
    return Promise.reject(new Error("Unexpected cancellation in a creation test."));
  }
  async createScheduledEvent(
    guildId: string,
    payload: ScheduledEventPayload,
    reason?: string,
  ): Promise<DiscordScheduledEvent> {
    this.eventWrites.push({ guildId, payload, reason });
    if (this.beforeEvent) await this.beforeEvent();
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
    return created;
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

function context(overrides: Partial<DiscordActionContext> = {}): DiscordActionContext {
  return {
    guildId: GUILD,
    channelId: TEXT,
    userId: USER,
    botId: BOT,
    messageId: "600",
    content: REQUEST,
    ...overrides,
  };
}

function eventArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_quote: REQUEST,
    name: "Movie night",
    description: null,
    entity_type: "voice",
    channel_id: VOICE,
    location: null,
    start_time: "2025-09-05T20:00:00",
    end_time: null,
    time_zone: "America/Vancouver",
    ...overrides,
  };
}

function inviteArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_quote: REQUEST,
    channel_id: VOICE,
    event_id: null,
    max_age: null,
    max_uses: null,
    ...overrides,
  };
}

function existingEvent(overrides: Partial<DiscordScheduledEvent> = {}): DiscordScheduledEvent {
  return {
    id: "550",
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

const KEY = turnKey(GUILD, TEXT, USER);

async function fixture(
  run: (
    client: StubDiscord,
    service: DiscordActionService,
    turns: TurnStore<PendingRequest>,
    db: Database,
  ) => Promise<void>,
): Promise<void> {
  using db = openDatabase(":memory:");
  const client = new StubDiscord();
  const turns = new TurnStore<PendingRequest>(() => NOW);
  await run(
    client,
    createDiscordActionService(client, db, "America/Vancouver", () => NOW, turns),
    turns,
    db,
  );
}

function denyRole(client: StubDiscord, memberId: string, permission: bigint) {
  const roleId = client.members[memberId].roles[0];
  const role = client.guild.roles.find((item) => item.id === roleId)!;
  role.permissions = String(BigInt(role.permissions) & ~permission);
}

test("abandonment and reset invalidate a delayed creation and clarification", async () => {
  for (const reset of [false, true]) {
    await fixture(async (client, service, turns) => {
      const initial = await service.createSession(context());
      await initial.executeTool("clarify_discord_action", {
        request_quote: REQUEST,
        question: "Which channel?",
      });
      const delayed = await service.createSession(context({ messageId: "601", content: "Lounge" }));
      if (reset) await service.clearPending(GUILD, TEXT, USER);
      else await service.createSession(context({ messageId: "602", content: "Never mind" }));

      const creation = await delayed.executeTool("create_discord_event", eventArgs());
      expect(creation.ok).toStrictEqual(false);
      expect(client.eventWrites.length).toStrictEqual(0);
      const clarification = await delayed.executeTool("clarify_discord_action", {
        request_quote: REQUEST,
        question: "What end time?",
      });
      expect(clarification.needsClarification).toStrictEqual(undefined);
      expect(turns.pending(KEY)).toBeNull();
    });
  }
});

test("an older completed mutation preserves a newer clarification", async () => {
  await fixture(async (client, service, turns) => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const blocked = new Promise<void>((resolve) => (release = resolve));
    client.beforeEvent = () => {
      markStarted();
      return blocked;
    };
    const older = await service.createSession(context());
    const running = older.executeTool("create_discord_event", eventArgs());
    await started;
    const request = "Create a workshop event tomorrow";
    try {
      const newer = await service.createSession(context({ messageId: "602", content: request }));
      await newer.executeTool("clarify_discord_action", {
        request_quote: request,
        question: "When?",
      });
    } finally {
      release();
      expect((await running).ok).toStrictEqual(true);
    }
    expect(turns.pending(KEY)?.content).toStrictEqual(request);
  });
});

test("abandonment during the final event lookup prevents the external write", async () => {
  await fixture(async (client, service) => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const blocked = new Promise<void>((resolve) => (release = resolve));
    client.listScheduledEvents = async () => {
      markStarted();
      await blocked;
      return [];
    };
    const session = await service.createSession(context());
    const running = session.executeTool("create_discord_event", eventArgs());
    await started;
    try {
      await service.createSession(context({ messageId: "601", content: "Never mind" }));
    } finally {
      release();
    }
    expect((await running).ok).toStrictEqual(false);
    expect(client.eventWrites.length).toStrictEqual(0);
  });
});

test("a newer explicit request invalidates a delayed invite", async () => {
  await fixture(async (client, service) => {
    const delayed = await service.createSession(context());
    await service.createSession(context({ messageId: "601", content: "Create a workshop event" }));
    const result = await delayed.executeTool("create_discord_invite", inviteArgs());
    expect(result.ok).toStrictEqual(false);
    expect(client.inviteWrites.length).toStrictEqual(0);
  });
});

test("voice request creates a real event with resolved UTC time and verified invite URL", async () => {
  await fixture(async (client, service) => {
    const session = await service.createSession(context());
    const lookup = await session.executeTool("get_discord_event_context", {});
    expect(lookup.time_zone).toStrictEqual("America/Vancouver");
    const event = await session.executeTool("create_discord_event", eventArgs());
    expect(event.ok).toStrictEqual(true);
    expect(event.eventUrl).toStrictEqual("https://discord.com/events/100/501");
    expect(client.eventWrites[0].payload).toStrictEqual({
      name: "Movie night",
      privacy_level: 2,
      entity_type: 2,
      scheduled_start_time: "2025-09-06T03:00:00.000Z",
      channel_id: VOICE,
    });
    expect(client.eventWrites[0].guildId).toStrictEqual(GUILD);
    expect(client.eventWrites[0].reason!).toContain(USER);
    expect(client.eventWrites[0].reason!).toContain("600");
    const invite = await session.executeTool(
      "create_discord_invite",
      inviteArgs({ event_id: event.eventId }),
    );
    expect(invite.ok).toStrictEqual(true);
    expect(invite.inviteUrl).toStrictEqual("https://discord.gg/sandbox-invite?event=501");
    expect(client.inviteWrites[0].payload).toStrictEqual({
      max_age: 86400,
      max_uses: 0,
      unique: false,
      temporary: false,
    });
    expect(session.results.length).toStrictEqual(2);
  });
});

test("external events require and forward a location and end time", async () => {
  await fixture(async (client, service) => {
    const session = await service.createSession(context());
    const result = await session.executeTool(
      "create_discord_event",
      eventArgs({
        entity_type: "external",
        channel_id: null,
        location: "Central Library",
        description: "Bring a book.",
        end_time: "2025-09-05T22:00:00",
      }),
    );
    expect(result.ok).toStrictEqual(true);
    expect(client.eventWrites[0].payload).toStrictEqual({
      name: "Movie night",
      privacy_level: 2,
      entity_type: 3,
      scheduled_start_time: "2025-09-06T03:00:00.000Z",
      scheduled_end_time: "2025-09-06T05:00:00.000Z",
      description: "Bring a book.",
      channel_id: null,
      entity_metadata: { location: "Central Library" },
    });
  });
  for (const missing of [{ end_time: null }, { location: null }]) {
    await fixture(async (client, service) => {
      const session = await service.createSession(context());
      const result = await session.executeTool(
        "create_discord_event",
        eventArgs({
          entity_type: "external",
          channel_id: null,
          location: "Central Library",
          end_time: "2025-09-05T22:00:00",
          ...missing,
        }),
      );
      expect(result.ok).toStrictEqual(false);
      expect(client.eventWrites.length).toStrictEqual(0);
    });
  }
});

test("Haru's action voice preserves exact event names, Discord timestamps, and invite links", async () => {
  await fixture(async (client, service) => {
    const title = "Will & Grace? Movie night!";
    const request = `Create the event ${title} on September 5 from 8pm to 10pm in Lounge and share an invite.`;
    const session = await service.createSession(context({ content: request }));
    const event = await session.executeTool(
      "create_discord_event",
      eventArgs({
        request_quote: request,
        name: title,
        end_time: "2025-09-05T22:00:00",
      }),
    );
    const invite = await session.executeTool(
      "create_discord_invite",
      inviteArgs({
        request_quote: request,
        event_id: event.eventId,
      }),
    );
    expect(event.ok).toStrictEqual(true);
    expect(invite.ok).toStrictEqual(true);
    expect(client.eventWrites[0].payload.name).toStrictEqual(title);
    expect(client.eventWrites[0].payload.scheduled_start_time).toStrictEqual(
      "2025-09-06T03:00:00.000Z",
    );
    expect(client.eventWrites[0].payload.scheduled_end_time).toStrictEqual(
      "2025-09-06T05:00:00.000Z",
    );
    const lines = formatActionResults(session.results)!.split("\n");
    expect(lines[0]).toContain("Ehehe~");
    expect(lines[1]).toStrictEqual(title);
    expect(lines[2]).toStrictEqual("<t:1757127600:F> – <t:1757134800:F>");
    expect(lines[3]).toStrictEqual("https://discord.com/events/100/501");
    expect(lines[5]).toStrictEqual("Here's your event invite!~");
    expect(lines[6]).toStrictEqual("https://discord.gg/sandbox-invite?event=501");
    expect(event.eventUrl).toStrictEqual(lines[3]);
    expect(invite.inviteUrl).toStrictEqual(lines[6]);
  });
});

test("multi-day event receipts include the verified end date", async () => {
  await fixture(async (client, service) => {
    const request =
      "Create a Retreat event at Camp from September 5 at 8pm until September 7 at 10pm Vancouver time.";
    const session = await service.createSession(context({ content: request }));
    const result = await session.executeTool(
      "create_discord_event",
      eventArgs({
        request_quote: request,
        name: "Retreat",
        entity_type: "external",
        channel_id: null,
        location: "Camp",
        end_time: "2025-09-07T22:00:00",
      }),
    );
    expect(result.ok).toStrictEqual(true);
    expect(client.eventWrites[0].payload.scheduled_start_time).toStrictEqual(
      "2025-09-06T03:00:00.000Z",
    );
    expect(client.eventWrites[0].payload.scheduled_end_time).toStrictEqual(
      "2025-09-08T05:00:00.000Z",
    );
    expect(formatActionResults(session.results)!).toContain("<t:1757127600:F> – <t:1757307600:F>");
  });
});

test("uncertain invite receipts keep a confirmed event and all uncertainty without rewriting links", async () => {
  await fixture(async (client, service) => {
    client.inviteFailure = new DiscordApiError("Connection lost after sending", 0, true);
    const session = await service.createSession(context());
    const event = await session.executeTool("create_discord_event", eventArgs());
    const invite = await session.executeTool(
      "create_discord_invite",
      inviteArgs({ event_id: event.eventId }),
    );
    expect(event.ok).toStrictEqual(true);
    expect(invite.ok).toStrictEqual(false);
    expect(invite.uncertain).toStrictEqual(true);
    const receipt = formatActionResults(session.results)!;
    expect(receipt).toContain("Ehehe~ I made your event!");
    expect(receipt).toContain("https://discord.com/events/100/501");
    expect(receipt).toContain("Eep... Discord did not confirm the result.");
    expect(receipt).toContain("may have succeeded; I have not retried it");
    expect(receipt.includes("Here's your event invite")).toStrictEqual(false);
    expect(receipt.includes("https://discord.gg/")).toStrictEqual(false);
    await session.executeTool("create_discord_invite", inviteArgs({ event_id: event.eventId }));
    expect(client.inviteWrites.length).toStrictEqual(1);

    // Voice decoration must not rewrite a verified result's URL punctuation.
    const url = "https://discord.gg/sandbox-invite?event=501&source=local!";
    const failure = `The invite could not be verified at ${url}`;
    const result = { ok: false, uncertain: true, message: failure };
    const formatted = formatActionResults([result])!;
    expect(formatted.slice(formatted.indexOf("https://"))).toStrictEqual(url);
    expect(result.message).toStrictEqual(failure);
  });
});

test("clarification keeps Haru's question intact and does not frame missing details as failure", async () => {
  await fixture(async (client, service) => {
    const session = await service.createSession(context());
    const question = "Ehehe~ what time should Movie night end? (｡•ᴗ•｡)";
    await session.executeTool("clarify_discord_action", { request_quote: REQUEST, question });
    expect(formatActionResults(session.results)).toStrictEqual(question);
    expect(client.eventWrites.length + client.inviteWrites.length).toStrictEqual(0);
    const followup = await service.createSession(context({ messageId: "601", content: "10pm" }));
    expect(followup.instructions).toContain(question);
  });
});

test("Stage creation uses a Stage channel and requires both parties' moderator permissions", async () => {
  await fixture(async (client, service) => {
    const session = await service.createSession(context());
    const result = await session.executeTool(
      "create_discord_event",
      eventArgs({ entity_type: "stage", channel_id: STAGE }),
    );
    expect(result.ok).toStrictEqual(true);
    expect(client.eventWrites[0].payload.entity_type).toStrictEqual(1);
    expect(client.eventWrites[0].payload.channel_id).toStrictEqual(STAGE);
  });
  for (const member of [USER, BOT]) {
    await fixture(async (client, service) => {
      denyRole(client, member, P.MOVE_MEMBERS);
      const session = await service.createSession(context());
      const result = await session.executeTool(
        "create_discord_event",
        eventArgs({ entity_type: "stage", channel_id: STAGE }),
      );
      expect(result.ok).toStrictEqual(false);
      expect(String(result.message)).toContain(member === USER ? "You need" : "Haru needs");
      expect(client.eventWrites.length).toStrictEqual(0);
    });
  }
});

test("requester and bot must each have event and invite permissions", async () => {
  for (const member of [USER, BOT]) {
    for (const action of ["event", "invite"]) {
      await fixture(async (client, service) => {
        denyRole(client, member, action === "event" ? P.CREATE_EVENTS : P.CREATE_INSTANT_INVITE);
        const session = await service.createSession(context());
        const result = await session.executeTool(
          action === "event" ? "create_discord_event" : "create_discord_invite",
          action === "event" ? eventArgs() : inviteArgs(),
        );
        expect(result.ok).toStrictEqual(false);
        expect(String(result.message)).toContain(member === USER ? "You need" : "Haru needs");
        expect(client.eventWrites.length + client.inviteWrites.length).toStrictEqual(0);
      });
    }
  }
});

test("external event creation checks server permissions for requester and bot", async () => {
  for (const member of [USER, BOT]) {
    await fixture(async (client, service) => {
      denyRole(client, member, P.CREATE_EVENTS);
      const session = await service.createSession(context());
      const result = await session.executeTool(
        "create_discord_event",
        eventArgs({
          entity_type: "external",
          channel_id: null,
          location: "Library",
          end_time: "2025-09-05T22:00:00",
        }),
      );
      expect(result.ok).toStrictEqual(false);
      expect(String(result.message)).toContain(member === USER ? "You need" : "Haru needs");
      expect(client.eventWrites.length).toStrictEqual(0);
    });
  }
});

test("channel overwrites prevent creating an inaccessible voice event", async () => {
  for (const member of [USER, BOT]) {
    await fixture(async (client, service) => {
      client.channels[1].permission_overwrites = [
        {
          id: member,
          type: 1,
          allow: "0",
          deny: String(P.CONNECT),
        },
      ];
      const session = await service.createSession(context());
      const result = await session.executeTool("create_discord_event", eventArgs());
      expect(result.ok).toStrictEqual(false);
      expect(client.eventWrites.length).toStrictEqual(0);
    });
  }
});

test("cross-server channel IDs and event references cannot cause writes", async () => {
  await fixture(async (client, service) => {
    client.channels.push({ id: "777", guild_id: "999", name: "Other server", type: 2 });
    client.events.push(existingEvent({ id: "778", guild_id: "999" }));
    const session = await service.createSession(context());
    for (const [name, args] of [
      ["create_discord_event", eventArgs({ channel_id: "777" })],
      ["create_discord_invite", inviteArgs({ channel_id: "777" })],
      ["create_discord_invite", inviteArgs({ event_id: "778" })],
    ] as const) {
      const result = await session.executeTool(name, args);
      expect(result.ok).toStrictEqual(false);
      expect(String(result.message)).toContain("not in this server");
    }
    expect(client.eventWrites.length + client.inviteWrites.length).toStrictEqual(0);
  });
});

test("private event invites return the direct event link without creating an invite", async () => {
  await fixture(async (client, service) => {
    client.channels[1].permission_overwrites = [
      { id: GUILD, type: 0, allow: "0", deny: String(P.VIEW_CHANNEL) },
      { id: "201", type: 0, allow: String(P.VIEW_CHANNEL), deny: "0" },
      { id: "301", type: 0, allow: String(P.VIEW_CHANNEL), deny: "0" },
    ];
    client.events.push(existingEvent());
    const session = await service.createSession(context());
    const result = await session.executeTool(
      "create_discord_invite",
      inviteArgs({ event_id: "550" }),
    );
    expect(result.ok).toStrictEqual(false);
    expect(String(result.message)).toContain("private");
    expect(String(result.message)).toContain("https://discord.com/events/100/550");
    expect(client.inviteWrites.length).toStrictEqual(0);
  });
});

test("event invites cannot redirect through another channel or target ended events", async () => {
  for (const variant of ["channel", "status"]) {
    await fixture(async (client, service) => {
      client.events.push(existingEvent(variant === "status" ? { status: 3 } : {}));
      const session = await service.createSession(context());
      const result = await session.executeTool(
        "create_discord_invite",
        inviteArgs({
          event_id: "550",
          channel_id: variant === "channel" ? TEXT : VOICE,
        }),
      );
      expect(result.ok).toStrictEqual(false);
      expect(client.inviteWrites.length).toStrictEqual(0);
    });
  }
});

test("repeated calls and replayed messages reuse the recorded event result", async () => {
  await fixture(async (client, service, _turns, db) => {
    const session = await service.createSession(context());
    const original = await session.executeTool("create_discord_event", eventArgs());
    const repeated = await session.executeTool(
      "create_discord_event",
      eventArgs({ name: "A second event" }),
    );
    // A new service has empty in-memory turns, as after a restart; the records are in SQLite.
    const restarted = createDiscordActionService(client, db, "America/Vancouver", () => NOW);
    const replay = await restarted.createSession(context());
    const replayed = await replay.executeTool("create_discord_event", eventArgs());
    expect(original.ok).toStrictEqual(true);
    expect(repeated).toStrictEqual(original);
    expect(replayed).toStrictEqual(original);
    expect(client.eventWrites.length).toStrictEqual(1);
  });
});

test("two users creating the same event at once make one Discord write", async () => {
  await fixture(async (client, service) => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    client.beforeEvent = () => {
      markStarted();
      return new Promise<void>((resolve) => (release = resolve));
    };
    const first = await service.createSession(context());
    const second = await service.createSession(context({ userId: "202", messageId: "601" }));
    const running = first.executeTool("create_discord_event", eventArgs());
    await started;
    const concurrent = await second.executeTool("create_discord_event", eventArgs());
    release();
    expect((await running).ok).toStrictEqual(true);
    expect(concurrent.ok).toStrictEqual(false);
    expect(concurrent.uncertain).toStrictEqual(true);
    expect(String(concurrent.message)).toContain("already in progress");
    expect(client.eventWrites.length).toStrictEqual(1);
  });
});

test("two users replacing an ended event at once recreate it only once", async () => {
  await fixture(async (client, service) => {
    const original = await (
      await service.createSession(context())
    ).executeTool("create_discord_event", eventArgs());
    expect(original.ok).toStrictEqual(true);
    client.events[0].status = 3;
    // Hold both lookups of the stale receipt until both sessions are waiting on Discord.
    let waiting = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const list = client.listScheduledEvents.bind(client);
    client.listScheduledEvents = async (guildId) => {
      if (++waiting === 2) release();
      await gate;
      return await list(guildId);
    };
    const first = await service.createSession(context({ messageId: "602" }));
    const second = await service.createSession(context({ userId: "202", messageId: "603" }));
    const results = await Promise.all([
      first.executeTool("create_discord_event", eventArgs()),
      second.executeTool("create_discord_event", eventArgs()),
    ]);
    expect(results.map((result) => result.ok)).toStrictEqual([true, false]);
    expect(String(results[1].message)).toContain("changed while I was checking");
    expect(client.eventWrites.length).toStrictEqual(2);
  });
});

test("a definite failure releases the event so a new message can try again", async () => {
  await fixture(async (client, service) => {
    client.eventFailure = new DiscordApiError("Missing Permissions", 403, false);
    const first = await (
      await service.createSession(context())
    ).executeTool("create_discord_event", eventArgs());
    expect(first.ok).toStrictEqual(false);
    expect(first.uncertain).toBeUndefined();
    client.eventFailure = undefined;
    const retry = await (
      await service.createSession(context({ messageId: "601" }))
    ).executeTool("create_discord_event", eventArgs());
    expect(retry.ok).toStrictEqual(true);
    expect(client.eventWrites.length).toStrictEqual(2);
  });
});

test("new messages with the same event fingerprint reuse the receipt", async () => {
  await fixture(async (client, service) => {
    const first = await service.createSession(context());
    const original = await first.executeTool("create_discord_event", eventArgs());
    const second = await service.createSession(context({ messageId: "601" }));
    const reused = await second.executeTool(
      "create_discord_event",
      eventArgs({ name: "MOVIE NIGHT" }),
    );
    expect(reused.ok).toStrictEqual(true);
    expect(reused.eventId).toStrictEqual(original.eventId);
    expect(reused.eventUrl).toStrictEqual(original.eventUrl);
    expect(String(reused.message)).toContain("already waiting for you");
    expect(String(reused.message).includes("I made your event")).toStrictEqual(false);
    expect(client.eventWrites.length).toStrictEqual(1);
  });
});

test("a new request can recreate a deleted or cancelled event without replaying the old message", async () => {
  for (const deleted of [true, false]) {
    await fixture(async (client, service) => {
      const first = await service.createSession(context());
      const original = await first.executeTool("create_discord_event", eventArgs());
      if (deleted) client.events = [];
      else client.events[0].status = 4;
      const replay = await service.createSession(context());
      expect(await replay.executeTool("create_discord_event", eventArgs())).toStrictEqual(original);
      expect(client.eventWrites.length).toStrictEqual(1);
      const replacement = await service.createSession(context({ messageId: "601" }));
      const recreated = await replacement.executeTool("create_discord_event", eventArgs());
      expect(recreated.ok).toStrictEqual(true);
      expect(recreated.eventId).toStrictEqual("502");
      expect(client.eventWrites.length).toStrictEqual(2);
    });
  }
});

test("concurrent matching requests claim only one Discord write", async () => {
  await fixture(async (client, service) => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const blocked = new Promise<void>((resolve) => (release = resolve));
    client.beforeEvent = () => {
      markStarted();
      return blocked;
    };
    const first = await service.createSession(context());
    const running = first.executeTool("create_discord_event", eventArgs());
    await started;
    const second = await service.createSession(context({ messageId: "601" }));
    try {
      const competing = await second.executeTool("create_discord_event", eventArgs());
      expect(competing.ok).toStrictEqual(false);
      expect(String(competing.message)).toContain("in progress");
      expect(client.eventWrites.length).toStrictEqual(1);
    } finally {
      release();
      const completed = await running;
      expect(completed.ok).toStrictEqual(true);
    }
  });
});

test("uncertain Discord event POST is not retried by repeats or a new message", async () => {
  await fixture(async (client, service) => {
    client.eventFailure = new DiscordApiError("Timed out after sending", 0, true);
    const first = await service.createSession(context());
    const result = await first.executeTool("create_discord_event", eventArgs());
    expect(result.ok).toStrictEqual(false);
    expect(result.uncertain).toStrictEqual(true);
    expect(String(result.message)).toContain("may have succeeded");
    expect(await first.executeTool("create_discord_event", eventArgs())).toStrictEqual(result);
    const second = await service.createSession(context({ messageId: "601" }));
    expect(await second.executeTool("create_discord_event", eventArgs())).toStrictEqual(result);
    expect(client.eventWrites.length).toStrictEqual(1);
  });
});

test("existing matching bot event is reused when no local receipt exists", async () => {
  await fixture(async (client, service) => {
    client.events.push(existingEvent());
    const session = await service.createSession(context());
    const result = await session.executeTool("create_discord_event", eventArgs());
    expect(result.ok).toStrictEqual(true);
    expect(result.eventId).toStrictEqual("550");
    expect(String(result.message)).toContain("already waiting for you");
    expect(String(result.message).includes("I made your event")).toStrictEqual(false);
    expect(client.eventWrites.length).toStrictEqual(0);
  });
});

test("pending clarification continues only for the same user, channel, and guild", async () => {
  await fixture(async (client, service) => {
    const initial = await service.createSession(context());
    const question = await initial.executeTool("clarify_discord_action", {
      request_quote: REQUEST,
      question: "What end time?",
    });
    expect(question.needsClarification).toStrictEqual(true);
    for (const overrides of [{ userId: "202" }, { channelId: "403" }, { guildId: "101" }]) {
      const stranger = await service.createSession(
        context({ messageId: "601", content: "10pm", ...overrides }),
      );
      const refused = await stranger.executeTool(
        "create_discord_event",
        eventArgs({ end_time: "2025-09-05T22:00:00" }),
      );
      expect(refused.ok).toStrictEqual(false);
    }
    expect(client.eventWrites.length).toStrictEqual(0);
    const followup = await service.createSession(context({ messageId: "602", content: "10pm" }));
    expect(followup.instructions).toContain("What end time?");
    const completed = await followup.executeTool(
      "create_discord_event",
      eventArgs({ end_time: "2025-09-05T22:00:00" }),
    );
    expect(completed.ok).toStrictEqual(true);
    expect(client.eventWrites.length).toStrictEqual(1);
    expect(client.eventWrites[0].reason!).toContain("message 600");
    const later = await service.createSession(context({ messageId: "603", content: "10pm" }));
    const noLongerPending = await later.executeTool("create_discord_event", eventArgs());
    expect(noLongerPending.ok).toStrictEqual(false);
  });
});

test("successful event and failed invite both remain in truthful receipts", async () => {
  await fixture(async (client, service) => {
    client.inviteFailure = new DiscordApiError("Discord denied the invite request.", 403);
    const session = await service.createSession(context());
    const event = await session.executeTool("create_discord_event", eventArgs());
    const invite = await session.executeTool(
      "create_discord_invite",
      inviteArgs({ event_id: event.eventId }),
    );
    expect(event.ok).toStrictEqual(true);
    expect(invite.ok).toStrictEqual(false);
    const receipt = formatActionResults(session.results)!;
    expect(receipt).toContain("https://discord.com/events/100/501");
    expect(receipt).toContain("Ehehe~ I made your event!");
    expect(receipt).toContain("Eep... Discord denied the invite request.");
    expect(receipt.includes("Here's your event invite")).toStrictEqual(false);
    expect(client.eventWrites.length).toStrictEqual(1);
    expect(client.inviteWrites.length).toStrictEqual(1);
    await session.executeTool("create_discord_invite", inviteArgs({ event_id: event.eventId }));
    expect(client.inviteWrites.length).toStrictEqual(1);
  });
});

test("verified event success survives receipt persistence failure and its durable claim blocks replay", async () => {
  await fixture(async (client, service, _turns, db) => {
    // Fail the receipt write (the update of the pending claim) after Discord accepted the event.
    db.run(`CREATE TRIGGER fail_receipt BEFORE UPDATE ON discord_action_operations
            BEGIN SELECT RAISE(ABORT, 'Simulated storage failure'); END`);
    const session = await service.createSession(context());
    const result = await session.executeTool("create_discord_event", eventArgs());
    expect(result.ok).toStrictEqual(true);
    expect(result.eventId).toStrictEqual("501");
    expect(formatActionResults(session.results)!).toContain("https://discord.com/events/100/501");
    db.run("DROP TRIGGER fail_receipt");
    const restoredService = createDiscordActionService(client, db, "America/Vancouver", () => NOW);
    const replay = await restoredService.createSession(context());
    const repeated = await replay.executeTool("create_discord_event", eventArgs());
    expect(repeated.ok).toStrictEqual(false);
    expect(repeated.uncertain).toStrictEqual(true);
    expect(String(repeated.message)).toContain("have not repeated");
    expect(client.eventWrites.length).toStrictEqual(1);
  });
});

test("quoted requests, hypotheticals, negation, and cancellation cannot authorize writes", async () => {
  const messages = [
    `> ${REQUEST}`,
    `Someone said "${REQUEST}"`,
    `\`\`\`\n${REQUEST}\n\`\`\``,
    `Hypothetically, ${REQUEST}`,
    `What would happen if I asked you to ${REQUEST}`,
    `Do not ${REQUEST}`,
    `Don't ${REQUEST}`,
    "Cancel the event request.",
  ];
  for (const content of messages) {
    expect(hasExplicitActionRequest(content)).toStrictEqual(false);
    await fixture(async (client, service) => {
      const session = await service.createSession(context({ content }));
      const result = await session.executeTool("create_discord_event", eventArgs());
      expect(result.ok).toStrictEqual(false);
      expect(client.eventWrites.length).toStrictEqual(0);
    });
  }
});

test("a request to summarize quoted action text cannot use that quote to authorize creation", async () => {
  await fixture(async (client, service) => {
    const content = `Create a summary of this event request: "${REQUEST}"`;
    const session = await service.createSession(context({ content }));
    const result = await session.executeTool("create_discord_event", eventArgs());
    expect(result.ok).toStrictEqual(false);
    expect(client.eventWrites.length).toStrictEqual(0);
  });
});

test("cancellation and reset discard pending authorization", async () => {
  for (const reset of [false, true]) {
    await fixture(async (client, service) => {
      const initial = await service.createSession(context());
      await initial.executeTool("clarify_discord_action", {
        request_quote: REQUEST,
        question: "What end time?",
      });
      if (reset) await service.clearPending(GUILD, TEXT, USER);
      const followup = await service.createSession(
        context({ messageId: "601", content: reset ? "10pm" : "Cancel, never mind." }),
      );
      const result = await followup.executeTool("create_discord_event", eventArgs());
      expect(result.ok).toStrictEqual(false);
      expect(client.eventWrites.length).toStrictEqual(0);
    });
  }
});

test("curly-apostrophe cancellation clears the pending request for later replies", async () => {
  await fixture(async (client, service) => {
    const initial = await service.createSession(context());
    await initial.executeTool("clarify_discord_action", {
      request_quote: REQUEST,
      question: "What end time?",
    });
    const cancelled = await service.createSession(
      context({ messageId: "601", content: "Don’t create it." }),
    );
    expect((await cancelled.executeTool("create_discord_event", eventArgs())).ok).toStrictEqual(
      false,
    );
    const later = await service.createSession(context({ messageId: "602", content: "10pm" }));
    expect((await later.executeTool("create_discord_event", eventArgs())).ok).toStrictEqual(false);
    expect(client.eventWrites.length).toStrictEqual(0);
  });
});

test("hypothetical and quoted followups cannot execute a pending request", async () => {
  for (const content of ["Hypothetically, what if it were at 10pm?", "> 10pm"]) {
    await fixture(async (client, service) => {
      const initial = await service.createSession(context());
      await initial.executeTool("clarify_discord_action", {
        request_quote: REQUEST,
        question: "What end time?",
      });
      const followup = await service.createSession(context({ messageId: "601", content }));
      const result = await followup.executeTool(
        "create_discord_event",
        eventArgs({ end_time: "2025-09-05T22:00:00" }),
      );
      expect(result.ok).toStrictEqual(false);
      expect(client.eventWrites.length).toStrictEqual(0);
    });
  }
});

test("invalid or past event times and mismatched channel kinds cannot reach Discord", async () => {
  for (const overrides of [
    { start_time: "2024-12-01T20:00:00" },
    { end_time: "2025-09-05T19:00:00" },
    { start_time: "2025-02-30T20:00:00" },
    { channel_id: TEXT },
    { entity_type: "stage", channel_id: VOICE },
  ]) {
    await fixture(async (client, service) => {
      const session = await service.createSession(context());
      const result = await session.executeTool("create_discord_event", eventArgs(overrides));
      expect(result.ok).toStrictEqual(false);
      expect(client.eventWrites.length).toStrictEqual(0);
    });
  }
});

test("a session whose turn expired after 20 minutes cannot write or ask", async () => {
  using db = openDatabase(":memory:");
  const client = new StubDiscord();
  let now = NOW;
  const turns = new TurnStore<PendingRequest>(() => now);
  const service = createDiscordActionService(client, db, "America/Vancouver", () => now, turns);
  const session = await service.createSession(context());
  now += 20 * 60_000;
  expect((await session.executeTool("create_discord_event", eventArgs())).ok).toStrictEqual(false);
  expect(
    (
      await session.executeTool("clarify_discord_action", {
        request_quote: REQUEST,
        question: "Which channel?",
      })
    ).ok,
  ).toStrictEqual(false);
  expect(client.eventWrites.length).toStrictEqual(0);
  expect(turns.pending(KEY)).toBeNull();
  expect(turns.turn(KEY)).toBeNull();
});

test("an older Discord message reaching session initialization late cannot revive an abandoned request", async () => {
  await fixture(async (client, service, turns) => {
    // These adjacent snowflakes collapse to the same value if compared as Numbers.
    const olderId = "1545337190928613416";
    const newerId = "1545337190928613417";
    await service.createSession(context({ messageId: newerId, content: "Never mind" }));
    // An older handler may still be awaiting context or web-search requests.
    const older = await service.createSession(context({ messageId: olderId }));
    expect((await older.executeTool("create_discord_event", eventArgs())).ok).toStrictEqual(false);
    expect(
      (
        await older.executeTool("clarify_discord_action", {
          request_quote: REQUEST,
          question: "Which channel?",
        })
      ).ok,
    ).toStrictEqual(false);
    expect(client.eventWrites.length).toStrictEqual(0);
    expect(turns.pending(KEY)).toBeNull();
    expect(turns.turn(KEY)?.messageId).toStrictEqual(newerId);
  });
});

test("reset ordering blocks older requests without clearing newer clarification", async () => {
  await fixture(async (client, service, turns) => {
    await service.clearPending(GUILD, TEXT, USER, "602");
    for (const messageId of ["600", "602"]) {
      const stale = await service.createSession(context({ messageId }));
      expect((await stale.executeTool("create_discord_event", eventArgs())).ok).toStrictEqual(
        false,
      );
      expect(
        (
          await stale.executeTool("clarify_discord_action", {
            request_quote: REQUEST,
            question: "Which channel?",
          })
        ).ok,
      ).toStrictEqual(false);
    }
    expect(client.eventWrites.length).toStrictEqual(0);
    const newer = await service.createSession(context({ messageId: "603" }));
    expect(
      (
        await newer.executeTool("clarify_discord_action", {
          request_quote: REQUEST,
          question: "Which channel?",
        })
      ).needsClarification,
    ).toStrictEqual(true);
    // A delayed older reset must not delete the newer request's clarification.
    await service.clearPending(GUILD, TEXT, USER, "601");
    expect(turns.pending(KEY)?.messageId).toStrictEqual("603");
    const followup = await service.createSession(context({ messageId: "604", content: "Lounge" }));
    expect((await followup.executeTool("create_discord_event", eventArgs())).ok).toStrictEqual(
      true,
    );
    expect(client.eventWrites.length).toStrictEqual(1);
    expect(client.eventWrites[0].reason!).toContain("message 603");
  });
});
