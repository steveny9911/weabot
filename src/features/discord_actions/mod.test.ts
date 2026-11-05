import { assertEquals, assertStringIncludes } from "@std/assert";
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
} from "../../services/discord_events.ts";
import {
  createDiscordActionService,
  type DiscordActionContext,
  type DiscordActionService,
  formatActionResults,
  hasExplicitActionRequest,
} from "./mod.ts";

const GUILD = "100";
const USER = "200";
const BOT = "300";
const TEXT = "400";
const VOICE = "401";
const STAGE = "402";
const CAPABILITIES = P.CREATE_EVENTS | P.CREATE_INSTANT_INVITE | P.MANAGE_CHANNELS |
  P.MUTE_MEMBERS | P.MOVE_MEMBERS;
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

async function fixture(
  run: (client: StubDiscord, service: DiscordActionService, kv: Deno.Kv) => Promise<void>,
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  const client = new StubDiscord();
  try {
    await run(client, createDiscordActionService(client, kv, "America/Vancouver", () => NOW), kv);
  } finally {
    kv.close();
  }
}

function denyRole(client: StubDiscord, memberId: string, permission: bigint) {
  const roleId = client.members[memberId].roles[0];
  const role = client.guild.roles.find((item) => item.id === roleId)!;
  role.permissions = String(BigInt(role.permissions) & ~permission);
}

Deno.test("abandonment and reset invalidate a delayed creation and clarification", async () => {
  for (const reset of [false, true]) {
    await fixture(async (client, service, kv) => {
      const initial = await service.createSession(context());
      await initial.executeTool("clarify_discord_action", {
        request_quote: REQUEST,
        question: "Which channel?",
      });
      const delayed = await service.createSession(context({ messageId: "601", content: "Lounge" }));
      if (reset) await service.clearPending(GUILD, TEXT, USER);
      else await service.createSession(context({ messageId: "602", content: "Never mind" }));

      const creation = await delayed.executeTool("create_discord_event", eventArgs());
      assertEquals(creation.ok, false);
      assertEquals(client.eventWrites.length, 0);
      const clarification = await delayed.executeTool("clarify_discord_action", {
        request_quote: REQUEST,
        question: "What end time?",
      });
      assertEquals(clarification.needsClarification, undefined);
      assertEquals((await kv.get(["discord_action_pending", GUILD, TEXT, USER])).value, null);
    });
  }
});

Deno.test("an older completed mutation preserves a newer clarification", async () => {
  await fixture(async (client, service, kv) => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => markStarted = resolve);
    const blocked = new Promise<void>((resolve) => release = resolve);
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
      assertEquals((await running).ok, true);
    }
    const pending = await kv.get<{ content: string }>([
      "discord_action_pending",
      GUILD,
      TEXT,
      USER,
    ]);
    assertEquals(pending.value?.content, request);
  });
});

Deno.test("abandonment during the final event lookup prevents the external write", async () => {
  await fixture(async (client, service) => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => markStarted = resolve);
    const blocked = new Promise<void>((resolve) => release = resolve);
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
    assertEquals((await running).ok, false);
    assertEquals(client.eventWrites.length, 0);
  });
});

Deno.test("a newer explicit request invalidates a delayed invite", async () => {
  await fixture(async (client, service) => {
    const delayed = await service.createSession(context());
    await service.createSession(context({ messageId: "601", content: "Create a workshop event" }));
    const result = await delayed.executeTool("create_discord_invite", inviteArgs());
    assertEquals(result.ok, false);
    assertEquals(client.inviteWrites.length, 0);
  });
});

