# Review of the Bun Migration Plan

Review of `docs/bun-migration-plan.md` at commit `e963f97`. Four reviewers covered data model, link
transport, runtime and tooling, and tests and slicing. Every finding below was re-checked:

- **Verified (re-run):** reproduced again in a separate experiment after the reviewer reported it.
- **Verified (code/docs):** confirmed against the current source or Bun 1.4.4's bundled docs.
- **Reported:** shown by the reviewer's experiment and consistent with code and docs, but not
  re-run.

All experiments ran on Bun 1.4.4 (SQLite 3.53.4) on loopback only.

## Decisions (2026-11-05)

| Question                              | Decision                                                                                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proxy environment variables (issue 1) | Delete them from `process.env` at startup, with a test.                                                                                                                                                                         |
| Event duplicate guards (issue 3)      | Superseded by the simplified data model: event actions run under an in-memory per-guild lock, so no revision column is needed. Turn tokens and pending clarifications move to memory, so issues 2 and 4 become in-memory rules. |
| Running canary `bun lint` (issue 14)  | `bunx bun@<exact canary> lint --max-warnings 0`, with the Bun install cache kept in CI.                                                                                                                                         |

## Summary

| #   | Issue                                                                                          | Severity | Status                       |
| --- | ---------------------------------------------------------------------------------------------- | -------- | ---------------------------- |
| 1   | Bun `fetch` follows proxy environment variables, bypassing IP pinning                          | High     | Verified (re-run)            |
| 2   | `clearPending` must rotate the turn token; the plan says it keeps it                           | High     | Verified (code)              |
| 3   | The `once` claim loses its turn check and atomic event-guard claim                             | High     | Verified (code)              |
| 4   | One `expires_at` merges two lifetimes, so clarifications stop expiring                         | High     | Verified (code)              |
| 5   | Slices 2 and 3 cannot run: mixed Deno/Bun breaks, imports cross slices                         | High     | Verified (code)              |
| 6   | A throwing `Bun.cron` handler kills the whole process                                          | High     | Verified (re-run)            |
| 7   | Test rule for `assertRejects`/`assertThrows` gives false greens; `assert` loses type narrowing | High     | Verified (re-run)            |
| 8   | `Bun.serve` dev mode returns a stack-trace page in production                                  | Medium   | Verified (re-run)            |
| 9   | Test runner: 5 s default timeout, `.env` loaded, globals leak across files, no network guard   | Medium   | Verified (re-run)            |
| 10  | `Bun.serve` closes requests idle for 10 s                                                      | Medium   | Verified (docs)              |
| 11  | `bun fmt` (Prettier) reformats 65 files; formatting plan is inconsistent                       | Medium   | Verified (docs) / Reported   |
| 12  | Weekly stats drop or duplicate a day across DST in non-UTC time zones                          | Medium   | Verified (re-run)            |
| 13  | Transport details: missing `Accept-Encoding`, `Bun/1.4.4` user agent, IP-literal SNI           | Medium   | Verified (re-run)            |
| 14  | Lint gaps: warnings don't fail; canary download size; shadowing pitfall                        | Medium   | Reported                     |
| 15  | Bun auto-installs missing packages at runtime                                                  | Medium   | Reported (docs)              |
| 16  | Smaller data-layer items (overflow guard, transaction mode, durability, ordering, upsert)      | Low      | Verified (code) / Reported   |
| 17  | Smaller test items (exact counts, discovery, `toStrictEqual` gaps, `fetch` stub types)         | Low      | Verified (re-run) / Reported |
| 18  | Tooling and deployment-note gaps (version pinning, CI trigger, `NODE_ENV`, `bun install`)      | Low      | Reported                     |

Things the reviewers confirmed are fine are listed at the end.

---

## 1. Bun `fetch` follows proxy environment variables (High)

**Summary.** With `HTTP_PROXY` set, Bun's `fetch` sent a request for `http://203.0.113.9/` to the
proxy instead of the pinned IP. Passing `proxy: ""` did not stop it; deleting the environment
variable did. (Re-run output: `HTTP_PROXY set: status 502 | proxy hits=1`,
`proxy:'' option: … hits=2`, `after delete env: … hits=2`.)

