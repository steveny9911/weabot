import { describe, expect, test } from "bun:test";
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
import { type Database, openDatabase } from "../../db/database.ts";

const GUILD = "100";
const USER = "200";
const BOT = "300";
const TEXT = "400";
const VOICE = "401";
const STAGE = "402";
const EVENT = "550";
const NOW = Date.parse("2025-01-01T12:00:00Z");
const REQUEST = "Cancel the Movie night event.";
const CHANNEL_PERMISSIONS =
  P.VIEW_CHANNEL | P.CONNECT | P.MANAGE_CHANNELS | P.MUTE_MEMBERS | P.MOVE_MEMBERS;

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
  run: (client: CancellationDiscord, service: DiscordActionService, kv: Database) => Promise<void>,
): Promise<void> {
  const kv = openDatabase(":memory:");
  const client = new CancellationDiscord();
  try {
    await run(
      client,
      createDiscordActionService(client, kv, "America/Vancouver", () => NOW),
      kv,
    );
  } finally {
    kv.close();
  }
}

function setPermissions(client: CancellationDiscord, userId: string, permissions: bigint) {
  const role = client.guild.roles.find((role) => role.id === client.members[userId].roles[0])!;
  role.permissions = String(permissions);
}

test("never mind invalidates an already-running cancellation followup", async () => {
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
    expect(result.ok).toStrictEqual(false);
    expect(client.cancellationWrites.length).toStrictEqual(0);
    expect(client.events[0].status).toStrictEqual(1);
  });
});

test("cancellation cancels the exactly named event and records the real requester", async () => {
  await fixture(async (client, service) => {
    const session = await service.createSession(context());
    const result = await session.executeTool("cancel_discord_event", args());
    expect(result.ok).toStrictEqual(true);
    expect(result.eventId).toStrictEqual(EVENT);
    expect(String(result.message)).toMatch(/cancel/i);
    expect(client.events[0].status).toStrictEqual(4);
    expect(client.cancellationWrites.length).toStrictEqual(1);
    expect(client.cancellationWrites[0].guildId).toStrictEqual(GUILD);
    expect(client.cancellationWrites[0].eventId).toStrictEqual(EVENT);
    expect(client.cancellationWrites[0].reason!).toContain(USER);
    expect(client.cancellationWrites[0].reason!).toContain("600");
    expect(client.eventReads.length > 0).toStrictEqual(true);
    expect(formatActionResults(session.results)!).toMatch(/cancel/i);
    expect(client.createWrites + client.inviteWrites).toStrictEqual(0);
  });
});

describe("cancellation ignores real Discord mention snowflakes when resolving an event", () => {
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
    test(label, async () => {
      await fixture(async (client, service) => {
        client.members[botId] = { user: { id: botId, bot: true }, roles: ["301"] };
        client.events[0] = existingEvent({ id: eventId, creator_id: botId });
        const request = `${markup} Cancel the Movie night event.`;
        const session = await service.createSession(context({ botId, content: request }));
        const result = await session.executeTool(
          "cancel_discord_event",
          args({ request_quote: request }),
        );
        expect(result.ok).toStrictEqual(true);
        expect(client.cancellationWrites.map((write) => write.eventId)).toStrictEqual([eventId]);
        expect(client.events[0].status).toStrictEqual(4);
      });
    });
  }
});

test("cancellation accepts an event-link clarification with a real bot mention", async () => {
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
    expect(question.needsClarification).toStrictEqual(true);
    expect(client.cancellationWrites.length).toStrictEqual(0);

    const link = `https://discord.com/events/${GUILD}/${eventId}`;
    const followup = await service.createSession(
      context({
        botId,
        messageId: "601",
        content: `<@!${botId}> ${link}`,
      }),
    );
    const result = await followup.executeTool(
      "cancel_discord_event",
      args({ request_quote: request, event_reference: link }),
    );
    expect(result.ok).toStrictEqual(true);
    expect(client.cancellationWrites.map((write) => write.eventId)).toStrictEqual([eventId]);
    expect(client.events[0].status).toStrictEqual(4);
  });
});