Deno.test("voice request creates a real event with resolved UTC time and verified invite URL", async () => {
  await fixture(async (client, service) => {
    const session = await service.createSession(context());
    const lookup = await session.executeTool("get_discord_event_context", {});
    assertEquals(lookup.time_zone, "America/Vancouver");
    const event = await session.executeTool("create_discord_event", eventArgs());
    assertEquals(event.ok, true);
    assertEquals(event.eventUrl, "https://discord.com/events/100/501");
    assertEquals(client.eventWrites[0].payload, {
      name: "Movie night",
      privacy_level: 2,
      entity_type: 2,
      scheduled_start_time: "2025-09-06T03:00:00.000Z",
      channel_id: VOICE,
    });
    assertEquals(client.eventWrites[0].guildId, GUILD);
    assertStringIncludes(client.eventWrites[0].reason!, USER);
    assertStringIncludes(client.eventWrites[0].reason!, "600");
    const invite = await session.executeTool(
      "create_discord_invite",
      inviteArgs({ event_id: event.eventId }),
    );
    assertEquals(invite.ok, true);
    assertEquals(invite.inviteUrl, "https://discord.gg/sandbox-invite?event=501");
    assertEquals(client.inviteWrites[0].payload, {
      max_age: 86400,
      max_uses: 0,
      unique: false,
      temporary: false,
    });
    assertEquals(session.results.length, 2);
  });
});

Deno.test("external events require and forward a location and end time", async () => {
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
    assertEquals(result.ok, true);
    assertEquals(client.eventWrites[0].payload, {
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
      assertEquals(result.ok, false);
      assertEquals(client.eventWrites.length, 0);
    });
  }
});

Deno.test("Haru's action voice preserves exact event names, Discord timestamps, and invite links", async () => {
  await fixture(async (client, service) => {
    const title = "Will & Grace? Movie night!";
    const request =
      `Create the event ${title} on September 5 from 8pm to 10pm in Lounge and share an invite.`;
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
    assertEquals(event.ok, true);
    assertEquals(invite.ok, true);
    assertEquals(client.eventWrites[0].payload.name, title);
    assertEquals(client.eventWrites[0].payload.scheduled_start_time, "2025-09-06T03:00:00.000Z");
    assertEquals(client.eventWrites[0].payload.scheduled_end_time, "2025-09-06T05:00:00.000Z");
    const lines = formatActionResults(session.results)!.split("\n");
    assertStringIncludes(lines[0], "Ehehe~");
    assertEquals(lines[1], title);
    assertEquals(lines[2], "<t:1757127600:F> – <t:1757134800:F>");
    assertEquals(lines[3], "https://discord.com/events/100/501");
    assertEquals(lines[5], "Here's your event invite!~");
    assertEquals(lines[6], "https://discord.gg/sandbox-invite?event=501");
    assertEquals(event.eventUrl, lines[3]);
    assertEquals(invite.inviteUrl, lines[6]);
  });
});

Deno.test("multi-day event receipts include the verified end date", async () => {
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
    assertEquals(result.ok, true);
    assertEquals(client.eventWrites[0].payload.scheduled_start_time, "2025-09-06T03:00:00.000Z");
    assertEquals(client.eventWrites[0].payload.scheduled_end_time, "2025-09-08T05:00:00.000Z");
    assertStringIncludes(
      formatActionResults(session.results)!,
      "<t:1757127600:F> – <t:1757307600:F>",
    );
  });
});

Deno.test("uncertain invite receipts keep a confirmed event and all uncertainty without rewriting links", async () => {
  await fixture(async (client, service) => {
    client.inviteFailure = new DiscordApiError("Connection lost after sending", 0, true);
    const session = await service.createSession(context());
    const event = await session.executeTool("create_discord_event", eventArgs());
    const invite = await session.executeTool(
      "create_discord_invite",
      inviteArgs({ event_id: event.eventId }),
    );
    assertEquals(event.ok, true);
    assertEquals(invite.ok, false);
    assertEquals(invite.uncertain, true);
    const receipt = formatActionResults(session.results)!;
    assertStringIncludes(receipt, "Ehehe~ I made your event!");
    assertStringIncludes(receipt, "https://discord.com/events/100/501");
    assertStringIncludes(receipt, "Eep... Discord did not confirm the result.");
    assertStringIncludes(receipt, "may have succeeded; I have not retried it");
    assertEquals(receipt.includes("Here's your event invite"), false);
    assertEquals(receipt.includes("https://discord.gg/"), false);
    await session.executeTool("create_discord_invite", inviteArgs({ event_id: event.eventId }));
    assertEquals(client.inviteWrites.length, 1);

    // Voice decoration must not rewrite a verified result's URL punctuation.
    const url = "https://discord.gg/sandbox-invite?event=501&source=local!";
    const failure = `The invite could not be verified at ${url}`;
    const result = { ok: false, uncertain: true, message: failure };
    const formatted = formatActionResults([result])!;
    assertEquals(formatted.slice(formatted.indexOf("https://")), url);
    assertEquals(result.message, failure);
  });
});

