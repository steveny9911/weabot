import { assert, assertEquals } from "@std/assert";
import type { AiResult, AiService } from "../ai_service.ts";
import type { AppConfig } from "./config.ts";
import type { RecentDiscordMessage } from "./features/chat_context/mod.ts";
import { registerCronJobs } from "./scheduler.ts";
import { createRateLimitService } from "./services/rate_limit.ts";
import { createStorageService } from "./services/storage.ts";

function config(): AppConfig {
  return {
    discordToken: "test-token",
    channelId: "channel",
    channelIds: ["channel"],
    timeZone: "UTC",
    glueAlertThreshold: 7,
    aiEnabled: true,
    openaiApiKey: "test-key",
    aiRateLimitPerUser: 1,
    aiDailyTokenBudget: 100,
    aiMaxInputChars: 500,
    aiEnableUwu: false,
    aiContextMaxMessages: 40,
    aiContextInactivityMinutes: 20,
    webSearchEnabled: false,
    webSearchApiKey: undefined,
    webSearchMaxResults: 3,
    linkOpenEnabled: true,
    autonomousChatEnabled: true,
    autonomousChatChannelIds: ["channel"],
    autonomousChatMinHumanMessages: 1,
    autonomousChatActivityWindowMinutes: 20,
    autonomousChatCooldownMinutes: 1,
    autonomousChatReplyChance: 1,
    autonomousChatMaxContextMessages: 40,
  };
}

type GenerateOptions = Parameters<AiService["generateReply"]>[1];
interface Generation {
  messages: Array<Record<string, unknown>>;
  options: GenerateOptions;
}
interface Reaction {
  channelId: string;
  messageId: string;
  emoji: string;
}
interface Fixture {
  run: () => Promise<void>;
  restart: () => void;
  advance: (ms: number) => void;
  humanMessage: (id?: string, ageMs?: number) => RecentDiscordMessage;
  messages: Map<string, RecentDiscordMessage[]>;
  rateLimit: ReturnType<typeof createRateLimitService>;
  storage: ReturnType<typeof createStorageService>;
  generations: Generation[];
  posts: string[];
  reactions: Reaction[];
}
interface FixtureOptions {
  settings?: Partial<AppConfig>;
  reaction?: (reaction: Reaction) => Promise<Response>;
  getRecentMessages?: (channelId: string) => Promise<RecentDiscordMessage[]>;
}

const reply: AiResult = {
  ok: true,
  text: "Lovely day!",
  tokensUsed: 10,
  participation: { action: "reply", text: "Lovely day!" },
};
const react: AiResult = {
  ok: true,
  text: "",
  tokensUsed: 10,
  participation: { action: "react", messageId: "message", emoji: "😂" },
};
const silent: AiResult = {
  ok: true,
  text: "",
  tokensUsed: 10,
  participation: { action: "silent" },
};

