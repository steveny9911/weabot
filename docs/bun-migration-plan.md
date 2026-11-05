# Bun Migration Plan

Port Haru from Deno to Bun on branch `feat/bun`. Behavior seen in Discord stays the same. The
storage layer is redesigned for SQLite, and the bot starts with an empty database. Each slice ends
in a state that can be run and checked before the next one starts.

Status: **draft**. Base: `master` at `59535bf`.

## Decisions

| Topic                | Decision                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime              | Bun, pinned to `1.4.x` (`engines` and `packageManager` in `package.json`, and CI).                                                                                                               |
| Dependencies         | Built-in Bun and `node:` APIs first. Runtime dependencies: only the official AWS SDK (`@aws-sdk/client-cost-explorer`, `@smithy/credential-provider-imds`). npm packages pinned to major (`^`).  |
| Discord gateway      | Global `WebSocket`, unchanged.                                                                                                                                                                   |
| Database             | `bun:sqlite` with a new relational schema (see [Data model](#data-model)). It replaces Deno KV behind the existing service interfaces.                                                           |
| Data                 | **Start fresh.** No migration from Deno KV. Vote history, glue streaks, pending polls, rate-limit counters and chat state start empty.                                                           |
| Scheduled jobs       | In-process `Bun.cron(schedule, handler, { tz: "UTC" })`.                                                                                                                                         |
| HTTP server          | `Bun.serve`.                                                                                                                                                                                     |
| DNS for link checks  | `Bun.dns.lookup(hostname, { backend: "c-ares" })`, raced against the link deadline. See [DNS choice](#dns-choice).                                                                               |
| Link transport       | Bun `fetch` to the validated IP literal, with the original `Host` header and `tls.serverName`. Replaces undici.                                                                                  |
| Tests                | Converted to `bun:test` (`test`, `describe`, `expect`). `@std/assert` is removed.                                                                                                                |
| Format / type check  | `bun fmt` and `bun check`, both built in and stable in 1.4.4.                                                                                                                                    |
| Lint                 | `bun lint`. It is canary-only as of Bun 1.4.4 (see [Lint](#lint)), so CI runs it from **one pinned canary build** while the app runs on stable 1.4.4. Switch to stable `bun lint` when it ships. |
| Layout               | Unchanged for the port (root-level `main.ts`, `ai_service.ts`, `bot_actions.ts`, `discord_gateway.ts` stay). Restructuring is a later change.                                                    |
| Scripts              | All ported (issue agent, sandbox runners, evaluation scripts).                                                                                                                                   |
| Deployment           | Out of scope for now. See [Deployment notes](#deployment-notes-for-later).                                                                                                                       |
| `master` during port | No new code lands on `master` until `feat/bun` merges.                                                                                                                                           |

### DNS choice

`Bun.dns.lookup` and `node:dns` `resolve4`/`resolve6` are **equally safe** here. Haru validates
every returned address and then connects only to a validated one, so where the answer came from
cannot widen what Haru connects to. The remaining differences are small:

- `Bun.dns.lookup` has no abort signal. The 8-second link deadline still applies, by racing the
  lookup. On the c-ares backend an abandoned lookup is a cheap asynchronous query that finishes or
  times out by itself, without tying up a thread.
- It returns IPv4 and IPv6 together. If one family fails and the other succeeds, Haru gets the
  successful family's addresses rather than failing the whole request. Every address returned is
  still validated, so this does not weaken safety.
- `backend: "c-ares"` is set explicitly. It is Bun's Linux default, reads `/etc/resolv.conf`
  directly, and keeps behavior identical on macOS dev machines, where the default backend differs.

Consequence for tests: PR #30's "cancel the sibling DNS query" tests no longer apply, since there is
a single lookup. They are replaced by "a hung lookup still ends at the deadline" and "partial family
results are validated". The lookup function is injected, so no test replaces a global.

### Lint

Checked on 2026-11-05:

- The npm dist-tags show `latest: 1.4.4` and `canary: 1.4.4-canary.20261104.1`.
- Bun's lint docs for 1.4.4 (shipped in `bun-types@1.4.4`) say: "`bun lint` is only in canary builds
  of Bun."

`bun fmt` and `bun check` are in stable 1.4.4. Plan:

- **CI** runs lint from the pinned canary build (`bunx bun@1.4.4-canary.20261104.1 lint`). That pins
  the exact build, so results are reproducible. Lint is a development tool only; production and
  tests run on stable 1.4.4.
- **Locally**, `bun run lint` runs the same pinned canary through `bunx`, so lint results match CI.
- **Config** goes in `bunfig.toml` under `[lint.rules]`, starting from the defaults (ESLint and
  typescript-eslint recommended, plus the `bun:test` rules).
- When a stable Bun release includes `bun lint`, bump the pinned Bun version and replace the `bunx`
  call with `bun lint`.
- If the canary build misbehaves, slice 0 records it and lint falls back to stricter `tsconfig`
  flags until stable.

## What changes, by file

Non-test files that use Deno APIs or `npm:` imports on `master`:

| File                                                                                                                                                 | Deno usage                                              | Bun replacement                                                            | Slice |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- | ----- |
| `src/config.ts`                                                                                                                                      | `Deno.env.get` (29)                                     | `process.env`                                                              | 1     |
| `ai_service.ts`                                                                                                                                      | `Deno.env.get` (11)                                     | `process.env`                                                              | 1     |
| `src/services/usage.ts`                                                                                                                              | `Deno.env.get`; `--allow-sys` user-agent workaround     | `process.env`; workaround removed                                          | 1     |
| `src/services/storage.ts`                                                                                                                            | `Deno.Kv`                                               | SQLite repositories (`src/db/`)                                            | 2     |
| `src/services/rate_limit.ts`                                                                                                                         | `Deno.Kv`                                               | SQLite repositories                                                        | 2     |
| `src/features/discord_actions/mod.ts`                                                                                                                | `Deno.Kv`, `Deno.KvKey`, `Deno.KvEntryMaybe`            | SQLite repositories                                                        | 2     |
| `src/services/public_fetch.ts`                                                                                                                       | `Deno.resolveDns`, `Deno.errors.NotFound`, `npm:undici` | `Bun.dns.lookup`; Bun `fetch` pinning                                      | 3     |
| `src/scheduler.ts`                                                                                                                                   | `Deno.cron` (5 jobs)                                    | `Bun.cron` behind an injected registrar, plus a maintenance job            | 4     |
| `src/server.ts`                                                                                                                                      | `Deno.serve`                                            | `Bun.serve`                                                                | 4     |
| `main.ts`                                                                                                                                            | `Deno.openKv`, `Deno.env.get`                           | Open the database at `HARU_DB_PATH`                                        | 4     |
| `scripts/issue_agent/*.ts`                                                                                                                           | `Deno.Command`, `Deno.args`, `Deno.cwd`                 | `Bun.spawn`, `process.argv`, `process.cwd()`                               | 5     |
| `scripts/run_discord_sandbox.ts`, `test_discord_events.ts`, `test_reactions_sandbox.ts`, `test_autonomous_participation.ts`, `evaluate_reactions.ts` | `Deno.openKv`, `Deno.args`, `Deno.exitCode`             | Database (in memory or a sandbox file), `process.argv`, `process.exitCode` | 5     |

`discord_gateway.ts`, `bot_actions.ts`, `src/services/discord*.ts`, `src/services/link_open.ts` and
the `src/features/*` modules not listed above use no Deno APIs and should need no source changes
beyond import paths.

Tests: 33 `*.test.ts` files plus `tests/*.integration.ts` and `tests/fixtures/link_tls.ts`. They
contain 492 `Deno.test` calls, 23 `t.step` calls and about 1,600 `@std/assert` assertions. Two test
files replace Deno globals directly (`Deno.cron` in `src/scheduler.autonomous.test.ts`,
`Deno.resolveDns` in `src/services/public_fetch.test.ts`). Both become injected dependencies.

## Data model

### Data Haru stores today

| Deno KV key                                                                                    | What it holds                                                                        | Written by                      |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------- |
| `["votes", channel, date, user]` and `["user_votes", channel, user, date]`                     | One mood vote, stored twice as two indexes                                           | `storage.recordVote`            |
| `["pending_polls", messageId]`                                                                 | A posted poll and whether its results were collected                                 | `storage` poll methods          |
| `["context_resets", channel]`                                                                  | Message and time of the latest `\reset`                                              | `storage.setContextReset`       |
| `["autonomous_participation", channel]`                                                        | Latest considered human message, last attempt time, last reaction emoji              | `storage` participation methods |
| `["ai_usage", "user", user, minute]`                                                           | Per-user AI requests in one minute (2-minute TTL)                                    | `rate_limit`                    |
| `["ai_usage", "daily_requests", date]`, `["ai_usage", "daily_tokens", date]`                   | Daily AI request and token totals (48-hour TTL)                                      | `rate_limit`                    |
| `["discord_action_pending", guild, channel, user]`                                             | A Discord action waiting for clarification (20-minute TTL)                           | `discord_actions`               |
| `["discord_action_generation", guild, channel, user]`                                          | The current turn's token, which invalidates older in-flight sessions (20-minute TTL) | `discord_actions`               |
| `["discord_actions", guild, messageId, action]`                                                | Idempotency record: an action claimed or done for one message                        | `discord_actions`               |
| `["discord_event_fingerprint", guild, hash]`, `["discord_event_cancellation", guild, eventId]` | Guards against creating the same event twice or cancelling one twice                 | `discord_actions`               |

### Design principles

- **One table per concept**, with real columns and indexes. No generic key-value table, and no
  duplicate copies of a record for indexing.
- **Transactions instead of retry loops.** `bun:sqlite` is synchronous, so a read-check-write
  sequence inside `db.transaction(...)` cannot interleave with other code in the process. That
  replaces Deno KV's `atomic().check()` and versionstamp retry loops. **Rule: never `await` inside a
  transaction.** Network calls such as Discord and OpenAI happen between transactions, never inside
  one.
- **`STRICT` tables** (Bun bundles SQLite 3.53.4, and `STRICT` type enforcement was tested). JSON
  columns carry `CHECK (json_valid(...))`.
- **Discord IDs are `TEXT`.** Snowflakes exceed JavaScript's safe integer range.
- **Times are `INTEGER` milliseconds since the epoch, UTC.** Calendar dates (the poll day, the usage
  day) are `TEXT` in `YYYY-MM-DD` form.
- **Expiry is a column, not a TTL.** Reads ignore expired rows, and an hourly maintenance job
  deletes them.
- **The service interfaces stay the same** (`StorageService`, `RateLimitService`, the Discord action
  service), so callers do not change. Only their implementations move to SQLite.

### Schema (migration 1)

```sql
-- Mood polls: one row per posted poll.
CREATE TABLE polls (
  message_id    TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL,
  poll_date     TEXT NOT NULL,              -- YYYY-MM-DD the poll is for
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  collected_at  INTEGER                     -- NULL until results are stored
) STRICT;
CREATE INDEX polls_uncollected ON polls (expires_at) WHERE collected_at IS NULL;

-- Mood votes: at most one vote per user, per channel, per day.
CREATE TABLE votes (
  channel_id  TEXT NOT NULL,
  vote_date   TEXT NOT NULL,                -- YYYY-MM-DD
  user_id     TEXT NOT NULL,
  user_name   TEXT NOT NULL,                -- display name at vote time
  mood        TEXT NOT NULL CHECK (mood IN ('umazing', 'ok', 'glue')),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, vote_date, user_id)
) STRICT;
CREATE INDEX votes_by_user ON votes (channel_id, user_id, vote_date DESC);

-- Latest \reset per channel or thread.
CREATE TABLE context_resets (
  channel_id  TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL,
  reset_at    INTEGER NOT NULL
) STRICT;

-- Autonomous chat watermark and cooldown per channel.
CREATE TABLE autonomous_participation (
  channel_id                 TEXT PRIMARY KEY,
  latest_human_message_id    TEXT NOT NULL,
  latest_human_timestamp_ms  INTEGER NOT NULL,
  attempted_at               INTEGER NOT NULL,
  last_reaction_emoji        TEXT
) STRICT;

-- AI rate limiting: requests per user per UTC minute.
CREATE TABLE ai_user_minute_requests (
  user_id   TEXT NOT NULL,
  minute    TEXT NOT NULL,                  -- YYYY-MM-DDTHH:MM (UTC)
  requests  INTEGER NOT NULL CHECK (requests >= 0),
  PRIMARY KEY (user_id, minute)
) STRICT;

-- AI usage per UTC day: request count and token total.
CREATE TABLE ai_daily_usage (
  usage_date  TEXT PRIMARY KEY,             -- YYYY-MM-DD (UTC)
  requests    INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
  tokens      INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0)
) STRICT;

-- Discord action conversation state per (guild, channel, user).
-- The turn token replaces Deno KV versionstamps: a session is current only
-- while the stored token still equals the token it was given.
CREATE TABLE discord_action_turns (
  guild_id     TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  turn_token   TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  is_reset     INTEGER NOT NULL DEFAULT 0 CHECK (is_reset IN (0, 1)),
  pending      TEXT CHECK (pending IS NULL OR json_valid(pending)),  -- clarification request
  expires_at   INTEGER NOT NULL,
  PRIMARY KEY (guild_id, channel_id, user_id)
) STRICT;

-- Idempotency: an action requested by one message runs at most once.
CREATE TABLE discord_action_operations (
  guild_id     TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  action       TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  result       TEXT CHECK (result IS NULL OR json_valid(result)),
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (guild_id, message_id, action)
) STRICT;

-- Duplicate guards across messages: same event created twice, same event cancelled twice.
CREATE TABLE discord_event_guards (
  guild_id     TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('creation_fingerprint', 'cancellation')),
  guard_key    TEXT NOT NULL,               -- fingerprint hash or event ID
  state        TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  result       TEXT CHECK (result IS NULL OR json_valid(result)),
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (guild_id, kind, guard_key)
) STRICT;
```

`discord_action_turns` merges the two former keys (`discord_action_pending` and
`discord_action_generation`), which were always read and written together under one compare-and-set.
One row now holds the turn token and the optional pending clarification. Clearing the pending
request sets `pending` to `NULL` and keeps the token, which preserves today's "abandon or reset
leaves a new generation behind" rule.

### How each operation maps

| Operation                                                                          | SQL shape                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordVote`                                                                       | Upsert into `votes` on `(channel_id, vote_date, user_id)`. One row instead of two.                                                                                                     |
| `getUserHistory`                                                                   | `SELECT … WHERE channel_id = ? AND user_id = ? ORDER BY vote_date DESC LIMIT ?` (uses `votes_by_user`).                                                                                |
| `getVotesForDate`                                                                  | `SELECT … WHERE channel_id = ? AND vote_date = ?` (primary key prefix).                                                                                                                |
| `getStats`                                                                         | `SELECT vote_date, mood, COUNT(*) … WHERE channel_id = ? AND vote_date BETWEEN ? AND ? GROUP BY vote_date, mood`. The code still fills days with no votes with zeros.                  |
| `getConsecutiveGlueCount`                                                          | Same JavaScript streak logic over the user's latest 30 votes. Kept in code because its "consecutive calendar days" rule is already tested.                                             |
| `getUsersAtRisk`                                                                   | `SELECT DISTINCT user_id … WHERE channel_id = ?`, then the streak logic per user.                                                                                                      |
| `savePendingPoll` / `getExpiredPolls` / `getAllPendingPolls` / `markPollCollected` | Insert, then `WHERE collected_at IS NULL [AND expires_at <= ?]`, then `UPDATE … SET collected_at = ?`.                                                                                 |
| `claimAutonomousParticipation` / `finish…`                                         | One transaction: read the channel row, apply the existing `isNewerHumanMessage` and cooldown rules, then upsert. No retry loop.                                                        |
| `admitRequest`                                                                     | One transaction: read this minute's user count and today's tokens, check the limits, then increment both counters. No retry loop.                                                      |
| `recordTokenUsage`                                                                 | `INSERT … ON CONFLICT(usage_date) DO UPDATE SET tokens = tokens + ?`, with a safe-integer guard before writing.                                                                        |
| Discord action turn claim / `ensureCurrent` / `clearPending`                       | One transaction to read and replace the turn token. "Is this session still current?" becomes `turn_token = ?` on the row.                                                              |
| Discord action `once`                                                              | Transaction 1 claims (`state = 'pending'`, failing if a row exists), then the Discord call runs, then transaction 2 records `done` with the result. The same two-phase shape as today. |

### Retention

The hourly maintenance job deletes:

| Table                                                                                                               | Rows deleted             | Today's equivalent                                                          |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `ai_user_minute_requests`                                                                                           | Older than 2 minutes     | 2-minute TTL                                                                |
| `ai_daily_usage`                                                                                                    | Older than 30 days       | 48-hour TTL. Keeping 30 days costs almost nothing and helps with debugging. |
| `discord_action_turns`                                                                                              | `expires_at` in the past | 20-minute TTL                                                               |
| `votes`, `polls`, `context_resets`, `autonomous_participation`, `discord_action_operations`, `discord_event_guards` | Never                    | No TTL today                                                                |

Reads always filter on `expires_at` or the time window, so correctness never depends on when the job
last ran.

### Schema versioning

- `src/db/migrations.ts` holds an ordered list of SQL migrations. Migration 1 is the schema above.
- On startup, `openDatabase(path)`:
  - sets `PRAGMA journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000` and
    `synchronous = NORMAL`
  - reads `PRAGMA user_version`
  - applies each newer migration in its own transaction, bumping `user_version` with each
- A database with a newer `user_version` than the code knows about refuses to start, so an old build
  never writes to a newer schema.
- The path comes from `HARU_DB_PATH`, defaulting to `./data/haru.sqlite3`. `":memory:"` is used for
  tests and sandbox scripts.

### Code layout

```
src/db/
  database.ts        openDatabase(path), pragmas, migration runner
  migrations.ts      ordered SQL migrations
  votes.ts           vote and poll queries
  chat_state.ts      context resets, autonomous participation
  ai_usage.ts        rate-limit and daily usage counters
  discord_actions.ts turns, operations, event guards
  maintenance.ts     retention deletes
```

`src/services/storage.ts`, `src/services/rate_limit.ts` and `src/features/discord_actions/mod.ts`
keep their public interfaces and call these modules. `src/types/storage.ts` keeps its exported
record types for the port. Its `odUserId`/`odUserName` field names are left as they are; the new
columns are `user_id`/`user_name`, and the mapping happens in `src/db/votes.ts`.

## Test conversion rules

Each test file is converted in the same slice as the code it covers.

| Deno                         | Bun                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `Deno.test(name, fn)`        | `test(name, fn)`                                                                                                                 |
| `t.step(name, fn)`           | A `describe` block with one `test` per step (Bun runs them in order). Where steps share sequential state, keep it as one `test`. |
| `assertEquals(a, b)`         | `expect(a).toStrictEqual(b)`. Not `toEqual`, which ignores `undefined` properties.                                               |
| `assertStringIncludes(s, x)` | `expect(s).toContain(x)`                                                                                                         |
| `assert(x)`                  | `expect(x).toBeTruthy()`, or a more specific matcher where it reads better                                                       |
| `assertRejects(fn, E, msg)`  | `await expect(fn()).rejects.toThrow(...)`, checking both the class and the message                                               |
| `assertThrows(fn, E, msg)`   | `expect(fn).toThrow(...)`                                                                                                        |
| `assertMatch(s, re)`         | `expect(s).toMatch(re)`                                                                                                          |
| `assertGreater(a, b)`        | `expect(a).toBeGreaterThan(b)`                                                                                                   |
| `Deno.openKv(":memory:")`    | `openDatabase(":memory:")`                                                                                                       |
| `Deno.env.set` / `delete`    | `process.env` with restore in `afterEach`                                                                                        |

Deno's test sanitizers (leaked timers, ops and resources) have no Bun equivalent. Tests that relied
on them implicitly get explicit cleanup (`afterEach`, `clearTimeout`, closing servers).

**Tests tied to Deno KV are rewritten, not converted.** `src/services/rate_limit.test.ts` (22
in-memory KV instances, 23 direct KV operations) and parts of `storage.test.ts` and
`discord_actions/mod.test.ts` test KV mechanics that no longer exist: compare-and-set conflicts,
retry exhaustion, TTL values, compatibility with existing counters. They are replaced by tests of
the same **behavior** on SQLite:

- concurrent admissions never exceed the limit
- token totals are never lost
- expired rows are invisible
- an old session can never overwrite a newer turn
- an action never runs twice for one message

**Test-count parity.** Slice 0 records the Deno test count per file as a baseline. For converted
files, Bun counts must match except where a `t.step` group was split. For rewritten files, the table
at the end of this document lists each removed KV-mechanics test and the behavior test that replaces
it, so no behavior loses coverage.

## Slices

Every slice ends with:

```bash
bun install --frozen-lockfile
bun fmt --check
bun check
bun run lint
bun test <files ported so far>
```

Files not yet ported stay as they are on `master` until their slice. CI runs the Bun job over ported
files, plus the existing CloudFormation lint.

### Slice 0: Scaffolding and baseline

Changes:

- `package.json`:
  - `"type": "module"`.
  - `engines.bun: "~1.4.4"` and `packageManager: "bun@1.4.4"`.
  - `dependencies`: `@aws-sdk/client-cost-explorer@^3`, `@smithy/credential-provider-imds@^4`.
  - `devDependencies`: `@types/bun@^1`.
  - `scripts`: `start`, `dev` (`bun --watch`), `test`, `check`, `fmt`, `fmt:check`, `lint` (pinned
    canary, see [Lint](#lint)), `test:transport`, and the `agent:*` scripts.
- `bun.lock`, committed.
- `bunfig.toml`:
  - `[fmt]`, set as close to the current `deno fmt` settings as `bun fmt` allows (print width 100,
    two-space indent, double quotes).
  - `[lint.rules]`, starting from the defaults.
  - Test settings.
- `tsconfig.json`: `strict`, `noImplicitAny`, `noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`, `noImplicitReturns`, `allowImportingTsExtensions`,
  `module: "preserve"`, `moduleResolution: "bundler"`, `types: ["bun"]` and `noEmit`.
- `.gitignore`: add `node_modules/` and `data/`.
- CI: add a Bun job (`oven-sh/setup-bun` pinned to `1.4.4`, ARM runner) running the slice checks
  over ported files. Keep the CloudFormation lint job. The Deno job keeps running over files not yet
  ported until slice 6 removes it.
- Baseline: run the Deno suite on `master` and save the per-file test counts to
  `docs/bun-migration-baseline.txt`.
- Assertion parity check: a small throwaway test confirming that `toStrictEqual` fails where
  `assertEquals` fails, for `undefined` properties, class instances and `Date` values. Delete it
  after recording the result.

Verify:

- `bun install --frozen-lockfile`, `bun fmt --check`, `bun check` and `bun run lint` succeed on the
  empty ported set.
- `bun --version` in CI prints `1.4.4`. The lint step reports the canary build it used.
- The baseline file lists 33 test files and 543 tests (100 steps), plus 17 transport tests.

### Slice 1: Code without Deno APIs, plus environment variables

Port `src/config.ts`, `ai_service.ts` and `src/services/usage.ts` (`Deno.env` to `process.env`).
Then convert the tests for every module that needs no other runtime change:

- `src/utils/retry`
- `src/features/poll`, `stats`, `reaction_gif`, `reactions`, `chat_context`
- `src/features/autonomous_chat/turns`, `discord_actions/time`
- `src/services/discord`, `discord_events`, `web_search`, `reaction_context`, `usage`
- `src/config`
- `ai_service` and `ai_service.tools`

Two other changes in this slice:

- Fix the one constructor parameter property (`DiscordApiError` in
  `src/services/discord_events.ts`), so the code is also valid without type transforms.
- `usage.ts`: keep the explicit environment-then-IMDSv2 credential chain, and drop the
  `defaultUserAgentProvider` override that only existed for Deno's `--allow-sys`.

Verify:

- The slice checks pass, and per-file counts match the baseline.
- `usage.test.ts` passes with the real AWS SDK, using the existing injected request handler.

### Slice 2: SQLite data layer

Build `src/db/` as described in [Data model](#data-model). Then switch `storage.ts`, `rate_limit.ts`
and `discord_actions/mod.ts` to it, keeping their public interfaces.

Tests:

- `src/db/*.test.ts`, one file per module, on `:memory:` databases:
  - **Migrations:** a fresh database reaches `user_version = 1`; running them twice is a no-op; a
    database from a newer version refuses to open.
  - **Constraints:** an invalid mood, invalid JSON or a negative counter is rejected by SQLite
    itself.
  - **Votes:** voting again the same day replaces the vote; history order and limit; stats over a
    range including empty days; streaks across gaps.
  - **Polls:** expired-and-uncollected selection; marking a poll collected.
  - **AI usage:** many concurrent `admitRequest` calls never exceed the per-user limit; the budget
    check; no token totals lost under concurrent `recordTokenUsage`; minute and day rollover.
  - **Autonomous participation:** an older message never replaces a newer one; the cooldown; the
    last reaction emoji is kept.
  - **Discord actions:** a turn token supersedes older sessions; `clearPending` keeps a new turn;
    `once` never runs an action twice for a message, including concurrent attempts; the event
    guards.
  - **Maintenance:** expired rows are deleted; rows with no expiry are kept.
- Convert or rewrite the tests for `storage`, `rate_limit`, `poll_collection` and `discord_actions`
  (`mod`, `authorization`, `cancellation`), following the
  [test conversion rules](#test-conversion-rules).

Verify:

- The slice checks pass. Converted files match baseline counts, and every rewritten test is listed
  in the table at the end.
- The behavior guaranteed by PR #26 (atomic usage accounting), PR #29 (retryable poll collection),
  PR #21 (Discord action idempotency and ordering) and PR #35/#37 (autonomous participation) still
  holds, each shown by a named test.

### Slice 3: Link-safety transport

In `src/services/public_fetch.ts`:

- `resolveAddresses`:
  - Use an injected lookup, by default `Bun.dns.lookup(hostname, { backend: "c-ares" })`.
  - Race it against the caller's signal. On abort, return immediately and let the lookup finish by
    itself.
  - An empty result or "not found" fails the request as unresolvable. Every returned address goes
    through the existing blocklist.
- `requestPinned`:
  - Bun `fetch` to `scheme://<validated IP>:<port>/path`, with the IPv6 address in brackets.
  - The original `Host` header, `tls: { serverName: hostname, ca, rejectUnauthorized: true }`,
    `redirect: "manual"`, `decompress: false`, `keepalive: false`, and the caller's `signal`.
  - Keep the existing decompression and size limits on the raw body.
- Delete the undici import, the `Readable` bridging, and the Deno-specific comments.
- `link_open.ts` is unchanged apart from imports.

Convert `public_fetch.test.ts`, `link_open.test.ts`, `tests/public_fetch.integration.ts`,
`tests/link_open.integration.ts` and `tests/fixtures/link_tls.ts`. Replace the DNS sibling
cancellation tests with "a hung lookup ends at the deadline" and "partial family results are
validated".

Verify:

- All transport integration tests pass under `bun test tests/`, on loopback fixtures only, covering:
  - pinning to the validated address
  - `Host` and SNI preserved
  - wrong certificate name rejected
  - redirects not followed by the transport
  - stalled and trickling bodies hitting the 8-second deadline
  - invalid compression
  - expanded-size limit
  - rejected bodies released
  - a hung DNS lookup ending at the deadline
- The unit tests for the IP blocklist and redirect revalidation match the baseline counts.

### Slice 4: Scheduler, HTTP server and entry point

- `src/scheduler.ts`:
  - `registerCronJobs` takes a `cron(name, schedule, handler)` registrar. The production registrar
    wraps `Bun.cron(schedule, handler, { tz: "UTC" })` and logs the job name.
  - The five schedules (`0 5 * * *`, `0 6 * * *`, `0 6 * * SUN`, `30 * * * *`, `* * * * *`) are
    unchanged.
  - A sixth job, `15 * * * *`, runs the database maintenance.
  - Bun does not start a job again until the previous run finishes, which matches `Deno.cron`.
- `src/server.ts`: `Bun.serve({ port: 8000, fetch: handler })`. The handler is already a standard
  `Request` to `Response` function and is unchanged.
- `main.ts`: `openDatabase(process.env.HARU_DB_PATH ?? "./data/haru.sqlite3")` instead of
  `Deno.openKv`, and start the gateway, cron and server as today.
- Convert `src/scheduler.autonomous.test.ts`, which uses the injected registrar,
  `src/server.test.ts` and the four `bot_actions*.test.ts` files.

Verify:

- The slice checks pass, and per-file counts match the baseline.
- A test asserts, using `Bun.cron.parse(schedule, from, { tz: "UTC" })`, that every production
  schedule resolves to the same UTC time with `TZ` unset, `TZ=UTC` and `TZ=America/Los_Angeles`. A
  pre-check on Bun 1.4.4 with `TZ=America/Los_Angeles` gave 05:00, 06:00 and Sunday 06:00 UTC with
  `{ tz: "UTC" }`, but 13:00 and 14:00 UTC without it.
- A **local smoke run** against a test bot or Bot Sandbox, not the production token while production
  is online:
  - `bun run start`
  - `/health` returns `OK`
  - the gateway logs READY
  - a mention gets a reply, and `\reset` works
  - `POST /trigger_poll` with `ADMIN_HTTP_TOKEN` posts a poll
  - the every-minute autonomous-chat job logs that it ran
  - `data/haru.sqlite3` is created at `user_version = 1`, and the poll appears in `polls`

### Slice 5: Scripts

- `scripts/issue_agent/*`: `Deno.Command` becomes `Bun.spawn`, and `Deno.args` and `Deno.cwd()`
  become `process.argv.slice(2)` and `process.cwd()`.
- The sandbox and evaluation scripts use `openDatabase(":memory:")` or a separate sandbox file,
  never the production database, along with `process.argv` and `process.exitCode`.
- Convert `scripts/run_discord_sandbox.test.ts` and `scripts/test_reactions_sandbox.test.ts`.
- Update the `agent:*` and sandbox entries in `package.json`.

Verify:

- The slice checks pass.
- `bun run agent:next-issue` without `--claim` works (read-only, needs `gh` authenticated).
- Each sandbox script's preview or dry-run mode starts and exits cleanly without posting.

### Slice 6: Remove Deno and finish

- Delete `deno.json`, `deno.lock`, the Deno settings in `.vscode/` and the Deno CI job.
- Run `bun fmt` over the whole repo **as its own commit**, so formatting churn stays separate from
  logic changes.
- README:
  - Bun commands for setup, development, testing, formatting and linting.
  - `HARU_DB_PATH` replaces `DENO_KV_PATH`.
  - A short description of the data model and the empty starting database.
  - The Deno Deploy and Deno sections removed.
  - The AWS section marked as pending the deployment follow-up.
- CI (Bun only): `bun install --frozen-lockfile`, `bun fmt --check`, `bun check`, `bun run lint`,
  `bun test`, `bun run test:transport`, and the CloudFormation lint.

Verify:

- `git grep -n -i deno -- ':!docs/'` finds nothing except the deployment notes.
- Full suite green. Every difference from the baseline is explained in the table below.
- The slice 4 smoke run is repeated on the final commit.
- CI is green on `feat/bun`.

### Slice 7: Pull request

Open a PR from `feat/bun` to `master`. Merging it **does not deploy anything**, since deploys are
manual. Until the deployment follow-up is done, production keeps running the Deno build at
`59535bf`, and `master` can no longer produce a Deno hotfix. If one is needed, branch from the tag
`deno-final` (created on `59535bf` before this PR merges).

## Deployment notes (for later)

Not part of this plan. Recorded so the follow-up starts from the right place.

- **The systemd unit and helper scripts live in the CloudFormation startup script.** Changing
  `ExecStart` or the Deno install means a CloudFormation update, which stops and restarts the
  instance, and risks **replacing it** if `ExistingAmiId` is not pinned (see the README). Suggested
  approach: move `haru.service` and the `haru-*` helper scripts into the repo (for example
  `deploy/aws/`), and have the deploy step install them from the checkout, so runtime changes no
  longer need infrastructure updates.
- **Installing Bun.** Install a pinned `1.4.x` linux-aarch64 build with a checksum check in the
  deploy step, as is done for Deno today.
- **Unit settings:**
  - `ExecStart=/usr/local/bin/bun run main.ts`
  - `Environment=TZ=UTC`
  - `Environment=HARU_DB_PATH=/var/lib/haru/haru.sqlite3`
  - Keep `ProtectSystem=strict` and `ReadWritePaths=/var/lib/haru`.
  - Remove the Deno-only `DENO_DIR` and `DENO_KV_PATH`.
- **Fresh database.** The new database file is a different format and starts empty. Use a new file
  name next to the old one, and leave the Deno KV file and its S3 backups untouched. Name the new
  backup differently (for example `kv/haru-bun.sqlite3`) so `kv/latest.sqlite3` keeps the last Deno
  backup.
- **Backups.** The existing `sqlite3 .backup` helper works unchanged on the new file, and WAL mode
  is safe with `.backup`.
- **Memory.** Check memory use on the `t4g.nano` (512 MB) after cutover.
- **`deploy_aws.sh`** still runs `cloudformation deploy` without `ExistingAmiId`. Fix that, or use
  only the app-only deploy path, before the first Bun deploy.
- **Rollback.** Redeploy `deno-final` with the old unit. The Deno KV file is still on the instance.

## Future work (after the port)

- Switch from the pinned canary to stable `bun lint` once it ships.
- Data model follow-ups: a `users` table (display names kept current instead of a snapshot per
  vote), per-guild settings in the database instead of environment variables, and renaming
  `odUserId`/`odUserName` in `src/types/storage.ts`.
- Restructure the repo layout (move the root-level modules into `src/`).

## Test-count differences against the baseline

Filled in during the port. Rewritten Deno KV mechanics tests are listed with the behavior test that
replaces them.

| File | Deno tests | Bun tests | Reason / replacement |
| ---- | ---------- | --------- | -------------------- |
