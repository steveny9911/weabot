/**
 * Local semantic smoke test; never starts Haru's gateway, cron jobs, or server.
 *
 * deno run --unstable-kv --env-file=.env --allow-env \
 *   --allow-net=discord.com,api.openai.com scripts/test_discord_events.ts --dry-run
 *
 * Omit --dry-run to create and clean up one sandbox event/invite. --keep leaves
 * the event visible; the invitation still expires after 60 seconds / one use.
 * Both modes call the real AI API and read Bot Sandbox metadata. The requester
 * is explicitly simulated as the sandbox owner, not an actual Discord message.
 */
import { createAiService } from "../ai_service.ts";
import { loadConfig } from "../src/config.ts";
import {
  createDiscordActionService,
  formatActionResults,
} from "../src/features/discord_actions/mod.ts";
import {
  createDiscordEventsClient,
  type DiscordEventsClient,
  type DiscordInvite,
  type DiscordScheduledEvent,
} from "../src/services/discord_events.ts";

const SANDBOX_ID = "589723496473690132";
const TEXT_CHANNEL_ID = "589723496473690134";
const VOICE_CHANNEL_ID = "589723496473690136";
const TIME_ZONE = "America/Vancouver";
const API_BASE = "https://discord.com/api/v10";

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown): Record<string, unknown> {
  ensure(value !== null && typeof value === "object", "Expected a Discord response object.");
  return value as Record<string, unknown>;
}

