import { expect, test } from "bun:test";
import { openDatabase } from "./database.ts";
import { createDiscordActionQueries, type GuardKey, type OperationKey } from "./discord_actions.ts";

const OPERATION: OperationKey = { guildId: "g", messageId: "m1", action: "create_discord_event" };
const GUARD: GuardKey = { guildId: "g", kind: "creation_fingerprint", key: "hash" };

test("a claim writes a pending operation and guard only when the turn is current", () => {
  using db = openDatabase(":memory:");
  const records = createDiscordActionQueries(db);
  expect(records.claim(OPERATION, GUARD, () => false, 1)).toBe(false);
  expect(records.getOperation(OPERATION)).toBeNull();
  expect(records.getGuard(GUARD)).toBeNull();

  expect(records.claim(OPERATION, GUARD, () => true, 1)).toBe(true);
  expect(records.getOperation(OPERATION)).toStrictEqual({ state: "pending", updatedAt: 1 });
  expect(records.getGuard(GUARD)).toStrictEqual({ state: "pending", updatedAt: 1 });
});

test("a second claim for the same message or the same event is refused", () => {
  using db = openDatabase(":memory:");
  const records = createDiscordActionQueries(db);
  expect(records.claim(OPERATION, GUARD, () => true, 1)).toBe(true);
  expect(records.claim(OPERATION, null, () => true, 2)).toBe(false);
  const otherMessage = { ...OPERATION, messageId: "m2" };
  expect(records.claim(otherMessage, GUARD, () => true, 2)).toBe(false);
  expect(records.getOperation(otherMessage)).toBeNull();
  // The same event in another guild, or another action for the message, is independent.
  expect(
    records.claim({ ...OPERATION, action: "create_discord_invite" }, null, () => true, 2),
  ).toBe(true);
  expect(records.claim(otherMessage, { ...GUARD, guildId: "h" }, () => true, 2)).toBe(true);
});

test("a claim is all or nothing", () => {
  using db = openDatabase(":memory:");
  const records = createDiscordActionQueries(db);
  db.run(`CREATE TRIGGER fail_guard BEFORE INSERT ON discord_event_guards
          BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`);
  expect(() => records.claim(OPERATION, GUARD, () => true, 1)).toThrow("simulated failure");
  expect(records.getOperation(OPERATION)).toBeNull();
});

test("completion records the result and keeps the guard only when the event may exist", () => {
  using db = openDatabase(":memory:");
  const records = createDiscordActionQueries(db);
  const result = { ok: true, message: "made", eventId: "501" };
  records.claim(OPERATION, GUARD, () => true, 1);
  records.complete(OPERATION, GUARD, result, true, 2);
  expect(records.getOperation(OPERATION)).toStrictEqual({ state: "done", result, updatedAt: 2 });
  expect(records.getGuard(GUARD)).toStrictEqual({ state: "done", result, updatedAt: 2 });

  const failed = { ...OPERATION, messageId: "m2" };
  const otherGuard = { ...GUARD, key: "other" };
  records.claim(failed, otherGuard, () => true, 3);
  records.complete(failed, otherGuard, { ok: false, message: "no" }, false, 4);
  expect(records.getOperation(failed)?.result).toStrictEqual({ ok: false, message: "no" });
  expect(records.getGuard(otherGuard)).toBeNull();
});

test("a stale guard is deleted only if it still holds what was read", () => {
  using db = openDatabase(":memory:");
  const records = createDiscordActionQueries(db);
  records.claim(OPERATION, GUARD, () => true, 1);
  records.complete(OPERATION, GUARD, { ok: true, eventId: "501" }, true, 2);
  const seen = records.getGuard(GUARD)!;
  // Another handler replaced the guard after it was read.
  records.complete(OPERATION, GUARD, { ok: true, eventId: "502" }, true, 3);
  expect(records.deleteGuardIfUnchanged(GUARD, seen)).toBe(false);
  const current = records.getGuard(GUARD)!;
  expect(records.deleteGuardIfUnchanged(GUARD, current)).toBe(true);
  expect(records.getGuard(GUARD)).toBeNull();
});

test("a stale guard is kept when only its time changed", () => {
  using db = openDatabase(":memory:");
  const records = createDiscordActionQueries(db);
  const result = { ok: true, eventId: "501" };
  records.claim(OPERATION, GUARD, () => true, 1);
  records.complete(OPERATION, GUARD, result, true, 2);
  const seen = records.getGuard(GUARD)!;
  records.complete(OPERATION, GUARD, result, true, 3);
  expect(records.deleteGuardIfUnchanged(GUARD, seen)).toBe(false);
  expect(records.getGuard(GUARD)?.updatedAt).toBe(3);
});

test("a stale guard is kept when only its result changed", () => {
  using db = openDatabase(":memory:");
  const records = createDiscordActionQueries(db);
  records.claim(OPERATION, GUARD, () => true, 1);
  records.complete(OPERATION, GUARD, { ok: true, eventId: "501" }, true, 2);
  const seen = records.getGuard(GUARD)!;
  records.complete(OPERATION, GUARD, { ok: true, eventId: "502" }, true, 2);
  expect(records.deleteGuardIfUnchanged(GUARD, seen)).toBe(false);
  expect(records.getGuard(GUARD)?.result).toStrictEqual({ ok: true, eventId: "502" });
});