test("cancellation resolves exact case-insensitive names and user-provided URLs or IDs", async () => {
  for (const reference of ["MOVIE NIGHT", `https://discord.com/events/${GUILD}/${EVENT}`, EVENT]) {
    await fixture(async (client, service) => {
      const request = `Cancel the ${reference} event.`;
      const session = await service.createSession(context({ content: request }));
      const result = await session.executeTool(
        "cancel_discord_event",
        args({ request_quote: request, event_reference: reference }),
      );
      expect(result.ok).toStrictEqual(true);
      expect(client.cancellationWrites.map((write) => write.eventId)).toStrictEqual([EVENT]);
    });
  }
});

test("cancellation does not accept a model-selected ID absent from the human request", async () => {
  await fixture(async (client, service) => {
    const session = await service.createSession(context());
    await session.executeTool("get_discord_event_context", {});
    const result = await session.executeTool(
      "cancel_discord_event",
      args({ event_reference: EVENT }),
    );
    expect(result.ok).toStrictEqual(false);
    expect(client.cancellationWrites.length).toStrictEqual(0);
  });
});

test("cancellation cannot guess an event from a partial name or several named targets", async () => {
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
      expect(result.needsClarification).toStrictEqual(true);
      expect(client.cancellationWrites.length).toStrictEqual(0);
    });
  }
});

test("multiple supplied event links or IDs require the user to choose one", async () => {
  for (const useLinks of [false, true]) {
    await fixture(async (client, service) => {
      const firstId = "1545337190928613416";
      const secondId = "1545337190928613417";
      client.events = [
        existingEvent({ id: firstId }),
        existingEvent({ id: secondId, name: "Game night" }),
      ];
      const reference = (id: string) =>
        useLinks ? `https://discord.com/events/${GUILD}/${id}` : id;
      const request = `Cancel event ${reference(firstId)} or ${reference(secondId)}.`;
      const session = await service.createSession(context({ content: request }));
      const result = await session.executeTool(
        "cancel_discord_event",
        args({ request_quote: request, event_reference: reference(firstId) }),
      );
      expect(result.needsClarification).toStrictEqual(true);
      expect(client.cancellationWrites.length).toStrictEqual(0);
    });
  }
});

test("a bulk cancellation can continue after the user chooses one event link", async () => {
  await fixture(async (client, service) => {
    client.events.push(existingEvent({ id: "551", name: "Game night" }));
    const request = "Cancel all events.";
    const session = await service.createSession(context({ content: request }));
    const question = await session.executeTool(
      "cancel_discord_event",
      args({ request_quote: request, event_reference: null }),
    );
    expect(question.needsClarification).toStrictEqual(true);
    expect(client.cancellationWrites.length).toStrictEqual(0);
    const link = `https://discord.com/events/${GUILD}/${EVENT}`;
    const followup = await service.createSession(context({ messageId: "601", content: link }));
    const result = await followup.executeTool(
      "cancel_discord_event",
      args({ request_quote: request, event_reference: link }),
    );
    expect(result.ok).toStrictEqual(true);
    expect(result.needsClarification).toStrictEqual(undefined);
    expect(client.cancellationWrites.map((write) => write.eventId)).toStrictEqual([EVENT]);
    expect(client.events[1].status).toStrictEqual(1);
  });
});

test("code and blockquote event references cannot choose a cancellation target", async () => {
  for (const quote of ["`Movie night`", "```\nMovie night\n```", "> Movie night"]) {
    await fixture(async (client, service) => {
      const request = `Cancel the event.\n${quote}`;
      const session = await service.createSession(context({ content: request }));
      const result = await session.executeTool(
        "cancel_discord_event",
        args({ request_quote: request }),
      );
      expect(result.ok).toStrictEqual(false);
      expect(client.cancellationWrites.length).toStrictEqual(0);
    });
  }
});

test("an ordinary quoted event title can be cancelled directly", async () => {
  await fixture(async (client, service) => {
    const request = 'Cancel "Movie night"';
    const session = await service.createSession(context({ content: request }));
    const result = await session.executeTool(
      "cancel_discord_event",
      args({ request_quote: request }),
    );
    expect(result.ok).toStrictEqual(true);
    expect(client.cancellationWrites.map((write) => write.eventId)).toStrictEqual([EVENT]);
  });
});