async function withAutonomousJob(
  result: AiResult | ((generation: Generation) => Promise<AiResult>),
  test: (fixture: Fixture) => Promise<void>,
  options: FixtureOptions = {},
) {
  const kv = await Deno.openKv(":memory:");
  const originalCron = Deno.cron;
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = Date.parse("2026-09-05T12:34:00Z");
  const jobs = new Map<string, () => Promise<void>>();
  Deno.cron = ((name, _schedule, handler) => {
    jobs.set(name, handler as () => Promise<void>);
    return Promise.resolve();
  }) as typeof Deno.cron;
  globalThis.fetch = () => Promise.resolve(Response.json({ id: "bot" }));
  Date.now = () => now;
  try {
    const settings = { ...config(), ...options.settings };
    const rateLimit = createRateLimitService(kv, settings, () => now);
    const storage = createStorageService(kv);
    const generations: Generation[] = [];
    const posts: string[] = [];
    const reactions: Reaction[] = [];
    const humanMessage = (id = "message", ageMs = 1000): RecentDiscordMessage => ({
      id,
      authorId: "human",
      authorName: "Alice",
      authorBot: false,
      content: "What a nice day!",
      timestamp: new Date(now - ageMs).toISOString(),
      imageUrls: [],
    });
    const messages = new Map(
      settings.autonomousChatChannelIds.map((channelId) => [channelId, [humanMessage()]]),
    );
    let run: () => Promise<void>;
    const restart = () => {
      registerCronJobs(
        settings,
        {
          postMessage(_channel, payload) {
            assert("content" in payload);
            posts.push(payload.content);
            return Promise.resolve(Response.json({ id: "reply" }));
          },
          addReaction(channelId, messageId, emoji) {
            const reaction = { channelId, messageId, emoji };
            reactions.push(reaction);
            return options.reaction?.(reaction) ?? Promise.resolve(
              new Response(null, {
                status: 204,
              }),
            );
          },
          sendDM: () => Promise.reject(new Error("unexpected DM")),
          getPollVoters: () => Promise.reject(new Error("unexpected poll")),
          getRecentMessages: options.getRecentMessages ??
            ((channelId) => Promise.resolve(messages.get(channelId) ?? [])),
        },
        storage,
        new Intl.DateTimeFormat("en-US"),
        {
          generateReply(context, generateOptions) {
            const generation = { messages: context, options: generateOptions };
            generations.push(generation);
            return typeof result === "function" ? result(generation) : Promise.resolve(result);
          },
        },
        rateLimit,
      );
      const job = jobs.get("Autonomous Chat");
      assert(job);
      run = job;
    };
    restart();
    await test({
      run: () => run(),
      restart,
      advance: (ms) => now += ms,
      humanMessage,
      messages,
      rateLimit,
      storage,
      generations,
      posts,
      reactions,
    });
  } finally {
    Deno.cron = originalCron;
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    kv.close();
  }
}

Deno.test("autonomous chat counts successful usage and blocks fresh activity at the soft budget", () =>
  withAutonomousJob(reply, async (fixture) => {
    await fixture.rateLimit.recordTokenUsage(99);
    await fixture.run();
    fixture.advance(60_001);
    fixture.messages.set("channel", [fixture.humanMessage("next-message")]);
    await fixture.run();
    assertEquals(fixture.generations.length, 1);
    assertEquals(fixture.posts, ["Lovely day!"]);
    assertEquals(await fixture.rateLimit.getUsageStats(), {
      dailyTokensUsed: 109,
      dailyTokenBudget: 100,
      requestsToday: 1,
    });
  }));

Deno.test("autonomous chat records failed generation tokens and does not reconsider its batch", () =>
  withAutonomousJob({ ok: false, error: "generation failed", tokensUsed: 10 }, async (fixture) => {
    await fixture.run();
    fixture.advance(60_001);
    fixture.restart();
    await fixture.run();
    assertEquals(fixture.generations.length, 1);
    assertEquals(fixture.posts, []);
    assertEquals(fixture.reactions, []);
    assertEquals(await fixture.rateLimit.getUsageStats(), {
      dailyTokensUsed: 10,
      dailyTokenBudget: 100,
      requestsToday: 1,
    });
  }));

Deno.test("autonomous failed generation tokens block fresh activity at the soft budget", () =>
  withAutonomousJob({ ok: false, error: "generation failed", tokensUsed: 10 }, async (fixture) => {
    await fixture.rateLimit.recordTokenUsage(99);
    await fixture.run();
    fixture.advance(60_001);
    fixture.messages.set("channel", [fixture.humanMessage("next-message")]);
    await fixture.run();
    assertEquals(fixture.generations.length, 1);
    assertEquals(fixture.posts, []);
    assertEquals(fixture.reactions, []);
    assertEquals(await fixture.rateLimit.getUsageStats(), {
      dailyTokensUsed: 109,
      dailyTokenBudget: 100,
      requestsToday: 1,
    });
  }));

