/**
 * In-memory Discord action turns and pending clarifications.
 *
 * A turn is the latest message a user sent in a channel. Each write of a turn issues a new token,
 * so a session can check that its turn is still the current one (a token works like a version).
 * Turns and pending clarifications expire 20 minutes after they were written. They only
 * coordinate work inside this process, so they are not persisted.
 */

export const TURN_TTL_MS = 20 * 60_000;

export interface Turn {
  token: string;
  messageId: string;
  reset?: boolean;
}

interface Expiring<T> {
  value: T;
  expiresAt: number;
}

export class TurnStore<Pending> {
  readonly #turns = new Map<string, Expiring<Turn>>();
  readonly #pending = new Map<string, Expiring<Pending>>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #read<T>(map: Map<string, Expiring<T>>, key: string): T | null {
    const entry = map.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.#now()) {
      map.delete(key);
      return null;
    }
    return entry.value;
  }

  /** The current turn, or null if there is none or it expired. */
  turn(key: string): Turn | null {
    return this.#read(this.#turns, key);
  }

  /** Stores a new turn with a fresh token and returns it. */
  setTurn(key: string, messageId: string, reset = false): Turn {
    const turn: Turn = { token: crypto.randomUUID(), messageId, ...(reset ? { reset } : {}) };
    this.#turns.set(key, { value: turn, expiresAt: this.#now() + TURN_TTL_MS });
    return turn;
  }

  /** Whether `token` is still the token of the current, unexpired turn. */
  isCurrent(key: string, token: string): boolean {
    return this.turn(key)?.token === token;
  }

  pending(key: string): Pending | null {
    return this.#read(this.#pending, key);
  }

  setPending(key: string, value: Pending): void {
    this.#pending.set(key, { value, expiresAt: this.#now() + TURN_TTL_MS });
  }

  deletePending(key: string): void {
    this.#pending.delete(key);
  }

  /** Removes expired entries. Returns how many were removed. */
  sweep(): number {
    const now = this.#now();
    let removed = 0;
    for (const map of [this.#turns, this.#pending] as Map<string, Expiring<unknown>>[]) {
      for (const [key, entry] of map) {
        if (entry.expiresAt <= now) {
          map.delete(key);
          removed++;
        }
      }
    }
    return removed;
  }
}

export function turnKey(guildId: string, channelId: string, userId: string): string {
  return JSON.stringify([guildId, channelId, userId]);
}
