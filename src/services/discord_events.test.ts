import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  createDiscordEventsClient,
  DiscordApiError,
  type DiscordChannel,
  type DiscordGuild,
  type DiscordMember,
  DiscordPermissions as P,
  type DiscordScheduledEvent,
  getChannelPermissions,
  getGuildPermissions,
  type ScheduledEventPayload,
} from "./discord_events.ts";

const guild: DiscordGuild = {
  id: "guild",
  owner_id: "owner",
  roles: [
    { id: "guild", permissions: String(P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY) },
    { id: "planner", permissions: String(P.CREATE_EVENTS | P.CONNECT) },
    { id: "inviter", permissions: String(P.CREATE_INSTANT_INVITE) },
    { id: "admin", permissions: String(P.ADMINISTRATOR) },
    { id: "other", permissions: String(P.MANAGE_CHANNELS) },
  ],
};
const member: DiscordMember = { user: { id: "member" }, roles: ["planner", "inviter"] };
const channel: DiscordChannel = { id: "voice", guild_id: "guild", name: "General", type: 2 };
const event: DiscordScheduledEvent = {
  id: "event",
  guild_id: "guild",
  name: "Game night",
  channel_id: "voice",
  entity_type: 2,
  scheduled_start_time: "2099-01-01T04:00:00.000Z",
  scheduled_end_time: "2099-01-01T06:00:00.000Z",
  status: 1,
};
const event_payload: ScheduledEventPayload = {
  name: event.name,
  privacy_level: 2,
  entity_type: 2,
  channel_id: "voice",
  scheduled_start_time: event.scheduled_start_time,
  scheduled_end_time: event.scheduled_end_time!,
};
const invite_payload = { max_age: 3600, max_uses: 5, temporary: false, unique: true };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function fetchMock(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
}

Deno.test("Discord events client reads typed guild, member, channels, and events", async () => {
  const routes: Record<string, unknown> = {
    "/guilds/guild": guild,
    "/guilds/guild/members/member": member,
    "/guilds/guild/channels": [channel],
    "/guilds/guild/scheduled-events": [event],
    "/guilds/guild/scheduled-events/event": event,
  };
  const requests: string[] = [];
  const client = createDiscordEventsClient("fake-token", {
    fetch: fetchMock((url, init) => {
      const path = url.replace("https://discord.com/api/v10", "");
      requests.push(path);
      assertEquals(init?.method, "GET");
      assertEquals(new Headers(init?.headers).get("Authorization"), "Bot fake-token");
      assertEquals(init?.body, undefined);
      assert(init?.signal);
      return jsonResponse(routes[path]);
    }),
  });
  assertEquals(await client.getGuild("guild"), guild);
  assertEquals(await client.getMember("guild", "member"), member);
  assertEquals(await client.getChannels("guild"), [channel]);
  assertEquals(await client.listScheduledEvents("guild"), [event]);
  assertEquals(await client.getScheduledEvent("guild", "event"), event);
  assertEquals(requests, Object.keys(routes));
});

Deno.test("Discord event and invite POSTs preserve payloads and encode audit reasons", async () => {
  const requests: { path: string; payload: unknown; reason: string | null }[] = [];
  const external_payload: ScheduledEventPayload = {
    ...event_payload,
    entity_type: 3,
    channel_id: null,
    entity_metadata: { location: "Board game café" },
  };
  const client = createDiscordEventsClient("fake-token", {
    fetch: fetchMock((url, init) => {
      assertEquals(init?.method, "POST");
      const payload = JSON.parse(String(init?.body));
      requests.push({
        path: new URL(url).pathname,
        payload,
        reason: new Headers(init?.headers).get("X-Audit-Log-Reason"),
      });
      return jsonResponse(
        url.endsWith("/invites")
          ? { code: "abc-DEF_123", guild: { id: "guild" }, channel: { id: "voice" } }
          : { ...event, ...payload },
        201,
      );
    }),
  });
  assertEquals(
    await client.createScheduledEvent("guild", event_payload, "Requested by café user"),
    {
      ...event,
      ...event_payload,
    },
  );
  const external = await client.createScheduledEvent("guild", external_payload);
  assertEquals(external.entity_metadata, { location: "Board game café" });
  assertEquals((await client.createInvite("voice", invite_payload)).code, "abc-DEF_123");
  assertEquals(requests, [
    {
      path: "/api/v10/guilds/guild/scheduled-events",
      payload: event_payload,
      reason: encodeURIComponent("Requested by café user"),
    },
    { path: "/api/v10/guilds/guild/scheduled-events", payload: external_payload, reason: null },
    { path: "/api/v10/channels/voice/invites", payload: invite_payload, reason: null },
  ]);
});

