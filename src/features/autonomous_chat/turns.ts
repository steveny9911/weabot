import type { RecentDiscordMessage } from "../chat_context/mod.ts";

export interface ConversationTurn {
  id: string;
  messages: RecentDiscordMessage[];
  anchorIds: string[];
}
const CONNECTIVE =
  /^(?:more like|and then|but then|because|wait for it|wait|so anyway|hear me out|here(?:'s| is) the punchline)[.!…:]*$/i;
const LAUGHTER = /^(?:x+d+|l(?:o+l)+|lmao|lmfao|rofl|haha(?:ha)*|hehe(?:he)*|kek+w*|😂|🤣)[! .]*$/i;
export function isIncompleteFragment(message: RecentDiscordMessage): boolean {
  return !message.imageUrls.length && CONNECTIVE.test(message.content.trim());
}

/** Adjacency avoids merging interleaved authors; explicit reply changes start a new turn. */
export function conversationTurns(messages: RecentDiscordMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const message of messages) {
    const last = turns.at(-1);
    const previous = last?.messages.at(-1);
    const reference = last?.messages.find((m) => m.referencedMessage)?.referencedMessage?.id;
    const gap = previous
      ? Date.parse(message.timestamp) - Date.parse(previous.timestamp)
      : Infinity;
    if (
      last && previous && previous.authorId === message.authorId &&
      !previous.authorBot && !message.authorBot && gap >= 0 && gap <= 15_000 &&
      (!message.referencedMessage || message.referencedMessage.id === reference)
    ) last.messages.push(message);
    else turns.push({ id: message.id, messages: [message], anchorIds: [] });
  }
  for (const turn of turns) {
    const substantive = turn.messages.filter((m) =>
      !isIncompleteFragment(m) && (m.imageUrls.length > 0 || !LAUGHTER.test(m.content.trim()))
    );
    const finalConnector = turn.messages.findLastIndex(isIncompleteFragment);
    turn.anchorIds = turn.messages.filter((m, index) =>
      !isIncompleteFragment(m) &&
      (m.imageUrls.length > 0 || !(substantive.length && LAUGHTER.test(m.content.trim()))) &&
      // A question before a connective and its continuation is setup, not the joke itself.
      !(index < finalConnector && /\?\s*$/.test(m.content))
    ).map((m) => m.id);
  }
  return turns;
}
