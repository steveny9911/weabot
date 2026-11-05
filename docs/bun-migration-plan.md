# Bun Migration Plan

Port Haru from Deno to Bun on branch `feat/bun`, as a behavior-identical runtime port. Each slice
ends in a state that can be run and checked before the next one starts.

Status: **draft**. Base: `master` at `59535bf`.

## Decisions

| Topic                | Decision                                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime              | Bun, pinned to `1.4.x` (`engines` and `packageManager` in `package.json`, and CI).                                                                                                              |
| Dependencies         | Built-in Bun and `node:` APIs first. Runtime dependencies: only the official AWS SDK (`@aws-sdk/client-cost-explorer`, `@smithy/credential-provider-imds`). npm packages pinned to major (`^`). |
| Discord gateway      | Global `WebSocket`, unchanged.                                                                                                                                                                  |
| Database             | `bun:sqlite`. One generic `kv` table that reproduces the Deno KV subset Haru uses, behind the existing storage interfaces.                                                                      |
| Data                 | **Start fresh.** No migration from Deno KV. Vote history, glue streaks, pending polls, rate-limit counters and chat state reset at cutover.                                                     |
| Scheduled jobs       | In-process `Bun.cron(schedule, handler)`, always UTC.                                                                                                                                           |
| HTTP server          | `Bun.serve`.                                                                                                                                                                                    |
| DNS for link checks  | `node:dns/promises` `Resolver` (`resolve4`/`resolve6`, `cancel()`). Not `Bun.dns.lookup`, which cannot be cancelled and merges both families.                                                   |
| Link transport       | Bun `fetch` to the validated IP literal, with the original `Host` header and `tls.serverName`. Replaces undici.                                                                                 |
| Tests                | Converted to `bun:test` (`test`, `describe`, `expect`). `@std/assert` is removed.                                                                                                               |
| Format / type check  | `bun fmt` and `bun check` (both built in and stable in 1.4.4).                                                                                                                                  |
| Lint                 | `bun lint` is canary-only in 1.4.4, so it is **not used yet**. Stricter `tsconfig` flags cover the gap. Add `bun lint` to CI when it reaches a stable release.                                  |
| Layout               | Unchanged for the port (root-level `main.ts`, `ai_service.ts`, `bot_actions.ts`, `discord_gateway.ts` stay). Restructuring is a later change.                                                   |
| Scripts              | All ported (issue agent, sandbox runners, evaluation scripts).                                                                                                                                  |
| Deployment           | Out of scope for now. See [Deployment notes](#deployment-notes-for-later).                                                                                                                      |
| `master` during port | No new code lands on `master` until `feat/bun` merges.                                                                                                                                          |

## What changes, by file

Non-test files that use Deno APIs or `npm:` imports on `master`:

| File                                                                                                                                                 | Deno usage                                              | Bun replacement                                        | Slice |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------ | ----- |
| `src/config.ts`                                                                                                                                      | `Deno.env.get` (29)                                     | `process.env`                                          | 1     |
| `ai_service.ts`                                                                                                                                      | `Deno.env.get` (11)                                     | `process.env`                                          | 1     |
| `src/services/usage.ts`                                                                                                                              | `Deno.env.get`; `--allow-sys` user-agent workaround     | `process.env`; workaround removed                      | 1     |
| `src/services/storage.ts`                                                                                                                            | `Deno.Kv`                                               | SQLite `kv` facade                                     | 2     |
| `src/services/rate_limit.ts`                                                                                                                         | `Deno.Kv`                                               | SQLite `kv` facade                                     | 2     |
| `src/features/discord_actions/mod.ts`                                                                                                                | `Deno.Kv`, `Deno.KvKey`, `Deno.KvEntryMaybe`            | SQLite `kv` facade types                               | 2     |
| `src/services/public_fetch.ts`                                                                                                                       | `Deno.resolveDns`, `Deno.errors.NotFound`, `npm:undici` | `node:dns` `Resolver`; Bun `fetch` pinning             | 3     |
| `src/scheduler.ts`                                                                                                                                   | `Deno.cron` (5 jobs)                                    | `Bun.cron` behind an injected registrar                | 4     |
| `src/server.ts`                                                                                                                                      | `Deno.serve`                                            | `Bun.serve`                                            | 4     |
| `main.ts`                                                                                                                                            | `Deno.openKv`, `Deno.env.get`                           | Open SQLite at `HARU_DB_PATH`                          | 4     |
| `scripts/issue_agent/*.ts`                                                                                                                           | `Deno.Command`, `Deno.args`, `Deno.cwd`                 | `Bun.spawn`, `process.argv`, `process.cwd()`           | 5     |
| `scripts/run_discord_sandbox.ts`, `test_discord_events.ts`, `test_reactions_sandbox.ts`, `test_autonomous_participation.ts`, `evaluate_reactions.ts` | `Deno.openKv`, `Deno.args`, `Deno.exitCode`             | SQLite (in-memory), `process.argv`, `process.exitCode` | 5     |

`discord_gateway.ts`, `bot_actions.ts`, `src/services/discord*.ts`, `src/services/link_open.ts` and
the `src/features/*` modules not listed above use no Deno APIs and should need no source changes
beyond import paths.

Tests: 33 `*.test.ts` files plus `tests/*.integration.ts` and `tests/fixtures/link_tls.ts`. They
contain 492 `Deno.test` calls, 23 `t.step` calls and about 1,600 `@std/assert` assertions. Two test
files replace Deno globals directly (`Deno.cron` in `src/scheduler.autonomous.test.ts` and
`Deno.resolveDns` in `src/services/public_fetch.test.ts`). In the port, both become injected
dependencies, so no test replaces a runtime global.

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
| `Deno.openKv(":memory:")`    | `openKv(":memory:")` from the new SQLite facade                                                                                  |
| `Deno.env.set` / `delete`    | `process.env` with restore in `afterEach`                                                                                        |

Deno's test sanitizers (leaked timers, ops and resources) have no Bun equivalent. Tests that relied
on them implicitly get explicit cleanup (`afterEach`, `clearTimeout`, closing servers).

**Test-count parity.** Slice 0 records the Deno test count per file as a baseline. Each slice
compares the converted files' Bun counts against it. A file may change count only where a `t.step`
group was split into separate tests. Any such change is recorded in the table at the end of this
document.

## Slices

Every slice ends with:

```bash
bun install --frozen-lockfile
bun fmt --check
bun check
bun test <files ported so far>
```

Files not yet ported stay as they are on `master` until their slice. CI runs only the Bun job over
ported files, plus the existing CloudFormation lint.

### Slice 0: Scaffolding and baseline

Changes:

- `package.json`:
  - `"type": "module"`.
  - `engines.bun: "~1.4.4"` and `packageManager: "bun@1.4.4"`.
  - `dependencies`: `@aws-sdk/client-cost-explorer@^3`, `@smithy/credential-provider-imds@^4`.
  - `devDependencies`: `@types/bun@^1`.
  - `scripts`: `start`, `dev` (`bun --watch`), `test`, `check`, `fmt`, `fmt:check`,
    `test:transport`, and the `agent:*` scripts.
- `bun.lock`, committed.
- `bunfig.toml`, with a `[fmt]` section set as close to the current `deno fmt` settings as `bun fmt`
  allows (print width 100, two-space indent, double quotes), and test settings.
- `tsconfig.json`:
  - The current `strict` and `noImplicitAny`.
  - `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch` and `noImplicitReturns`, in
    place of the lint rules.
  - `allowImportingTsExtensions`, `module: "preserve"`, `moduleResolution: "bundler"`,
    `types: ["bun"]` and `noEmit`.
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

- `bun install --frozen-lockfile`, `bun fmt --check` and `bun check` succeed on the empty ported
  set.
- `bun --version` in CI prints `1.4.4`.
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

### Slice 2: SQLite storage

Add `src/services/kv.ts`: a small facade over `bun:sqlite` that provides only the Deno KV subset
Haru uses, with async signatures so callers change as little as possible:

- `get`, `getMany`, `set` with `expireIn`, `delete`
- `list({ prefix })`
- `atomic().check(...).set(...).delete(...).commit()` with versionstamps

Schema, one table:

```sql
CREATE TABLE kv (
  key        TEXT PRIMARY KEY,  -- JSON-encoded key tuple
  value      TEXT NOT NULL,     -- JSON-encoded value
  version    INTEGER NOT NULL,  -- versionstamp for atomic checks
  expires_at INTEGER            -- epoch ms, NULL = no expiry
);
```

Rules:

- Keys are encoded as JSON arrays. Prefix scans match whole elements, so a prefix of channel `"123"`
  never matches channel `"1234"`.
- A commit runs in one SQLite transaction. Every `check` must match the stored version or the whole
  commit fails, as with Deno KV.
- Expired rows are invisible to reads. A periodic sweep deletes them.
- The database opens in WAL mode with a busy timeout. The path comes from `HARU_DB_PATH`, defaulting
  to `./data/haru.sqlite3`, and `:memory:` works for tests.
- Values must be JSON-safe. The facade throws on anything else, rather than silently losing `Date`
  or `bigint` values.

Then:

- Switch `storage.ts`, `rate_limit.ts` and `discord_actions/mod.ts` to the facade.
- Add `src/services/kv.test.ts` covering:
  - prefix boundaries
  - list ordering
  - expiry
  - atomic success and conflict
  - many concurrent `commit`s on the same key, where exactly one wins per version
  - `getMany`
  - non-JSON values rejected
- Convert the tests for `storage`, `rate_limit`, `poll_collection`, and `discord_actions` (`mod`,
  `authorization`, `cancellation`).

Verify:

- The slice checks pass, and per-file counts match the baseline.
- The concurrency regressions from PR #26 (atomic usage accounting) still pass. They are the
  evidence that the facade's checks behave like Deno KV's.

### Slice 3: Link-safety transport

In `src/services/public_fetch.ts`:

- `resolveAddresses`:
  - Use a `node:dns/promises` `Resolver`. It is injected, so tests need no globals.
  - Run `resolve4` and `resolve6` in parallel. "No record" (`ENODATA`, `ENOTFOUND`) counts as an
    empty answer, and any other error fails closed.
  - `resolver.cancel()` replaces the shared `AbortController` when the deadline fires or the other
    query fails.
- `requestPinned`:
  - Bun `fetch` to `scheme://<validated IP>:<port>/path`, with the IPv6 address in brackets.
  - The original `Host` header, `tls: { serverName: hostname, ca, rejectUnauthorized: true }`,
    `redirect: "manual"`, `decompress: false`, `keepalive: false`, and the caller's `signal`.
  - Keep the existing decompression and size limits on the raw body.
- Delete the undici import, the `Readable` bridging, and the Deno-specific comments.
- `link_open.ts` is unchanged apart from imports.

Convert `public_fetch.test.ts`, `link_open.test.ts`, `tests/public_fetch.integration.ts`,
`tests/link_open.integration.ts` and `tests/fixtures/link_tls.ts`.

Verify:

- All 17 transport integration tests pass under `bun test tests/`, on loopback fixtures only,
  covering:
  - pinning to the validated address
  - `Host` and SNI preserved
  - wrong certificate name rejected
  - redirects not followed by the transport
  - stalled and trickling bodies hitting the 8-second deadline
  - invalid compression
  - expanded-size limit
  - rejected bodies released
  - DNS sibling cancellation
- The unit tests for the IP blocklist and redirect revalidation match the baseline counts.

### Slice 4: Scheduler, HTTP server and entry point

- `src/scheduler.ts`:
  - `registerCronJobs` takes a `cron(name, schedule, handler)` registrar. The production registrar
    wraps `Bun.cron(schedule, handler, { tz: "UTC" })` and logs the job name.
  - The five schedules (`0 5 * * *`, `0 6 * * *`, `0 6 * * SUN`, `30 * * * *`, `* * * * *`) are
    unchanged.
  - Bun does not start a job again until the previous run finishes, which matches `Deno.cron`.
- `src/server.ts`: `Bun.serve({ port: 8000, fetch: handler })`. The handler is already a standard
  `Request` to `Response` function and is unchanged.
- `main.ts`: open the SQLite facade at `HARU_DB_PATH` instead of `Deno.openKv(DENO_KV_PATH)`, and
  start the gateway, cron and server as today.
- Convert `src/scheduler.autonomous.test.ts`, which uses the injected registrar instead of replacing
  `Deno.cron`, `src/server.test.ts` and the four `bot_actions*.test.ts` files.

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
  - `data/haru.sqlite3` is created

### Slice 5: Scripts

- `scripts/issue_agent/*`: `Deno.Command` becomes `Bun.spawn`, and `Deno.args` and `Deno.cwd()`
  become `process.argv.slice(2)` and `process.cwd()`.
- The sandbox and evaluation scripts open the SQLite facade (in memory, or a separate file, never
  production's) and use `process.argv` and `process.exitCode`.
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
  - Bun commands for setup, development, testing and formatting.
  - `HARU_DB_PATH` replaces `DENO_KV_PATH`.
  - A note that the database starts empty.
  - The Deno Deploy and Deno sections removed.
  - The AWS section marked as pending the deployment follow-up.
- CI (Bun only): `bun install --frozen-lockfile`, `bun fmt --check`, `bun check`, `bun test`,
  `bun run test:transport`, and the CloudFormation lint.

Verify:

- `git grep -n -i deno -- ':!docs/'` finds nothing except the deployment notes.
- Full suite: at least 543 tests plus the new `kv` tests, with every count difference against the
  baseline explained in the table below.
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
- **Fresh database.** The new database starts empty. Keep the old Deno KV file and its S3 backups
  untouched. Name the new backup differently (for example `kv/haru-bun.sqlite3`) so
  `kv/latest.sqlite3` keeps the last Deno backup.
- **Memory.** Check memory use on the `t4g.nano` (512 MB) after cutover.
- **`deploy_aws.sh`** still runs `cloudformation deploy` without `ExistingAmiId`. Fix that, or use
  only the app-only deploy path, before the first Bun deploy.
- **Rollback.** Redeploy `deno-final` with the old unit. The Deno KV file is still on the instance.

## Future work (after the port)

- Redesign the data model on SQLite: proper tables (votes, polls, rate limits, action state) instead
  of the generic `kv` table. The storage interfaces from slice 2 are the seam.
- Add `bun lint` to CI once it ships in a stable release.
- Restructure the repo layout (move the root-level modules into `src/`).

## Test-count differences against the baseline

Filled in during the port.

| File | Deno tests | Bun tests | Reason |
| ---- | ---------- | --------- | ------ |
