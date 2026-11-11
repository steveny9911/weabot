import { expect, test } from "bun:test";
import { createDiscordActionService, type DiscordActionService } from "./service.ts";
import { hasExplicitActionRequest } from "./intent.ts";
import { openDatabase } from "../../db/database.ts";
import { DiscordPermissions as P } from "../../discord/events.ts";
import {
  actionContext,
  existingEvent,
  NOW,
  StubEvents,
  VOICE,
} from "../../../tests/support/discord_actions.ts";

const EVENT_REQUEST = "Create the Movie night event on January 1 2027 at 8pm in Lounge.";
const INVITE_REQUEST = "Please create an invite to Lounge.";
const CANCEL_REQUEST = "Cancel the Movie night event.";
type Action = "create_discord_event" | "create_discord_invite" | "cancel_discord_event";

const context = (content: string, messageId = "600") => actionContext(content, { messageId });

function args(action: Action, request: string): Record<string, unknown> {
  if (action === "cancel_discord_event") {
    return { request_quote: request, event_reference: "Movie night" };
  }
  if (action === "create_discord_invite") {
    return {
      request_quote: request,
      channel_id: VOICE,
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
    channel_id: VOICE,
    location: null,
    start_time: "2027-01-01T20:00:00",
    end_time: null,
    time_zone: "America/Vancouver",
  };
}

/** The writes Discord received, as the actions that caused them. */
const written = (client: StubEvents): Action[] => [
  ...client.eventWrites.map((): Action => "create_discord_event"),
  ...client.inviteWrites.map((): Action => "create_discord_invite"),
  ...client.cancellationWrites.map((): Action => "cancel_discord_event"),
];

/** A service on a server where everyone may do everything, so only the request text decides. */
async function fixture(
  run: (service: DiscordActionService, client: StubEvents) => Promise<void>,
): Promise<void> {
  using db = openDatabase(":memory:");
  const all = P.ADMINISTRATOR;
  const client = new StubEvents({ everyone: all, requester: all, bot: all }, [existingEvent()]);
  await run(
    createDiscordActionService(client, db, "America/Vancouver", () => NOW),
    client,
  );
}

test("Discord multiline quotes cannot authorize any action or pending clarification", async () => {
  for (const [action, request] of [
    ["create_discord_event", EVENT_REQUEST],
    ["create_discord_invite", INVITE_REQUEST],
    ["cancel_discord_event", CANCEL_REQUEST],
  ] as const) {
    for (const marker of [">>> From Alex:", ">>>"]) {
      await fixture(async (service, client) => {
        const content = `Haru, summarize this quoted message:\n${marker}\n${request}`;
        expect(hasExplicitActionRequest(content)).toStrictEqual(false);
        const session = await service.createSession(context(content));
        expect((await session.executeTool(action, args(action, request))).ok).toStrictEqual(false);
        expect(
          (
            await session.executeTool("clarify_discord_action", {
              request_quote: request,
              question: "Which channel?",
            })
          ).ok,
        ).toStrictEqual(false);
        const followup = await service.createSession(context("Lounge", "601"));
        expect((await followup.executeTool(action, args(action, request))).ok).toStrictEqual(false);
        expect(written(client)).toStrictEqual([]);
      });
    }
  }
});
test("event creation, invitation, and cancellation require their own request authority", async () => {
  const requests: Record<Action, string> = {
    create_discord_event: EVENT_REQUEST,
    create_discord_invite: INVITE_REQUEST,
    cancel_discord_event: CANCEL_REQUEST,
  };
  for (const requested of Object.keys(requests) as Action[]) {
    for (const attempted of Object.keys(requests) as Action[]) {
      await fixture(async (service, client) => {
        const request = requests[requested];
        const session = await service.createSession(context(request));
        const result = await session.executeTool(attempted, args(attempted, request));
        expect(result.ok).toStrictEqual(attempted === requested);
        expect(written(client)).toStrictEqual(attempted === requested ? [attempted] : []);
      });
    }
  }
});

test("requesting an invitation for an existing event does not authorize event creation", async () => {
  for (const request of [
    "Create an invite for the Movie night event.",
    "Create an event invitation for Movie night.",
    "Create a Movie night event invite.",
  ]) {
    await fixture(async (service, client) => {
      const session = await service.createSession(context(request));
      expect(
        (await session.executeTool("create_discord_event", args("create_discord_event", request)))
          .ok,
      ).toStrictEqual(false);
      expect(
        (await session.executeTool("create_discord_invite", args("create_discord_invite", request)))
          .ok,
      ).toStrictEqual(true);
      expect(written(client)).toStrictEqual(["create_discord_invite"]);
    });
  }
});
test("pending clarification retains the original action kind for an ordinary answer", async () => {
  for (const [action, request] of [
    ["create_discord_event", "Create a Movie night event."],
    ["create_discord_invite", INVITE_REQUEST],
    ["cancel_discord_event", "Cancel the event."],
  ] as const) {
    await fixture(async (service, client) => {
      const initial = await service.createSession(context(request));
      const clarification = await initial.executeTool("clarify_discord_action", {
        request_quote: request,
        question: action === "cancel_discord_event" ? "Which event?" : "Which channel?",
      });
      expect(clarification.needsClarification).toStrictEqual(true);
      const reply = action === "cancel_discord_event" ? "Movie night" : "Lounge";
      const followup = await service.createSession(context(reply, "601"));
      expect((await followup.executeTool(action, args(action, request))).ok).toStrictEqual(true);
      expect(written(client)).toStrictEqual([action]);
    });
  }
});