Deno.test("clarification keeps Haru's question intact and does not frame missing details as failure", async () => {
  await fixture(async (client, service) => {
    const session = await service.createSession(context());
    const question = "Ehehe~ what time should Movie night end? (｡•ᴗ•｡)";
    await session.executeTool("clarify_discord_action", { request_quote: REQUEST, question });
    assertEquals(formatActionResults(session.results), question);
    assertEquals(client.eventWrites.length + client.inviteWrites.length, 0);
    const followup = await service.createSession(context({ messageId: "601", content: "10pm" }));
    assertStringIncludes(followup.instructions, question);
  });
});

Deno.test("Stage creation uses a Stage channel and requires both parties' moderator permissions", async () => {
  await fixture(async (client, service) => {
    const session = await service.createSession(context());
    const result = await session.executeTool(
      "create_discord_event",
      eventArgs({ entity_type: "stage", channel_id: STAGE }),
    );
    assertEquals(result.ok, true);
    assertEquals(client.eventWrites[0].payload.entity_type, 1);
    assertEquals(client.eventWrites[0].payload.channel_id, STAGE);
  });
  for (const member of [USER, BOT]) {
    await fixture(async (client, service) => {
      denyRole(client, member, P.MOVE_MEMBERS);
      const session = await service.createSession(context());
      const result = await session.executeTool(
        "create_discord_event",
        eventArgs({ entity_type: "stage", channel_id: STAGE }),
      );
      assertEquals(result.ok, false);
      assertStringIncludes(String(result.message), member === USER ? "You need" : "Haru needs");
      assertEquals(client.eventWrites.length, 0);
    });
  }
});

Deno.test("requester and bot must each have event and invite permissions", async () => {
  for (const member of [USER, BOT]) {
    for (const action of ["event", "invite"]) {
      await fixture(async (client, service) => {
        denyRole(client, member, action === "event" ? P.CREATE_EVENTS : P.CREATE_INSTANT_INVITE);
        const session = await service.createSession(context());
        const result = await session.executeTool(
          action === "event" ? "create_discord_event" : "create_discord_invite",
          action === "event" ? eventArgs() : inviteArgs(),
        );
        assertEquals(result.ok, false);
        assertStringIncludes(String(result.message), member === USER ? "You need" : "Haru needs");
        assertEquals(client.eventWrites.length + client.inviteWrites.length, 0);
      });
    }
  }
});

Deno.test("external event creation checks server permissions for requester and bot", async () => {
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
      assertEquals(result.ok, false);
      assertStringIncludes(String(result.message), member === USER ? "You need" : "Haru needs");
      assertEquals(client.eventWrites.length, 0);
    });
  }
});

Deno.test("channel overwrites prevent creating an inaccessible voice event", async () => {
  for (const member of [USER, BOT]) {
    await fixture(async (client, service) => {
      client.channels[1].permission_overwrites = [{
        id: member,
        type: 1,
        allow: "0",
        deny: String(P.CONNECT),
      }];
      const session = await service.createSession(context());
      const result = await session.executeTool("create_discord_event", eventArgs());
      assertEquals(result.ok, false);
      assertEquals(client.eventWrites.length, 0);
    });
  }
});

