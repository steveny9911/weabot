import { assertEquals } from "@std/assert";
import {
  createDiscordActionService,
  type DiscordActionContext,
  type DiscordActionService,
  hasExplicitActionRequest,
} from "./mod.ts";
import {
  type DiscordEventsClient,
  DiscordPermissions as P,
  type DiscordScheduledEvent,
} from "../../services/discord_events.ts";

const GUILD = "100";
const USER = "200";
const BOT = "300";
const CHANNEL = "400";
const EVENT = "500";
const EVENT_REQUEST = "Create the Movie night event on January 1 2027 at 8pm in General.";
const INVITE_REQUEST = "Please create an invite to General.";
const CANCEL_REQUEST = "Cancel the Movie night event.";
const NOW = Date.parse("2026-09-04T12:00:00Z");
type Action = "create_discord_event" | "create_discord_invite" | "cancel_discord_event";

function context(content: string, messageId = "600"): DiscordActionContext {
  return { guildId: GUILD, channelId: CHANNEL, userId: USER, botId: BOT, messageId, content };
}

function args(action: Action, request: string): Record<string, unknown> {
  if (action === "cancel_discord_event") {
    return { request_quote: request, event_reference: "Movie night" };
  }
  if (action === "create_discord_invite") {
    return {
      request_quote: request,
      channel_id: CHANNEL,
      event_id: null,
      max_age: 60,
      max_uses: 1,
    };
  }
  return {
    request_quote: request,
    name: "Movie night",
    description: null,
    entity_type: "voice",
    channel_id: CHANNEL,
    location: null,
    start_time: "2027-01-01T20:00:00",
    end_time: null,
    time_zone: "America/Vancouver",
  };
}

async function fixture(
  run: (service: DiscordActionService, writes: Action[]) => Promise<void>,
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  const writes: Action[] = [];
  const event: DiscordScheduledEvent = {
    id: EVENT,
    guild_id: GUILD,
    name: "Movie night",
    channel_id: CHANNEL,
    entity_type: 2,
    status: 1,
    creator_id: BOT,
    scheduled_start_time: "2027-01-02T04:00:00.000Z",
  };
  const client: DiscordEventsClient = {
    getGuild: () =>
      Promise.resolve({
        id: GUILD,
        owner_id: USER,
        roles: [{ id: GUILD, permissions: String(P.ADMINISTRATOR) }],
      }),
    getMember: (_guildId, id) => Promise.resolve({ user: { id, bot: id === BOT }, roles: [] }),
    getChannels: () =>
      Promise.resolve([{ id: CHANNEL, guild_id: GUILD, name: "General", type: 2 }]),
    // The existing cancellation target differs in time from creation requests.
    listScheduledEvents: () =>
      Promise.resolve([{ ...event, scheduled_start_time: "2027-02-01T20:00:00Z" }]),
    getScheduledEvent: () => Promise.resolve(event),
    createScheduledEvent: (_guildId, payload) => {
      writes.push("create_discord_event");
      return Promise.resolve({
        ...event,
        ...payload,
        channel_id: payload.channel_id ?? null,
        id: "501",
      });
    },
    createInvite: () => {
      writes.push("create_discord_invite");
      return Promise.resolve({ code: "test-only", guild: { id: GUILD }, channel: { id: CHANNEL } });
    },
    cancelScheduledEvent: () => {
      writes.push("cancel_discord_event");
      return Promise.resolve({ ...event, status: 4 });
    },
  };
  try {
    await run(createDiscordActionService(client, kv, "America/Vancouver", () => NOW), writes);
  } finally {
    kv.close();
  }
}

Deno.test("Discord multiline quotes cannot authorize any action or pending clarification", async () => {
  for (
    const [action, request] of [
      ["create_discord_event", EVENT_REQUEST],
      ["create_discord_invite", INVITE_REQUEST],
      ["cancel_discord_event", CANCEL_REQUEST],
    ] as const
  ) {
    for (const marker of [">>> From Alex:", ">>>"]) {
      await fixture(async (service, writes) => {
        const content = `Haru, summarize this quoted message:\n${marker}\n${request}`;
        assertEquals(hasExplicitActionRequest(content), false);
        const session = await service.createSession(context(content));
        assertEquals((await session.executeTool(action, args(action, request))).ok, false);
        assertEquals(
          (await session.executeTool("clarify_discord_action", {
            request_quote: request,
            question: "Which channel?",
          })).ok,
          false,
        );
        const followup = await service.createSession(context("General", "601"));
        assertEquals((await followup.executeTool(action, args(action, request))).ok, false);
        assertEquals(writes, []);
      });
    }
  }
});