test("Cancel it with no pending request asks for a target then accepts an exact link", async () => {
  await fixture(async (client, service) => {
    const request = "Cancel it.";
    const session = await service.createSession(context({ content: request }));
    const question = await session.executeTool(
      "cancel_discord_event",
      args({ request_quote: request, event_reference: null }),
    );
    expect(question.needsClarification).toStrictEqual(true);
    expect(client.cancellationWrites.length).toStrictEqual(0);
    const link = `https://discord.com/events/${GUILD}/${EVENT}`;
    const followup = await service.createSession(context({ messageId: "601", content: link }));
    const result = await followup.executeTool(
      "cancel_discord_event",
      args({ request_quote: request, event_reference: link }),
    );
    expect(result.ok).toStrictEqual(true);
    expect(client.cancellationWrites.map((write) => write.eventId)).toStrictEqual([EVENT]);
  });
});

test("Cancel it abandons pending creation without cancelling an existing event", async () => {
  await fixture(async (client, service) => {
    const creationRequest = "Create the Movie night event.";
    const creation = await service.createSession(context({ content: creationRequest }));
    const question = await creation.executeTool("clarify_discord_action", {
      request_quote: creationRequest,
      question: "When should Movie night start?",
    });
    expect(question.needsClarification).toStrictEqual(true);
    const request = "Cancel it.";
    const abandoned = await service.createSession(context({ messageId: "601", content: request }));
    const cancelled = await abandoned.executeTool(
      "cancel_discord_event",
      args({ request_quote: request, event_reference: null }),
    );
    expect(cancelled.ok).toStrictEqual(false);
    expect(cancelled.needsClarification).toStrictEqual(undefined);
    const later = await service.createSession(
      context({
        messageId: "602",
        content: `September 5 at 8pm. https://discord.com/events/${GUILD}/${EVENT}`,
      }),
    );
    expect(
      (
        await later.executeTool(
          "cancel_discord_event",
          args({
            request_quote: request,
            event_reference: `https://discord.com/events/${GUILD}/${EVENT}`,
          }),
        )
      ).ok,
    ).toStrictEqual(false);
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
    expect(created.ok).toStrictEqual(false);
    expect(client.cancellationWrites.length + client.createWrites).toStrictEqual(0);
    expect(client.events[0].status).toStrictEqual(1);
  });
});

test("cancellation rejects cross-server URLs and mismatched Discord event guilds", async () => {
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
      expect(result.ok).toStrictEqual(false);
      expect(client.cancellationWrites.length).toStrictEqual(0);
    });
  }
});

test("duplicate event names require clarification and the user's followup selects the ID", async () => {
  await fixture(async (client, service) => {
    client.events.push(existingEvent({ id: "551" }));
    const session = await service.createSession(context());
    const ambiguous = await session.executeTool("cancel_discord_event", args());
    expect(ambiguous.needsClarification).toStrictEqual(true);
    expect(client.cancellationWrites.length).toStrictEqual(0);
    const followup = await service.createSession(context({ messageId: "601", content: "551" }));
    const cancelled = await followup.executeTool(
      "cancel_discord_event",
      args({ event_reference: "551" }),
    );
    expect(cancelled.ok).toStrictEqual(true);
    expect(client.cancellationWrites.map((write) => write.eventId)).toStrictEqual(["551"]);
    expect(client.cancellationWrites[0].reason!).toContain("600");
    expect(client.events[0].status).toStrictEqual(1);
  });
});

