import { expect, test } from "bun:test";
import { asFetch } from "../test_support/fetch.ts";
import { assert } from "../test_support/assert.ts";
import type { AiResult, AiService } from "../ai_service.ts";
import type { AppConfig } from "./config.ts";
import type { RecentDiscordMessage } from "./features/chat_context/mod.ts";
import { type CronRegistrar, registerCronJobs } from "./scheduler.ts";
import { openDatabase } from "./db/database.ts";
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
  getReactionContext?: NonNullable<
    import("./services/discord.ts").DiscordClient["getReactionContext"]
  >;
  getMessage?: NonNullable<import("./services/discord.ts").DiscordClient["getMessage"]>;
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
  const kv = openDatabase(":memory:");
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalRandom = Math.random;
  Math.random = () => 0;
  let now = Date.parse("2026-09-05T12:34:00Z");
  const jobs = new Map<string, () => Promise<void> | void>();
  const cron: CronRegistrar = (name, _schedule, handler) => jobs.set(name, handler);
  globalThis.fetch = asFetch(() => Promise.resolve(Response.json({ id: "bot" })));
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
        cron,
        settings,
        {
          ...(options.getReactionContext ? { getReactionContext: options.getReactionContext } : {}),
          ...(options.getMessage ? { getMessage: options.getMessage } : {}),
          postMessage(_channel, payload) {
            assert("content" in payload);
            posts.push(payload.content);
            return Promise.resolve(Response.json({ id: "reply" }));
          },
          addReaction(channelId, messageId, emoji) {
            const reaction = { channelId, messageId, emoji };
            reactions.push(reaction);
            return (
              options.reaction?.(reaction) ??
              Promise.resolve(
                new Response(null, {
                  status: 204,
                }),
              )
            );
          },
          sendDM: () => Promise.reject(new Error("unexpected DM")),
          getPollVoters: () => Promise.reject(new Error("unexpected poll")),
          getRecentMessages:
            options.getRecentMessages ??
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
      run = async () => await job();
    };
    restart();
    await test({
      run: () => run(),
      restart,
      advance: (ms) => (now += ms),
      humanMessage,
      messages,
      rateLimit,
      storage,
      generations,
      posts,
      reactions,
    });
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    Math.random = originalRandom;
    kv.close();
  }
}

test("autonomous chat counts successful usage and blocks fresh activity at the soft budget", () =>
  withAutonomousJob(reply, async (fixture) => {
    await fixture.rateLimit.recordTokenUsage(99);
    await fixture.run();
    fixture.advance(60_001);
    fixture.messages.set("channel", [fixture.humanMessage("next-message")]);
    await fixture.run();
    expect(fixture.generations.length).toStrictEqual(1);
    expect(fixture.posts).toStrictEqual(["Lovely day!"]);
    expect(await fixture.rateLimit.getUsageStats()).toStrictEqual({
      dailyTokensUsed: 109,
      dailyTokenBudget: 100,
      requestsToday: 1,
    });
  }));

test("autonomous chat records failed generation tokens and does not reconsider its batch", () =>
  withAutonomousJob({ ok: false, error: "generation failed", tokensUsed: 10 }, async (fixture) => {
    await fixture.run();
    fixture.advance(60_001);
    fixture.restart();
    await fixture.run();
    expect(fixture.generations.length).toStrictEqual(1);
    expect(fixture.posts).toStrictEqual([]);
    expect(fixture.reactions).toStrictEqual([]);
    expect(await fixture.rateLimit.getUsageStats()).toStrictEqual({
      dailyTokensUsed: 10,
      dailyTokenBudget: 100,
      requestsToday: 1,
    });
  }));

test("autonomous failed generation tokens block fresh activity at the soft budget", () =>
  withAutonomousJob({ ok: false, error: "generation failed", tokensUsed: 10 }, async (fixture) => {
    await fixture.rateLimit.recordTokenUsage(99);
    await fixture.run();
    fixture.advance(60_001);
    fixture.messages.set("channel", [fixture.humanMessage("next-message")]);
    await fixture.run();
    expect(fixture.generations.length).toStrictEqual(1);
    expect(fixture.posts).toStrictEqual([]);
    expect(fixture.reactions).toStrictEqual([]);
    expect(await fixture.rateLimit.getUsageStats()).toStrictEqual({
      dailyTokensUsed: 109,
      dailyTokenBudget: 100,
      requestsToday: 1,
    });
  }));