Deno.test("a direct request before a multiline quote retains only its own action authority", async () => {
  await fixture(async (service, writes) => {
    const content = `${INVITE_REQUEST}\n>>> Other person's request:\n${EVENT_REQUEST}`;
    const session = await service.createSession(context(content));
    assertEquals(hasExplicitActionRequest(content), true);
    assertEquals(
      (await session.executeTool(
        "create_discord_event",
        args("create_discord_event", EVENT_REQUEST),
      ))
        .ok,
      false,
    );
    assertEquals(
      (await session.executeTool(
        "create_discord_invite",
        args("create_discord_invite", INVITE_REQUEST),
      ))
        .ok,
      true,
    );
    assertEquals(writes, ["create_discord_invite"]);
  });
});

Deno.test("event creation, invitation, and cancellation require their own request authority", async () => {
  const requests: Record<Action, string> = {
    create_discord_event: EVENT_REQUEST,
    create_discord_invite: INVITE_REQUEST,
    cancel_discord_event: CANCEL_REQUEST,
  };
  for (const requested of Object.keys(requests) as Action[]) {
    for (const attempted of Object.keys(requests) as Action[]) {
      await fixture(async (service, writes) => {
        const request = requests[requested];
        const session = await service.createSession(context(request));
        const result = await session.executeTool(attempted, args(attempted, request));
        assertEquals(result.ok, attempted === requested, `${requested} -> ${attempted}`);
        assertEquals(writes, attempted === requested ? [attempted] : []);
      });
    }
  }
});

Deno.test("requesting an invitation for an existing event does not authorize event creation", async () => {
  for (
    const request of [
      "Create an invite for the Movie night event.",
      "Create an event invitation for Movie night.",
      "Create a Movie night event invite.",
    ]
  ) {
    await fixture(async (service, writes) => {
      const session = await service.createSession(context(request));
      assertEquals(
        (await session.executeTool("create_discord_event", args("create_discord_event", request)))
          .ok,
        false,
      );
      assertEquals(
        (await session.executeTool("create_discord_invite", args("create_discord_invite", request)))
          .ok,
        true,
      );
      assertEquals(writes, ["create_discord_invite"]);
    });
  }
});

Deno.test("combined event and invite requests retain both permissions", async () => {
  for (
    const request of [
      "Create Movie night on January 1 2027 at 8pm in General and share an invite.",
      "Create the Movie night event with an invite.",
      "Create an event and an invitation.",
    ]
  ) {
    await fixture(async (service, writes) => {
      const session = await service.createSession(context(request));
      for (const action of ["create_discord_event", "create_discord_invite"] as const) {
        assertEquals((await session.executeTool(action, args(action, request))).ok, true, request);
      }
      assertEquals(writes, ["create_discord_event", "create_discord_invite"]);
    });
  }
});

Deno.test("pending clarification retains the original action kind for an ordinary answer", async () => {
  for (
    const [action, request] of [
      ["create_discord_event", "Create a Movie night event."],
      ["create_discord_invite", INVITE_REQUEST],
      ["cancel_discord_event", "Cancel the event."],
    ] as const
  ) {
    await fixture(async (service, writes) => {
      const initial = await service.createSession(context(request));
      const clarification = await initial.executeTool("clarify_discord_action", {
        request_quote: request,
        question: action === "cancel_discord_event" ? "Which event?" : "Which channel?",
      });
      assertEquals(clarification.needsClarification, true);
      const reply = action === "cancel_discord_event" ? "Movie night" : "General";
      const followup = await service.createSession(context(reply, "601"));
      assertEquals((await followup.executeTool(action, args(action, request))).ok, true);
      assertEquals(writes, [action]);
    });
  }
});

Deno.test("quoted clarification answers cannot supply event cancellation references", async () => {
  await fixture(async (service, writes) => {
    const request = "Cancel the event.";
    const initial = await service.createSession(context(request));
    await initial.executeTool("clarify_discord_action", {
      request_quote: request,
      question: "Which event?",
    });
    const followup = await service.createSession(
      context("Haru, here is somebody else's message:\n>>> Their answer:\nMovie night", "601"),
    );
    const result = await followup.executeTool(
      "cancel_discord_event",
      args("cancel_discord_event", request),
    );
    assertEquals(result.ok, false);
    assertEquals(writes, []);
  });
});