Deno.test("Discord cancellation PATCH changes only status and encodes its route and audit reason", async () => {
  const canceled = { ...event, guild_id: "guild/name", id: "event/name", status: 4 };
  let count = 0;
  const client = createDiscordEventsClient("fake-token", {
    fetch: fetchMock((url, init) => {
      count++;
      assertEquals(
        url,
        "https://discord.com/api/v10/guilds/guild%2Fname/scheduled-events/event%2Fname",
      );
      assertEquals(init?.method, "PATCH");
      assertEquals(JSON.parse(String(init?.body)), { status: 4 });
      const headers = new Headers(init?.headers);
      assertEquals(headers.get("Authorization"), "Bot fake-token");
      assertEquals(headers.get("X-Audit-Log-Reason"), encodeURIComponent("Cancel for café user"));
      assert(init?.signal);
      return jsonResponse(canceled);
    }),
  });
  assertEquals(
    await client.cancelScheduledEvent("guild/name", "event/name", "Cancel for café user"),
    canceled,
  );
  assertEquals(count, 1);
});

Deno.test("Discord cancellation requires an exact canceled receipt", async (t) => {
  const cases = [
    { label: "still scheduled", body: event },
    { label: "active", body: { ...event, status: 2 } },
    { label: "completed", body: { ...event, status: 3 } },
    { label: "wrong event", body: { ...event, status: 4, id: "other" } },
    { label: "wrong guild", body: { ...event, status: 4, guild_id: "other" } },
    { label: "incomplete", body: { id: "event", guild_id: "guild", status: 4 } },
  ];
  for (const test_case of cases) {
    await t.step(test_case.label, async () => {
      let count = 0;
      const client = createDiscordEventsClient("fake-token", {
        fetch: fetchMock(() => {
          count++;
          return jsonResponse({ ...test_case.body, description: "secret" });
        }),
      });
      const error = await assertRejects(
        () => client.cancelScheduledEvent("guild", "event"),
        DiscordApiError,
      );
      assertEquals(count, 1);
      assertEquals(error.status, 200);
      assertEquals(error.uncertain, true);
      assertStringIncludes(error.message, "Check Discord before trying again");
      assertEquals(error.message.includes("secret"), false);
      assertEquals(error.message.includes("fake-token"), false);
    });
  }
});

Deno.test("Discord single event reads reject another event or guild", async (t) => {
  for (const body of [{ ...event, id: "other" }, { ...event, guild_id: "other" }]) {
    await t.step(`${body.guild_id}/${body.id}`, async () => {
      let count = 0;
      const client = createDiscordEventsClient("fake-token", {
        fetch: fetchMock(() => {
          count++;
          return jsonResponse(body);
        }),
      });
      const error = await assertRejects(
        () => client.getScheduledEvent("guild", "event"),
        DiscordApiError,
      );
      assertEquals(count, 1);
      assertEquals(error.uncertain, false);
    });
  }
});

