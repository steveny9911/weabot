/** What a provider's folder exports to the registry, and the helper that builds it. */
import type { AiProvider } from "./types.ts";

/** Reads a secret from `.env`; blank means unset. */
type SecretReader = (name: string) => string | undefined;

/** The keys a config section accepts: `true` for a setting, an object for a section under it. */
export interface KeyTree {
  [key: string]: true | KeyTree;
}

/** A provider as the registry and config see it, with its own settings type hidden. */
export interface AiProviderModule {
  /** The provider's key in `.env`. */
  apiKeyEnv: string;
  /** Every key its `ai.<name>` section in config.yaml accepts. */
  configKeys: KeyTree;
  /** Reads and checks the provider's section. Throws for a missing or invalid setting. */
  parseConfig(section: unknown, secret: SecretReader): unknown;
  create(settings: unknown, apiKey: string | undefined): AiProvider;
}

/**
 * Defines a provider: `F` is the shape of its config.yaml section and `S` its checked settings.
 * Only here are the two joined to the untyped registry.
 */
export function defineAiProvider<F, S>(provider: {
  apiKeyEnv: string;
  configKeys: Array<keyof F & string>;
  parseConfig(section: F | undefined, secret: SecretReader): S;
  create(settings: S, apiKey: string | undefined): AiProvider;
}): AiProviderModule {
  return {
    apiKeyEnv: provider.apiKeyEnv,
    configKeys: Object.fromEntries(provider.configKeys.map((key) => [key, true])),
    parseConfig: (section, secret) => provider.parseConfig(section as F | undefined, secret),
    create: (settings, apiKey) => provider.create(settings as S, apiKey),
  };
}