test("autonomous chat preserves its exemption from the human per-minute limit", () =>
  withAutonomousJob(
    reply,
    async (fixture) => {
      await fixture.run();
      // Fresh activity and an expired cooldown, still within the same UTC minute.
      fixture.advance(1000);
      fixture.messages.set("channel", [fixture.humanMessage("next-message", 0)]);
      await fixture.run();
      expect(fixture.generations.length).toStrictEqual(2);
      expect(fixture.posts).toStrictEqual(["Lovely day!", "Lovely day!"]);
      expect(await fixture.rateLimit.getUsageStats()).toStrictEqual({
        dailyTokensUsed: 20,
        dailyTokenBudget: 100,
        requestsToday: 2,
      });
    },
    { settings: { autonomousChatCooldownMinutes: 0.001 } },
  ));

test("autonomous chat skips generation and request counting when budget is already exhausted", () =>
  withAutonomousJob(reply, async (fixture) => {
    await fixture.rateLimit.recordTokenUsage(100);
    await fixture.run();
    expect(fixture.generations.length).toStrictEqual(0);
    expect(fixture.posts).toStrictEqual([]);
    expect(fixture.reactions).toStrictEqual([]);
    expect((await fixture.rateLimit.getUsageStats()).requestsToday).toStrictEqual(0);
    expect(await fixture.storage.getAutonomousParticipation("channel")).toStrictEqual(null);
  }));

test("autonomous reaction sends one emoji without text and survives scheduler restarts", () =>
  withAutonomousJob(react, async (fixture) => {
    await fixture.run();
    const options = fixture.generations[0].options;
    assert(options && "mode" in options);
    expect(options.mode).toStrictEqual("autonomous");
    expect(options.allowedMessageIds).toStrictEqual(["message"]);
    assert(options.instructions.includes("Haru"));
    fixture.advance(60_001);
    await fixture.run();
    fixture.restart();
    await fixture.run();
    expect(fixture.generations.length).toStrictEqual(1);
    expect(fixture.posts).toStrictEqual([]);
    expect(fixture.reactions).toStrictEqual([
      { channelId: "channel", messageId: "message", emoji: "😂" },
    ]);
    expect(await fixture.rateLimit.getUsageStats()).toStrictEqual({
      dailyTokensUsed: 10,
      dailyTokenBudget: 100,
      requestsToday: 1,
    });
  }));

test("autonomous silence emits no text or reaction and consumes the activity once", () =>
  withAutonomousJob(silent, async (fixture) => {
    await fixture.run();
    fixture.advance(60_001);
    fixture.restart();
    await fixture.run();
    expect(fixture.generations.length).toStrictEqual(1);
    expect(fixture.posts).toStrictEqual([]);
    expect(fixture.reactions).toStrictEqual([]);
    expect((await fixture.rateLimit.getUsageStats()).dailyTokensUsed).toStrictEqual(10);
    expect((await fixture.rateLimit.getUsageStats()).requestsToday).toStrictEqual(1);
  }));

test("autonomous chat does not use legacy text as fallback for a missing participation decision", () =>
  withAutonomousJob(
    { ok: true, text: "Needless fallback text", tokensUsed: 10 },
    async (fixture) => {
      await fixture.run();
      expect(fixture.posts).toStrictEqual([]);
      expect(fixture.reactions).toStrictEqual([]);
    },
  ));

