import { expect, test } from "bun:test";
import { TURN_TTL_MS, TurnStore, turnKey } from "./state.ts";

const KEY = turnKey("guild", "channel", "user");

test("every turn write issues a new token, so an older session is no longer current", () => {
  const turns = new TurnStore<string>(() => 0);
  const first = turns.setTurn(KEY, "600");
  expect(turns.isCurrent(KEY, first.token)).toBe(true);
  const cleared = turns.setTurn(KEY, "600", true);
  expect(cleared.token).not.toBe(first.token);
  expect(cleared).toStrictEqual({ token: cleared.token, messageId: "600", reset: true });
  expect(turns.isCurrent(KEY, first.token)).toBe(false);
  expect(turns.isCurrent(KEY, cleared.token)).toBe(true);
  expect(turns.isCurrent(turnKey("guild", "channel", "other"), cleared.token)).toBe(false);
});

test("turns and pending clarifications expire 20 minutes after their own writes", () => {
  let now = 0;
  const turns = new TurnStore<string>(() => now);
  turns.setPending(KEY, "question");
  now = 10 * 60_000;
  const turn = turns.setTurn(KEY, "601");
  now = TURN_TTL_MS - 1;
  expect(turns.pending(KEY)).toBe("question");
  now = TURN_TTL_MS;
  expect(turns.pending(KEY)).toBeNull();
  expect(turns.isCurrent(KEY, turn.token)).toBe(true);
  now = 10 * 60_000 + TURN_TTL_MS;
  expect(turns.turn(KEY)).toBeNull();
  expect(turns.isCurrent(KEY, turn.token)).toBe(false);
});

test("sweep removes only expired entries", () => {
  let now = 0;
  const turns = new TurnStore<string>(() => now);
  turns.setTurn(turnKey("g", "c", "old"), "1");
  turns.setPending(turnKey("g", "c", "old"), "old question");
  now = 15 * 60_000;
  turns.setTurn(KEY, "2");
  now = TURN_TTL_MS;
  expect(turns.sweep()).toBe(2);
  expect(turns.sweep()).toBe(0);
  expect(turns.turn(KEY)?.messageId).toBe("2");
});