- `HTTPS_PROXY`, `ALL_PROXY` and the lowercase forms are also honored, per the reviewer.
- `NO_PROXY` did not bypass it.
- Loopback targets skip the proxy, so the planned loopback tests would never catch this.

**Why it matters.** The current undici transport ignores proxies, and `public_fetch.ts` documents
that guarantee. With a proxy in the environment, the proxy makes the outbound connection, so Haru's
IP checks no longer decide where the connection goes. Developer machines and some hosts set these
variables. This sandbox does.

**Options.**

- **A.** Delete the proxy variables from `process.env` at startup. One line. Discord and OpenAI
  calls also lose proxy support, which is fine unless a deployment needs a proxy.
- **B.** Refuse to start if any proxy variable is set. Safer, but more disruptive for development.
- **C.** Replace `fetch` with `node:https` and a custom DNS lookup (option C from the earlier
  research), which does not read proxy variables. More code to re-validate.

**Recommendation.** A, plus a test that the variables are absent after startup, plus a note in the
plan's "Link transport" row.

```ts
// main.ts, before anything calls fetch
const PROXY_VARIABLES = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
];
for (const name of PROXY_VARIABLES) delete process.env[name];
```

---

## 2. `clearPending` must rotate the turn token (High)

**Summary.** The plan says clearing a pending request "keeps the token". Today `clearPending` writes
a **new** token with `reset: true`, with the comment "Leave a new generation behind so
already-running sessions cannot restore the request"
(`src/features/discord_actions/mod.ts:291-300`). If the token is kept, a model call already running
when the user says "never mind" or `\reset` can still pass the token check and write its
clarification back. The reviewer reproduced this.

**Options.**

- **A.** Rotate the token in `clearPending`, as today.
- **B.** Keep the token and add a generation counter that increments on every write. More complex,
  no benefit.

**Recommendation.** A. Fix the plan text. `clearPending` also has to create the row if missing and
keep today's "ignore older message" early return.

```sql
INSERT INTO discord_action_turns
  (guild_id, channel_id, user_id, turn_token, message_id, is_reset, pending, pending_expires_at, expires_at)
VALUES (?, ?, ?, ?, ?, 1, NULL, NULL, ?)
ON CONFLICT (guild_id, channel_id, user_id) DO UPDATE SET
  turn_token = excluded.turn_token,
  message_id = excluded.message_id,
  is_reset = 1,
  pending = NULL,
  pending_expires_at = NULL,
  expires_at = excluded.expires_at;
```

---

## 3. The `once` claim loses its turn check and atomic event-guard claim (High)

**Summary.** The plan maps `once` to "claim `state = 'pending'`, failing if a row exists". The
current claim (`mod.ts:255-262`) checks three things in one commit:

1. no operation row exists for this message and action;
2. the event guard (creation fingerprint or cancellation) is absent or unchanged;
3. the session's turn is still current.

Without (3), a session replaced by `\reset` or a newer message during earlier awaits can still claim
and perform the Discord write. Without (2) inside the same transaction, a guard conflict could leave
a stuck `pending` operation that blocks that message forever.

There is also a read-await-write sequence the plan doesn't cover: `once` reads the fingerprint,
awaits `listScheduledEvents`, then deletes the fingerprint only if it is unchanged
(`mod.ts:230-245`). `discord_event_guards` has no version column to compare.

**Options.**

- **A.** One claim transaction covering all three checks. Delete a stale guard with
  `WHERE … AND state = 'done' AND result = ?`, comparing the JSON read earlier.
- **B.** Same, but add `revision INTEGER` to `discord_event_guards` and compare it instead of the
  JSON text.

**Recommendation.** B. A revision column is clearer than comparing JSON text. Document the claim and
completion steps in the plan.

