/**
 * Discord action operation records and event guards.
 *
 * An operation row means an action already ran (or is running) for one Discord message. A guard
 * row stops the same event from being created or cancelled twice across messages.
 */
import type { Database } from "bun:sqlite";

export type GuardKind = "creation_fingerprint" | "cancellation";
export type ClaimState = "pending" | "done";

export interface OperationKey {
  guildId: string;
  messageId: string;
  action: string;
}
export interface GuardKey {
  guildId: string;
  kind: GuardKind;
  key: string;
}
/** A stored claim. `result` is the JSON-decoded result, absent while pending. */
export interface StoredClaim<T> {
  state: ClaimState;
  result?: T;
  updatedAt: number;
}

interface ClaimRow {
  state: ClaimState;
  result: string | null;
  updated_at: number;
}

function toClaim<T>(row: ClaimRow | null): StoredClaim<T> | null {
  if (!row) return null;
  return {
    state: row.state,
    ...(row.result === null ? {} : { result: JSON.parse(row.result) as T }),
    updatedAt: row.updated_at,
  };
}

export function createDiscordActionQueries(db: Database) {
  const getOperation = db.query<ClaimRow, { guild: string; message: string; action: string }>(
    `SELECT state, result, updated_at FROM discord_action_operations
     WHERE guild_id = $guild AND message_id = $message AND action = $action`,
  );
  const insertOperation = db.query(
    `INSERT INTO discord_action_operations (guild_id, message_id, action, state, updated_at)
     VALUES ($guild, $message, $action, 'pending', $at)`,
  );
  const completeOperation = db.query(
    `INSERT INTO discord_action_operations (guild_id, message_id, action, state, result, updated_at)
     VALUES ($guild, $message, $action, 'done', $result, $at)
     ON CONFLICT (guild_id, message_id, action) DO UPDATE SET
       state = 'done', result = excluded.result, updated_at = excluded.updated_at`,
  );
  const getGuard = db.query<ClaimRow, { guild: string; kind: GuardKind; key: string }>(
    `SELECT state, result, updated_at FROM discord_event_guards
     WHERE guild_id = $guild AND kind = $kind AND guard_key = $key`,
  );
  const insertGuard = db.query(
    `INSERT INTO discord_event_guards (guild_id, kind, guard_key, state, updated_at)
     VALUES ($guild, $kind, $key, 'pending', $at)`,
  );
  const completeGuard = db.query(
    `INSERT INTO discord_event_guards (guild_id, kind, guard_key, state, result, updated_at)
     VALUES ($guild, $kind, $key, 'done', $result, $at)
     ON CONFLICT (guild_id, kind, guard_key) DO UPDATE SET
       state = 'done', result = excluded.result, updated_at = excluded.updated_at`,
  );
  const deleteGuard = db.query(
    `DELETE FROM discord_event_guards WHERE guild_id = $guild AND kind = $kind AND guard_key = $key`,
  );
  const deleteGuardIfUnchanged = db.query(
    `DELETE FROM discord_event_guards
     WHERE guild_id = $guild AND kind = $kind AND guard_key = $key
       AND state = $state AND result IS $result AND updated_at = $updatedAt`,
  );

  const op = (key: OperationKey) => ({
    guild: key.guildId,
    message: key.messageId,
    action: key.action,
  });
  const guard = (key: GuardKey) => ({ guild: key.guildId, kind: key.kind, key: key.key });

  /**
   * Claims an operation (and optionally a guard) as pending, only if neither exists and
   * `isCurrent()` still holds. All checks and writes happen in one transaction.
   */
  const claim = db.transaction(
    (operation: OperationKey, guardKey: GuardKey | null, isCurrent: () => boolean, at: number) => {
      if (!isCurrent()) return false;
      if (getOperation.get(op(operation))) return false;
      if (guardKey && getGuard.get(guard(guardKey))) return false;
      insertOperation.run({ ...op(operation), at });
      if (guardKey) insertGuard.run({ ...guard(guardKey), at });
      return true;
    },
  );

  /** Records the result; keeps the guard only when `keepGuard` (the event may exist). */
  const complete = db.transaction(
    (
      operation: OperationKey,
      guardKey: GuardKey | null,
      result: unknown,
      keepGuard: boolean,
      at: number,
    ) => {
      const json = JSON.stringify(result);
      completeOperation.run({ ...op(operation), result: json, at });
      if (!guardKey) return;
      if (keepGuard) completeGuard.run({ ...guard(guardKey), result: json, at });
      else deleteGuard.run(guard(guardKey));
    },
  );

  return {
    getOperation<T>(key: OperationKey): StoredClaim<T> | null {
      return toClaim<T>(getOperation.get(op(key)));
    },
    getGuard<T>(key: GuardKey): StoredClaim<T> | null {
      return toClaim<T>(getGuard.get(guard(key)));
    },
    /** Deletes a guard only if it still holds what was read. Returns whether it was deleted. */
    deleteGuardIfUnchanged<T>(key: GuardKey, seen: StoredClaim<T>): boolean {
      return (
        deleteGuardIfUnchanged.run({
          ...guard(key),
          state: seen.state,
          result: seen.result === undefined ? null : JSON.stringify(seen.result),
          updatedAt: seen.updatedAt,
        }).changes > 0
      );
    },
    claim(
      operation: OperationKey,
      guardKey: GuardKey | null,
      isCurrent: () => boolean,
      at: number,
    ) {
      return claim.immediate(operation, guardKey, isCurrent, at);
    },
    complete(
      operation: OperationKey,
      guardKey: GuardKey | null,
      result: unknown,
      keepGuard: boolean,
      at: number,
    ): void {
      complete.immediate(operation, guardKey, result, keepGuard, at);
    },
  };
}
