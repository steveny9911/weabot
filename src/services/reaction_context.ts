/** Read-only, live permission/inventory checks for autonomous reactions. */
import { type GuildEmoji, type ReactionContext } from "../features/reactions/mod.ts";
import { createDiscordEventsClient, getChannelPermissions } from "./discord_events.ts";

export async function readReactionContext(
  token: string,
  channelId: string,
  botId: string,
): Promise<ReactionContext> {
  async function get(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const r = await fetch(`https://discord.com/api/v10${path}`, {
        headers: { Authorization: `Bot ${token}` },
        signal: controller.signal,
        redirect: "error",
      });
      if (!r.ok) {
        await r.body?.cancel();
        throw new Error("Reaction metadata unavailable");
      }
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }
  const channel = await get(`/channels/${encodeURIComponent(channelId)}`);
  if (
    !channel || typeof channel !== "object" || !("guild_id" in channel) ||
    typeof channel.guild_id !== "string" || !/^\d+$/.test(channel.guild_id)
  ) {
    throw new Error("Expected a guild reaction channel");
  }
  const guildId = channel.guild_id;
  const events = createDiscordEventsClient(token);
  const [guild, member, channels, rawEmojis] = await Promise.all([
    events.getGuild(guildId),
    events.getMember(guildId, botId),
    events.getChannels(guildId),
    get(`/guilds/${guildId}/emojis`),
  ]);
  const actual = channels.find((c) => c.id === channelId && (c.type === 0 || c.type === 5));
  if (!actual || guild.id !== guildId || member.user.id !== botId || !Array.isArray(rawEmojis)) {
    throw new Error("Reaction context identity mismatch");
  }
  const emojis: GuildEmoji[] = [];
  for (const e of rawEmojis) {
    if (
      !e || typeof e !== "object" || typeof e.id !== "string" || !/^\d+$/.test(e.id) ||
      typeof e.name !== "string" || !Array.isArray(e.roles) ||
      !e.roles.every((role: unknown) => typeof role === "string") ||
      typeof e.available !== "boolean"
    ) {
      throw new Error("Invalid guild emoji inventory");
    }
    emojis.push({ id: e.id, name: e.name, available: e.available, roles: e.roles });
  }
  const permissions = getChannelPermissions(guild, member, actual);
  const needed = (1n << 10n) | (1n << 16n) | (1n << 6n); // View, history, add reactions.
  return {
    guildId,
    channelId,
    canReact: (permissions & needed) === needed,
    memberRoles: member.roles,
    emojis,
  };
}