Deno.test("cross-server channel IDs and event references cannot cause writes", async () => {
  await fixture(async (client, service) => {
    client.channels.push({ id: "777", guild_id: "999", name: "Other server", type: 2 });
    client.events.push(existingEvent({ id: "778", guild_id: "999" }));
    const session = await service.createSession(context());
    for (
      const [name, args] of [
        ["create_discord_event", eventArgs({ channel_id: "777" })],
        ["create_discord_invite", inviteArgs({ channel_id: "777" })],
        ["create_discord_invite", inviteArgs({ event_id: "778" })],
      ] as const
    ) {
      const result = await session.executeTool(name, args);
      assertEquals(result.ok, false);
      assertStringIncludes(String(result.message), "not in this server");
    }
    assertEquals(client.eventWrites.length + client.inviteWrites.length, 0);
  });
});

Deno.test("private event invites return the direct event link without creating an invite", async () => {
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
    assertEquals(result.ok, false);
    assertStringIncludes(String(result.message), "private");
    assertStringIncludes(String(result.message), "https://discord.com/events/100/550");
    assertEquals(client.inviteWrites.length, 0);
  });
});

Deno.test("event invites cannot redirect through another channel or target ended events", async () => {
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
      assertEquals(result.ok, false);
      assertEquals(client.inviteWrites.length, 0);
    });
  }
});

Deno.test("repeated calls and replayed messages reuse the recorded event result", async () => {
  await fixture(async (client, service, kv) => {
    const session = await service.createSession(context());
    const original = await session.executeTool("create_discord_event", eventArgs());
    const repeated = await session.executeTool(
      "create_discord_event",
      eventArgs({ name: "A second event" }),
    );
    const restarted = createDiscordActionService(client, kv, "America/Vancouver", () => NOW);
    const replay = await restarted.createSession(context());
    const replayed = await replay.executeTool("create_discord_event", eventArgs());
    assertEquals(original.ok, true);
    assertEquals(repeated, original);
    assertEquals(replayed, original);
    assertEquals(client.eventWrites.length, 1);
  });
});

Deno.test("new messages with the same event fingerprint reuse the receipt", async () => {
  await fixture(async (client, service) => {
    const first = await service.createSession(context());
    const original = await first.executeTool("create_discord_event", eventArgs());
    const second = await service.createSession(context({ messageId: "601" }));
    const reused = await second.executeTool(
      "create_discord_event",
      eventArgs({ name: "MOVIE NIGHT" }),
    );
    assertEquals(reused.ok, true);
    assertEquals(reused.eventId, original.eventId);
    assertEquals(reused.eventUrl, original.eventUrl);
    assertStringIncludes(String(reused.message), "already waiting for you");
    assertEquals(String(reused.message).includes("I made your event"), false);
    assertEquals(client.eventWrites.length, 1);
  });
});

Deno.test("a new request can recreate a deleted or cancelled event without replaying the old message", async () => {
  for (const deleted of [true, false]) {
    await fixture(async (client, service) => {
      const first = await service.createSession(context());
      const original = await first.executeTool("create_discord_event", eventArgs());
      if (deleted) client.events = [];
      else client.events[0].status = 4;
      const replay = await service.createSession(context());
      assertEquals(await replay.executeTool("create_discord_event", eventArgs()), original);
      assertEquals(client.eventWrites.length, 1);
      const replacement = await service.createSession(context({ messageId: "601" }));
      const recreated = await replacement.executeTool("create_discord_event", eventArgs());
      assertEquals(recreated.ok, true);
      assertEquals(recreated.eventId, "502");
      assertEquals(client.eventWrites.length, 2);
    });
  }
});

Deno.test("concurrent matching requests claim only one Discord write", async () => {
  await fixture(async (client, service) => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => markStarted = resolve);
    const blocked = new Promise<void>((resolve) => release = resolve);
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
      assertEquals(competing.ok, false);
      assertStringIncludes(String(competing.message), "in progress");
      assertEquals(client.eventWrites.length, 1);
    } finally {
      release();
      const completed = await running;
      assertEquals(completed.ok, true);
    }
  });
});