Deno.test("autonomous chat preserves its exemption from the human per-minute limit", () =>
  withAutonomousJob(reply, async (fixture) => {
    await fixture.run();
    // Fresh activity and an expired cooldown, still within the same UTC minute.
    fixture.advance(1000);
    fixture.messages.set("channel", [fixture.humanMessage("next-message", 0)]);
    await fixture.run();
    assertEquals(fixture.generations.length, 2);
    assertEquals(fixture.posts, ["Lovely day!", "Lovely day!"]);
    assertEquals(await fixture.rateLimit.getUsageStats(), {
      dailyTokensUsed: 20,
      dailyTokenBudget: 100,
      requestsToday: 2,
    });
  }, { settings: { autonomousChatCooldownMinutes: 0.001 } }));

Deno.test("autonomous chat skips generation and request counting when budget is already exhausted", () =>
  withAutonomousJob(reply, async (fixture) => {
    await fixture.rateLimit.recordTokenUsage(100);
    await fixture.run();
    assertEquals(fixture.generations.length, 0);
    assertEquals(fixture.posts, []);
    assertEquals(fixture.reactions, []);
    assertEquals((await fixture.rateLimit.getUsageStats()).requestsToday, 0);
    assertEquals(await fixture.storage.getAutonomousParticipation("channel"), null);
  }));

Deno.test("autonomous reaction sends one emoji without text and survives scheduler restarts", () =>
  withAutonomousJob(react, async (fixture) => {
    await fixture.run();
    const options = fixture.generations[0].options;
    assert(options && "mode" in options);
    assertEquals(options.mode, "autonomous");
    assertEquals(options.allowedMessageIds, ["message"]);
    assert(options.instructions.includes("Haru"));
    fixture.advance(60_001);
    await fixture.run();
    fixture.restart();
    await fixture.run();
    assertEquals(fixture.generations.length, 1);
    assertEquals(fixture.posts, []);
    assertEquals(fixture.reactions, [{ channelId: "channel", messageId: "message", emoji: "😂" }]);
    assertEquals(await fixture.rateLimit.getUsageStats(), {
      dailyTokensUsed: 10,
      dailyTokenBudget: 100,
      requestsToday: 1,
    });
  }));

Deno.test("autonomous silence emits no text or reaction and consumes the activity once", () =>
  withAutonomousJob(silent, async (fixture) => {
    await fixture.run();
    fixture.advance(60_001);
    fixture.restart();
    await fixture.run();
    assertEquals(fixture.generations.length, 1);
    assertEquals(fixture.posts, []);
    assertEquals(fixture.reactions, []);
    assertEquals((await fixture.rateLimit.getUsageStats()).dailyTokensUsed, 10);
    assertEquals((await fixture.rateLimit.getUsageStats()).requestsToday, 1);
  }));

Deno.test("autonomous chat does not use legacy text as fallback for a missing participation decision", () =>
  withAutonomousJob(
    { ok: true, text: "Needless fallback text", tokensUsed: 10 },
    async (fixture) => {
      await fixture.run();
      assertEquals(fixture.posts, []);
      assertEquals(fixture.reactions, []);
    },
  ));

for (
  const failure of [
    { name: "missing permissions", status: 403, code: 50013 },
    { name: "deleted message", status: 404, code: 10008 },
    { name: "unavailable emoji", status: 400, code: 10014 },
    { name: "rate limit", status: 429, code: 0 },
    { name: "server error", status: 503, code: 0 },
    { name: "ambiguous network error" },
  ]
) {
  Deno.test(`autonomous reaction handles ${failure.name} without retries or fallback text`, () =>
    withAutonomousJob(react, async (fixture) => {
      await fixture.run();
      fixture.advance(60_001);
      fixture.restart();
      await fixture.run();
      assertEquals(fixture.generations.length, 1);
      assertEquals(fixture.reactions.length, 1);
      assertEquals(fixture.posts, []);
      assertEquals((await fixture.rateLimit.getUsageStats()).dailyTokensUsed, 10);
      assertEquals((await fixture.rateLimit.getUsageStats()).requestsToday, 1);
    }, {
      reaction: () =>
        failure.status
          ? Promise.resolve(Response.json({ code: failure.code, retry_after: 0.001 }, {
            status: failure.status,
          }))
          : Promise.reject(new TypeError("network connection lost")),
    }));
}

