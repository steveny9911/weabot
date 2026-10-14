/** Reviewed meanings, guild-local inventories, and bounded expression variation. */
export const REACTION_INTENTS = [
  "amusement",
  "dry_amusement",
  "appreciation",
  "celebration",
  "concern",
  "disapproval",
] as const;
export type ReactionIntent = typeof REACTION_INTENTS[number];
export const DECISION_REASONS = [
  "shared_joke",
  "acknowledgment",
  "achievement",
  "kindness",
  "concern",
  "unkindness",
  "useful_answer",
  "no_contribution",
  "incomplete",
  "ambiguous",
] as const;
export type DecisionReason = typeof DECISION_REASONS[number];
export interface ReactionChoice {
  emoji: string;
  intent: ReactionIntent;
  description: string;
}
export interface GuildEmoji {
  id: string;
  name: string;
  roles: string[];
  available: boolean;
}
export interface ReactionContext {
  guildId: string;
  channelId: string;
  canReact: boolean;
  memberRoles: string[];
  emojis: GuildEmoji[];
}

const meanings: Record<ReactionIntent, string> = {
  amusement:
    "Shared laughter at a genuinely funny harmless joke; never laugh at cruelty or distress.",
  dry_amusement:
    "Quiet, deadpan amusement at harmless absurdity or a bad joke; avoid mocking a person.",
  appreciation: "Warm appreciation or bashfulness about kindness; not approval of harmful conduct.",
  celebration: "Sincere excitement about an achievement; never sarcastic hostility or humiliation.",
  concern: "Gentle support for the affected person; do not trivialize distress with a joke.",
  disapproval:
    "Mild side-eye at unkind behavior, not contempt for the person; words may be clearer.",
};
const custom = [
  {
    name: "BocchiSip",
    intent: "dry_amusement",
    description: "Pink-haired anime girl quietly sipping a cup.",
  },
  {
    name: "RyoDisgust",
    intent: "disapproval",
    description: "Blue-haired anime girl giving restrained side-eye.",
  },
  {
    name: "Madge",
    intent: "disapproval",
    description: "Annoyed green frog; comically huffy, not threatening.",
  },
  {
    name: "UwU",
    intent: "appreciation",
    description: "Coy, smiling anime girl; warm or a little flustered.",
  },
  {
    name: "shyggers",
    intent: "appreciation",
    description: "Blushing yellow face; bashful appreciation.",
  },
  {
    name: "AYAYA",
    intent: "celebration",
    description: "Cheerful anime face; use sincere excitement despite local sarcastic uses.",
  },
  {
    name: "pog",
    intent: "celebration",
    description: "Open-mouthed surprised face; impressed delight.",
  },
  {
    name: "KEKW",
    intent: "amusement",
    description: "Man laughing heartily; only shared harmless humor.",
  },
] as const;
const guildIds: Record<string, readonly string[]> = {
  "782856078907277332": [
    "1079652016252534925",
    "1079652021235355648",
    "946997106500063312",
    "827753977093423142",
    "1212914816864362546",
    "819503386943684618",
    "819754959871672330",
    "995865643599548486",
  ],
  "589723496473690132": [
    "1559742515698081933",
    "1559742624347328553",
    "1559742646656835637",
    "1559742668941041795",
    "1559742933555478630",
    "1559742194259202049",
    "1559742955043029043",
    "1559742976572395610",
  ],
};
const unicode: Record<ReactionIntent, string[]> = {
  amusement: ["😂", "😄", "🤣"],
  dry_amusement: ["😅", "😐"],
  appreciation: ["❤️", "👍"],
  celebration: ["🎉", "🙌"],
  concern: ["💙", "🫂"],
  disapproval: ["😒"],
};

/** All reviewed, currently usable expressions; names never establish their meanings. */
export function availableReactions(context: ReactionContext | null): ReactionChoice[] {
  if (context && !context.canReact) return [];
  const reviewed = guildIds[context?.guildId ?? ""];
  return REACTION_INTENTS.flatMap((intent) => {
    const local = context && reviewed
      ? custom.flatMap((entry, index) => {
        const e = context.emojis.find((emoji) => emoji.id === reviewed[index]);
        return entry.intent === intent && e?.available && /^[A-Za-z0-9_]{2,32}$/.test(e.name) &&
            (e.roles.length === 0 || e.roles.some((role) => context.memberRoles.includes(role)))
          ? [{
            emoji: `${e.name}:${e.id}`,
            intent,
            description: `${entry.description} ${meanings[intent]}`,
          }]
          : [];
      })
      : [];
    return local.length ? local : unicode[intent].map((emoji) => ({
      emoji,
      intent,
      description: meanings[intent],
    }));
  });
}

/** Expose one expression per meaning: model picks stance/target, app supplies variation. */
export function reactionChoices(
  context: ReactionContext | null,
  previousEmoji?: string,
  random: () => number = Math.random,
): ReactionChoice[] {
  const available = availableReactions(context);
  return REACTION_INTENTS.flatMap((intent) => {
    const candidates = available.filter((choice) => choice.intent === intent);
    if (!candidates.length) return [];
    const varied = candidates.length > 1
      ? candidates.filter((entry) => entry.emoji !== previousEmoji)
      : candidates;
    const sample = random();
    const index = Number.isFinite(sample)
      ? Math.floor(Math.min(0.999999, Math.max(0, sample)) * varied.length)
      : 0;
    return [varied[index]];
  });
}

export function isAllowedReaction(
  emoji: string,
  intent: unknown,
  choices: ReactionChoice[],
): boolean {
  return choices.some((choice) => choice.emoji === emoji && choice.intent === intent);
}