Deno.test("ambiguous mutations are never retried or reported as definite failure", async (t) => {
  const failure_cases = [
    {
      label: "server error",
      response: () => jsonResponse({ message: "secret" }, 503),
      status: 503,
    },
    { label: "request timeout", response: () => jsonResponse({}, 408), status: 408 },
    { label: "unreadable success", response: () => new Response("not-json"), status: 200 },
    { label: "incomplete success", response: () => jsonResponse({}), status: 200 },
    {
      label: "network error",
      response: (): Response => {
        throw new Error("network request leaked fake-token");
      },
      status: 0,
    },
  ];
  for (const failure of failure_cases) {
    for (const kind of ["event", "invite", "cancel"]) {
      await t.step(`${kind}: ${failure.label}`, async () => {
        let count = 0;
        const client = createDiscordEventsClient("fake-token", {
          fetch: fetchMock(() => {
            count++;
            return failure.response();
          }),
        });
        const error = await assertRejects(
          () =>
            kind === "event"
              ? client.createScheduledEvent("guild", event_payload)
              : kind === "invite"
              ? client.createInvite("voice", invite_payload)
              : client.cancelScheduledEvent("guild", "event"),
          DiscordApiError,
        );
        assertEquals(count, 1);
        assertEquals(error.uncertain, true);
        assertEquals(error.status, failure.status);
        assertStringIncludes(error.message, "Check Discord before trying again");
        assertEquals(error.message.includes("fake-token"), false);
        assertEquals(error.message.includes("secret"), false);
      });
    }
  }
});

Deno.test("Discord 429 and client errors are definite failures without retries", async (t) => {
  for (const status of [400, 401, 403, 404, 429]) {
    for (const kind of ["invite", "cancel"]) {
      await t.step(`${kind}: ${status}`, async () => {
        let count = 0;
        const client = createDiscordEventsClient("fake-token", {
          fetch: fetchMock(() => {
            count++;
            return jsonResponse({ message: "untrusted-error", retry_after: 2.25 }, status);
          }),
        });
        const error = await assertRejects(
          () =>
            kind === "invite"
              ? client.createInvite("voice", invite_payload)
              : client.cancelScheduledEvent("guild", "event"),
          DiscordApiError,
        );
        assertEquals(count, 1);
        assertEquals(error.uncertain, false);
        assertEquals(error.status, status);
        assertEquals(error.message.includes("untrusted-error"), false);
        if (status === 429) {
          assertEquals(error.retryAfter, 2.25);
          assertStringIncludes(error.message, "3 seconds");
        }
      });
    }
  }
});

Deno.test("Discord rate limit header survives a non-JSON error response", async () => {
  const client = createDiscordEventsClient("fake-token", {
    fetch: fetchMock(() =>
      new Response("too many requests", { status: 429, headers: { "Retry-After": "1.5" } })
    ),
  });
  const error = await assertRejects(
    () => client.createInvite("voice", invite_payload),
    DiscordApiError,
  );
  assertEquals(error.uncertain, false);
  assertEquals(error.retryAfter, 1.5);
});

Deno.test("Discord reads retry a confirmed rate limit after its fractional delay", async () => {
  const delays: number[] = [];
  const signals: AbortSignal[] = [];
  const client = createDiscordEventsClient("fake-token", {
    fetch: fetchMock((_url, init) => {
      assertEquals(init?.method, "GET");
      signals.push(init!.signal!);
      return signals.length === 1
        ? jsonResponse({ retry_after: 6.2501 }, 429)
        : jsonResponse(event);
    }),
    sleep: (milliseconds) => {
      delays.push(milliseconds);
      assertEquals(signals[0].aborted, false);
      return Promise.resolve();
    },
  });
  assertEquals(await client.getScheduledEvent("guild", "event"), event);
  assertEquals(delays, [6251]);
  assertEquals(signals.length, 2);
  assert(signals[0] !== signals[1]);
});

Deno.test("Discord reads can retry using Retry-After when the body is unreadable", async () => {
  let count = 0;
  const delays: number[] = [];
  const client = createDiscordEventsClient("fake-token", {
    fetch: fetchMock(() => {
      count++;
      return count === 1
        ? new Response("rate limited", { status: 429, headers: { "Retry-After": "0.125" } })
        : jsonResponse([channel]);
    }),
    sleep: (milliseconds) => {
      delays.push(milliseconds);
      return Promise.resolve();
    },
  });
  assertEquals(await client.getChannels("guild"), [channel]);
  assertEquals(count, 2);
  assertEquals(delays, [125]);
});

