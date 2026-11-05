import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
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
const EVENT = "550";
const NOW = Date.parse("2025-01-01T12:00:00Z");
const REQUEST = "Cancel the Movie night event.";
const CHANNEL_PERMISSIONS = P.VIEW_CHANNEL | P.CONNECT | P.MANAGE_CHANNELS | P.MUTE_MEMBERS |
  P.MOVE_MEMBERS;

function existingEvent(overrides: Partial<DiscordScheduledEvent> = {}): DiscordScheduledEvent {
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

class CancellationDiscord implements DiscordEventsClient {
  guild: DiscordGuild = {
    id: GUILD,
    owner_id: "999",
    roles: [
      { id: GUILD, permissions: String(CHANNEL_PERMISSIONS) },
      { id: "201", permissions: String(P.MANAGE_EVENTS) },
      { id: "301", permissions: String(P.CREATE_EVENTS) },
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
  events = [existingEvent()];
  cancellationWrites: Array<{ guildId: string; eventId: string; reason?: string }> = [];
  eventReads: Array<{ guildId: string; eventId: string }> = [];
  createWrites = 0;
  inviteWrites = 0;
  cancellationFailure: Error | undefined;
  beforeCancellation: (() => Promise<void>) | undefined;
  beforeRead: (() => void) | undefined;

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
  createScheduledEvent(
    _guildId: string,
    _payload: ScheduledEventPayload,
    _reason?: string,
  ): Promise<DiscordScheduledEvent> {
    this.createWrites++;
    return Promise.resolve(existingEvent({ id: "551" }));
  }
  createInvite(
    _channelId: string,
    _payload: ChannelInvitePayload,
    _reason?: string,
  ): Promise<DiscordInvite> {
    this.inviteWrites++;
    return Promise.resolve({ code: "test-invite" });
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

function args(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { request_quote: REQUEST, event_reference: "Movie night", ...overrides };
}

async function fixture(
  run: (client: CancellationDiscord, service: DiscordActionService, kv: Deno.Kv) => Promise<void>,
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  const client = new CancellationDiscord();
  try {
    await run(client, createDiscordActionService(client, kv, "America/Vancouver", () => NOW), kv);
  } finally {
    kv.close();
  }
}

function setPermissions(client: CancellationDiscord, userId: string, permissions: bigint) {
  const role = client.guild.roles.find((role) => role.id === client.members[userId].roles[0])!;
  role.permissions = String(permissions);
}

Deno.test("never mind invalidates an already-running cancellation followup", async () => {
  await fixture(async (client, service) => {
    const request = "Cancel an event";
    const initial = await service.createSession(context({ content: request }));
    await initial.executeTool(
      "cancel_discord_event",
      args({
        request_quote: request,
        event_reference: null,
      }),
    );
    const delayed = await service.createSession(
      context({ messageId: "601", content: "Movie night" }),
    );
    await service.createSession(context({ messageId: "602", content: "Never mind" }));
    const result = await delayed.executeTool(
      "cancel_discord_event",
      args({ request_quote: request }),
    );
    assertEquals(result.ok, false);
    assertEquals(client.cancellationWrites.length, 0);
    assertEquals(client.events[0].status, 1);
  });
});

Deno.test("cancellation cancels the exactly named event and records the real requester", async () => {
  await fixture(async (client, service) => {
    const session = await service.createSession(context());
    const result = await session.executeTool("cancel_discord_event", args());
    assertEquals(result.ok, true);
    assertEquals(result.eventId, EVENT);
    assertMatch(String(result.message), /cancel/i);
    assertEquals(client.events[0].status, 4);
    assertEquals(client.cancellationWrites.length, 1);
    assertEquals(client.cancellationWrites[0].guildId, GUILD);
    assertEquals(client.cancellationWrites[0].eventId, EVENT);
    assertStringIncludes(client.cancellationWrites[0].reason!, USER);
    assertStringIncludes(client.cancellationWrites[0].reason!, "600");
    assertEquals(client.eventReads.length > 0, true);
    assertMatch(formatActionResults(session.results)!, /cancel/i);
    assertEquals(client.createWrites + client.inviteWrites, 0);
  });
});

Deno.test("cancellation ignores real Discord mention snowflakes when resolving an event", async (t) => {
  const botId = "1448562887038599168";
  const eventId = "1545337190928613416";
  const mentions = [
    ["bot user mention", `<@${botId}>`],
    ["bot nickname mention", `<@!${botId}>`],
    ["another user mention", `<@${botId}> <@181268251601403905>`],
    ["role mention", `<@${botId}> <@&589723496473690135>`],
    ["channel mention", `<@${botId}> <#589723496473690136>`],
    ["static custom emoji", `<@${botId}> <:wave:123456789012345678>`],
    ["animated custom emoji", `<@${botId}> <a:wave:123456789012345678>`],
    ["slash-command mention", `<@${botId}> </event manage:123456789012345678>`],
  ];
  for (const [label, markup] of mentions) {
    await t.step(label, async () => {
      await fixture(async (client, service) => {
        client.members[botId] = { user: { id: botId, bot: true }, roles: ["301"] };
        client.events[0] = existingEvent({ id: eventId, creator_id: botId });
        const request = `${markup} Cancel the Movie night event.`;
        const session = await service.createSession(context({ botId, content: request }));
        const result = await session.executeTool(
          "cancel_discord_event",
          args({ request_quote: request }),
        );
        assertEquals(result.ok, true);
        assertEquals(client.cancellationWrites.map((write) => write.eventId), [eventId]);
        assertEquals(client.events[0].status, 4);
      });
    });
  }
});

Deno.test("cancellation accepts an event-link clarification with a real bot mention", async () => {
  await fixture(async (client, service) => {
    const botId = "1448562887038599168";
    const eventId = "1545337190928613416";
    client.members[botId] = { user: { id: botId, bot: true }, roles: ["301"] };
    client.events[0] = existingEvent({ id: eventId, creator_id: botId });
    const request = `<@${botId}> Cancel the event.`;
    const session = await service.createSession(context({ botId, content: request }));
    const question = await session.executeTool(
      "cancel_discord_event",
      args({ request_quote: request, event_reference: null }),
    );
    assertEquals(question.needsClarification, true);
    assertEquals(client.cancellationWrites.length, 0);

    const link = `https://discord.com/events/${GUILD}/${eventId}`;
    const followup = await service.createSession(context({
      botId,
      messageId: "601",
      content: `<@!${botId}> ${link}`,
    }));
    const result = await followup.executeTool(
      "cancel_discord_event",
      args({ request_quote: request, event_reference: link }),
    );
    assertEquals(result.ok, true);
    assertEquals(client.cancellationWrites.map((write) => write.eventId), [eventId]);
    assertEquals(client.events[0].status, 4);
  });
});

Deno.test("cancellation resolves exact case-insensitive names and user-provided URLs or IDs", async () => {
  for (const reference of ["MOVIE NIGHT", `https://discord.com/events/${GUILD}/${EVENT}`, EVENT]) {
    await fixture(async (client, service) => {
      const request = `Cancel the ${reference} event.`;
      const session = await service.createSession(context({ content: request }));
      const result = await session.executeTool(
        "cancel_discord_event",
        args({ request_quote: request, event_reference: reference }),
      );
      assertEquals(result.ok, true, reference);
      assertEquals(client.cancellationWrites.map((write) => write.eventId), [EVENT]);
    });
  }
});

Deno.test("cancellation does not accept a model-selected ID absent from the human request", async () => {
  await fixture(async (client, service) => {
    const session = await service.createSession(context());
    await session.executeTool("get_discord_event_context", {});
    const result = await session.executeTool(
      "cancel_discord_event",
      args({ event_reference: EVENT }),
    );
    assertEquals(result.ok, false);
    assertEquals(client.cancellationWrites.length, 0);
  });
});

Deno.test("cancellation cannot guess an event from a partial name or several named targets", async () => {
  for (const request of ["Cancel the Movie event.", "Cancel Movie night and Game night events."]) {
    await fixture(async (client, service) => {
      client.events.push(existingEvent({ id: "551", name: "Game night" }));
      const session = await service.createSession(context({ content: request }));
      const result = await session.executeTool(
        "cancel_discord_event",
        args({
          request_quote: request,
          event_reference: request.includes("Game night") ? "Movie night" : "Movie",
        }),
      );
      assertEquals(result.needsClarification, true);
      assertEquals(client.cancellationWrites.length, 0);
    });
  }
});

Deno.test("multiple supplied event links or IDs require the user to choose one", async () => {
  for (const useLinks of [false, true]) {
    await fixture(async (client, service) => {
      const firstId = "1545337190928613416";
      const secondId = "1545337190928613417";
      client.events = [
        existingEvent({ id: firstId }),
        existingEvent({ id: secondId, name: "Game night" }),
      ];
      const reference = (id: string) => useLinks ? `https://discord.com/events/${GUILD}/${id}` : id;
      const request = `Cancel event ${reference(firstId)} or ${reference(secondId)}.`;
      const session = await service.createSession(context({ content: request }));
      const result = await session.executeTool(
        "cancel_discord_event",
        args({ request_quote: request, event_reference: reference(firstId) }),
      );
      assertEquals(result.needsClarification, true);
      assertEquals(client.cancellationWrites.length, 0);
    });
  }
});

Deno.test("a bulk cancellation can continue after the user chooses one event link", async () => {
  await fixture(async (client, service) => {
    client.events.push(existingEvent({ id: "551", name: "Game night" }));
    const request = "Cancel all events.";
    const session = await service.createSession(context({ content: request }));
    const question = await session.executeTool(
      "cancel_discord_event",
      args({ request_quote: request, event_reference: null }),
    );
    assertEquals(question.needsClarification, true);
    assertEquals(client.cancellationWrites.length, 0);
    const link = `https://discord.com/events/${GUILD}/${EVENT}`;
    const followup = await service.createSession(context({ messageId: "601", content: link }));
    const result = await followup.executeTool(
      "cancel_discord_event",
      args({ request_quote: request, event_reference: link }),
    );
    assertEquals(result.ok, true);
    assertEquals(result.needsClarification, undefined);
    assertEquals(client.cancellationWrites.map((write) => write.eventId), [EVENT]);
    assertEquals(client.events[1].status, 1);
  });
});

Deno.test("code and blockquote event references cannot choose a cancellation target", async () => {
  for (const quote of ["`Movie night`", "```\nMovie night\n```", "> Movie night"]) {
    await fixture(async (client, service) => {
      const request = `Cancel the event.\n${quote}`;
      const session = await service.createSession(context({ content: request }));
      const result = await session.executeTool(
        "cancel_discord_event",
        args({ request_quote: request }),
      );
      assertEquals(result.ok, false);
      assertEquals(client.cancellationWrites.length, 0);
    });
  }
});

Deno.test("an ordinary quoted event title can be cancelled directly", async () => {
  await fixture(async (client, service) => {
    const request = 'Cancel "Movie night"';
    const session = await service.createSession(context({ content: request }));
    const result = await session.executeTool(
      "cancel_discord_event",
      args({ request_quote: request }),
    );
    assertEquals(result.ok, true);
    assertEquals(client.cancellationWrites.map((write) => write.eventId), [EVENT]);
  });
});

Deno.test("Cancel it with no pending request asks for a target then accepts an exact link", async () => {
  await fixture(async (client, service) => {
    const request = "Cancel it.";
    const session = await service.createSession(context({ content: request }));
    const question = await session.executeTool(
      "cancel_discord_event",
      args({ request_quote: request, event_reference: null }),
    );
    assertEquals(question.needsClarification, true);
    assertEquals(client.cancellationWrites.length, 0);
    const link = `https://discord.com/events/${GUILD}/${EVENT}`;
    const followup = await service.createSession(context({ messageId: "601", content: link }));
    const result = await followup.executeTool(
      "cancel_discord_event",
      args({ request_quote: request, event_reference: link }),
    );
    assertEquals(result.ok, true);
    assertEquals(client.cancellationWrites.map((write) => write.eventId), [EVENT]);
  });
});

Deno.test("Cancel it abandons pending creation without cancelling an existing event", async () => {
  await fixture(async (client, service) => {
    const creationRequest = "Create the Movie night event.";
    const creation = await service.createSession(context({ content: creationRequest }));
    const question = await creation.executeTool("clarify_discord_action", {
      request_quote: creationRequest,
      question: "When should Movie night start?",
    });
    assertEquals(question.needsClarification, true);
    const request = "Cancel it.";
    const abandoned = await service.createSession(context({ messageId: "601", content: request }));
    const cancelled = await abandoned.executeTool(
      "cancel_discord_event",
      args({ request_quote: request, event_reference: null }),
    );
    assertEquals(cancelled.ok, false);
    assertEquals(cancelled.needsClarification, undefined);
    const later = await service.createSession(context({
      messageId: "602",
      content: `September 5 at 8pm. https://discord.com/events/${GUILD}/${EVENT}`,
    }));
    assertEquals(
      (await later.executeTool(
        "cancel_discord_event",
        args({
          request_quote: request,
          event_reference: `https://discord.com/events/${GUILD}/${EVENT}`,
        }),
      )).ok,
      false,
    );
    const created = await later.executeTool("create_discord_event", {
      request_quote: creationRequest,
      name: "Movie night",
      description: null,
      entity_type: "voice",
      channel_id: VOICE,
      location: null,
      start_time: "2025-09-05T20:00:00",
      end_time: null,
      time_zone: "America/Vancouver",
    });
    assertEquals(created.ok, false);
    assertEquals(client.cancellationWrites.length + client.createWrites, 0);
    assertEquals(client.events[0].status, 1);
  });
});

Deno.test("cancellation rejects cross-server URLs and mismatched Discord event guilds", async () => {
  for (const crossServerUrl of [true, false]) {
    await fixture(async (client, service) => {
      const reference = crossServerUrl ? `https://discord.com/events/999/${EVENT}` : EVENT;
      const request = `Cancel event ${reference}.`;
      if (!crossServerUrl) client.events[0].guild_id = "999";
      const session = await service.createSession(context({ content: request }));
      const result = await session.executeTool(
        "cancel_discord_event",
        args({ request_quote: request, event_reference: reference }),
      );
      assertEquals(result.ok, false);
      assertEquals(client.cancellationWrites.length, 0);
    });
  }
});

Deno.test("duplicate event names require clarification and the user's followup selects the ID", async () => {
  await fixture(async (client, service) => {
    client.events.push(existingEvent({ id: "551" }));
    const session = await service.createSession(context());
    const ambiguous = await session.executeTool("cancel_discord_event", args());
    assertEquals(ambiguous.needsClarification, true);
    assertEquals(client.cancellationWrites.length, 0);
    const followup = await service.createSession(context({ messageId: "601", content: "551" }));
    const cancelled = await followup.executeTool(
      "cancel_discord_event",
      args({ event_reference: "551" }),
    );
    assertEquals(cancelled.ok, true);
    assertEquals(client.cancellationWrites.map((write) => write.eventId), ["551"]);
    assertStringIncludes(client.cancellationWrites[0].reason!, "600");
    assertEquals(client.events[0].status, 1);
  });
});

Deno.test("a vague cancellation asks which event and accepts the same user's answer", async () => {
  await fixture(async (client, service) => {
    const request = "Cancel the event.";
    const session = await service.createSession(context({ content: request }));
    const question = await session.executeTool(
      "cancel_discord_event",
      args({ request_quote: request, event_reference: null }),
    );
    assertEquals(question.needsClarification, true);
    assertEquals(client.cancellationWrites.length, 0);
    for (const overrides of [{ userId: "202" }, { channelId: "403" }, { guildId: "101" }]) {
      const stranger = await service.createSession(context({
        messageId: "601",
        content: "Movie night",
        ...overrides,
      }));
      const result = await stranger.executeTool(
        "cancel_discord_event",
        args({ request_quote: request }),
      );
      assertEquals(result.ok, false);
    }
    const followup = await service.createSession(
      context({ messageId: "602", content: "Movie night" }),
    );
    const result = await followup.executeTool(
      "cancel_discord_event",
      args({ request_quote: request }),
    );
    assertEquals(result.ok, true);
    assertEquals(client.cancellationWrites.length, 1);
  });
});

Deno.test("never mind abandons a pending cancellation and later details cannot revive it", async () => {
  await fixture(async (client, service) => {
    const request = "Cancel the event.";
    const session = await service.createSession(context({ content: request }));
    await session.executeTool(
      "cancel_discord_event",
      args({ request_quote: request, event_reference: null }),
    );
    const abandoned = await service.createSession(
      context({ messageId: "601", content: "Never mind." }),
    );
    assertEquals(
      (await abandoned.executeTool("cancel_discord_event", args({ request_quote: request }))).ok,
      false,
    );
    const later = await service.createSession(
      context({ messageId: "602", content: "Movie night" }),
    );
    assertEquals(
      (await later.executeTool("cancel_discord_event", args({ request_quote: request }))).ok,
      false,
    );
    assertEquals(client.cancellationWrites.length, 0);
  });
});

Deno.test("cancellation authorization rejects discussion, quotes, negation, and abandoning creation", async () => {
  assertEquals(hasExplicitActionRequest(REQUEST), true);
  for (
    const content of [
      `> ${REQUEST}`,
      `Someone said "${REQUEST}"`,
      `\`\`\`\n${REQUEST}\n\`\`\``,
      `Hypothetically, ${REQUEST}`,
      "How can I cancel the Movie night event?",
      "Don't cancel the Movie night event.",
      "Don’t cancel the Movie night event.",
      "Do not cancel the Movie night event.",
      "Cancel the event request.",
    ]
  ) {
    assertEquals(hasExplicitActionRequest(content), false, content);
    await fixture(async (client, service) => {
      const session = await service.createSession(context({ content }));
      const result = await session.executeTool(
        "cancel_discord_event",
        args({ request_quote: content }),
      );
      assertEquals(result.ok, false, content);
      assertEquals(client.cancellationWrites.length, 0);
    });
  }
});

Deno.test("creation and cancellation requests cannot authorize each other's operations", async () => {
  await fixture(async (client, service) => {
    const creationRequest = "Create the Movie night event.";
    const creation = await service.createSession(context({ content: creationRequest }));
    assertEquals(
      (await creation.executeTool("cancel_discord_event", args({ request_quote: creationRequest })))
        .ok,
      false,
    );
    const cancellation = await service.createSession(context({ messageId: "601" }));
    const result = await cancellation.executeTool("create_discord_event", {
      request_quote: REQUEST,
      name: "Movie night",
      description: null,
      entity_type: "voice",
      channel_id: VOICE,
      location: null,
      start_time: "2025-09-05T20:00:00",
      end_time: null,
      time_zone: "America/Vancouver",
    });
    assertEquals(result.ok, false);
    assertEquals(client.cancellationWrites.length + client.createWrites, 0);
  });
});

Deno.test("cancellation checks each actor's event ownership permissions independently", async () => {
  for (const creator of [BOT, USER, "777", null]) {
    for (const deniedActor of [USER, BOT, null]) {
      await fixture(async (client, service) => {
        client.events[0].creator_id = creator;
        for (const actor of [USER, BOT]) {
          const owns = creator === actor;
          setPermissions(
            client,
            actor,
            actor === deniedActor
              ? (owns ? 0n : P.CREATE_EVENTS)
              : (owns ? P.CREATE_EVENTS : P.MANAGE_EVENTS),
          );
        }
        const session = await service.createSession(context());
        const result = await session.executeTool("cancel_discord_event", args());
        assertEquals(result.ok, deniedActor === null, `creator=${creator}, denied=${deniedActor}`);
        assertEquals(client.cancellationWrites.length, deniedActor === null ? 1 : 0);
      });
    }
  }
});

Deno.test("event creators can cancel with Manage Events even without Create Events", async () => {
  await fixture(async (client, service) => {
    setPermissions(client, BOT, P.MANAGE_EVENTS);
    const session = await service.createSession(context());
    assertEquals((await session.executeTool("cancel_discord_event", args())).ok, true);
    assertEquals(client.cancellationWrites.length, 1);
  });
});

Deno.test("voice and Stage cancellation respect channel overwrites for both actors", async () => {
  for (const entityType of [1, 2]) {
    const required = entityType === 1
      ? [P.VIEW_CHANNEL, P.MANAGE_CHANNELS, P.MUTE_MEMBERS, P.MOVE_MEMBERS]
      : [P.VIEW_CHANNEL, P.CONNECT];
    for (const permission of required) {
      for (const actor of [USER, BOT]) {
        await fixture(async (client, service) => {
          const channelId = entityType === 1 ? STAGE : VOICE;
          client.events[0].entity_type = entityType;
          client.events[0].channel_id = channelId;
          client.channels.find((channel) => channel.id === channelId)!.permission_overwrites = [
            { id: actor, type: 1, allow: "0", deny: String(permission) },
          ];
          const session = await service.createSession(context());
          const result = await session.executeTool("cancel_discord_event", args());
          assertEquals(
            result.ok,
            false,
            `entity=${entityType}, actor=${actor}, permission=${permission}`,
          );
          assertEquals(client.cancellationWrites.length, 0);
        });
      }
    }
  }
});

Deno.test("external and Stage events can be cancelled with their required permissions", async () => {
  for (const entityType of [1, 3]) {
    await fixture(async (client, service) => {
      client.events[0] = existingEvent({
        entity_type: entityType,
        channel_id: entityType === 1 ? STAGE : null,
        entity_metadata: entityType === 3 ? { location: "The library" } : null,
      });
      const session = await service.createSession(context());
      assertEquals((await session.executeTool("cancel_discord_event", args())).ok, true);
      assertEquals(client.cancellationWrites.length, 1);
    });
  }
});

Deno.test("already cancelled events return a truthful receipt without another write", async () => {
  await fixture(async (client, service) => {
    client.events[0].status = 4;
    const session = await service.createSession(context());
    const result = await session.executeTool("cancel_discord_event", args());
    assertEquals(result.ok, true);
    assertMatch(String(result.message), /already.*cancel/i);
    assertEquals(client.cancellationWrites.length, 0);
  });
});

Deno.test("active and completed events cannot be cancelled", async () => {
  for (const status of [2, 3]) {
    await fixture(async (client, service) => {
      client.events[0].status = status;
      const session = await service.createSession(context());
      const result = await session.executeTool("cancel_discord_event", args());
      assertEquals(result.ok, false);
      assertEquals(client.cancellationWrites.length, 0);
    });
  }
});

Deno.test("recurring events are not cancelled without an occurrence-aware implementation", async () => {
  await fixture(async (client, service) => {
    Object.assign(client.events[0], { recurrence_rule: { frequency: 2, interval: 1 } });
    const session = await service.createSession(context());
    const result = await session.executeTool("cancel_discord_event", args());
    assertEquals(result.ok, false);
    assertEquals(client.cancellationWrites.length, 0);
  });
});

Deno.test("cancellation refreshes the event before writing and refuses changed state", async () => {
  for (const change of ["status", "creator", "guild", "missing"]) {
    await fixture(async (client, service) => {
      client.beforeRead = () => {
        if (change === "status") client.events[0].status = 2;
        if (change === "creator") client.events[0].creator_id = "777";
        if (change === "guild") client.events[0].guild_id = "999";
        if (change === "missing") client.events = [];
      };
      const session = await service.createSession(context());
      const result = await session.executeTool("cancel_discord_event", args());
      assertEquals(result.ok, false, change);
      assertEquals(client.cancellationWrites.length, 0);
      assertEquals(client.eventReads.length > 0, true);
    });
  }
});

Deno.test("replayed cancellation messages do not repeat a confirmed write", async () => {
  await fixture(async (client, service, kv) => {
    const session = await service.createSession(context());
    const original = await session.executeTool("cancel_discord_event", args());
    assertEquals(original.ok, true);
    assertEquals((await session.executeTool("cancel_discord_event", args())).ok, true);
    const restarted = createDiscordActionService(client, kv, "America/Vancouver", () => NOW);
    const replay = await restarted.createSession(context());
    assertEquals((await replay.executeTool("cancel_discord_event", args())).ok, true);
    assertEquals(client.cancellationWrites.length, 1);
  });
});

Deno.test("concurrent cancellation requests claim only one Discord mutation", async () => {
  await fixture(async (client, service) => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => markStarted = resolve);
    const blocked = new Promise<void>((resolve) => release = resolve);
    client.beforeCancellation = () => {
      markStarted();
      return blocked;
    };
    const first = await service.createSession(context());
    const running = first.executeTool("cancel_discord_event", args());
    await started;
    const second = await service.createSession(context({ messageId: "601" }));
    try {
      const competing = await second.executeTool("cancel_discord_event", args());
      assertEquals(competing.ok, false);
      assertEquals(client.cancellationWrites.length, 1);
    } finally {
      release();
      assertEquals((await running).ok, true);
    }
  });
});

Deno.test("uncertain cancellation is not repeated by replays or a fresh request for the same event", async () => {
  await fixture(async (client, service) => {
    client.cancellationFailure = new DiscordApiError("Timed out after sending", 0, true);
    const first = await service.createSession(context());
    const uncertain = await first.executeTool("cancel_discord_event", args());
    assertEquals(uncertain.ok, false);
    assertEquals(uncertain.uncertain, true);
    assertMatch(String(uncertain.message), /may have succeeded|not confirm/i);
    assertEquals((await first.executeTool("cancel_discord_event", args())).uncertain, true);
    const fresh = await service.createSession(context({ messageId: "601" }));
    assertEquals((await fresh.executeTool("cancel_discord_event", args())).uncertain, true);
    assertEquals(client.cancellationWrites.length, 1);
  });
});
