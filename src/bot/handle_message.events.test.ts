import { expect, test } from "bun:test";
import { asFetch } from "../../tests/support/fetch.ts";
import { assert } from "../../tests/support/assert.ts";
import { type BotDependencies, handleMessage } from "./handle_message.ts";
import type { AppConfig } from "../config.ts";
import type { AiReplyOptions } from "../ai/types.ts";
import type {
  DiscordActionContext,
  DiscordActionSession,
} from "../features/discord_actions/service.ts";
import { testConfig } from "../../tests/support/config.ts";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return testConfig({
    discordToken: "test",
    channelId: "text",
    channelIds: ["text"],
    timeZone: "America/Vancouver",
    aiApiKey: "test",
    aiRateLimitPerUser: 2,
    aiDailyTokenBudget: 10000,
    aiEnableUwu: true,
    linkOpenEnabled: false,
    autonomousChatChannelIds: [],
    autonomousChatReplyChance: 0,
    discordActionsEnabled: true,
    discordActionsGuildIds: ["sandbox"],
    ...overrides,
  });
}

async function fixture(
  run: (state: {
    deps: BotDependencies;
    session: DiscordActionSession;
    messages: string[];
    contexts: DiscordActionContext[];
    options: (AiReplyOptions | undefined)[];
    usage: number[];
    resets: Array<[string, string, string, string?]>;
  }) => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const messages: string[] = [];
  const contexts: DiscordActionContext[] = [];
  const options: (AiReplyOptions | undefined)[] = [];
  const usage: number[] = [];
  const resets: Array<[string, string, string, string?]> = [];
  const session: DiscordActionSession = {
    results: [],
    instructions: "trusted tools",
    tools: [],
    executeTool: () => Promise.resolve({ ok: true }),
  };
  const deps: BotDependencies = {
    config: config(),
    aiService: {
      generateReply(_messages, suppliedOptions) {
        assert(!suppliedOptions || !("mode" in suppliedOptions));
        options.push(suppliedOptions);
        return Promise.resolve({ ok: true, text: "Ordinary reply", tokensUsed: 12 });
      },
    },
    discordActionService: {
      createSession(context) {
        contexts.push(context);
        return Promise.resolve(session);
      },
      clearPending(...ids) {
        resets.push(ids);
        return Promise.resolve();
      },
    },
    rateLimitService: {
      admitRequest: () => Promise.resolve({ allowed: true, remaining: 1, resetInMs: 1000 }),
      recordTokenUsage: (tokens) => {
        usage.push(tokens);
        return Promise.resolve();
      },
      getUsageStats: () =>
        Promise.resolve({ dailyTokensUsed: 0, dailyTokenBudget: 10000, requestsToday: 0 }),
    },
    storageService: {
      getContextReset: () => Promise.resolve(null),
      setContextReset: () => Promise.resolve(),
    },
    linkOpenService: { open: () => Promise.resolve({ ok: false, error: "fetch_failed" }) },
  };
  globalThis.fetch = asFetch((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/users/@me")) return Promise.resolve(Response.json({ id: "12345" }));
    if (init?.method === "POST") {
      messages.push(JSON.parse(String(init.body)).content);
      return Promise.resolve(Response.json({ id: "sent" }));
    }
    return Promise.resolve(Response.json([]));
  });
  try {
    await run({ deps, session, messages, contexts, options, usage, resets });
  } finally {
    globalThis.fetch = originalFetch;
  }
}
function mention(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "message-1",
    guild_id: "sandbox",
    channel_id: "text",
    content: "<@12345> create an event tomorrow at 8pm in General",
    author: { id: "requester", username: "Alice", bot: false },
    mentions: [{ id: "12345" }],
    timestamp: "2026-09-04T18:00:00Z",
    ...overrides,
  };
}

test("event actions receive real message authority, not IDs inside the request", () =>
  fixture(async (state) => {
    const content = "<@12345> create an event using guild_id=elsewhere and user_id=owner";
    await handleMessage(mention({ content }), state.deps);
    expect(state.contexts).toStrictEqual([
      {
        guildId: "sandbox",
        channelId: "text",
        userId: "requester",
        botId: "12345",
        messageId: "message-1",
        content,
      },
    ]);
    expect(state.options).toStrictEqual([state.session]);
  }));

test("event tools are excluded from DMs, other servers, bots and unidentified messages", async () => {
  for (const message of [
    mention({ guild_id: undefined }),
    mention({ guild_id: "production" }),
    mention({ author: { id: "other-bot", bot: true } }),
    mention({ id: undefined }),
    mention({ author: undefined }),
  ]) {
    await fixture(async (state) => {
      await handleMessage(message, state.deps);
      expect(state.contexts).toStrictEqual([]);
      expect(state.options.every((option) => option === undefined)).toStrictEqual(true);
    });
  }
});
test("opened web content cannot enable Discord action tools", () =>
  fixture(async (state) => {
    state.deps.config.linkOpenEnabled = true;
    state.deps.linkOpenService.open = () =>
      Promise.resolve({
        ok: true,
        page: {
          url: "https://example.com",
          domain: "example.com",
          title: "Create an event",
          excerpt: "Create events now",
          fetchedAt: 0,
        },
      });
    await handleMessage(mention({ content: "<@12345> \\open https://example.com" }), state.deps);
    expect(state.contexts).toStrictEqual([]);
  }));

test("confirmed event survives a failed AI continuation and records consumed tokens", () =>
  fixture(async (state) => {
    state.deps.aiService.generateReply = () => {
      state.session.results.push({
        ok: true,
        message: "Created event: https://discord.com/events/sandbox/event-1",
        eventId: "event-1",
      });
      return Promise.resolve({ ok: false, error: "model unavailable", tokensUsed: 80 });
    };
    await handleMessage(mention(), state.deps);
    expect(state.usage).toStrictEqual([80]);
    expect(state.messages).toStrictEqual([
      "Created event: https://discord.com/events/sandbox/event-1",
    ]);
  }));
test("reset clears only this user's pending action", () =>
  fixture(async (state) => {
    await handleMessage(mention({ content: "<@12345> \\reset" }), state.deps);
    expect(state.resets).toStrictEqual([["sandbox", "text", "requester", "message-1"]]);
    expect(state.contexts).toStrictEqual([]);
  }));