test("a vague cancellation asks which event and accepts the same user's answer", async () => {
  await fixture(async (client, service) => {
    const request = "Cancel the event.";
    const session = await service.createSession(context({ content: request }));
    const question = await session.executeTool(
      "cancel_discord_event",
      args({ request_quote: request, event_reference: null }),
    );
    expect(question.needsClarification).toStrictEqual(true);
    expect(client.cancellationWrites.length).toStrictEqual(0);
    for (const overrides of [{ userId: "202" }, { channelId: "403" }, { guildId: "101" }]) {
      const stranger = await service.createSession(
        context({
          messageId: "601",
          content: "Movie night",
          ...overrides,
        }),
      );
      const result = await stranger.executeTool(
        "cancel_discord_event",
        args({ request_quote: request }),
      );
      expect(result.ok).toStrictEqual(false);
    }
    const followup = await service.createSession(
      context({ messageId: "602", content: "Movie night" }),
    );
    const result = await followup.executeTool(
      "cancel_discord_event",
      args({ request_quote: request }),
    );
    expect(result.ok).toStrictEqual(true);
    expect(client.cancellationWrites.length).toStrictEqual(1);
  });
});

test("never mind abandons a pending cancellation and later details cannot revive it", async () => {
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
    expect(
      (await abandoned.executeTool("cancel_discord_event", args({ request_quote: request }))).ok,
    ).toStrictEqual(false);
    const later = await service.createSession(
      context({ messageId: "602", content: "Movie night" }),
    );
    expect(
      (await later.executeTool("cancel_discord_event", args({ request_quote: request }))).ok,
    ).toStrictEqual(false);
    expect(client.cancellationWrites.length).toStrictEqual(0);
  });
});

test("cancellation authorization rejects discussion, quotes, negation, and abandoning creation", async () => {
  expect(hasExplicitActionRequest(REQUEST)).toStrictEqual(true);
  for (const content of [
    `> ${REQUEST}`,
    `Someone said "${REQUEST}"`,
    `\`\`\`\n${REQUEST}\n\`\`\``,
    `Hypothetically, ${REQUEST}`,
    "How can I cancel the Movie night event?",
    "Don't cancel the Movie night event.",
    "Don’t cancel the Movie night event.",
    "Do not cancel the Movie night event.",
    "Cancel the event request.",
  ]) {
    expect(hasExplicitActionRequest(content)).toStrictEqual(false);
    await fixture(async (client, service) => {
      const session = await service.createSession(context({ content }));
      const result = await session.executeTool(
        "cancel_discord_event",
        args({ request_quote: content }),
      );
      expect(result.ok).toStrictEqual(false);
      expect(client.cancellationWrites.length).toStrictEqual(0);
    });
  }
});

test("creation and cancellation requests cannot authorize each other's operations", async () => {
  await fixture(async (client, service) => {
    const creationRequest = "Create the Movie night event.";
    const creation = await service.createSession(context({ content: creationRequest }));
    expect(
      (await creation.executeTool("cancel_discord_event", args({ request_quote: creationRequest })))
        .ok,
    ).toStrictEqual(false);
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
    expect(result.ok).toStrictEqual(false);
    expect(client.cancellationWrites.length + client.createWrites).toStrictEqual(0);
  });
});

test("cancellation checks each actor's event ownership permissions independently", async () => {
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
              ? owns
                ? 0n
                : P.CREATE_EVENTS
              : owns
                ? P.CREATE_EVENTS
                : P.MANAGE_EVENTS,
          );
        }
        const session = await service.createSession(context());
        const result = await session.executeTool("cancel_discord_event", args());
        expect(result.ok).toStrictEqual(deniedActor === null);
        expect(client.cancellationWrites.length).toStrictEqual(deniedActor === null ? 1 : 0);
      });
    }
  }
});

test("event creators can cancel with Manage Events even without Create Events", async () => {
  await fixture(async (client, service) => {
    setPermissions(client, BOT, P.MANAGE_EVENTS);
    const session = await service.createSession(context());
    expect((await session.executeTool("cancel_discord_event", args())).ok).toStrictEqual(true);
    expect(client.cancellationWrites.length).toStrictEqual(1);
  });
});

test("voice and Stage cancellation respect channel overwrites for both actors", async () => {
  for (const entityType of [1, 2]) {
    const required =
      entityType === 1
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
          expect(result.ok).toStrictEqual(false);
          expect(client.cancellationWrites.length).toStrictEqual(0);
        });
      }
    }
  }
});