for (const failure of [
  { name: "missing permissions", status: 403, code: 50013 },
  { name: "deleted message", status: 404, code: 10008 },
  { name: "unavailable emoji", status: 400, code: 10014 },
  { name: "rate limit", status: 429, code: 0 },
  { name: "server error", status: 503, code: 0 },
  { name: "ambiguous network error" },
]) {
  test(`autonomous reaction handles ${failure.name} without retries or fallback text`, () =>
    withAutonomousJob(
      react,
      async (fixture) => {
        await fixture.run();
        fixture.advance(60_001);
        fixture.restart();
        await fixture.run();
        expect(fixture.generations.length).toStrictEqual(1);
        expect(fixture.reactions.length).toStrictEqual(1);
        expect(fixture.posts).toStrictEqual([]);
        expect((await fixture.rateLimit.getUsageStats()).dailyTokensUsed).toStrictEqual(10);
        expect((await fixture.rateLimit.getUsageStats()).requestsToday).toStrictEqual(1);
      },
      {
        reaction: () =>
          failure.status
            ? Promise.resolve(
                Response.json(
                  { code: failure.code, retry_after: 0.001 },
                  {
                    status: failure.status,
                  },
                ),
              )
            : Promise.reject(new TypeError("network connection lost")),
      },
    ));
}

test("autonomous participation skips fresh humans during cooldown then permits new activity", () =>
  withAutonomousJob(silent, async (fixture) => {
    await fixture.run();
    fixture.advance(30_000);
    fixture.messages.set("channel", [fixture.humanMessage("new-message")]);
    await fixture.run();
    expect(fixture.generations.length).toStrictEqual(1);
    expect((await fixture.rateLimit.getUsageStats()).requestsToday).toStrictEqual(1);
    fixture.advance(30_001);
    await fixture.run();
    expect(fixture.generations.length).toStrictEqual(2);
    expect((await fixture.rateLimit.getUsageStats()).requestsToday).toStrictEqual(2);
    expect(
      (await fixture.storage.getAutonomousParticipation("channel"))?.latestHumanMessageId,
    ).toStrictEqual("new-message");
  }));

for (const target of ["self-message", "bot-message", "already-reacted", "unknown-message"]) {
  test(`autonomous chat refuses reaction target ${target}`, () =>
    withAutonomousJob(
      {
        ok: true,
        text: "",
        tokensUsed: 10,
        participation: { action: "react", messageId: target, emoji: "😂" },
      },
      async (fixture) => {
        fixture.messages.set("channel", [
          { ...fixture.humanMessage("self-message", 70_000), authorId: "bot", authorBot: false },
          { ...fixture.humanMessage("bot-message", 2000), authorId: "other-bot", authorBot: true },
          { ...fixture.humanMessage("already-reacted", 1500), hasOwnReaction: true },
          fixture.humanMessage(),
        ]);
        await fixture.run();
        const options = fixture.generations[0].options;
        assert(options && "mode" in options);
        expect(options.allowedMessageIds).toStrictEqual(["message"]);
        expect(fixture.posts).toStrictEqual([]);
        expect(fixture.reactions).toStrictEqual([]);
      },
    ));
}

test("autonomous chat never generates from only bots or its own messages", () =>
  withAutonomousJob(reply, async (fixture) => {
    fixture.messages.set("channel", [
      { ...fixture.humanMessage("self-message"), authorId: "bot", authorBot: false },
      { ...fixture.humanMessage("bot-message"), authorId: "other-bot", authorBot: true },
    ]);
    await fixture.run();
    expect(fixture.generations.length).toStrictEqual(0);
    expect(fixture.posts).toStrictEqual([]);
    expect(fixture.reactions).toStrictEqual([]);
    expect((await fixture.rateLimit.getUsageStats()).requestsToday).toStrictEqual(0);
  }));

test("autonomous channel read failure does not block participation in the next channel", () =>
  withAutonomousJob(
    react,
    async (fixture) => {
      await fixture.run();
      expect(fixture.generations.length).toStrictEqual(1);
      expect(fixture.reactions).toStrictEqual([
        { channelId: "working", messageId: "message", emoji: "😂" },
      ]);
      expect(fixture.posts).toStrictEqual([]);
    },
    {
      settings: { autonomousChatChannelIds: ["unavailable", "working"] },
      getRecentMessages: (channelId) =>
        channelId === "unavailable"
          ? Promise.reject(new Error("Discord channel unavailable"))
          : Promise.resolve([
              {
                id: "message",
                authorId: "human",
                authorName: "Alice",
                authorBot: false,
                content: "A good meme",
                timestamp: new Date(Date.now() - 1000).toISOString(),
                imageUrls: [],
              },
            ]),
    },
  ));