```ts
type Claim = "claimed" | "already" | "superseded" | "guard_conflict";

const claim = db.transaction(
  (turn: TurnKey, token: string, op: OperationKey, guard?: GuardClaim): Claim => {
    const current = db
      .query(
        `SELECT 1 FROM discord_action_turns
     WHERE guild_id = ? AND channel_id = ? AND user_id = ? AND turn_token = ? AND expires_at > ?`,
      )
      .get(turn.guildId, turn.channelId, turn.userId, token, now());
    if (!current) return "superseded";

    const inserted = db
      .query(
        `INSERT INTO discord_action_operations (guild_id, message_id, action, state, updated_at)
     VALUES (?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING`,
      )
      .run(op.guildId, op.messageId, op.action, now());
    if (inserted.changes !== 1) return "already";

    if (guard) {
      const guarded = db
        .query(
          `INSERT INTO discord_event_guards (guild_id, kind, guard_key, state, revision, updated_at)
       VALUES (?, ?, ?, 'pending', 1, ?)
       ON CONFLICT DO UPDATE SET state = 'pending', revision = revision + 1, updated_at = excluded.updated_at
       WHERE discord_event_guards.revision = ?`,
        )
        .run(guard.guildId, guard.kind, guard.key, now(), guard.expectedRevision ?? -1);
      if (guarded.changes !== 1) throw new GuardConflict(); // rolls back the operation insert
    }
    return "claimed";
  },
);

// Run with claim.immediate(...) and map GuardConflict to the existing "already in progress" message.
```

Completion stays one transaction: the operation becomes `done` with its result, and the guard
becomes `done` if `result.ok || result.uncertain`, otherwise it is deleted. A failure to record
completion keeps the claim, as today (`mod.ts:281-285`).

---

## 4. One `expires_at` merges two lifetimes (High)

**Summary.** Today the turn token and the pending clarification are separate keys, each with its own
20-minute expiry:

- every mention refreshes the turn (`mod.ts:347-353`);
- only `ask()` writes the clarification, with its own expiry (`mod.ts:460`).

With one `expires_at` on the merged row, every mention would extend an old clarification. Its stored
`content` is used as the authorization origin (`mod.ts:402-415`), so an old request could stay
actionable indefinitely. Today it expires 20 minutes after the question.

**Options.**

- **A.** Add `pending_expires_at`. Only `ask()` sets it. Turn creation drops `pending` once it has
  expired.
- **B.** Keep one column. Simpler, but changes how long an authorization lives.

**Recommendation.** A, which keeps today's behavior. Every read of the token or the pending request
must also filter on its expiry column.

```sql
ALTER TABLE discord_action_turns ADD COLUMN pending_expires_at INTEGER;
-- (In the plan, this goes into migration 1 rather than an ALTER.)

-- ask(): write the clarification only if this session is still current.
UPDATE discord_action_turns
SET pending = ?, pending_expires_at = ?
WHERE guild_id = ? AND channel_id = ? AND user_id = ? AND turn_token = ? AND expires_at > ?;
-- changes must be 1, otherwise throw "superseded".

-- Turn creation: keep an unexpired clarification, drop an expired or abandoned one.
-- pending = CASE WHEN :drop = 1 OR pending_expires_at <= :now THEN NULL ELSE pending END
```

---

## 5. Slices 2 and 3 cannot run; imports cross slice boundaries (High)

**Summary.**

- **Deno can't load ported code.** Once slice 2 moves storage to `bun:sqlite`, Deno can no longer
  load anything that imports it (`Unsupported scheme "bun"`). The plan keeps a Deno CI job "over
  unported files", but about 90 unported tests import those modules (`bot_actions*`,
  `scheduler.autonomous`, `autonomous_chat`, `scripts/*`). They would run nowhere until slices 4-5.
- **The bot can't start.** `main.ts` can start under neither runtime from slice 2 until slice 4, yet
  the plan promises a runnable state per slice.
- **Slice 1 imports Deno-typed code.** `turns.test.ts` imports `isNewerHumanMessage` from
  `storage.ts` through `autonomous_chat/mod.ts:8`. `bun check` follows imports and fails on
  `Deno.Kv` types.
- **`poll_collection.test.ts` needs slice 4.** It replaces `Deno.cron` (lines 41-53) and imports the
  scheduler and server, but it is assigned to slice 2. The plan lists only two such test files;
  there are three.