Deno.test("autonomous participation skips fresh humans during cooldown then permits new activity", () =>
  withAutonomousJob(silent, async (fixture) => {
    await fixture.run();
    fixture.advance(30_000);
    fixture.messages.set("channel", [fixture.humanMessage("new-message")]);
    await fixture.run();
    assertEquals(fixture.generations.length, 1);
    assertEquals((await fixture.rateLimit.getUsageStats()).requestsToday, 1);
    fixture.advance(30_001);
    await fixture.run();
    assertEquals(fixture.generations.length, 2);
    assertEquals((await fixture.rateLimit.getUsageStats()).requestsToday, 2);
    assertEquals(
      (await fixture.storage.getAutonomousParticipation("channel"))?.latestHumanMessageId,
      "new-message",
    );
  }));

for (const target of ["self-message", "bot-message", "already-reacted", "unknown-message"]) {
  Deno.test(`autonomous chat refuses reaction target ${target}`, () =>
    withAutonomousJob({
      ok: true,
      text: "",
      tokensUsed: 10,
      participation: { action: "react", messageId: target, emoji: "😂" },
    }, async (fixture) => {
      fixture.messages.set("channel", [
        { ...fixture.humanMessage("self-message", 70_000), authorId: "bot", authorBot: false },
        { ...fixture.humanMessage("bot-message", 2000), authorId: "other-bot", authorBot: true },
        { ...fixture.humanMessage("already-reacted", 1500), hasOwnReaction: true },
        fixture.humanMessage(),
      ]);
      await fixture.run();
      const options = fixture.generations[0].options;
      assert(options && "mode" in options);
      assertEquals(options.allowedMessageIds, ["message"]);
      assertEquals(fixture.posts, []);
      assertEquals(fixture.reactions, []);
    }));
}

Deno.test("autonomous chat never generates from only bots or its own messages", () =>
  withAutonomousJob(reply, async (fixture) => {
    fixture.messages.set("channel", [
      { ...fixture.humanMessage("self-message"), authorId: "bot", authorBot: false },
      { ...fixture.humanMessage("bot-message"), authorId: "other-bot", authorBot: true },
    ]);
    await fixture.run();
    assertEquals(fixture.generations.length, 0);
    assertEquals(fixture.posts, []);
    assertEquals(fixture.reactions, []);
    assertEquals((await fixture.rateLimit.getUsageStats()).requestsToday, 0);
  }));

Deno.test("autonomous channel read failure does not block participation in the next channel", () =>
  withAutonomousJob(react, async (fixture) => {
    await fixture.run();
    assertEquals(fixture.generations.length, 1);
    assertEquals(fixture.reactions, [{ channelId: "working", messageId: "message", emoji: "😂" }]);
    assertEquals(fixture.posts, []);
  }, {
    settings: { autonomousChatChannelIds: ["unavailable", "working"] },
    getRecentMessages: (channelId) =>
      channelId === "unavailable"
        ? Promise.reject(new Error("Discord channel unavailable"))
        : Promise.resolve([{
          id: "message",
          authorId: "human",
          authorName: "Alice",
          authorBot: false,
          content: "A good meme",
          timestamp: new Date(Date.now() - 1000).toISOString(),
          imageUrls: [],
        }]),
  }));