test("autonomous failed reaction does not block the next channel", () =>
  withAutonomousJob(
    react,
    async (fixture) => {
      await fixture.run();
      expect(fixture.generations.length).toStrictEqual(2);
      expect(fixture.reactions.map((reaction) => reaction.channelId)).toStrictEqual([
        "unavailable",
        "working",
      ]);
      expect(fixture.posts).toStrictEqual([]);
    },
    {
      settings: { autonomousChatChannelIds: ["unavailable", "working"] },
      reaction: ({ channelId }) =>
        channelId === "unavailable"
          ? Promise.reject(new TypeError("network connection lost"))
          : Promise.resolve(new Response(null, { status: 204 })),
    },
  ));

test("autonomous chat skips an overlapping scheduled run", async () => {
  let finish!: (result: AiResult) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => (started = resolve));
  await withAutonomousJob(
    () => {
      started();
      return new Promise<AiResult>((resolve) => (finish = resolve));
    },
    async (fixture) => {
      const firstRun = fixture.run();
      await entered;
      try {
        await fixture.run();
        expect(fixture.generations.length).toStrictEqual(1);
        expect((await fixture.rateLimit.getUsageStats()).requestsToday).toStrictEqual(1);
      } finally {
        finish(react);
        await firstRun;
      }
      expect(fixture.reactions.length).toStrictEqual(1);
      expect(fixture.posts).toStrictEqual([]);
    },
  );
});

test("autonomous reaction cooldown starts after slow generation finishes", async () => {
  let advance!: Fixture["advance"];
  let firstGeneration = true;
  await withAutonomousJob(
    async () => {
      if (firstGeneration) {
        firstGeneration = false;
        await Promise.resolve();
        advance(59_000);
        return react;
      }
      return silent;
    },
    async (fixture) => {
      advance = fixture.advance;
      const startedAt = Date.now();
      await fixture.run();
      expect(fixture.reactions.length).toStrictEqual(1);

      // The next scheduled minute is only one second after the reaction finished.
      fixture.advance(1000);
      fixture.messages.set("channel", [fixture.humanMessage("next-message", 0)]);
      fixture.restart();
      await fixture.run();
      expect(fixture.generations.length).toStrictEqual(1);
      expect((await fixture.rateLimit.getUsageStats()).requestsToday).toStrictEqual(1);
      expect(
        (await fixture.storage.getAutonomousParticipation("channel"))?.attemptedAt,
      ).toStrictEqual(startedAt + 59_000);

      fixture.advance(59_000);
      await fixture.run();
      expect(fixture.generations.length).toStrictEqual(2);
      expect(fixture.reactions.length).toStrictEqual(1);
      expect(fixture.posts).toStrictEqual([]);
      expect((await fixture.rateLimit.getUsageStats()).requestsToday).toStrictEqual(2);
      expect((await fixture.rateLimit.getUsageStats()).dailyTokensUsed).toStrictEqual(20);
    },
  );
});

