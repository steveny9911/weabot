# Bun Migration Plan

Port Haru from Deno to Bun on branch `feat/bun`. Behavior seen in Discord stays the same, with two
accepted exceptions listed under [Behavior changes](#behavior-changes). Storage moves from Deno KV
to a new SQLite data model, and the bot starts with an empty database.

Status: **ready to implement**. Base: `master` at `59535bf`. This revision applies every finding in
[`bun-migration-review.md`](bun-migration-review.md) and the simplified data model agreed on
2026-11-05.

## Guiding principle

**Everything the bot does on Bun must behave the same as it did on Deno before the migration.** Deno
itself is being removed, so Deno runtime concerns (permission flags, Deno-only workarounds, keeping
Deno able to run the bot) get no effort. The Deno test job keeps running only as the behavior
reference for code that has not been ported yet. Any Bun-side behavior difference is either fixed or
listed under [Behavior changes](#behavior-changes) as an explicit decision.

## Decisions

| Topic                | Decision                                                                                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime              | Bun 1.4.4. `packageManager: "bun@1.4.4"` is the single version source for CI (`oven-sh/setup-bun` reads it). `engines.bun: "~1.4.4"` documents the 1.4.x range; Bun itself does not enforce either field.                                                                            |
| Dependencies         | Built-in Bun and `node:` APIs first. Runtime dependencies: only the official AWS SDK (`@aws-sdk/client-cost-explorer@^3`, `@smithy/credential-provider-imds@^4`). Dev dependency: `@types/bun@^1`. Runtime auto-install is disabled.                                                 |
| Discord gateway      | Global `WebSocket`, unchanged. The IDENTIFY properties change from `"deno"` to `"bun"`.                                                                                                                                                                                              |
| Database             | `bun:sqlite`, seven tables for data that must survive a restart (see [Data model](#data-model)).                                                                                                                                                                                     |
| In-memory state      | Per-user per-minute AI request counts, Discord action turn tokens and pending clarifications. All are short-lived and only coordinate work inside the running process.                                                                                                               |
| Data                 | Start fresh. No migration from Deno KV.                                                                                                                                                                                                                                              |
| Scheduled jobs       | In-process `Bun.cron(schedule, handler, { tz: "UTC" })` through a registrar that catches and logs handler errors.                                                                                                                                                                    |
| HTTP server          | `Bun.serve` with `development: false`, `idleTimeout: 120` and an `error()` handler.                                                                                                                                                                                                  |
| DNS for link checks  | `Bun.dns.lookup(hostname, { backend: "c-ares" })`, injected, raced against the link deadline.                                                                                                                                                                                        |
| Link transport       | Bun `fetch` to the validated IP literal, with explicit `Host`, `Accept`, `Accept-Encoding` and `User-Agent` headers, and `tls.serverName` only when the original host is a name.                                                                                                     |
| Proxy variables      | Deleted from `process.env` at startup, because Bun's `fetch` would otherwise route link requests through them and bypass IP pinning.                                                                                                                                                 |
| Tests                | `bun:test`, run with `--isolate`, a preload that blocks unstubbed network calls and sets a 20 s default timeout, and helpers for `assert`, `rejects` and `throws`.                                                                                                                   |
| Environment files    | `env = false` in `bunfig.toml`. `start` and `dev` pass `--env-file=.env` explicitly, as Deno's `--env` did. Tests never read `.env`.                                                                                                                                                 |
| Format               | `bun fmt` (Prettier-compatible), applied to the whole repo in one commit in slice 0.                                                                                                                                                                                                 |
| Type check           | `bun check`.                                                                                                                                                                                                                                                                         |
| Lint                 | `bunx bun@1.4.4-canary.20261104.1 lint --max-warnings 0`, because `bun lint` is canary-only in 1.4.4. CI caches the Bun install cache. Switch to stable `bun lint` when it ships. Never add the canary as a dependency: its binary would shadow `bun` inside every `bun run` script. |
| Layout               | Unchanged (root-level `main.ts`, `ai_service.ts`, `bot_actions.ts`, `discord_gateway.ts` stay).                                                                                                                                                                                      |
| Scripts              | All ported.                                                                                                                                                                                                                                                                          |
| Deployment           | Out of scope. See [Deployment notes](#deployment-notes-for-later).                                                                                                                                                                                                                   |
| `master` during port | No new code lands on `master` until `feat/bun` merges.                                                                                                                                                                                                                               |

### Behavior changes

Accepted on purpose:

1. **A pending clarification is forgotten on restart.** If Haru asked "what time should the event
   start?" and the bot restarts before the user answers, the user repeats the request. Restarts only
   happen on deploys.
2. **A restart resets the per-minute AI request counts.** At most one extra minute of allowance. The
   daily token budget is persisted and unaffected.

Side effects of the new runtime, all safe because every address is validated before connecting:

- **Partial DNS failure.** A host whose AAAA (IPv6) lookup fails but whose A (IPv4) lookup succeeds
  now opens over IPv4 instead of failing.
- **DNS caching.** Bun caches lookups, so a DNS change can take effect slightly later.
- **`/etc/hosts`.** Lookups read `/etc/hosts`.

Fixed bug: weekly stats no longer drop or duplicate a day across a DST change when the process runs
in a non-UTC time zone.

## What changes, by file

| File                                                     | Change                                                                                                                                                | Slice |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `src/config.ts`, `ai_service.ts`                         | `Deno.env.get` becomes `process.env`                                                                                                                  | 1     |
| `src/services/usage.ts`                                  | `process.env`; drop the Deno `--allow-sys` user-agent workaround; inject the 15 s timeout; type the injected fetcher without `typeof fetch`           | 1     |
| `src/services/discord_events.ts`                         | Replace the one constructor parameter property; type the injected fetcher without `typeof fetch`                                                      | 1     |
| `src/types/storage.ts`                                   | Receives `StorageService`, `ContextStorageService` and `isNewerHumanMessage` from `storage.ts`, so slice 1 files no longer import a Deno-typed module | 1     |
| `src/services/public_fetch.ts`                           | `Bun.dns.lookup`; Bun `fetch` pinning; undici removed                                                                                                 | 2     |
| `src/runtime_env.ts` (new)                               | `stripProxyEnvironment()`                                                                                                                             | 2     |
| `src/db/*` (new)                                         | Database, migrations, queries                                                                                                                         | 3     |
| `src/services/storage.ts`, `src/services/rate_limit.ts`  | SQLite plus in-memory minute counter                                                                                                                  | 3     |
| `src/features/discord_actions/mod.ts` and new `state.ts` | In-memory turns, pending clarifications and per-guild lock; SQLite operation records and event guards                                                 | 3     |
| `src/scheduler.ts`                                       | Injected cron registrar; UTC date arithmetic; maintenance job                                                                                         | 3     |
| `src/server.ts`                                          | `Bun.serve`                                                                                                                                           | 3     |
| `main.ts`                                                | Strip proxy variables, open the database, start everything                                                                                            | 3     |
| `discord_gateway.ts`                                     | IDENTIFY properties `"bun"`                                                                                                                           | 3     |
| `scripts/**`                                             | `Bun.spawn`, `process.argv`, `process.cwd()`, `process.exitCode`, in-memory or sandbox databases                                                      | 4     |
| `deno.json`, `deno.lock`, `.vscode/`                     | Removed                                                                                                                                               | 5     |

## Data model

### What is stored where

| Data                                                         | Survives restart?                                                                           | Where                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | --------------------------- |
| Polls, votes                                                 | Yes                                                                                         | `polls`, `votes`            |
| `\reset` markers                                             | Yes                                                                                         | `context_resets`            |
| Autonomous chat watermark, cooldown, last reaction           | Yes. Stops Haru reacting to the same message again after a restart.                         | `autonomous_participation`  |
| Daily AI requests and tokens                                 | Yes. A restart must not reset the budget.                                                   | `ai_daily_usage`            |
| Discord action records (an action ran for a message)         | Yes. Stops an action from being repeated.                                                   | `discord_action_operations` |
| Discord event guards (same event created or cancelled twice) | Yes                                                                                         | `discord_event_guards`      |
| Per-user AI requests per minute                              | No                                                                                          | Memory                      |
| Discord action turn tokens                                   | No. They coordinate model calls inside this process, which do not survive a restart anyway. | Memory                      |
| Pending clarifications                                       | No (accepted, see Behavior changes)                                                         | Memory                      |

### Principles

- **One table per concept**, real columns, indexes, `STRICT` tables and `CHECK` constraints.
- **One shared `Database` handle** for the whole process, passed to every service.
- **Transactions instead of retry loops.** `bun:sqlite` is synchronous, so a read-check-write inside
  a transaction cannot interleave with other code. Read-check-write transactions run with
  `.immediate()`, so they also behave correctly if a second connection ever exists.
- **Never `await` inside a transaction.** Network calls happen between transactions.
- **Where a sequence must span an `await`** (checking Discord for an existing event before claiming
  a guard), it runs under an in-memory per-guild lock rather than version checks.
- **Discord IDs are `TEXT`.** Times are `INTEGER` milliseconds since the epoch (UTC). Calendar dates
  are `TEXT` `YYYY-MM-DD`.
- **Counters cannot exceed JavaScript's safe integer range** (enforced by `CHECK`).
- **List queries keep Deno KV's key order** with explicit `ORDER BY`, because tests compare arrays.
- **The service interfaces stay the same**, so callers do not change.

### Schema (migration 1)

```sql
CREATE TABLE polls (
  message_id    TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL,
  poll_date     TEXT NOT NULL,                  -- YYYY-MM-DD the poll is for
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  collected_at  INTEGER                         -- NULL until results are stored
) STRICT;
CREATE INDEX polls_uncollected ON polls (expires_at) WHERE collected_at IS NULL;

CREATE TABLE votes (
  channel_id   TEXT NOT NULL,
  vote_date    TEXT NOT NULL,                   -- YYYY-MM-DD
  user_id      TEXT NOT NULL,
  user_name    TEXT NOT NULL,                   -- display name at vote time
  mood         TEXT NOT NULL CHECK (mood IN ('umazing', 'ok', 'glue')),
  recorded_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, vote_date, user_id)
) STRICT;
CREATE INDEX votes_by_user ON votes (channel_id, user_id, vote_date DESC);

CREATE TABLE context_resets (
  channel_id  TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL,
  reset_at    INTEGER NOT NULL
) STRICT;

CREATE TABLE autonomous_participation (
  channel_id                 TEXT PRIMARY KEY,
  latest_human_message_id    TEXT NOT NULL,
  latest_human_timestamp_ms  INTEGER NOT NULL,
  attempted_at               INTEGER NOT NULL,
  last_reaction_emoji        TEXT
) STRICT;

CREATE TABLE ai_daily_usage (
  usage_date  TEXT PRIMARY KEY,                 -- YYYY-MM-DD (UTC)
  requests    INTEGER NOT NULL DEFAULT 0 CHECK (requests BETWEEN 0 AND 9007199254740991),
  tokens      INTEGER NOT NULL DEFAULT 0 CHECK (tokens BETWEEN 0 AND 9007199254740991)
) STRICT;

-- An action requested by one Discord message runs at most once.
CREATE TABLE discord_action_operations (
  guild_id    TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  action      TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  result      TEXT CHECK (result IS NULL OR json_valid(result)),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (guild_id, message_id, action)
) STRICT;

-- The same event is not created twice or cancelled twice, across messages.
CREATE TABLE discord_event_guards (
  guild_id    TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('creation_fingerprint', 'cancellation')),
  guard_key   TEXT NOT NULL,                    -- fingerprint hash or event ID
  state       TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  result      TEXT CHECK (result IS NULL OR json_valid(result)),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (guild_id, kind, guard_key)
) STRICT;
```

### Database setup and migrations

`openDatabase(path)` in `src/db/database.ts`:

- Sets `journal_mode = WAL`, `synchronous = FULL`, `foreign_keys = ON` and `busy_timeout = 5000`.
  `FULL` keeps the "claim before a Discord write" guarantee across power loss; write volume is tiny.
- Applies each migration newer than `PRAGMA user_version` in its own transaction, bumping
  `user_version`.
- Refuses to start if the database is newer than the code.
- The path comes from `HARU_DB_PATH`, defaulting to `./data/haru.sqlite3`. `":memory:"` is used for
  tests and sandbox scripts.

### In-memory state

`src/features/discord_actions/state.ts` holds three pieces of state.

**Turns.** A map from `(guild, channel, user)` to:

```ts
interface TurnState {
  token: string; // crypto.randomUUID(), replaced on every new turn and on clear
  messageId: string;
  isReset: boolean;
  expiresAt: number; // 20 minutes after the last turn write
  pending?: { request: PendingRequest; expiresAt: number }; // 20 minutes after ask()
}
```

The rules, the same as today:

- **New turn (`createSession`):** reject messages older than the stored message. Otherwise issue a
  new token, and drop `pending` if it has expired or the new message abandons or restates the
  request.
- **`clearPending`:** issue a **new** token, set `isReset`, and drop `pending`. Older messages are
  ignored.
- **`ask()`:** sets `pending` only if the session's token is still the stored token, with its own
  20-minute expiry.
- **`ensureCurrent()`:** checks that the stored token still equals the session's token and has not
  expired.
- **`finishPending()`:** drops `pending` only if the token still matches.
- **Expiry:** expired entries are ignored on read and removed by the maintenance job.

**Per-guild lock.** A small async mutex keyed by guild ID. Event actions (create and cancel) run
their whole "check guard, check Discord, claim, perform, record" sequence under it, so the
read-await-write in today's `once()` cannot race.

**Per-minute AI counter.** In `src/services/rate_limit.ts`, a map from `user` to
`{ minute, count }`. Old minutes are replaced on access.

### How each operation maps

| Operation                                                       | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordVote`                                                    | Upsert into `votes` on `(channel_id, vote_date, user_id)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `getUserHistory`                                                | `… WHERE channel_id = ? AND user_id = ? ORDER BY vote_date DESC LIMIT ?`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `getVotesForDate`                                               | `… WHERE channel_id = ? AND vote_date = ? ORDER BY user_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `getStats`                                                      | `GROUP BY vote_date, mood` over the range. Empty days are filled in code, stepping with `setUTCDate`.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `getConsecutiveGlueCount`                                       | Same JavaScript streak logic over the latest 30 votes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `getUsersAtRisk`                                                | `SELECT DISTINCT user_id … ORDER BY user_id`, then the streak logic per user.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `savePendingPoll`                                               | Upsert on `message_id`, resetting `collected_at` (today's `kv.set` overwrote the record).                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `getExpiredPolls`, `getAllPendingPolls`                         | `WHERE collected_at IS NULL [AND expires_at <= ?] ORDER BY message_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `markPollCollected`                                             | `UPDATE … SET collected_at = ?`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `claimAutonomousParticipation`, `finishAutonomousParticipation` | One immediate transaction: read, apply `isNewerHumanMessage` and the cooldown, upsert. The last reaction emoji is kept unless a new one is given.                                                                                                                                                                                                                                                                                                                                                                                   |
| `admitRequest`                                                  | Synchronously, with no `await` in between: check the in-memory minute count, read today's tokens, check both limits, then increment the minute count and `ai_daily_usage.requests`.                                                                                                                                                                                                                                                                                                                                                 |
| `recordTokenUsage`                                              | `INSERT … ON CONFLICT (usage_date) DO UPDATE SET tokens = tokens + ?`. A `CHECK` failure becomes today's `RangeError`.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Discord action `once`                                           | Under the per-guild lock for guarded event actions: (1) if an operation row exists, return its result; (2) if a `done` guard points to an event that is no longer active on Discord, delete the guard; (3) in one transaction, check the session's token, insert the `pending` operation and the `pending` guard; (4) perform the Discord call; (5) in one transaction, mark the operation `done`, and mark the guard `done` if `result.ok \|\| result.uncertain`, otherwise delete it. If step 5 fails, the claim stays, as today. |

### Retention

The hourly maintenance job deletes `ai_daily_usage` rows older than 30 days and expired in-memory
turn entries. All other tables keep their rows, as Deno KV did.

### Code layout

```
src/db/
  database.ts          openDatabase(), pragmas, migration runner
  migrations.ts        ordered SQL migrations
  votes.ts             votes and polls
  chat_state.ts        context resets, autonomous participation
  ai_usage.ts          ai_daily_usage
  discord_actions.ts   operations and event guards
  maintenance.ts       retention deletes
src/features/discord_actions/state.ts   turns, pending clarifications, per-guild lock
```

`src/types/storage.ts` keeps its exported record types. Its `odUserId` and `odUserName` field names
stay for the port; `src/db/votes.ts` maps them to `user_id` and `user_name`.

## Test conversion

### Support files (slice 0)

**`test_support/assert.ts`** provides:

- `assert(condition, message?)`, which keeps TypeScript narrowing;
- `rejects(run, ErrorClass, messageIncludes?)` and `throws(...)`, which check the class **and** the
  message and return the typed error.

Bun's own `toThrow(Class, message)` ignores the message, so it is not used for these.

```ts
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
// throws(): the same for synchronous functions.
```

**`test_support/setup.ts`** is preloaded through `bunfig.toml`. It sets a 20 s default timeout,
because `[test] timeout` in `bunfig.toml` is ignored in Bun 1.4.4. It also replaces `fetch` with a
function that throws on any unstubbed network call.

### Rules

| Deno                                                                              | Bun                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Deno.test(name, fn)`                                                             | `test(name, fn)`                                                                                                                                                                                                 |
| `t.step(name, fn)`                                                                | `describe(name, () => { for (...) test(...) })`. All 23 uses are independent loops. Bun cannot nest `test()` inside `test()`.                                                                                    |
| `assertEquals(a, b)`                                                              | `expect(a).toStrictEqual(b)`. Use `toBe` for identity checks such as the "DNS caller cancellation aborts and settles both pending address families" test in `public_fetch.test.ts` (comparing a `DOMException`). |
| `assertStringIncludes(s, x)`                                                      | `expect(s).toContain(x)`                                                                                                                                                                                         |
| `assert(x)`                                                                       | `assert(x)` from `test_support/assert.ts`                                                                                                                                                                        |
| `assertRejects(...)`, `assertThrows(...)`                                         | `rejects(...)`, `throws(...)` from `test_support/assert.ts`, keeping the returned error where it is used (14 sites)                                                                                              |
| `assertMatch`, `assertGreater`                                                    | `toMatch`, `toBeGreaterThan`                                                                                                                                                                                     |
| `Deno.openKv(":memory:")`                                                         | `openDatabase(":memory:")`, one handle shared by the services under test                                                                                                                                         |
| `Deno.env.set` / `delete`                                                         | `process.env.X = "..."` / `delete process.env.X`. Never assign `undefined`, which stores the string `"undefined"`.                                                                                               |
| Replacing `Deno.cron` (`scheduler.autonomous.test.ts`, `poll_collection.test.ts`) | Pass a fake cron registrar                                                                                                                                                                                       |
| Replacing `Deno.resolveDns` (`public_fetch.test.ts`)                              | Pass a fake lookup                                                                                                                                                                                               |
| `Deno.serve`, `Deno.listen`, `Deno.Conn` (integration tests)                      | `Bun.serve` (with an explicit `idleTimeout`) or `node:net`                                                                                                                                                       |
| Fetch stubs typed `typeof fetch`                                                  | Type injected fetchers as `(input: string \| URL \| Request, init?: RequestInit) => Promise<Response>` (`RequestInfo` is a DOM type that `@types/bun` does not provide)                                          |

**Tests tied to Deno KV are rewritten as behavior tests.** This covers `rate_limit.test.ts` and the
KV-inspecting parts of `storage.test.ts`, `poll_collection.test.ts` and
`discord_actions/mod.test.ts`. The behaviors covered:

- concurrent admissions never exceed the limit;
- token totals are never lost;
- an old session never overwrites a newer turn;
- an action never runs twice for a message;
- an event is never created twice.

### Exact counts

Deno on `master` reports 543 tests (100 steps) over 33 files, and 17 transport tests (28 steps).
After `t.step` groups become separate tests, Bun must report exactly:

- **630** tests for the 33 unit test files (643 Deno tests and steps, minus 13 step parents);
- **35** tests for the transport integration files (17 + 28, minus 10 step parents).

Rewritten tests may change these numbers. Every change is recorded in the table at the end, with the
behavior test that replaces it. A test script that silently skips a misspelled file must not pass,
so CI compares the reported counts.

## Slices

Each slice ends with:

```bash
bun install --frozen-lockfile
bun run fmt:check
bun run check
bun run lint
bun test --isolate <test files ported so far>
```

`bun check` follows every import, including type-only imports. A ported file must therefore not
import a module that still uses Deno; shared types and helpers move first.

### Slice 0: Scaffolding, formatting, test support, baseline

**Changes**

1. **Baseline first** (on `master`, before any change):
   - record per-file Deno test counts in `docs/bun-migration-baseline.txt`;
   - compare `deno lint` with `bun lint` (canary) output on `master`.
2. **`package.json`:**
   - `"type": "module"`, `packageManager: "bun@1.4.4"`, `engines.bun: "~1.4.4"`;
   - the AWS SDK dependencies and `@types/bun`;
   - scripts:

     ```json
     "start": "bun --env-file=.env main.ts",
     "dev": "bun --watch --env-file=.env main.ts",
     "test": "bun test --isolate",
     "test:transport": "bun test --isolate ./tests/public_fetch.integration.ts ./tests/link_open.integration.ts",
     "check": "bun check",
     "fmt": "bun fmt",
     "fmt:check": "bun fmt --check",
     "lint": "bunx bun@1.4.4-canary.20261104.1 lint --max-warnings 0"
     ```

   - the `agent:*` scripts are added in slice 4.
3. **`bunfig.toml`:**

   ```toml
   env = false

   [install]
   auto = "disable"

   [fmt]
   printWidth = 100
   tabWidth = 2
   useTabs = false
   singleQuote = false
   proseWrap = "always"

   [lint.rules]
   # defaults (ESLint and typescript-eslint recommended); adjust after the baseline comparison

   [test]
   preload = ["./test_support/setup.ts"]
   ```

4. **`tsconfig.json`:** `strict`, `noImplicitAny`, `noUnusedLocals`, `noUnusedParameters`,
   `noFallthroughCasesInSwitch`, `noImplicitReturns`, `allowImportingTsExtensions`,
   `module: "preserve"`, `moduleResolution: "bundler"`, `types: ["bun"]`, `noEmit`.
5. **`.gitignore`:** add `node_modules/`, `data/` and `.env*`.
6. **`test_support/assert.ts` and `test_support/setup.ts`**, with their own tests.
7. **One commit that runs `bun fmt` on the whole repo**, listed in `.git-blame-ignore-revs`. The
   same commit removes `deno fmt --check` from the Deno CI job, since Prettier's output differs from
   Deno's.
8. **CI:**
   - add `feat/bun` to the push trigger;
   - add a Bun job (`oven-sh/setup-bun` reading `packageManager`, ARM runner, cache
     `~/.bun/install/cache`);
   - keep the CloudFormation lint;
   - keep the Deno job (minus `fmt`) for unported files until slice 3.
9. **Assertion parity check** (throwaway test). Record where `toStrictEqual` and `assertEquals`
   disagree: `undefined` properties, class instances, `Date`, `Error`, typed arrays, `-0`, invalid
   dates.

**Verify**

- Every command in the slice checklist passes.
- CI prints Bun `1.4.4` and the canary version used for lint.
- The baseline file shows 33 files, 543 tests (100 steps), and 17 transport tests (28 steps).
- The lint comparison is recorded, and rules are adjusted so `bun lint` is at least as strict as
  `deno lint` was.

### Slice 1: Code without Deno APIs, plus environment variables

**Changes**

- `src/config.ts`, `ai_service.ts`, `src/services/usage.ts`: `process.env`.
- `usage.ts`: drop the `--allow-sys` workaround; inject `TIMEOUT_MS` so its test doesn't take 15 s;
  type the injected fetcher explicitly. Keep the environment-then-IMDSv2 credential chain.
- `discord_events.ts`: replace the constructor parameter property on `DiscordApiError`; type the
  injected fetcher explicitly.
- Move `StorageService`, `ContextStorageService` and `isNewerHumanMessage` into
  `src/types/storage.ts`. `storage.ts` re-exports them, and the Deno code is unchanged otherwise.
- Convert these tests:
  - `src/utils/retry`
  - `src/features/poll`, `stats`, `reaction_gif`, `reactions`, `chat_context`
  - `src/features/autonomous_chat/turns`, `autonomous_chat`
  - `src/features/discord_actions/time`
  - `src/services/discord`, `discord_events`, `web_search`, `reaction_context`, `usage`
  - `src/config`
  - `ai_service`, `ai_service.tools`

**Verify**

- The slice checklist passes for the converted files.
- Per-file counts match the baseline.
- The Deno job still passes for the remaining files.

### Slice 2: Link transport and DNS

**Changes**

- **In the same commit that adds the transport files to `deno.json` `exclude`**, replace the Deno
  `test:transport` task and the CI step "Verify pinned HTTP and TLS transport" with the Bun
  `test:transport` script. `deno test` exits 1 ("No test modules found") when it is given an
  excluded file explicitly.
- Injected fetchers use the `Fetcher` type (`src/types/fetch.ts`); `globalThis.fetch` stubs use
  `asFetch()` (`test_support/fetch.ts`).
- `src/runtime_env.ts`: `stripProxyEnvironment()` deletes `HTTP_PROXY`, `HTTPS_PROXY` and
  `ALL_PROXY` in both cases. It is called from `main.ts` in slice 3, and has a test now.
- `public_fetch.ts`, `resolveAddresses(hostname, signal, lookup = defaultLookup)`:
  - `defaultLookup` is `Bun.dns.lookup(hostname, { backend: "c-ares" })`.
  - Race it against the signal, rejecting with the signal's reason. Remove the abort listener when
    the lookup settles.
  - Not found means unresolvable. Every returned address goes through the existing blocklist.
- `public_fetch.ts`, `requestPinned(url, address, signal, ca)`:

  ```ts
  const target = new URL(url.href);
  target.hostname = isIP(address) === 6 ? `[${address}]` : address;
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

  Keep the existing gzip, deflate and br decoding with its size limits on the raw body. Reject other
  encodings, including `zstd`. Return no body for 204, 205 and 304. Remove undici and the
  Deno-specific comments.

- **Tests.** Convert `public_fetch.test.ts`, `link_open.test.ts`,
  `tests/public_fetch.integration.ts`, `tests/link_open.integration.ts` and
  `tests/fixtures/link_tls.ts`.
  - Use `Bun.serve` with an explicit `idleTimeout`, or `node:net`.
  - Replace the DNS sibling-cancellation tests with "a hung lookup ends at the deadline" and
    "partial family results are validated".
  - Re-validate the Brotli case that the Deno test comment marks as runtime-specific.
- **IPv6:** add an IPv6 loopback case that runs where IPv6 is available and is skipped (with a
  logged reason) where it is not.

**Verify**

- `bun run test:transport` reports exactly 35 tests. These cover:
  - pinning, `Host` and SNI, and wrong-certificate rejection;
  - redirects not followed;
  - stalled and trickling bodies ending at the 8-second deadline;
  - invalid compression, the expanded-size limit, and rejected bodies released;
  - a hung lookup ending at the deadline;
  - proxy variables removed.
- Unit counts match the baseline, apart from the recorded DNS test replacements.

### Slice 3: Data layer and runtime (the bot runs)

**Changes**

- Injected fetchers use the `Fetcher` type; `globalThis.fetch` stubs use `asFetch()`.
- `src/db/*` and `src/features/discord_actions/state.ts`, as in [Data model](#data-model).
- `storage.ts`, `rate_limit.ts` and `discord_actions/mod.ts` moved onto them. Public interfaces
  unchanged.
- **`src/scheduler.ts`:**
  - `registerCronJobs(registrar, …)`. The production registrar:

    ```ts
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

  - The five schedules are unchanged. A sixth job at `15 * * * *` runs maintenance.
  - Date arithmetic for the stats window uses `setUTCDate`.
- **`src/server.ts`:**
  `Bun.serve({ port: 8000, development: false, idleTimeout: 120, fetch: handler, error })`. The
  `error()` handler logs and returns a plain 500.
- **`main.ts`:** `stripProxyEnvironment()`, then
  `openDatabase(process.env.HARU_DB_PATH ?? "./data/haru.sqlite3")`, then start the gateway, cron
  and server.
- **`discord_gateway.ts`:** IDENTIFY properties `"bun"`.
- **Tests.**
  - New `src/db/*.test.ts` and `state.test.ts`:
    - migrations, including refusing a newer database;
    - constraints;
    - vote upsert, history, stats across DST under `TZ=America/Los_Angeles`, and streaks;
    - polls, including the overwrite case;
    - the AI budget: concurrent admissions and the safe-integer limit;
    - autonomous participation;
    - turns: a new token on clear, the separate pending expiry, a stale `ask()` rejected;
    - the per-guild lock;
    - operation and guard claims, including concurrent attempts;
    - maintenance.
  - Convert or rewrite `storage`, `rate_limit`, `poll_collection`, `discord_actions` (`mod`,
    `authorization`, `cancellation`), `bot_actions*`, `scheduler.autonomous` and `server`.
  - A registrar test: a throwing handler is caught.
  - A schedule test: `Bun.cron.parse(schedule, from, { tz: "UTC" })` gives the same UTC times with
    `TZ` unset, `UTC` and `America/Los_Angeles`.
  - A server test: a throwing handler returns a plain 500.
- **CI:** remove the Deno job. Only `scripts/` still uses Deno, until slice 4.

**Verify**

- The slice checklist passes.
- Counts match the baseline, with every rewrite recorded.
- Named tests show that the behavior of these PRs still holds:
  - #21: Discord action idempotency and ordering;
  - #26: atomic usage accounting;
  - #29: retryable poll collection;
  - #35 and #37: autonomous participation.
- **Smoke run.** Use a test bot or Bot Sandbox, never the production token while production is
  online:
  - `bun run start`; `/health` returns `OK`; the gateway logs READY;
  - a mention gets a reply, and `\reset` works;
  - an event clarification works, then is abandoned;
  - `POST /trigger_poll` posts a poll, and it appears in `polls`;
  - a handler slower than 10 s completes;
  - the autonomous job logs each minute;
  - `data/haru.sqlite3` is at `user_version = 1`.

### Slice 4: Scripts

**Changes**

- `scripts/issue_agent/*`: `Bun.spawn`, `process.argv.slice(2)`, `process.cwd()`.
- Sandbox and evaluation scripts: `openDatabase(":memory:")` or a separate sandbox file, never the
  production database. `process.argv` and `process.exitCode`.
- Convert `scripts/run_discord_sandbox.test.ts` and `scripts/test_reactions_sandbox.test.ts`.
- Add the `agent:*` and sandbox scripts to `package.json`.

**Verify**

- The slice checklist passes.
- `bun run agent:next-issue` without `--claim` works (read-only; needs `gh`).
- Each sandbox script's preview mode starts and exits without posting.

### Slice 5: Remove Deno and finish

**Changes**

- Delete `deno.json`, `deno.lock` and the Deno settings in `.vscode/`.
- README:
  - Bun setup, development, test, format and lint commands;
  - `HARU_DB_PATH`, and `.env` loaded only by `start` and `dev`;
  - the data model summary and the behavior changes;
  - the AWS section marked as pending the deployment follow-up.
- Final CI:
  - `bun install --frozen-lockfile`;
  - `fmt:check`, `check`, `lint`, `test` and `test:transport`, with the count comparison;
  - the CloudFormation lint.

**Verify**

- `git grep -n -i deno -- ':!docs/'` finds nothing.
- Full suite at the exact expected counts.
- The slice 3 smoke run is repeated on the final commit.
- CI is green on `feat/bun`.

### Slice 6: Pull request

- Tag `59535bf` as `deno-final` and push the tag.
- Open a PR from `feat/bun` to `master`. Merging does not deploy anything. Production keeps running
  `deno-final` until the deployment follow-up; Deno hotfixes branch from that tag.

## Deployment notes (for later)

Not part of this plan.

- **Move the systemd unit and helper scripts into the repo.** They are written by the CloudFormation
  startup script today, so changing them means a CloudFormation update. That stops and restarts the
  instance, and risks replacing it if `ExistingAmiId` is not pinned. Move `haru.service` and the
  `haru-*` helpers into `deploy/aws/`, and install them from the checkout during deploy.
- **Install Bun.** A pinned `1.4.4` linux-aarch64 build with a checksum check.
- **Install dependencies:** `bun install --frozen-lockfile --production` as the `haru` user,
  replacing `deno cache`. Runtime auto-install is disabled, so a missing install fails loudly.
- **Unit settings:**
  - `ExecStart=/usr/local/bin/bun run main.ts` (not `bun run start`, which adds a wrapper process);
  - `Environment=NODE_ENV=production`, `TZ=UTC` and `HARU_DB_PATH=/var/lib/haru/haru.sqlite3`;
  - keep `ProtectSystem=strict` and `ReadWritePaths=/var/lib/haru`;
  - remove `DENO_DIR` and `DENO_KV_PATH`;
  - do not set proxy variables (they are stripped anyway).
- **Fresh database.** Use a new file name. Keep the Deno KV file and its S3 backups untouched, and
  name the new backup differently (for example `kv/haru-bun.sqlite3`). Polls posted in the 24 hours
  before cutover will not be collected.
- **Backups.** Check that the instance's `sqlite3` CLI is 3.37 or newer, which `STRICT` tables need
  for `.backup`.
- **Memory.** Check memory use on the `t4g.nano` (512 MB) after cutover.
- **`deploy_aws.sh`.** It still runs `cloudformation deploy` without `ExistingAmiId`. Fix that, or
  use only the app-only deploy path.
- **Rollback.** Redeploy `deno-final` with the old unit. The Deno KV file is still on the instance.

## Slice log

### Slice 0 (done)

Commits: baseline and lint fixes, scaffolding, repository-wide `bun fmt`, CI.

- **Baseline** (`docs/bun-migration-baseline.txt`): 643 Deno tests and steps over 33 files, 630
  expected under Bun; transport 45 and 35. `deno lint` reported nothing. Canary `bun lint` reported
  two warnings (a useless regex escape and a useless initial assignment); both were fixed, and
  `bun lint --max-warnings 0` is clean.
- **Deno coexistence:**
  - With a `package.json` present, Deno expects a `node_modules` folder. `deno.json` now sets
    `"nodeModulesDir": "none"`, so Deno keeps using its own cache.
  - `deno.json` `exclude` lists the Bun-only paths. **Each slice adds its converted test files to
    this list**, because they import `bun:test`.
- **Gate:** `bun run migration:gate` type-checks and tests the files listed in
  `scripts/migration/ported.json` and fails on missing files or count mismatches. Each slice adds
  its converted test files there.
- **Script names:** `bun check` and `bun fmt` run the same-named `package.json` script when one
  exists. Both scripts call the real tool, so this is harmless; the gate uses
  `bun check --no-script`.
- **`RequestInfo`:** not provided by `@types/bun`. Use `string | URL | Request`.
- **Assertion parity:** recorded in the baseline file. One repo site needs `toBe` (the "DNS caller
  cancellation aborts and settles both pending address families" test in `public_fetch.test.ts`).
- **CI:** verified on GitHub (run 28): `setup-bun` read Bun 1.4.4 from `packageManager`, the cache
  was saved, and all four jobs passed.
- **`bun run test` fails until slice 5**, because it discovers unported Deno tests. Use
  `bun run migration:gate` until then.

#### Slice 0 review follow-up

- **Gate:**
  - fails on skipped or todo tests, which Bun counts as run;
  - fails if a ported test file is missing from `deno.json` `exclude`;
  - its parser is tested against a real Bun JUnit report.
- **Test helpers:**
  - the `fetch` guard now rejects like a real network failure instead of throwing synchronously;
  - its comment states that only the global `fetch` is guarded;
  - `throws()` refuses async functions and points to `rejects()`;
  - the helper tests check the exact failure messages and call `realFetch` against a loopback
    server.
- **Config and docs:** `@types/bun` pinned to `~1.4.4`; `.gitignore` keeps `.env.example` trackable;
  doc references name the test instead of a line number.
- **Deferred:**
  - `rejects<T>()` type overloads (a missing class allows any `T`);
  - gate hardening (normalize a `./` prefix, unescape XML entities, run `process.execPath`, require
    the repo root);
  - the Node 20 deprecation warning for `actions/checkout@v4` and `actions/cache@v4`.
- **Open:** guarding `Bun.fetch` and `Bun.dns.lookup` in the test preload. Revisit in slice 2, when
  link checks start using `Bun.dns.lookup`.

### Slice 1 (done)

- **17 test files converted** (an earlier chat summary said 19 by counting the two slice 2 transport
  files): `retry`, `poll`, `stats/embed`, `reaction_gif`, `reactions`, `chat_context`,
  `autonomous_chat/turns`, `autonomous_chat`, `discord_actions/time`, `discord`, `discord_events`,
  `web_search`, `reaction_context`, `usage`, `config`, `ai_service`, `ai_service.tools`.
- **Counts:**
  - Bun runs 281 tests for these files, matching the baseline. With the 14 infrastructure tests,
    that is 295.
  - Deno still runs the other 16 files: 301 tests (54 steps), i.e. 355 testcases. 355 plus the
    converted files' 288 Deno testcases is the 643 baseline.
- **Method:** a one-off TypeScript-AST codemod (not committed) rewrote `Deno.test`, the five
  assertion functions, `Deno.env.*` and the seven `t.step` groups. It refused anything it could not
  rewrite safely. One `assertEquals` failure message (naming the loop case) was kept by comparing
  `{ output_text, result }` instead of dropping it.
- **Source changes:**
  - `Deno.env.get` becomes `process.env` in `config.ts`, `ai_service.ts` and `usage.ts`.
  - `usage.ts`: the Deno `--allow-sys` user-agent workaround is removed; the provider deadline is
    injectable (`timeoutMs`), so its test takes 50 ms instead of 15 s.
  - `DiscordApiError` uses plain fields instead of constructor parameter properties.
  - `StorageService`, `ContextStorageService` and `isNewerHumanMessage` moved to
    `src/types/storage.ts`; `storage.ts` re-exports them.
- **New:**
  - `src/types/fetch.ts`: the `Fetcher` type for injected fetchers.
  - `test_support/fetch.ts`: `asFetch(stub)` for `globalThis.fetch` stubs, because Bun's
    `typeof fetch` requires a `preconnect` method.
- **CI fix:** Deno 2.6.0's `no-process-global` lint rule (in its recommended set) flags
  `process.env`. `deno.json` now excludes that rule; the file is removed in slice 5. Local checks
  now use exit codes, after an output tail hid this failure.
- **Found:** Bun's types make `Response.json()` return `Promise<unknown>` (Deno's return `any`), so
  `discord.ts` needed two type assertions. Expect more of these in later slices.

#### Slice 1 review follow-up

- **AWS user agent:** removing the Deno `--allow-sys` workaround in `usage.ts` made the real AWS
  client fail under Deno without `--allow-sys` (the request is refused before it is sent). Decision
  (option C): `deno.json` `start` and `dev` now pass `--allow-sys=osRelease`; the production unit in
  `deploy/aws/cloudformation.yml` is unchanged because deployment is out of scope. On Bun the client
  works, but the user agent sent to AWS changed from `weabot/1` to the SDK default (SDK version, OS
  and kernel release, runtime); open question, see below.
- **Docs:** the transport task and CI step change is now part of slice 2; slices 2 and 3 name the
  `Fetcher`/`asFetch` convention; the "19" wording is corrected.
- **Guiding principle added:** Bun behavior must match the pre-migration Deno behavior; Deno runtime
  concerns get no effort.

## Future work

- Switch to stable `bun lint` when it ships.
- Data model follow-ups:
  - a `users` table with current display names;
  - per-guild settings in the database;
  - renaming `odUserId` and `odUserName`.
- Restructure the repo layout.
- Pre-existing gateway quirks:
  - a heartbeat timer is not cleared on reconnect;
  - fatal close codes such as 4004 still reconnect.

## Test-count differences against the baseline

Filled in during the port.

| File | Deno tests + steps | Bun tests | Reason / replacement |
| ---- | ------------------ | --------- | -------------------- |