Deno.test("Discord read retries stop after two waits and preserve the final safe error", async () => {
  let count = 0;
  const delays: number[] = [];
  const client = createDiscordEventsClient("fake-token", {
    fetch: fetchMock(() => {
      count++;
      return jsonResponse({ retry_after: 15, message: "fake-token must never appear" }, 429);
    }),
    sleep: (milliseconds) => {
      delays.push(milliseconds);
      return Promise.resolve();
    },
  });
  const error = await assertRejects(() => client.getMember("guild", "member"), DiscordApiError);
  assertEquals(count, 3);
  assertEquals(delays, [15000, 15000]);
  assertEquals(error.status, 429);
  assertEquals(error.retryAfter, 15);
  assertEquals(error.uncertain, false);
  assertEquals(error.message.includes("fake-token"), false);
});

Deno.test("Discord reads do not retry long, missing, or invalid rate limit delays", async (t) => {
  for (const retry_after of [15.001, undefined, -1, "1", null]) {
    await t.step(String(retry_after), async () => {
      let count = 0;
      const client = createDiscordEventsClient("fake-token", {
        fetch: fetchMock(() => {
          count++;
          return jsonResponse({ retry_after }, 429);
        }),
        sleep: () => {
          throw new Error("Must not wait or retry");
        },
      });
      const error = await assertRejects(() => client.listScheduledEvents("guild"), DiscordApiError);
      assertEquals(count, 1);
      assertEquals(error.status, 429);
      assertEquals(error.uncertain, false);
    });
  }
});

Deno.test("Discord reads do not retry non-rate-limit failures", async (t) => {
  const failures = [
    { label: "server error", response: () => jsonResponse({ retry_after: 1 }, 503) },
    { label: "permission denied", response: () => jsonResponse({ retry_after: 1 }, 403) },
    { label: "unreadable success", response: () => new Response("not-json") },
    { label: "incomplete success", response: () => jsonResponse({}) },
    {
      label: "network error",
      response: (): Response => {
        throw new Error("secret transport details");
      },
    },
  ];
  for (const failure of failures) {
    await t.step(failure.label, async () => {
      let count = 0;
      const client = createDiscordEventsClient("fake-token", {
        fetch: fetchMock(() => {
          count++;
          return failure.response();
        }),
        sleep: () => {
          throw new Error("Must not wait or retry");
        },
      });
      const error = await assertRejects(() => client.getGuild("guild"), DiscordApiError);
      assertEquals(count, 1);
      assertEquals(error.uncertain, false);
      assertEquals(error.message.includes("secret"), false);
    });
  }
});

Deno.test("Discord request timeout aborts transport and marks only mutation uncertain", async () => {
  let count = 0;
  const client = createDiscordEventsClient("fake-token", {
    timeoutMs: 1,
    fetch: fetchMock((_url, init) =>
      new Promise((_resolve, reject) => {
        count++;
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })
    ),
  });
  const mutation_error = await assertRejects(
    () => client.createScheduledEvent("guild", event_payload),
    DiscordApiError,
  );
  assertEquals(mutation_error.uncertain, true);
  const cancel_error = await assertRejects(
    () => client.cancelScheduledEvent("guild", "event"),
    DiscordApiError,
  );
  assertEquals(cancel_error.uncertain, true);
  const read_error = await assertRejects(() => client.getGuild("guild"), DiscordApiError);
  assertEquals(read_error.uncertain, false);
  assertEquals(count, 3);
});

Deno.test("Discord malformed permission responses fail closed", async () => {
  const client = createDiscordEventsClient("fake-token", {
    fetch: fetchMock(() => jsonResponse({ ...guild, roles: [{ id: "guild", permissions: "-1" }] })),
  });
  const error = await assertRejects(() => client.getGuild("guild"), DiscordApiError);
  assertEquals(error.uncertain, false);
});

Deno.test("Discord lists older events with a nullable creator id", async () => {
  const old_event = { ...event, creator_id: null };
  const client = createDiscordEventsClient("fake-token", {
    fetch: fetchMock(() => jsonResponse([old_event])),
  });
  assertEquals(await client.listScheduledEvents("guild"), [old_event]);
});

Deno.test("Discord event reads retain recurring series metadata for action validation", async () => {
  const recurring_event = {
    ...event,
    recurrence_rule: { frequency: 2, interval: 1, by_weekday: [5] },
  };
  const client = createDiscordEventsClient("fake-token", {
    fetch: fetchMock(() => jsonResponse(recurring_event)),
  });
  assertEquals(await client.getScheduledEvent("guild", "event"), recurring_event);
});

