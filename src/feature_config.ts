/**
 * What every feature's config has in common: whether it is on, and which channels it works in.
 * A feature adds its own settings next to these.
 */

/** The channel IDs a feature works in, or `"all"` for every channel. */
export type ChannelScope = string[] | "all";

export interface FeatureConfig<Scope extends ChannelScope = ChannelScope> {
  enabled: boolean;
  channelIds: Scope;
}

/** Whether the feature is on and works in this channel. */
export function isActiveIn(feature: FeatureConfig, channelId: string): boolean {
  if (!feature.enabled) return false;
  return feature.channelIds === "all" || feature.channelIds.includes(channelId);
}

/** Unique IDs. They must be quoted in YAML: unquoted, they parse as numbers and lose digits. */
export function parseIds(name: string, value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
    throw new Error(`FATAL: ${name} in config.yaml must be a list of quoted strings`);
  }
  return [...new Set<string>(value)];
}

/**
 * Reads the `channel_ids` of a feature that posts to named channels: a list. A missing, null or
 * empty value falls back to `defaults`, the channels of the whole bot. `all` is an error, as there
 * is no way to list every channel.
 */
export function parseChannelList(name: string, value: unknown, defaults: string[]): string[] {
  if (value === "all") {
    throw new Error(`FATAL: ${name} in config.yaml cannot be "all": list the channels instead`);
  }
  const listed = parseIds(name, value);
  if (listed.includes("all")) {
    throw new Error(`FATAL: ${name} in config.yaml: write all without brackets, or list real IDs`);
  }
  return listed.length ? listed : defaults;
}

/** Like `parseChannelList`, for a feature that may work in every channel: `all` is allowed. */
export function parseChannelScope(name: string, value: unknown, defaults: string[]): ChannelScope {
  return value === "all" ? "all" : parseChannelList(name, value, defaults);
}