Deno.test("uncertain Discord event POST is not retried by repeats or a new message", async () => {
  await fixture(async (client, service) => {
    client.eventFailure = new DiscordApiError("Timed out after sending", 0, true);
    const first = await service.createSession(context());
    const result = await first.executeTool("create_discord_event", eventArgs());
    assertEquals(result.ok, false);
    assertEquals(result.uncertain, true);
    assertStringIncludes(String(result.message), "may have succeeded");
    assertEquals(await first.executeTool("create_discord_event", eventArgs()), result);
    const second = await service.createSession(context({ messageId: "601" }));
    assertEquals(await second.executeTool("create_discord_event", eventArgs()), result);
    assertEquals(client.eventWrites.length, 1);
  });
});

Deno.test("existing matching bot event is reused when no local receipt exists", async () => {
  await fixture(async (client, service) => {
    client.events.push(existingEvent());
    const session = await service.createSession(context());
    const result = await session.executeTool("create_discord_event", eventArgs());
    assertEquals(result.ok, true);
    assertEquals(result.eventId, "550");
    assertStringIncludes(String(result.message), "already waiting for you");
    assertEquals(String(result.message).includes("I made your event"), false);
    assertEquals(client.eventWrites.length, 0);
  });
});

Deno.test("pending clarification continues only for the same user, channel, and guild", async () => {
  await fixture(async (client, service) => {
    const initial = await service.createSession(context());
    const question = await initial.executeTool("clarify_discord_action", {
      request_quote: REQUEST,
      question: "What end time?",
    });
    assertEquals(question.needsClarification, true);
    for (const overrides of [{ userId: "202" }, { channelId: "403" }, { guildId: "101" }]) {
      const stranger = await service.createSession(
        context({ messageId: "601", content: "10pm", ...overrides }),
      );
      const refused = await stranger.executeTool(
        "create_discord_event",
        eventArgs({ end_time: "2025-09-05T22:00:00" }),
      );
      assertEquals(refused.ok, false);
    }
    assertEquals(client.eventWrites.length, 0);
    const followup = await service.createSession(context({ messageId: "602", content: "10pm" }));
    assertStringIncludes(followup.instructions, "What end time?");
    const completed = await followup.executeTool(
      "create_discord_event",
      eventArgs({ end_time: "2025-09-05T22:00:00" }),
    );
    assertEquals(completed.ok, true);
    assertEquals(client.eventWrites.length, 1);
    assertStringIncludes(client.eventWrites[0].reason!, "message 600");
    const later = await service.createSession(context({ messageId: "603", content: "10pm" }));
    const noLongerPending = await later.executeTool("create_discord_event", eventArgs());
    assertEquals(noLongerPending.ok, false);
  });
});

Deno.test("successful event and failed invite both remain in truthful receipts", async () => {
  await fixture(async (client, service) => {
    client.inviteFailure = new DiscordApiError("Discord denied the invite request.", 403);
    const session = await service.createSession(context());
    const event = await session.executeTool("create_discord_event", eventArgs());
    const invite = await session.executeTool(
      "create_discord_invite",
      inviteArgs({ event_id: event.eventId }),
    );
    assertEquals(event.ok, true);
    assertEquals(invite.ok, false);
    const receipt = formatActionResults(session.results)!;
    assertStringIncludes(receipt, "https://discord.com/events/100/501");
    assertStringIncludes(receipt, "Ehehe~ I made your event!");
    assertStringIncludes(receipt, "Eep... Discord denied the invite request.");
    assertEquals(receipt.includes("Here's your event invite"), false);
    assertEquals(client.eventWrites.length, 1);
    assertEquals(client.inviteWrites.length, 1);
    await session.executeTool("create_discord_invite", inviteArgs({ event_id: event.eventId }));
    assertEquals(client.inviteWrites.length, 1);
  });
});