test("autonomous reaction cooldown starts after slow Discord delivery finishes", async () => {
  let advance!: Fixture["advance"];
  let firstDelivery = true;
  await withAutonomousJob(
    ({ options }) => {
      assert(options && "mode" in options);
      return Promise.resolve({
        ok: true,
        text: "",
        tokensUsed: 10,
        participation: {
          action: "react",
          messageId: options.allowedMessageIds[0],
          emoji: options.reactionChoices!.find((c) => c.intent === "amusement")!.emoji,
        },
      });
    },
    async (fixture) => {
      advance = fixture.advance;
      await fixture.run();
      expect(fixture.reactions.length).toStrictEqual(1);
      fixture.advance(1000);
      fixture.messages.set("channel", [fixture.humanMessage("next-message", 0)]);
      fixture.restart();
      await fixture.run();
      expect(fixture.generations.length).toStrictEqual(1);
      expect((await fixture.rateLimit.getUsageStats()).requestsToday).toStrictEqual(1);

      fixture.advance(59_000);
      await fixture.run();
      expect(fixture.generations.length).toStrictEqual(2);
      expect(fixture.reactions.map(({ messageId }) => messageId)).toStrictEqual([
        "message",
        "next-message",
      ]);
      expect(fixture.posts).toStrictEqual([]);
    },
    {
      reaction: async () => {
        if (firstDelivery) {
          firstDelivery = false;
          await Promise.resolve();
          advance(59_000);
        }
        return new Response(null, { status: 204 });
      },
    },
  );
});

test("missing channel reaction permission prevents a write", () =>
  withAutonomousJob(
    react,
    async (f) => {
      await f.run();
      expect(f.reactions).toStrictEqual([]);
      expect(f.posts).toStrictEqual([]);
    },
    {
      getReactionContext: (channelId) =>
        Promise.resolve({
          channelId,
          guildId: "unknown",
          canReact: false,
          memberRoles: [],
          emojis: [],
        }),
    },
  ));
test("a deleted or edited target is rejected immediately before delivery", async () => {
  for (const changed of [
    null,
    {
      id: "message",
      authorId: "human",
      authorName: "Alice",
      authorBot: false,
      content: "An edited insult",
      timestamp: "2026-09-05T12:33:59Z",
      imageUrls: [],
    },
  ]) {
    await withAutonomousJob(
      react,
      async (f) => {
        await f.run();
        expect(f.reactions).toStrictEqual([]);
        expect(f.posts).toStrictEqual([]);
      },
      { getMessage: () => Promise.resolve(changed) },
    );
  }
});
test("new human activity arriving during generation cancels the stale reaction", () =>
  withAutonomousJob(
    ({ messages }) => {
      expect(messages.length).toStrictEqual(1);
      return Promise.resolve(react);
    },
    async (f) => {
      // Change the second read, not the initial snapshot.
      await f.run();
      expect(f.reactions).toStrictEqual([]);
    },
    {
      getRecentMessages: (() => {
        let count = 0;
        return () =>
          Promise.resolve([
            {
              id: ++count === 1 ? "message" : "new-message",
              authorId: "human",
              authorName: "Alice",
              authorBot: false,
              content: "A new joke",
              timestamp: new Date(Date.now() - 1000).toISOString(),
              imageUrls: [],
            },
          ]);
      })(),
    },
  ));
test("loss of emoji availability after generation prevents delivery", () => {
  let reads = 0;
  return withAutonomousJob(
    ({ options }) => {
      assert(options && "mode" in options);
      const c = options.reactionChoices!.find((c) => c.intent === "dry_amusement")!;
      return Promise.resolve<AiResult>({
        ok: true,
        text: "",
        tokensUsed: 10,
        participation: {
          action: "react",
          messageId: "message",
          emoji: c.emoji,
          intent: c.intent,
          reason: "shared_joke",
        },
      });
    },
    async (f) => {
      await f.run();
      expect(f.reactions).toStrictEqual([]);
    },
    {
      getReactionContext: (channelId) =>
        Promise.resolve({
          channelId,
          guildId: "589723496473690132",
          canReact: true,
          memberRoles: [],
          emojis: [
            {
              id: "1559742515698081933",
              name: "BocchiSip",
              roles: [],
              available: ++reads === 1,
            },
          ],
        }),
    },
  );
});

test("a context reset during generation cancels a reaction", () => {
  let fixture: Fixture;
  return withAutonomousJob(
    async () => {
      await fixture.storage.setContextReset({
        channelId: "channel",
        messageId: "reset",
        resetAt: Date.now(),
      });
      return react;
    },
    async (f) => {
      fixture = f;
      await f.run();
      expect(f.reactions).toStrictEqual([]);
      expect(f.posts).toStrictEqual([]);
    },
  );
});