Deno.test("autonomous failed reaction does not block the next channel", () =>
  withAutonomousJob(react, async (fixture) => {
    await fixture.run();
    assertEquals(fixture.generations.length, 2);
    assertEquals(fixture.reactions.map((reaction) => reaction.channelId), [
      "unavailable",
      "working",
    ]);
    assertEquals(fixture.posts, []);
  }, {
    settings: { autonomousChatChannelIds: ["unavailable", "working"] },
    reaction: ({ channelId }) =>
      channelId === "unavailable"
        ? Promise.reject(new TypeError("network connection lost"))
        : Promise.resolve(new Response(null, { status: 204 })),
  }));

Deno.test("autonomous chat skips an overlapping scheduled run", async () => {
  let finish!: (result: AiResult) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => started = resolve);
  await withAutonomousJob(() => {
    started();
    return new Promise<AiResult>((resolve) => finish = resolve);
  }, async (fixture) => {
    const firstRun = fixture.run();
    await entered;
    try {
      await fixture.run();
      assertEquals(fixture.generations.length, 1);
      assertEquals((await fixture.rateLimit.getUsageStats()).requestsToday, 1);
    } finally {
      finish(react);
      await firstRun;
    }
    assertEquals(fixture.reactions.length, 1);
    assertEquals(fixture.posts, []);
  });
});

Deno.test("autonomous reaction cooldown starts after slow generation finishes", async () => {
  let advance!: Fixture["advance"];
  let firstGeneration = true;
  await withAutonomousJob(async () => {
    if (firstGeneration) {
      firstGeneration = false;
      await Promise.resolve();
      advance(59_000);
      return react;
    }
    return silent;
  }, async (fixture) => {
    advance = fixture.advance;
    const startedAt = Date.now();
    await fixture.run();
    assertEquals(fixture.reactions.length, 1);

    // The next scheduled minute is only one second after the reaction finished.
    fixture.advance(1000);
    fixture.messages.set("channel", [fixture.humanMessage("next-message", 0)]);
    fixture.restart();
    await fixture.run();
    assertEquals(fixture.generations.length, 1);
    assertEquals((await fixture.rateLimit.getUsageStats()).requestsToday, 1);
    assertEquals(
      (await fixture.storage.getAutonomousParticipation("channel"))?.attemptedAt,
      startedAt + 59_000,
    );

    fixture.advance(59_000);
    await fixture.run();
    assertEquals(fixture.generations.length, 2);
    assertEquals(fixture.reactions.length, 1);
    assertEquals(fixture.posts, []);
    assertEquals((await fixture.rateLimit.getUsageStats()).requestsToday, 2);
    assertEquals((await fixture.rateLimit.getUsageStats()).dailyTokensUsed, 20);
  });
});

Deno.test("autonomous reaction cooldown starts after slow Discord delivery finishes", async () => {
  let advance!: Fixture["advance"];
  let firstDelivery = true;
  await withAutonomousJob(({ options }) => {
    assert(options && "mode" in options);
    return Promise.resolve({
      ok: true,
      text: "",
      tokensUsed: 10,
      participation: { action: "react", messageId: options.allowedMessageIds[0], emoji: "😂" },
    });
  }, async (fixture) => {
    advance = fixture.advance;
    await fixture.run();
    assertEquals(fixture.reactions.length, 1);
    fixture.advance(1000);
    fixture.messages.set("channel", [fixture.humanMessage("next-message", 0)]);
    fixture.restart();
    await fixture.run();
    assertEquals(fixture.generations.length, 1);
    assertEquals((await fixture.rateLimit.getUsageStats()).requestsToday, 1);

    fixture.advance(59_000);
    await fixture.run();
    assertEquals(fixture.generations.length, 2);
    assertEquals(fixture.reactions.map(({ messageId }) => messageId), ["message", "next-message"]);
    assertEquals(fixture.posts, []);
  }, {
    reaction: async () => {
      if (firstDelivery) {
        firstDelivery = false;
        await Promise.resolve();
        advance(59_000);
      }
      return new Response(null, { status: 204 });
    },
  });
});