Deno.test("verified event success survives receipt persistence failure and its durable claim blocks replay", async () => {
  await fixture(async (client, _service, kv) => {
    let failed = false;
    const failingKv = new Proxy(kv, {
      get(target, property) {
        if (property === "atomic") {
          return () => {
            const operation = target.atomic();
            // Fail the first receipt write after Discord accepted the mutation.
            if (client.eventWrites.length && !failed) {
              failed = true;
              operation.commit = () => Promise.reject(new Error("Simulated storage failure"));
            }
            return operation;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failingService = createDiscordActionService(
      client,
      failingKv,
      "America/Vancouver",
      () => NOW,
    );
    const session = await failingService.createSession(context());
    const result = await session.executeTool("create_discord_event", eventArgs());
    assertEquals(result.ok, true);
    assertEquals(result.eventId, "501");
    assertStringIncludes(
      formatActionResults(session.results)!,
      "https://discord.com/events/100/501",
    );
    const restoredService = createDiscordActionService(client, kv, "America/Vancouver", () => NOW);
    const replay = await restoredService.createSession(context());
    const repeated = await replay.executeTool("create_discord_event", eventArgs());
    assertEquals(repeated.ok, false);
    assertEquals(repeated.uncertain, true);
    assertStringIncludes(String(repeated.message), "have not repeated");
    assertEquals(client.eventWrites.length, 1);
  });
});

Deno.test("quoted requests, hypotheticals, negation, and cancellation cannot authorize writes", async () => {
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
    assertEquals(hasExplicitActionRequest(content), false);
    await fixture(async (client, service) => {
      const session = await service.createSession(context({ content }));
      const result = await session.executeTool("create_discord_event", eventArgs());
      assertEquals(result.ok, false);
      assertEquals(client.eventWrites.length, 0);
    });
  }
});

Deno.test("a request to summarize quoted action text cannot use that quote to authorize creation", async () => {
  await fixture(async (client, service) => {
    const content = `Create a summary of this event request: "${REQUEST}"`;
    const session = await service.createSession(context({ content }));
    const result = await session.executeTool("create_discord_event", eventArgs());
    assertEquals(result.ok, false);
    assertEquals(client.eventWrites.length, 0);
  });
});

Deno.test("cancellation and reset discard pending authorization", async () => {
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
      assertEquals(result.ok, false);
      assertEquals(client.eventWrites.length, 0);
    });
  }
});

Deno.test("curly-apostrophe cancellation clears the pending request for later replies", async () => {
  await fixture(async (client, service) => {
    const initial = await service.createSession(context());
    await initial.executeTool("clarify_discord_action", {
      request_quote: REQUEST,
      question: "What end time?",
    });
    const cancelled = await service.createSession(
      context({ messageId: "601", content: "Don’t create it." }),
    );
    assertEquals((await cancelled.executeTool("create_discord_event", eventArgs())).ok, false);
    const later = await service.createSession(context({ messageId: "602", content: "10pm" }));
    assertEquals((await later.executeTool("create_discord_event", eventArgs())).ok, false);
    assertEquals(client.eventWrites.length, 0);
  });
});

Deno.test("hypothetical and quoted followups cannot execute a pending request", async () => {
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
      assertEquals(result.ok, false);
      assertEquals(client.eventWrites.length, 0);
    });
  }
});

Deno.test("invalid or past event times and mismatched channel kinds cannot reach Discord", async () => {
  for (
    const overrides of [
      { start_time: "2024-12-01T20:00:00" },
      { end_time: "2025-09-05T19:00:00" },
      { start_time: "2025-02-30T20:00:00" },
      { channel_id: TEXT },
      { entity_type: "stage", channel_id: VOICE },
    ]
  ) {
    await fixture(async (client, service) => {
      const session = await service.createSession(context());
      const result = await session.executeTool("create_discord_event", eventArgs(overrides));
      assertEquals(result.ok, false);
      assertEquals(client.eventWrites.length, 0);
    });
  }
});

