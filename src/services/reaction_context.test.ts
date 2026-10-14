import { assertEquals, assertRejects } from "@std/assert";
import { readReactionContext } from "./reaction_context.ts";
Deno.test("reaction metadata uses actual channel overwrites, bot roles, and guild inventory", async () => {
  const original = globalThis.fetch;
  let deny = "0";
  globalThis.fetch = (input) => {
    const path = new URL(String(input)).pathname.replace("/api/v10", "");
    const channel = {
      id: "456",
      guild_id: "123",
      name: "memes",
      type: 0,
      permission_overwrites: [{ id: "123", type: 0, allow: "0", deny }],
    };
    const data: Record<string, unknown> = {
      "/channels/456": channel,
      "/guilds/123": {
        id: "123",
        owner_id: "owner",
        roles: [{ id: "123", permissions: String((1n << 10n) | (1n << 16n) | (1n << 6n)) }],
      },
      "/guilds/123/members/bot": { user: { id: "bot", bot: true }, roles: ["role"] },
      "/guilds/123/channels": [channel],
      "/guilds/123/emojis": [{ id: "999", name: "reviewed", available: true, roles: ["role"] }],
    };
    return Promise.resolve(Response.json(data[path]));
  };
  try {
    const c = await readReactionContext("test-token", "456", "bot");
    assertEquals(c.canReact, true);
    assertEquals(c.memberRoles, ["role"]);
    assertEquals(c.emojis[0].id, "999");
    deny = String(1n << 6n);
    assertEquals((await readReactionContext("test-token", "456", "bot")).canReact, false);
  } finally {
    globalThis.fetch = original;
  }
});
Deno.test("reaction metadata rejects malformed inventory without leaking response errors", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response("sensitive upstream body", { status: 403 }));
  try {
    await assertRejects(
      () => readReactionContext("secret", "456", "bot"),
      Error,
      "Reaction metadata unavailable",
    );
  } finally {
    globalThis.fetch = original;
  }
});