function overwrite(id: string, type: number, allow = 0n, deny = 0n) {
  return { id, type, allow: String(allow), deny: String(deny) };
}

Deno.test("guild permissions combine everyone and member roles without unrelated roles", () => {
  assertEquals(
    getGuildPermissions(guild, member),
    P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY | P.CREATE_EVENTS | P.CONNECT | P.CREATE_INSTANT_INVITE,
  );
});

Deno.test("channel role overwrites aggregate allows after everyone and role denies", () => {
  const permissions = getChannelPermissions(guild, member, {
    ...channel,
    permission_overwrites: [
      overwrite("guild", 0, 0n, P.CREATE_EVENTS | P.CONNECT),
      overwrite("planner", 0, P.CREATE_EVENTS, P.CREATE_INSTANT_INVITE),
      overwrite("inviter", 0, P.CREATE_INSTANT_INVITE, P.CREATE_EVENTS),
      overwrite("other", 0, P.MANAGE_CHANNELS, P.VIEW_CHANNEL),
    ],
  });
  assertEquals(permissions & P.CREATE_EVENTS, P.CREATE_EVENTS);
  assertEquals(permissions & P.CREATE_INSTANT_INVITE, P.CREATE_INSTANT_INVITE);
  assertEquals(permissions & P.CONNECT, 0n);
  assertEquals(permissions & P.VIEW_CHANNEL, P.VIEW_CHANNEL);
  assertEquals(permissions & P.MANAGE_CHANNELS, 0n);
});

Deno.test("member overwrite wins over role permissions and overwrites", () => {
  const permissions = getChannelPermissions(guild, member, {
    ...channel,
    permission_overwrites: [
      overwrite("planner", 0, P.CREATE_EVENTS, P.CONNECT),
      overwrite("member", 1, P.CONNECT, P.CREATE_EVENTS | P.CREATE_INSTANT_INVITE),
      // IDs in the wrong overwrite type must not be applied as roles or members.
      overwrite("member", 0, P.MANAGE_CHANNELS),
      overwrite("planner", 1, P.MOVE_MEMBERS),
    ],
  });
  assertEquals(permissions & P.CREATE_EVENTS, 0n);
  assertEquals(permissions & P.CREATE_INSTANT_INVITE, 0n);
  assertEquals(permissions & P.CONNECT, P.CONNECT);
  assertEquals(permissions & (P.MANAGE_CHANNELS | P.MOVE_MEMBERS), 0n);
});

Deno.test("active timeout is applied after channel overwrites and expires normally", () => {
  const timed_out: DiscordMember = {
    ...member,
    communication_disabled_until: "2099-01-01T00:00:00Z",
  };
  const allowed = P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY;
  assertEquals(getGuildPermissions(guild, timed_out), allowed);
  assertEquals(
    getChannelPermissions(guild, timed_out, {
      ...channel,
      permission_overwrites: [overwrite("member", 1, P.CREATE_EVENTS | P.CREATE_INSTANT_INVITE)],
    }),
    allowed,
  );
  assertEquals(
    getGuildPermissions(guild, { ...member, communication_disabled_until: "2000-01-01T00:00:00Z" }),
    getGuildPermissions(guild, member),
  );
});

Deno.test("owner and administrator bypass overwrites and timeout", () => {
  for (
    const privileged of [
      { user: { id: "owner" }, roles: [] },
      { user: { id: "admin-member" }, roles: ["admin"] },
    ]
  ) {
    const timed_out = { ...privileged, communication_disabled_until: "2099-01-01T00:00:00Z" };
    const all_needed = P.CREATE_EVENTS | P.CREATE_INSTANT_INVITE | P.MANAGE_CHANNELS | P.CONNECT;
    assertEquals(getGuildPermissions(guild, timed_out) & all_needed, all_needed);
    assertEquals(
      getChannelPermissions(guild, timed_out, {
        ...channel,
        permission_overwrites: [overwrite("guild", 0, 0n, all_needed)],
      }) & all_needed,
      all_needed,
    );
  }
});