Deno.test("a session losing its generation claim cannot retry over a newer abandonment", async () => {
  await fixture(async (client, _service, kv) => {
    let release!: () => void;
    let signalReady!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    let firstClaim = true;
    const racingKv = new Proxy(kv, {
      get(target, property) {
        if (property === "atomic") {
          return () => {
            const operation = target.atomic();
            if (firstClaim) {
              firstClaim = false;
              const commit = operation.commit.bind(operation);
              operation.commit = async () => {
                signalReady();
                await blocked;
                return await commit();
              };
            }
            return operation;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = createDiscordActionService(client, racingKv, "America/Vancouver", () => NOW);
    const olderPending = service.createSession(context());
    await ready;
    try {
      await service.createSession(context({ messageId: "602", content: "Never mind" }));
    } finally {
      release();
    }
    const older = await olderPending;
    assertEquals((await older.executeTool("create_discord_event", eventArgs())).ok, false);
    assertEquals(
      (await older.executeTool("clarify_discord_action", {
        request_quote: REQUEST,
        question: "Which channel?",
      })).ok,
      false,
    );
    assertEquals(client.eventWrites.length, 0);
    assertEquals((await kv.get(["discord_action_pending", GUILD, TEXT, USER])).value, null);
    const generation = await kv.get<{ messageId: string }>([
      "discord_action_generation",
      GUILD,
      TEXT,
      USER,
    ]);
    assertEquals(generation.value?.messageId, "602");
  });
});

Deno.test("an older Discord message reaching session initialization late cannot revive an abandoned request", async () => {
  await fixture(async (client, service, kv) => {
    // These adjacent snowflakes collapse to the same value if compared as Numbers.
    const olderId = "1545337190928613416";
    const newerId = "1545337190928613417";
    await service.createSession(context({ messageId: newerId, content: "Never mind" }));
    // An older handler may still be awaiting context or web-search requests.
    const older = await service.createSession(context({ messageId: olderId }));
    assertEquals((await older.executeTool("create_discord_event", eventArgs())).ok, false);
    assertEquals(
      (await older.executeTool("clarify_discord_action", {
        request_quote: REQUEST,
        question: "Which channel?",
      })).ok,
      false,
    );
    assertEquals(client.eventWrites.length, 0);
    assertEquals((await kv.get(["discord_action_pending", GUILD, TEXT, USER])).value, null);
    const generation = await kv.get<{ messageId: string }>([
      "discord_action_generation",
      GUILD,
      TEXT,
      USER,
    ]);
    assertEquals(generation.value?.messageId, newerId);
  });
});

Deno.test("reset ordering blocks older requests without clearing newer clarification", async () => {
  await fixture(async (client, service, kv) => {
    await service.clearPending(GUILD, TEXT, USER, "602");
    for (const messageId of ["600", "602"]) {
      const stale = await service.createSession(context({ messageId }));
      assertEquals((await stale.executeTool("create_discord_event", eventArgs())).ok, false);
      assertEquals(
        (await stale.executeTool("clarify_discord_action", {
          request_quote: REQUEST,
          question: "Which channel?",
        })).ok,
        false,
      );
    }
    assertEquals(client.eventWrites.length, 0);
    const newer = await service.createSession(context({ messageId: "603" }));
    assertEquals(
      (await newer.executeTool("clarify_discord_action", {
        request_quote: REQUEST,
        question: "Which channel?",
      })).needsClarification,
      true,
    );
    // A delayed older reset must not delete the newer request's clarification.
    await service.clearPending(GUILD, TEXT, USER, "601");
    const pending = await kv.get<{ messageId: string }>([
      "discord_action_pending",
      GUILD,
      TEXT,
      USER,
    ]);
    assertEquals(pending.value?.messageId, "603");
    const followup = await service.createSession(context({ messageId: "604", content: "Lounge" }));
    assertEquals((await followup.executeTool("create_discord_event", eventArgs())).ok, true);
    assertEquals(client.eventWrites.length, 1);
    assertStringIncludes(client.eventWrites[0].reason!, "message 603");
  });
});