/** Independently compute tomorrow's Vancouver evening timestamps for assertions. */
function tomorrowEvening(): { date: string; start: string; end: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  const tomorrow = new Date(Date.UTC(
    Number(part("year")),
    Number(part("month")) - 1,
    Number(part("day")) + 1,
  ));
  const date = tomorrow.toISOString().slice(0, 10);
  // Vancouver's DST changes are before midday; both evening times share this offset.
  const offsetText = new Intl.DateTimeFormat("en", {
    timeZone: TIME_ZONE,
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(`${date}T20:00:00Z`)).find((p) => p.type === "timeZoneName")!.value;
  const offset = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(offsetText);
  ensure(offset, "Could not resolve the Vancouver timezone offset.");
  const offsetMinutes = (offset[1] === "+" ? 1 : -1) *
    (Number(offset[2]) * 60 + Number(offset[3] ?? 0));
  const utc = (hour: string) =>
    new Date(Date.parse(`${date}T${hour}:00:00Z`) - offsetMinutes * 60_000).toISOString();
  return { date, start: utc("20"), end: utc("22") };
}

async function main(): Promise<void> {
  const args = new Set(Deno.args);
  ensure(
    [...args].every((arg) => ["--dry-run", "--keep", "--help"].includes(arg)),
    "Supported options: --dry-run, --keep, --help.",
  );
  if (args.has("--help")) {
    console.log(
      "--dry-run: four real-AI cases with fake Discord writes; otherwise create one sandbox event/invite. --keep: skip live cleanup. Requester is simulated as sandbox owner.",
    );
    return;
  }
  const dryRun = args.has("--dry-run");
  const keep = args.has("--keep");
  ensure(!(dryRun && keep), "--keep is only meaningful for a live run.");
  const config = {
    ...loadConfig(),
    channelId: TEXT_CHANNEL_ID,
    channelIds: [TEXT_CHANNEL_ID],
    autonomousChatEnabled: false,
    autonomousChatChannelIds: [],
    aiEnabled: true,
    aiEnableUwu: false,
    aiMaxInputChars: 0,
    timeZone: TIME_ZONE,
  };
  ensure(config.openaiApiKey, "OPENAI_API_KEY is required for this semantic test.");
  const real = createDiscordEventsClient(config.discordToken);
  async function api(path: string, method: "GET" | "DELETE" = "GET"): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: { Authorization: `Bot ${config.discordToken}` },
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch {
      throw new Error(`Discord ${method} could not be confirmed.`);
    }
    if (method === "DELETE" && response.status === 404) {
      await response.body?.cancel();
      return { already_absent: true };
    }
    ensure(response.ok, `Discord ${method} failed with HTTP ${response.status}.`);
    if (method === "DELETE") {
      await response.body?.cancel();
      return null;
    }
    try {
      return await response.json();
    } catch {
      throw new Error("Discord returned an unreadable response.");
    }
  }
  const me = record(await api("/users/@me"));
  ensure(me.bot === true && typeof me.id === "string", "Configured token is not a bot identity.");
  const botId = me.id;
  const guild = await real.getGuild(SANDBOX_ID);
  ensure(
    guild.id === SANDBOX_ID && record(guild).name === "Bot Sandbox",
    "Expected exactly Bot Sandbox.",
  );
  const [owner, bot, channels] = await Promise.all([
    real.getMember(SANDBOX_ID, guild.owner_id),
    real.getMember(SANDBOX_ID, botId),
    real.getChannels(SANDBOX_ID),
  ]);
  ensure(
    owner.user.id === guild.owner_id && !owner.user.bot,
    "Could not verify the sandbox owner.",
  );
  ensure(
    channels.some((c) => c.id === TEXT_CHANNEL_ID && c.type === 0),
    "Sandbox text channel is missing.",
  );
  ensure(
    channels.some((c) => c.id === VOICE_CHANNEL_ID && c.name === "General" && c.type === 2),
    "Sandbox General voice channel is missing.",
  );

  const runId = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
  const title = `Haru sandbox test ${runId}`;
  const expected = tomorrowEvening();
  const request =
    `Create a Discord event named ${title} in General voice on ${expected.date} at 20:00 America/Vancouver, ending at 22:00 that same day, and create an event invite expiring in 60 seconds limited to 1 use.`;
  const events: DiscordScheduledEvent[] = [];
  const invites: DiscordInvite[] = [];
  const verified: Record<string, unknown> = {};
  const cleanup: Record<string, unknown>[] = [];
  const cases: Record<string, unknown>[] = [];
  let activeCase = "complete";
  const sandbox = (id: string) =>
    ensure(id === SANDBOX_ID, "Blocked a non-sandbox guild operation.");
  const client: DiscordEventsClient = {
    getScheduledEvent(id, eventId) {
      sandbox(id);
      const event = events.find((event) => event.id === eventId);
      if (!event) throw new Error("Test event not found.");
      return Promise.resolve(event);
    },
    cancelScheduledEvent() {
      throw new Error("This creation smoke test does not cancel events through tools.");
    },
    getGuild(id) {
      sandbox(id);
      return Promise.resolve(guild);
    },
    getMember(id, userId) {
      sandbox(id);
      ensure([guild.owner_id, botId].includes(userId), "Unexpected test member.");
      return Promise.resolve(userId === botId ? bot : owner);
    },
    getChannels(id) {
      sandbox(id);
      return Promise.resolve(channels);
    },
    listScheduledEvents(id) {
      sandbox(id);
      // Context and cleanup are limited to artifacts from this invocation.
      return Promise.resolve([...events]);
    },
    async createScheduledEvent(id, payload, reason) {
      sandbox(id);
      ensure(activeCase === "complete", "Unexpected event write in a non-action test case.");
      ensure(events.length === 0, "The test allows exactly one event.");
      ensure(payload.name === title, "The test event title was not preserved.");
      ensure(
        payload.channel_id === VOICE_CHANNEL_ID && payload.entity_type === 2,
        "Unexpected event channel/type.",
      );
      ensure(
        Date.parse(payload.scheduled_start_time) === Date.parse(expected.start),
        "Unexpected event start time.",
      );
      ensure(
        Date.parse(payload.scheduled_end_time ?? "") === Date.parse(expected.end),
        "Unexpected event end time.",
      );
      const event: DiscordScheduledEvent = dryRun
        ? {
          ...payload,
          id: "999999999999999991",
          guild_id: id,
          channel_id: VOICE_CHANNEL_ID,
          creator_id: botId,
          status: 1,
        }
        : await real.createScheduledEvent(id, payload, reason);
      events.push(event);
      const actual = dryRun
        ? record(event)
        : record(await api(`/guilds/${id}/scheduled-events/${event.id}`));
      ensure(
        actual.id === event.id && actual.guild_id === id && actual.name === title,
        "Created event identity mismatch.",
      );
      ensure(
        actual.channel_id === VOICE_CHANNEL_ID && actual.entity_type === 2,
        "Created event location mismatch.",
      );
      ensure(
        Date.parse(String(actual.scheduled_start_time)) === Date.parse(expected.start),
        "Created event start mismatch.",
      );
      ensure(
        Date.parse(String(actual.scheduled_end_time)) === Date.parse(expected.end),
        "Created event end mismatch.",
      );
      verified.event = {
        id: event.id,
        url: `https://discord.com/events/${id}/${event.id}`,
        channel_id: actual.channel_id,
        start: actual.scheduled_start_time,
        end: actual.scheduled_end_time,
      };
      return event;
    },
    async createInvite(channelId, payload, reason) {
      ensure(
        activeCase === "complete" && events.length === 1,
        "An invite requires this run's test event.",
      );
      ensure(
        invites.length === 0 && channelId === VOICE_CHANNEL_ID,
        "Unexpected invite count or channel.",
      );
      ensure(
        payload.max_age === 60 && payload.max_uses === 1 && !payload.temporary,
        "Unexpected test invite settings.",
      );
      // Force a fresh code: deleting a reused invite could remove somebody else's link.
      const invite = dryRun
        ? { code: "haru-sandbox-dry-run", guild: { id: SANDBOX_ID }, channel: { id: channelId } }
        : await real.createInvite(channelId, { ...payload, unique: true }, reason);
      invites.push(invite);
      const eventId = events[0].id;
      if (!dryRun) {
        const actual = record(
          await api(
            `/invites/${encodeURIComponent(invite.code)}?guild_scheduled_event_id=${eventId}`,
          ),
        );
        ensure(record(actual.guild).id === SANDBOX_ID, "Invite guild mismatch.");
        ensure(record(actual.channel).id === VOICE_CHANNEL_ID, "Invite channel mismatch.");
        ensure(
          record(actual.guild_scheduled_event).id === eventId,
          "Discord did not associate the requested event with the invite.",
        );
      }
      verified.invite = {
        url: `https://discord.gg/${invite.code}?event=${eventId}`,
        event_id: eventId,
        expires_in_seconds: 60,
        maximum_uses: 1,
        event_association: dryRun ? "simulated" : "verified via Discord GET invite",
      };
      return invite;
    },
  };
  const kv = await Deno.openKv(":memory:");
  const service = createDiscordActionService(client, kv, TIME_ZONE);
  const ai = createAiService(config);
  let failure: string | undefined;
  try {
    const scenarios = [
      { name: "complete", content: request },
      ...(dryRun
        ? [
          { name: "needs_clarification", content: "Create an event for game night." },
          {
            name: "hypothetical",
            content:
              `Hypothetically, how would I ask Haru to create an event called ${title}? Please explain without doing it.`,
          },
          {
            name: "negated",
            content:
              `Do not create an event called ${title} or create an invitation; I am only discussing the idea.`,
          },
        ]
        : []),
    ];
    for (const scenario of scenarios) {
      activeCase = scenario.name;
      await service.clearPending(SANDBOX_ID, TEXT_CHANNEL_ID, guild.owner_id);
      const countBefore = events.length + invites.length;
      const session = await service.createSession({
        guildId: SANDBOX_ID,
        channelId: TEXT_CHANNEL_ID,
        userId: guild.owner_id,
        botId,
        messageId: `sandbox-test-${runId}-${scenario.name}`,
        content: scenario.content,
      });
      const toolCalls: string[] = [];
      const toolArguments: Record<string, unknown>[] = [];
      const result = await ai.generateReply([{
        author: "Simulated sandbox owner",
        content: scenario.content,
      }], {
        ...session,
        executeTool(name, args) {
          toolCalls.push(name);
          toolArguments.push({ name, arguments: args });
          return session.executeTool(name, args);
        },
      });
      const item: Record<string, unknown> = {
        name: scenario.name,
        ai_ok: result.ok,
        tokens_used: result.tokensUsed,
        tool_calls: toolCalls,
        tool_arguments: toolArguments,
        writes: events.length + invites.length - countBefore,
        receipts: formatActionResults(session.results),
      };
      cases.push(item);
      ensure(
        result.ok,
        "AI did not finish the semantic test; inspect verified artifacts and cleanup below.",
      );
      if (scenario.name === "complete") {
        ensure(
          events.length === 1 && invites.length === 1 && verified.event && verified.invite,
          "Expected one verified event and event invite.",
        );
        const receipt = session.results.find((r) => r.inviteUrl)?.inviteUrl;
        ensure(
          receipt && new URL(receipt).searchParams.get("event") === events[0].id,
          "Action result omitted the event invite query parameter.",
        );
        ensure(session.results.every((r) => r.ok), "A complete request returned an action error.");
      } else {
        ensure(
          events.length + invites.length === countBefore,
          "A non-action case wrote to Discord.",
        );
        ensure(
          !toolCalls.some((name) =>
            ["create_discord_event", "create_discord_invite"].includes(name)
          ),
          "The AI attempted a write for a non-action case.",
        );
        if (scenario.name === "needs_clarification") {
          ensure(
            session.results.some((r) => r.needsClarification),
            "Vague request did not register a pending clarification.",
          );
        }
      }
      item.passed = true;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : "Sandbox test failed.";
  } finally {
    kv.close();
    if (!dryRun && !keep) {
      for (const invite of invites) {
        try {
          const result = await api(`/invites/${encodeURIComponent(invite.code)}`, "DELETE");
          cleanup.push({
            kind: "invite",
            code: invite.code,
            deleted: result === null,
            already_absent: result !== null,
          });
        } catch (error) {
          cleanup.push({
            kind: "invite",
            code: invite.code,
            deleted: false,
            expires_in_seconds: 60,
            note: error instanceof Error ? error.message : "Invite cleanup failed.",
          });
        }
      }
      for (const event of events) {
        try {
          await api(`/guilds/${SANDBOX_ID}/scheduled-events/${event.id}`, "DELETE");
          cleanup.push({ kind: "event", id: event.id, deleted: true });
        } catch (error) {
          cleanup.push({
            kind: "event",
            id: event.id,
            deleted: false,
            note: error instanceof Error ? error.message : "Event cleanup failed.",
          });
          failure ??= "Test event cleanup failed; the event is still in Bot Sandbox.";
        }
      }
    }
    console.log(JSON.stringify(
      {
        ok: !failure,
        mode: dryRun ? "dry-run: real AI, simulated Discord writes" : "live sandbox",
        requester: {
          context: "SIMULATED sandbox owner; not an actual Discord message",
          id: guild.owner_id,
        },
        bot: { id: botId, username: me.username },
        guild: { id: SANDBOX_ID, name: "Bot Sandbox" },
        cases,
        verified,
        kept: !dryRun && keep,
        cleanup,
        ...(failure ? { error: failure } : {}),
      },
      null,
      2,
    ));
  }
  if (failure) Deno.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        stage: "preflight",
        error: error instanceof Error ? error.message : "Sandbox preflight failed.",
      }),
    );
    Deno.exitCode = 1;
  }
}