- **One test file has no slice.** `autonomous_chat.test.ts` (11 tests) isn't assigned to any slice.

**Options.**

- **A.** Reorder so that each slice's imports are already ported, and the bot becomes runnable in
  one slice. Keep Deno CI only while unported code still loads.
- **B.** Drop the per-slice "runnable" promise. Gate slices 2-3 on `bun check` and tests only.
- **C.** Keep Deno-compatible shims for moved modules. Too costly.

**Recommendation.** A, with honest gates. The proposed order is in the
[revised slice order](#proposed-revised-slice-order) section.

```ts
// Slice 1: move the pure helper out of storage.ts so slice-1 tests don't import Deno-typed code.
// src/features/autonomous_chat/watermark.ts
export function isNewerHumanMessage(candidate: Watermark, previous: Watermark): boolean {
  /* unchanged */
}
```

---

## 6. A throwing `Bun.cron` handler kills the process (High)

**Summary.** Re-run: an async handler that throws ended the process with exit code 1 on its first
run. Bun's docs say a thrown error becomes `uncaughtException` or `unhandledRejection`, and with no
listener the process exits. The five existing jobs already wrap their bodies in `try/catch`, but the
planned maintenance job runs synchronous SQLite deletes that can throw (`SQLITE_BUSY`,
`SQLITE_FULL`). One failure would take down the gateway, the HTTP server and every other job.

**Options.**

- **A.** The production cron registrar wraps every handler in `try/catch` and logs.
- **B.** Also add process-level handlers. Catches other leaks but can hide fatal states.
- **C.** Rely on systemd restarts. That becomes a crash loop if the failure persists.

**Recommendation.** A, plus a test that a throwing handler does not escape the registrar. If B is
added, make it log and exit non-zero rather than swallow.

```ts
export type CronRegistrar = (
  name: string,
  schedule: string,
  handler: () => Promise<void> | void,
) => void;

export const bunCron: CronRegistrar = (name, schedule, handler) => {
  Bun.cron(
    schedule,
    async () => {
      try {
        await handler();
      } catch (error) {
        console.error(`[CRON] ${name} failed:`, error);
      }
    },
    { tz: "UTC" },
  );
};
```

---

## 7. Test conversion rules give false greens and break type narrowing (High)

**Summary.**

- **`toThrow` ignores its second argument.** The plan maps `assertRejects(fn, Class, "msg")` to
  `rejects.toThrow(...)` "checking both class and message", but Bun's `toThrow(Class, "msg")`
  silently ignores the message. Re-run: a test expecting message `"zzz"` passed when the error said
  `"boom"`.
- **Some tests use the returned error.** There are 46 `assertRejects` and 12 `assertThrows` calls.
  14 sites read the returned error (`error.status`, `error.retryAfter` …), which `expect` does not
  return.
- **`assert(x)` narrows types; `expect` doesn't.** About a dozen `assert(result.ok)` calls narrow
  types for the next lines. Replacing them with `expect(...).toBeTruthy()` produces `bun check`
  errors.

**Options.**

- **A.** A small test helper module with `rejects`, `throws` and `assert` that check class and
  message, return the typed error, and narrow types.
- **B.** Inline `.catch((e) => e)` plus separate `toBeInstanceOf` and `toContain` checks at every
  site.
- **C.** Use `node:assert` for `assert`, `rejects` and `throws`. It's built in, but its message
  matching differs (regex or validation object).

**Recommendation.** A. It is mechanical, type-safe, and keeps the conversion diff small.

```ts
// test_support/assert.ts
import { expect } from "bun:test";

type ErrorClass<T extends Error> = abstract new (...args: never[]) => T;

export function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

export async function rejects<T extends Error>(
  run: () => Promise<unknown>,
  ErrorType: ErrorClass<T>,
  messageIncludes?: string,
): Promise<T> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ErrorType);
    if (messageIncludes !== undefined) expect((error as Error).message).toContain(messageIncludes);
    return error as T;
  }
  throw new Error(`Expected ${ErrorType.name} to be thrown`);
}

export function throws<T extends Error>(
  run: () => unknown,
  ErrorType: ErrorClass<T>,
  messageIncludes?: string,
): T {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ErrorType);
    if (messageIncludes !== undefined) expect((error as Error).message).toContain(messageIncludes);
    return error as T;
  }
  throw new Error(`Expected ${ErrorType.name} to be thrown`);
}
```

---

## 8. `Bun.serve` returns a stack-trace page in production (Medium)

**Summary.** Re-run: with `NODE_ENV` unset, a handler that throws returns a 500 with a 50 KB HTML
page containing the error, source and file paths. With `NODE_ENV=production`, it returns 21 bytes.
The systemd unit doesn't set `NODE_ENV`. Admin routes are token-protected, but any throw after
authentication would expose source paths.

**Options.**

- **A.** `development: false` plus an `error()` handler in code.
- **B.** `NODE_ENV=production` in the unit.
- **C.** Both.

**Recommendation.** C. The code setting makes it safe regardless of environment.

```ts
return Bun.serve({
  port: 8000,
  development: false,
  idleTimeout: 120, // see issue 10
  fetch: handler,
  error(error) {
    console.error("[SERVER] Unhandled error:", error);
    return new Response("Internal Server Error", { status: 500 });
  },
});
```

---

## 9. Test runner differences from Deno (Medium)

**Summary.** Re-run on Bun 1.4.4:

- **Default timeout is 5 s.** `usage.test.ts` "aborts stalled provider requests" takes 15 s
  (`TIMEOUT_MS = 15_000` in `usage.ts:44`) and fails. `[test] timeout` in `bunfig.toml` was ignored.
  `setDefaultTimeout()` in a preload file and `--timeout` both work.
- **`.env` is loaded into tests.** A `.env` value appeared in `bun test`. Deno tests didn't read
  `.env`. A developer's real tokens would reach tests.
- **Globals leak between test files.** A global set in one file was visible in the next. Deno
  isolates files. 11 test files replace `globalThis.fetch`, some without restoring it on failure.
- **No network guard.** Deno tests run without `--allow-net`, so an unstubbed `fetch` fails. Under
  Bun it would make a real call.

`--isolate` and `--no-env-file` were confirmed to fix the leak and the `.env` loading.

**Recommendation.** One preload file plus flags in the test script. Also make `TIMEOUT_MS` in
`usage.ts` injectable so the test doesn't need 15 s.

```toml
# bunfig.toml
[test]
preload = ["./test_support/setup.ts"]
```

```ts
// test_support/setup.ts
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(20_000);

const blockedFetch = (input: RequestInfo | URL) => {
  throw new Error(`Unstubbed network request: ${String(input)}`);
};
globalThis.fetch = Object.assign(blockedFetch, { preconnect() {} }) as typeof fetch;
```

```json
"test": "bun test --isolate --no-env-file"
```

---

## 10. `Bun.serve` closes requests idle for 10 seconds (Medium)

**Summary.** Bun's docs: connections with no data for `idleTimeout` seconds (default 10) are closed,
including requests still being handled. The reviewer saw a 15-second handler cut off at about 10 s.
`/trigger_poll`, `/trigger_stats` and `/trigger_collect` loop over channels with Discord calls and
retries, and can exceed 10 s. The caller would see a dropped connection while the work continues.
`Deno.serve` has no such limit.

**Recommendation.** `idleTimeout: 120` (shown in issue 8), and a smoke-test item: a handler over 10
s completes.

---

## 11. Formatting plan is inconsistent (Medium)

**Summary.**

- **Prettier churn.** `bun fmt` produces Prettier output. Per the reviewer, it changes 65 of 89
  files, about 5,600 lines. The plan checks `bun fmt --check` on ported files each slice but
  reformats the repo only in slice 6. Every ported file would get formatting changes mixed into its
  logic diff, and `deno fmt --check` would fail on them while the Deno job still runs.
- **Config names.** Option names are Prettier's (`printWidth`, `tabWidth`); Deno's names
  (`lineWidth`) are rejected.
- **Markdown wrapping.** `proseWrap` is missing. Deno uses `"always"`, so Markdown would stop being
  wrapped.
- **Script hijack.** Bun's docs: if `package.json` has a `fmt` script, `bun fmt` runs that script. A
  wrong `fmt` script makes `bun fmt --check` falsely pass.

**Recommendation.** Do one repo-wide `bun fmt` commit at the start of slice 0, list it in
`.git-blame-ignore-revs`, and remove the Deno job's `deno fmt --check` in the same commit. Define
`"fmt": "bun fmt"` and `"fmt:check": "bun fmt --check"` exactly.

```toml
[fmt]
printWidth = 100
tabWidth = 2
useTabs = false
singleQuote = false
proseWrap = "always"
```

---

## 12. Weekly stats drop or duplicate a day across DST (Medium)

**Summary.** `getStats` builds its days from `new Date("YYYY-MM-DD")` (UTC midnight) but steps with
local-time `setDate(getDate() + 1)` (`storage.ts:165-177`). The scheduler does the same at
`scheduler.ts:132`. Re-run with `TZ=America/Los_Angeles`: the range 2025-10-29 to 2025-11-04 lost
2025-11-04. Votes on a missing day are silently left out of the weekly summary. Harmless when the
process runs in UTC, as production does, but the bug carries over.

**Options.** Step in UTC (`setUTCDate`/`getUTCDate`), or generate the days in SQL.

**Recommendation.** Step in UTC (a one-line fix in both places), plus a test run with
`TZ=America/Los_Angeles`.

```ts
current.setUTCDate(current.getUTCDate() + 1);
```

---

## 13. Transport request details (Medium)

**Summary.** Re-run:

- **No `Accept-Encoding`.** With `decompress: false`, Bun sends none. Today's request sends
  `gzip, deflate, br`. By default Bun sends `gzip, deflate, br, zstd`, and Haru rejects `zstd`.
- **Runtime-revealing user agent.** Bun adds `User-Agent: Bun/1.4.4`, which undici didn't send. It
  tells arbitrary user-supplied sites the runtime and version.
- **IP-literal SNI.** A `serverName` that is an IP literal sends no SNI, which is correct. Don't
  rely on that detail; omit `serverName` when the original host is an IP literal.
- **Not testable here.** IPv6 couldn't be tested end to end in this sandbox (no IPv6).

**Recommendation.** Set the headers explicitly and omit `serverName` for IP hosts. The reviewer's
prototype passed gzip, deflate, br, identity, corrupt gzip, zstd rejection, a 400 MB gzip bomb
(stopped at 1 MB) and stalled streams.

```ts
const response = await fetch(target, {
  method: "GET",
  redirect: "manual",
  decompress: false,
  keepalive: false,
  signal,
  headers: {
    Host: url.host,
    Accept: "text/html,application/xhtml+xml",
    "Accept-Encoding": "gzip, deflate, br",
    "User-Agent": "HaruBot/1.0",
  },
  tls: { ca, rejectUnauthorized: true, ...(isIP(hostname) ? {} : { serverName: hostname }) },
});
```

DNS notes for the plan:

- **Behavior changes, all safe because every address is checked.** A broken AAAA record now falls
  back to IPv4 instead of failing. Bun caches lookups, including failures. The c-ares backend reads
  `/etc/hosts`.
- **Cancellation.** The deadline race was confirmed to reject at the deadline, and the abandoned
  lookup caused no unhandled rejection afterwards.

---

## 14. Lint gaps (Medium)

**Summary.** Reported from docs and experiments:

- **Warnings don't fail.** `bun lint` exits non-zero only on errors, and unused code is a warning by
  default. `deno lint` treated unused variables as errors.
- **Download size.** `bunx bun@<canary> lint` works, but it downloads a roughly 100 MB binary unless
  the Bun cache is kept.
- **Shadowing.** Do not add the canary as a dev dependency. Its binary would shadow `bun` inside
  every `bun run` script, so tests and formatting would run on the canary.
- **No exact-canary pin in CI.** `setup-bun` can't pin an exact canary, only "latest canary".

**Recommendation.**

```json
"lint": "bunx bun@1.4.4-canary.20261104.1 lint --max-warnings 0"
```

In CI, cache `~/.bun/install/cache`. Compare `deno lint` and `bun lint` output on `master` once in
slice 0.

---

## 15. Bun auto-installs missing packages at runtime (Medium)

**Summary.** Per the reviewer and Bun's docs: with no `node_modules`, Bun downloads missing packages
when the program runs, ignoring the lockfile. A deploy that forgets `bun install` would install
unpinned versions, on a box where the service's home directory is read-only.

**Recommendation.** Disable it, and add `bun install --frozen-lockfile --production` to the
deployment notes as the replacement for `deno cache`.

```toml
[install]
auto = "disable"
```

---

## 16. Smaller data-layer items (Low)

| Item                                                                                                                               | Recommendation                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens = tokens + ?` can't check for overflow, and SQLite silently exceeds JavaScript's safe-integer limit                        | Add `CHECK (tokens <= 9007199254740991 AND requests <= 9007199254740991)` and map the error to today's `RangeError`.                           |
| Bun's `db.transaction()` defaults to deferred, which fails immediately with `SQLITE_BUSY` if a second connection writes in between | Run read-check-write transactions with `.immediate()`, and share one `Database` handle across all services, as the tests already share one KV. |
| `synchronous = NORMAL` can lose the last commits on power loss, which matters for the "claim before a Discord write" guarantee     | Use `synchronous = FULL`. Write volume is tiny.                                                                                                |
| Deno KV listed rows in key order, and tests compare arrays                                                                         | Add `ORDER BY` to match: `user_id` for at-risk users, `message_id` for polls.                                                                  |
| `savePendingPoll` overwrote an existing record                                                                                     | Use `INSERT … ON CONFLICT DO UPDATE`, not a plain `INSERT`.                                                                                    |
| Poll collection tests inject failures into `recordVote` and `markPollCollected` separately                                         | Keep the per-call storage interface.                                                                                                           |
| Polls posted in the 24 hours before cutover won't be collected                                                                     | Note it in the deployment notes (accepted with "start fresh").                                                                                 |

---

## 17. Smaller test items (Low)

| Item                                                                                                                                                                                                                     | Recommendation                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Exact baseline: Deno reports 543 tests (100 steps); per-file totals of tests plus steps are 643 over 33 files. Transport is 17 tests (28 steps). After splitting steps into tests, Bun should report exactly 630 and 35. | Put exact expected counts in the baseline and fail on mismatch.                                                                         |
| `bun test tests/` finds nothing: `*.integration.ts` doesn't match Bun's test file pattern. A misspelled file argument is silently ignored.                                                                               | List integration files explicitly in `test:transport` and check the count.                                                              |
| `toStrictEqual` differs from `assertEquals` on `Error` objects, arrays with extra properties, typed arrays, `-0` and invalid dates. One repo site is affected (`public_fetch.test.ts:327`, comparing a `DOMException`).  | Use `toBe` there. Extend the slice 0 parity check to these cases.                                                                       |
| `@types/bun` types `fetch` with a required `preconnect`, so 16 stubs fail `bun check`.                                                                                                                                   | Type injected fetchers as `(input: RequestInfo \| URL, init?: RequestInit) => Promise<Response>` in `usage.ts` and `discord_events.ts`. |
| Clearing a variable with `process.env.X = undefined` stores the string `"undefined"`.                                                                                                                                    | Conversion rule: use `delete process.env.X`.                                                                                            |
| Integration tests also use `Deno.serve`, `Deno.listen` and `Deno.Conn`, which the plan doesn't list. A test comment notes a Deno-specific Brotli quirk.                                                                  | Add them to slice 3. Use `Bun.serve` or `node:net`, and re-validate the Brotli case.                                                    |
| The plan's assertion count says about 1,600; it's 1,498.                                                                                                                                                                 | Fix the number.                                                                                                                         |

---

## 18. Tooling and deployment-note gaps (Low)

| Item                                                                                                                                           | Recommendation                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bun doesn't enforce `engines` or `packageManager`; only `setup-bun` reads `packageManager`                                                     | Make `packageManager: "bun@1.4.4"` the single source for CI, with no separate version in the workflow.                                                                                        |
| CI only runs on pushes to `master` and `feat/aws-hosting`                                                                                      | Add `feat/bun` to the push trigger in slice 0, or open a draft PR early.                                                                                                                      |
| Bun loads `.env`, `.env.local` and `.env.*` by default; `.gitignore` covers only `.env`                                                        | Set `env = false` in `bunfig.toml`, pass `--env-file=.env` in the `start` and `dev` scripts, and ignore `.env*`.                                                                              |
| Deployment notes are missing settings                                                                                                          | Add `NODE_ENV=production` and `bun install --frozen-lockfile --production`. Check that the instance's `sqlite3` CLI is 3.37+ for `STRICT` tables. Use `bun run main.ts`, not `bun run start`. |
| The gateway IDENTIFY message says `"deno"` (`discord_gateway.ts:110-112`)                                                                      | Change it to `"bun"`.                                                                                                                                                                         |
| Two existing gateway quirks, unrelated to the port: a heartbeat timer isn't cleared on reconnect, and fatal close codes (4004) still reconnect | Track them separately.                                                                                                                                                                        |

---

## Proposed revised slice order

This addresses issues 5, 9 and 11. Each slice only imports code that is already ported, and the bot
becomes runnable at slice 3.

| Slice | Content                                                                                                                                                                               | Gate                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 0     | Scaffolding, repo-wide `bun fmt` commit, test support (helpers, preload, flags), `feat/bun` CI trigger, exact baseline. The Deno job loses only its `fmt` step.                       | Tooling green; baseline recorded                                         |
| 1     | Pure modules and environment variables. Move `isNewerHumanMessage` out of `storage.ts`. Includes `autonomous_chat.test.ts`.                                                           | `bun check` and tests for the ported files; Deno job still runs the rest |
| 2     | Link transport and DNS (no storage dependencies), including integration tests and proxy stripping.                                                                                    | Transport suite (35 tests)                                               |
| 3     | Data layer **plus** cron registrar, `Bun.serve`, `main.ts`, and every test that imports them (`bot_actions*`, `scheduler.autonomous`, `poll_collection`, `server`). Deno job removed. | Full suite apart from scripts; first local smoke run                     |
| 4     | Scripts.                                                                                                                                                                              | Dry runs                                                                 |
| 5     | Remove Deno, README, final CI.                                                                                                                                                        | Full suite (exact counts), smoke run repeated                            |
| 6     | Pull request.                                                                                                                                                                         | —                                                                        |

---

## Confirmed fine

- **Data model.** The schema loads; votes, polls, rate limiting and autonomous participation map
  correctly to single transactions; the glue-streak logic and retention windows are sound;
  `bun:sqlite` rows compare equal to plain objects in tests.
- **Transport.**
  - `Host` override is respected over HTTP and HTTPS, with or without a port.
  - TLS verifies against `serverName`, and a wrong name is rejected.
  - Connections are not shared across different server names.
  - `redirect: "manual"` returns the real 3xx response.
  - 204 and 304 responses have no body and no error.
  - Abort works during connect, headers and body.
  - Body cancellation closes the socket.
  - Malformed responses fail cleanly.
  - `link_open.ts` relies on nothing undici-specific.
- **Runtime.**
  - Cron: `Bun.cron` supports `SUN`, doesn't overlap runs, and `{ tz: "UTC" }` keeps the schedules
    correct.
  - Server and shutdown: `Bun.serve` binds all interfaces on port 8000 like `Deno.serve`; SIGTERM
    behaves as before.
  - Gateway: WebSocket close codes and reconnects work.
  - Tooling: `bun check` follows the proposed `tsconfig.json`, and a leftover `Deno` reference is
    caught as a type error.
  - Lint: the `[lint.rules]` placement is correct.
- **Tests.** All 23 `t.step` uses are independent loops, safe to convert to `describe`; tests in a
  file run in order.