test("external and Stage events can be cancelled with their required permissions", async () => {
  for (const entityType of [1, 3]) {
    await fixture(async (client, service) => {
      client.events[0] = existingEvent({
        entity_type: entityType,
        channel_id: entityType === 1 ? STAGE : null,
        entity_metadata: entityType === 3 ? { location: "The library" } : null,
      });
      const session = await service.createSession(context());
      expect((await session.executeTool("cancel_discord_event", args())).ok).toStrictEqual(true);
      expect(client.cancellationWrites.length).toStrictEqual(1);
    });
  }
});

test("already cancelled events return a truthful receipt without another write", async () => {
  await fixture(async (client, service) => {
    client.events[0].status = 4;
    const session = await service.createSession(context());
    const result = await session.executeTool("cancel_discord_event", args());
    expect(result.ok).toStrictEqual(true);
    expect(String(result.message)).toMatch(/already.*cancel/i);
    expect(client.cancellationWrites.length).toStrictEqual(0);
  });
});

test("active and completed events cannot be cancelled", async () => {
  for (const status of [2, 3]) {
    await fixture(async (client, service) => {
      client.events[0].status = status;
      const session = await service.createSession(context());
      const result = await session.executeTool("cancel_discord_event", args());
      expect(result.ok).toStrictEqual(false);
      expect(client.cancellationWrites.length).toStrictEqual(0);
    });
  }
});

test("recurring events are not cancelled without an occurrence-aware implementation", async () => {
  await fixture(async (client, service) => {
    Object.assign(client.events[0], { recurrence_rule: { frequency: 2, interval: 1 } });
    const session = await service.createSession(context());
    const result = await session.executeTool("cancel_discord_event", args());
    expect(result.ok).toStrictEqual(false);
    expect(client.cancellationWrites.length).toStrictEqual(0);
  });
});

test("cancellation refreshes the event before writing and refuses changed state", async () => {
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
      expect(result.ok).toStrictEqual(false);
      expect(client.cancellationWrites.length).toStrictEqual(0);
      expect(client.eventReads.length > 0).toStrictEqual(true);
    });
  }
});

test("replayed cancellation messages do not repeat a confirmed write", async () => {
  await fixture(async (client, service, kv) => {
    const session = await service.createSession(context());
    const original = await session.executeTool("cancel_discord_event", args());
    expect(original.ok).toStrictEqual(true);
    expect((await session.executeTool("cancel_discord_event", args())).ok).toStrictEqual(true);
    const restarted = createDiscordActionService(client, kv, "America/Vancouver", () => NOW);
    const replay = await restarted.createSession(context());
    expect((await replay.executeTool("cancel_discord_event", args())).ok).toStrictEqual(true);
    expect(client.cancellationWrites.length).toStrictEqual(1);
  });
});

test("concurrent cancellation requests claim only one Discord mutation", async () => {
  await fixture(async (client, service) => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const blocked = new Promise<void>((resolve) => (release = resolve));
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
      expect(competing.ok).toStrictEqual(false);
      expect(client.cancellationWrites.length).toStrictEqual(1);
    } finally {
      release();
      expect((await running).ok).toStrictEqual(true);
    }
  });
});

test("uncertain cancellation is not repeated by replays or a fresh request for the same event", async () => {
  await fixture(async (client, service) => {
    client.cancellationFailure = new DiscordApiError("Timed out after sending", 0, true);
    const first = await service.createSession(context());
    const uncertain = await first.executeTool("cancel_discord_event", args());
    expect(uncertain.ok).toStrictEqual(false);
    expect(uncertain.uncertain).toStrictEqual(true);
    expect(String(uncertain.message)).toMatch(/may have succeeded|not confirm/i);
    expect((await first.executeTool("cancel_discord_event", args())).uncertain).toStrictEqual(true);
    const fresh = await service.createSession(context({ messageId: "601" }));
    expect((await fresh.executeTool("cancel_discord_event", args())).uncertain).toStrictEqual(true);
    expect(client.cancellationWrites.length).toStrictEqual(1);
  });
});
