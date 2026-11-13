# 🐴 Weabot

A Discord bot for daily mental health reflection, inspired by [Umamusume](https://umamusume.jp/).

## What is Weabot?

Weabot posts a daily mood poll to your Discord server, asking members to reflect on their day:

- **🌟 Umazing** – Having a great day!
- **😐 Ok** – Just okay.
- **🩹 Glue** – Glue

The bot also tracks mood trends and can alert when someone has been feeling "glue" for too many days
in a row.

---

## Features

- **Daily Polls**: Automatically posts a mood poll at 9 PM PST.
- **Wellness Alerts**: Daily check (10 PM PST) for users feeling "glue" for 7+ consecutive days.
- **Weekly Stats**: Posts a mood summary every Sunday at 10 PM PST.
- **Test Endpoints**: HTTP endpoints for testing without waiting for scheduled jobs.

Each can be turned off, or limited to some channels, under `mood_poll`, `wellness` and
`weekly_stats` in `config.yaml`. A disabled job is skipped, and its admin trigger answers `409`.

### Scheduled Jobs

| Job                  | Schedule              | Description                            |
| -------------------- | --------------------- | -------------------------------------- |
| Daily Retro Poll     | 05:00 UTC (9 PM PST)  | Posts the daily mood poll              |
| Daily Wellness Check | 06:00 UTC (10 PM PST) | Sends alerts for consecutive glue days |
| Weekly Stats Summary | Sundays 06:00 UTC     | Posts weekly mood trends               |

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) 1.4.x (the exact version is in `package.json` `packageManager`)
- A Discord Bot Token ([create one here](https://discord.com/developers/applications))
- A Discord Server where you have admin permissions

### 1. Clone the Repository

```bash
git clone https://github.com/YOUR_USERNAME/weabot.git
cd weabot
bun install
```

### 2. Create Your Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** and name it (e.g., "Weabot").
3. Go to the **Bot** tab and click **Reset Token** to get your bot token.
4. **Save this token** – you'll need it for the `.env` file.

### 3. Invite the Bot to Your Server

1. In the Developer Portal, go to **OAuth2 → URL Generator**.
2. Select the **bot** scope.
3. Select these permissions:
   - `Send Messages`
   - `Read Messages/View Channels`
   - `Embed Links`
   - `Timeout Members` (only for landmine timeouts)
4. Copy the generated URL and open it in your browser.
5. Select your server and authorize the bot.

### 4. Get Your Channel ID

1. In Discord, go to **User Settings → Advanced** and enable **Developer Mode**.
2. Right-click the channel where you want the bot to post.
3. Click **Copy Channel ID**.
4. Repeat for each server/channel you want Haru in.

### 5. Configure Haru

Haru reads two files. Copy both samples, then fill them in:

```bash
cp .env.sample .env                  # secrets
cp config.example.yaml config.yaml   # everything else
```

`.env` holds only secrets. `.env.sample` lists them and marks the required one:

| Variable               | Required | Description                                                                                                  |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `DISCORD_TOKEN`        | Yes      | Your Discord bot token                                                                                       |
| `AI_API_KEY`           | No       | Provider key (`OPENAI_API_KEY` and `OPENROUTER_API_KEY` also work for their provider); AI is off without one |
| `BRAVE_SEARCH_API_KEY` | No       | Brave Search key; web search is off without one                                                              |
| `ADMIN_HTTP_TOKEN`     | No       | Bearer token for the admin HTTP endpoints                                                                    |
| `OPENAI_ADMIN_KEY`     | No       | OpenAI admin key for `\usage` cost and token reports                                                         |

`config.yaml` holds every other setting. `config.example.yaml` documents each key and shows its
default. The essentials:

```yaml
discord:
  channel_ids: ["your_channel_id_here"] # required; add more for several servers or channels
general:
  time_zone: America/Los_Angeles
ai:
  provider: openai # or gemini (needs models and system_prompt_file) or openrouter (needs preset)
```

Every feature has its own section with the same two settings, plus its own:

```yaml
landmine:
  enabled: true # turns the feature on or off
  channel_ids: ["123456789012345678"] # where it works; empty or left out means discord.channel_ids
  chance: 0.1 # a setting of this feature
```

`channel_ids: all` makes a feature work in every channel Haru can read. It is allowed for `ai_chat`,
`web_search`, `link_open`, `tweet_read`, `discord_actions` and `landmine`. The jobs and autonomous
chat post to channels you name, so they need a list. `ai.enabled` is the master switch for AI:
`ai_chat`, `autonomous_chat` and `discord_actions` cannot work with it off. Haru refuses to start on
a key it does not know, so a typo cannot silently leave a setting at its default.

`config.yaml` is ignored by git, like `.env`, so create it from the example before anything else
runs: `bun run start`, `bun run dev`, the scripts and `bun test` all import it, and fail with
`Cannot find module './config.yaml'` without it. Any key you leave out uses its default. Quote
channel IDs in YAML. The two files never overlap: a setting lives in exactly one of them.

`.env` is loaded only by `bun run start` and `bun run dev`; the sandbox and evaluation scripts below
load it explicitly. Tests read neither file's values.

### 6. Run the Bot

```bash
# Production
bun run start

# Development (restarts on file changes)
bun run dev
```

You should see:

```
🐴 Haru is running!
   Channels: 123456789012345678
   Database: ./data/haru.sqlite3
   Timezone: America/Los_Angeles
   Glue Alert Threshold: 7 days
```

---

## Running with Docker

```bash
cp .env.sample .env      # fill in DISCORD_TOKEN and any optional keys
cp config.example.yaml config.yaml   # set discord.channel_ids
mkdir data && sudo chown 1000:1000 data
docker compose pull      # fetch the published image (or skip it to build locally)
docker compose up -d
docker compose logs -f haru
```

The log should show `🐴 Haru is running!`. The container runs as user `1000` and keeps the SQLite
database in `./data`. Run only one instance per Discord token, so stop `bun run dev` first.
Container logs are capped at three 10 MB files. No port is published, because the bot only makes
outbound connections. To reach the admin API from the host, add `ports: ["127.0.0.1:8000:8000"]` and
set `ADMIN_HTTP_TOKEN`. `config.yaml` is mounted read-only; copy it before the first `up`, or Docker
creates a directory in its place (remove it with `sudo rmdir config.yaml`).

Everyday commands, from the repository directory:

- After editing `.env` or `config.yaml`: `docker compose up -d --force-recreate`
- Stop: `docker compose down` (the database stays in `./data`)
- Update by hand: `docker compose pull && docker compose up -d`

### Updating automatically with systemd

The timer pulls images but never runs `git pull`. When an update adds a setting file or a mount (as
`config.yaml` did), run `git pull` and create the file before the new image arrives, or the
container restarts in a loop until you do.

`deploy/systemd/` holds a user service and timer that pull the latest image every 6 hours and
recreate the container only when the image changed. Install them from the repository directory:

```bash
mkdir -p ~/.config/systemd/user
sed "s#@PROJECT_DIR@#$PWD#" deploy/systemd/haru-update.service > ~/.config/systemd/user/haru-update.service
cp deploy/systemd/haru-update.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now haru-update.timer
```

Check it with `systemctl --user list-timers haru-update.timer`, run an update now with
`systemctl --user start haru-update.service`, and read the result with
`journalctl --user -u haru-update.service -n 20`. The update also starts a stopped stack, so enable
the timer only when you want Haru running. To keep it running while you are logged out, run
`sudo loginctl enable-linger $USER` once. Remove it with
`systemctl --user disable --now haru-update.timer`.

## Using Haru in Discord

Mention Haru to chat, or use a command:

- `@Haru hello there`
- `@Haru \usage` (month-to-date costs and token totals)
- `@Haru \reset` (persistently clear context for this channel or thread)
- `@Haru \open https://example.com [optional question]` (open and summarize one link safely)
- `@Haru https://x.com/user/status/123 what is this?` (reads the tweet's text, up to 4 photos per
  tweet and a quoted tweet via FxTwitter/VxTwitter; videos are skipped)

### Landmines

Configure landmines in the `landmine` section of `config.yaml`. With `enabled: true`, every message
in the landmine channels has a `chance` of being a landmine. Haru announces whoever steps on one
with the number of landmines left, and by default (`step_penalty.enabled: true`) the author is also
timed out for `step_penalty.timeout_seconds`. With the penalty off it only announces, and nothing
slows down a user who sends many messages, so landmines run out faster. If `gifs` lists GIF links,
one picked at random is added to the end of the announcement. There are 100,000 landmines in total,
shared by all servers and saved in the database; once they are gone, nothing happens.

A timeout is Discord's own, so the user cannot send messages in **any** channel of the server until
it ends. The bot needs the **Timeout Members** permission and a role above the members it times out.
Discord never lets a bot time out the server owner or administrators, so with timeouts on they are
immune: nothing is announced and the landmine is not used up.

### Activity-triggered participation

When autonomous chat is enabled, Haru can choose a useful brief reply, one emoji reaction to a
recent human message, or silence. A meme can get a simple acknowledgment without another chat
message. Direct mentions and commands still use the normal reply path.

The existing human activity threshold, random admission chance, token budget, configured channels,
and cooldown apply to all autonomous participation. The latest considered human message and attempt
time are persisted per channel in the database, so replies, reactions, silence, errors, and restarts
cannot repeatedly process the same conversation. Reaction targets exclude bots, webhooks, older
handled messages, and messages Haru already reacted to. Nearby messages by one author are
represented as a turn, with reply relationships intact. Connective fragments and trailing laughter
do not become anchors for a completed joke. A fresh burst settles for eight seconds before
consideration.

Haru chooses a meaningful target and intent: amusement, dry amusement, appreciation, celebration,
concern, or gentle disapproval. She may enjoy reciprocal teasing, but should not reward cruelty or
laugh at distress. Ambiguous cases favor silence. Pudding and Bot Sandbox have reviewed, guild-local
IDs for BocchiSip, RyoDisgust, Madge, UwU, shyggers, AYAYA, pog, and KEKW. Meanings describe the
actual images and constrain sarcastic or mocking uses. Other servers, unavailable emotes, or role
restrictions use intent-specific Unicode equivalents. No arbitrary emoji-name inference or
external-server IDs are used. Variation within an intent prefers a different expression from the
last delivered reaction; this preference persists across restarts. Reaction gateway events do not
trigger chat.

Haru needs View Channel and Read Message History in the configured channels, plus Add Reactions to
introduce an emoji reaction. Missing permissions, deleted messages, unavailable emojis, rate limits,
and ambiguous network failures quietly skip the reaction with a local diagnostic and no fallback
message. Permissions are never changed automatically. `autonomous_chat.reply_chance` retains its
name and now controls admission to choose any of the three actions.

The conversation, target, guild permissions, and expression availability are checked again before a
reaction write. Decision diagnostics contain IDs, bounded intent/reason codes, and delivery status;
they omit raw chat content. Autonomous replies disable notification mentions.

For model-quality cases covering the split joke, celebration, kindness, cruelty, and distress, with
no Discord access:

```bash
bun run eval:reactions --dry-run
```

For an explicit live sandbox test, post human-authored messages without an @Haru mention in Bot
Sandbox **#bitconnect-memes**. Note the ID of the message immediately before the test. The runner
only reads messages newer than that boundary, uses the production participation path, and starts no
gateway, scheduler, or server. Test admission is explicitly 100% with a one-human-message threshold;
production admission settings are unchanged. A preview makes no Discord writes. `--send` opts into
one reply/reaction/silence decision and persists sandbox duplicate protection in a separate
temporary SQLite file (`/tmp/haru-reaction-sandbox.bun.sqlite3`).

```bash
bun run sandbox:reactions --dry-run --after=BOUNDARY_MESSAGE_ID

bun run sandbox:reactions --send --after=BOUNDARY_MESSAGE_ID
```

The sandbox tool refuses other write destinations, DMs, and older targets. Verify Discord's actual
reaction and bot-owned emoji ID after a live test; a valid silent choice does not prove transport.

For a real AI smoke test using synthetic conversations and no Discord writes:

```bash
bun run sandbox:autonomous
```

### AI usage limits

`ai.rate_limit_per_user` counts admitted mention requests per user in fixed UTC minute buckets.
Admission atomically checks and consumes the allowance, so concurrent mentions share the same limit.
Rejected requests do not consume an allowance. Accepted requests count even if fetching context or
links, generating a reply, or sending to Discord subsequently fails.

`ai.budget.daily_tokens` is a **soft threshold** on reported tokens across mentions and autonomous
chat. Admission stops once recorded usage reaches it. Already admitted requests can finish above the
threshold; there are no token reservations or strict limits on in-flight usage. For example, two
requests admitted with 1 token remaining may each finish using 100 tokens, exceeding the budget
by 199. Use provider spending controls if a strict spending limit is required.

`ai.budget.daily_request_quota` is a soft limit on model calls per day, for providers with a daily
request quota such as a free tier. It is unset (unlimited) by default. Mentions are admitted while
today's calls are below `ai.budget.mention_percent` (default `90`) of the quota, and autonomous chat
while they are below `autonomous_chat.request_percent` (default `30`), so the bot leaves headroom
and autonomous chat cannot use up the day. Admission counts one call; a reply that needs more model
calls (tool steps, or Gemini trying another model) records the rest when it finishes, so the day can
overshoot slightly. This applies to every provider. Refusals use the same "brain power" reply as the
token budget.

Days follow midnight in `America/Los_Angeles`, when provider free-tier quotas reset. Reported
tokens, including usage returned with failed generations, are recorded atomically. Tokens and extra
tool-loop calls are charged to the day when the response is recorded; admitted requests count on
their admission day. Requests spanning midnight may therefore appear in different daily buckets.
Autonomous chat uses the same budget check and request accounting, but remains exempt from the human
per-user limit. Per-minute user counts are kept in memory, so a restart resets them (at most one
extra minute of allowance). Daily request and token totals are stored in the database for 30 days,
so a restart does not reset the budget.

### Discord events and invitations

Ask Haru directly in a server channel, for example:

- `@Haru create a game night event tomorrow at 8 PM Pacific in General voice, ending at 10 PM.`
- `@Haru create an event for a meetup at Central Park on September 12 at noon America/Vancouver, ending at 2 PM.`
- `@Haru create an invite for the game night event, expiring in one day.`
- `@Haru cancel the game night event.`
- `@Haru cancel the event https://discord.com/events/SERVER_ID/EVENT_ID`

Haru resolves the channel and local time, creates the event, and returns the actual Discord link.
When essential details are missing, it asks a short question; mention Haru again with your answer.
Unfinished requests are kept for 20 minutes and are scoped to the same user, server, and channel.
`@Haru \reset` also clears your unfinished action request in that channel.

Haru can cancel an existing event that has not started. Give its exact name or event link; if the
name matches more than one event, she asks you to pick a link. Saying “never mind” or “cancel my
request” abandons an unfinished request. Cancellation keeps her usual character and reports success
only when Discord confirms it. Cancelling an event does not revoke its server invitation. A newer
request or reset prevents a delayed reply from starting an older action. An action already sent to
Discord can still finish and return its receipt.

The event's creator needs Create Events or Manage Events; another user needs Manage Events. Haru
applies these ownership checks independently to you and herself. Discord records events created
through Haru as hers, so you need Manage Events to ask her to cancel them. Voice events also need
View Channel and Connect; Stage events need View Channel and Stage moderator permissions. External
events use server-level permissions. These checks apply independently to you and Haru.

Both the requester and Haru need the appropriate Discord permissions:

| Action         | Permissions                                                              |
| -------------- | ------------------------------------------------------------------------ |
| Voice event    | Create Events, View Channel, Connect in the voice channel                |
| Stage event    | Create Events, View Channel, Manage Channels, Mute Members, Move Members |
| External event | Create Events at server level; a location and end time are required      |
| Server invite  | View Channel and Create Invite in the selected channel                   |

Add these permissions to Haru's server role as needed. The initial message/view/embed permissions
above do not grant event creation. A direct event link works for members with access; an event
server invite can let new members join. Private-channel events use direct event links. Creating an
invite does not send DMs, ping members, or RSVP on their behalf.

`discord_actions.enabled` defaults to `true`; set it to `false` to disable these tools.
`discord_actions.channel_ids` limits them to some channels (`all` for every channel).
`discord_actions.guild_ids` optionally restricts tools to a list of server IDs. An empty list allows
actions in joined servers, subject to requester and bot permissions. This setting restricts
event/invite tools, not ordinary chat or scheduled jobs. `general.time_zone` supplies the default
timezone when the user does not name one. Daylight saving gaps and repeated times require
clarification.

This version creates individual events and invitations and cancels scheduled events. Ending active
events, cancelling recurring series or occurrences, other event edits/deletion, and bulk invitations
are not exposed to the AI. Autonomous chat and opened web pages cannot invoke these tools. Mutation
attempts are recorded in the database; ambiguous network outcomes are not automatically retried.
Read-only requests can retry a confirmed rate limit twice, respecting Discord's delay (up to 15
seconds per wait). If Haru cannot confirm a write, inspect Discord before issuing another request.

### Test event creation in Bot Sandbox

For an interactive local instance in Bot Sandbox's `#general`:

```bash
bun run sandbox:discord
```

Send `Haru local, create a game night event tomorrow at 8 PM in General voice, ending at 10 PM.`
Then try `Haru local, cancel the game night event.` Use the same `Haru local,` prefix for
clarification replies. Do not mention `@Haru`: the prefix isolates local testing when production
uses the same bot identity. The runner accepts human messages only in that exact sandbox channel,
uses in-memory state and the current test message as context, and does not start scheduled jobs,
autonomous chat, or the HTTP server. Events and invitations are real; stop with Ctrl-C and remove
test artifacts when finished. Normal mentions are ignored locally.

The API smoke-test runner (`scripts/sandbox/events.ts`) uses the configured bot token and OpenAI
key, but never starts the gateway, scheduled jobs, or HTTP server. It checks the exact Bot Sandbox
server and General channels, uses an in-memory database, and explicitly simulates a request from the
sandbox owner. It does not post chat messages. This permits API testing even when the bot identity
is also used in production.

```bash
# Real AI interpretation and sandbox metadata; event/invite writes are simulated.
bun run sandbox:events --dry-run

# Create and verify one real sandbox event and a 60-second, one-use invite, then clean up.
bun run sandbox:events
```

The runner prints the verified times, links, and cleanup results. Add `--keep` to the live command
to leave the event visible. Only newly created test artifacts are eligible for cleanup; an invite
that the bot cannot delete expires after 60 seconds. Use the sandbox runner above for interactive
testing, or use a separate test bot identity with `dev`. The normal `dev` command also starts
scheduled jobs and can respond in any server the bot can access.

### OpenRouter

Set `ai.provider: openrouter` and `ai.preset` in `config.yaml`, and `AI_API_KEY` (or
`OPENROUTER_API_KEY`) in `.env`. The preset, made at
[openrouter.ai/settings/presets](https://openrouter.ai/settings/presets), holds the persona, the
models, and the settings; each reply is sent to `@preset/<slug>` with only the conversation. Startup
stops if `ai.preset` is missing. Images are sent as links, so they must be public HTTPS images.
Prompt caching comes from the preset (`cache_enabled`).

Do not turn on OpenRouter server tools (web search, datetime, fetch) in the preset: they bypass
Haru's per-channel limits, and while they are on OpenRouter ignores the structured output that
autonomous chat needs. Replies run Discord event actions, and autonomous chat asks for the same
structured decision as OpenAI, only from endpoints that honor the output format. A reply that calls
tools stays on the model that made the first call, because the preset may rotate between models; if
that model fails midway, the reply fails. `\usage` shows Haru's own daily counts.

### Gemini

Set `ai.provider: gemini`, `ai.models` and `ai.system_prompt_file` in `config.yaml`, and
`AI_API_KEY` in `.env`. The persona is read from the file at startup, and startup stops if it or
`ai.models` is missing, even when AI chat is off. PNG, JPEG, WebP and GIF images are sent; other
attachments are skipped. Gemini replies and runs Discord event actions, and autonomous chat asks it
for the same structured decision as OpenAI. A reply that calls tools stays on the model that made
the first call; if that model fails midway, the reply fails.

`ai.models` is a list. Each reply tries the models in order, giving each 8 seconds. Any failure
other than a bad key or request (400, 401, 403) moves on to the next model, and every attempt counts
toward the daily request quota. If all fail, Haru says her brain is fuzzy. Put the most reliable
model first, since there is no cooldown for a model that is down.

Thinking is off by default: each request asks for the lowest thinking level (`minimal`), which on
Gemini 3 models keeps thinking to little or none rather than turning it off. Some models, such as
gemini-3.7-flash and gemini-3.8-flash, reject `minimal`; while thinking is off they are skipped and
the next model is tried. Set `ai.thinking: true` to send no thinking setting and use each model's
default, which is slower and spends more tokens.

With Gemini, `\usage` shows the requests and tokens Haru counted today instead of a billing report.
The request limit shown is the share of the quota that mentions may use.

### Month-to-date usage

With OpenAI, `@Haru \usage` in a configured bot channel reports UTC month-to-date OpenAI API cost
and input/cache/output tokens. The reply shows its date range and scope, for example:

```text
📊 Usage — October 2026 (month to date)
2026-10-01 → 2026-10-06 13:45 UTC
OpenAI API cost: $3.50
Input tokens: 1,234,567
Cache tokens: 123,000
Output tokens: 8,000
```

Values above are illustrative. OpenAI costs cover all API products, while tokens cover model
completions (including Responses). Totals include usage outside Haru. Cache tokens are included in
input tokens, and provider data may lag. Missing credentials or failed queries show **Unavailable**;
valid empty results show zero. Reports are cached for five minutes, share concurrent queries,
refresh on month rollover, and use a fifteen-second deadline. The command works with AI disabled or
its budget exhausted, without spending model tokens.

Set `OPENAI_ADMIN_KEY` in secret environment storage, separately from `AI_API_KEY`. Optionally set
`usage.openai_project_id` to filter both OpenAI costs and tokens to Haru's project. The report is
visible to channel members.

Source:
[OpenAI usage and costs](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage).

---

## Testing the Bot

Weabot provides HTTP endpoints for testing without waiting for scheduled jobs. All endpoints except
`GET /health` are disabled by default. To enable them locally, set `ADMIN_HTTP_TOKEN` to a random
secret in your environment before starting Haru. Send it as `Authorization: Bearer <token>` on every
admin request. State-changing endpoints require POST. Keep this variable unset in production unless
you explicitly need administration. Do not put the token in a URL.

Link opening resolves and checks both address families on every redirect, then connects directly to
one validated public IP. The original hostname remains the HTTP Host and verified TLS identity.
Private/reserved addresses, mixed public/private DNS answers, and URL credentials are rejected. A
single 8-second deadline covers DNS, connection setup, up to three redirects, response body reads,
and decompression. Redirects and slowly arriving chunks do not reset the deadline. The 1 MiB body
limit applies to decoded bytes. Abandoned bodies are canceled, readers released, and the deadline
timer cleared on every exit; download and decoding errors return structured failures.
`bun run test:transport` checks the real HTTP/TLS transport against loopback-only fixtures; CI runs
it too.

### Available Endpoints

**Trigger Endpoints** (post to Discord):

| Endpoint                        | Description           |
| ------------------------------- | --------------------- |
| `POST /trigger_poll`            | Post a mood poll      |
| `POST /trigger_stats?days=7`    | Post stats embed      |
| `POST /trigger_alert?name=Test` | Post a wellness alert |

**Data Endpoints** (view/modify data):

| Endpoint                       | Description                |
| ------------------------------ | -------------------------- |
| `POST /vote?user=ID&mood=MOOD` | Record a test vote         |
| `GET /stats?days=7`            | View stats as JSON         |
| `GET /check-alerts`            | Check who's at risk        |
| `GET /user-history?user=ID`    | View a user's vote history |

**Other**:

| Endpoint      | Description         |
| ------------- | ------------------- |
| `GET /health` | Health check ("OK") |

### Test Workflow

1. **Start the bot**:

   ```bash
   export ADMIN_HTTP_TOKEN="$(openssl rand -hex 32)"
   bun run dev
   ```

2. **Test the poll**:

   ```bash
   curl -X POST -H "Authorization: Bearer $ADMIN_HTTP_TOKEN" http://localhost:8000/trigger_poll
   ```

   Check your Discord channel – a poll should appear!

3. **Test the stats embed**:

   ```bash
   curl -X POST -H "Authorization: Bearer $ADMIN_HTTP_TOKEN" http://localhost:8000/trigger_stats
   ```

4. **Test the wellness alert**:

   ```bash
   # Post a sample alert (customize name and days)
   curl -X POST -H "Authorization: Bearer $ADMIN_HTTP_TOKEN" "http://localhost:8000/trigger_alert?name=TestUser&days=7"
   ```

5. **Simulate votes** (for testing real alerts):
   ```bash
   # Record some votes to populate data
   curl -X POST -H "Authorization: Bearer $ADMIN_HTTP_TOKEN" "http://localhost:8000/vote?user=test123&name=TestUser&mood=glue&date=2025-12-05"
   curl -X POST -H "Authorization: Bearer $ADMIN_HTTP_TOKEN" "http://localhost:8000/vote?user=test123&name=TestUser&mood=umazing&date=2025-12-06"
   curl -X POST -H "Authorization: Bearer $ADMIN_HTTP_TOKEN" "http://localhost:8000/vote?user=test123&name=TestUser&mood=ok&date=2025-12-07"

   # View stats as JSON
   curl -H "Authorization: Bearer $ADMIN_HTTP_TOKEN" http://localhost:8000/stats?days=7

   # Check who's at risk
   curl -H "Authorization: Bearer $ADMIN_HTTP_TOKEN" http://localhost:8000/check-alerts
   ```

---

## Project Structure

```
weabot/
├── main.ts                     # Entry point: wires services together and starts the app
├── src/
│   ├── config.ts               # Settings from config.yaml, secrets from .env
│   ├── config_schema.ts        # The keys config.yaml accepts; rejects typos
│   ├── feature_config.ts       # What every feature shares: enabled, channel_ids, isActiveIn
│   ├── app/                    # Gateway, HTTP server and cron schedule (started by main.ts)
│   ├── jobs/                   # Work shared by cron jobs and admin HTTP triggers
│   ├── bot/                    # Message handling: mentions, \usage, \reset, \open, AI replies
│   ├── ai/                     # AI service, providers/ (one folder each), participation, reply text
│   ├── features/               # Bot logic (polls, stats, chat context, reactions, landmines, Discord actions)
│   ├── services/               # Storage and rate limits
│   ├── discord/                # The only code that calls the Discord REST API
│   ├── net/                    # Public-web fetches: link opening, tweets, web search, retry
│   ├── db/                     # SQLite: opening, migrations, queries per table group
│   └── types/                  # Shared domain types
├── tests/
│   ├── support/                # Test helpers and the test preload
│   ├── fixtures/               # Loopback servers for transport tests
│   └── *.integration.ts        # HTTP/TLS transport tests (bun run test:transport)
├── scripts/
│   ├── sandbox/                # Manual runs against the sandbox Discord server
│   └── eval/                   # Reaction evaluation
├── config.example.yaml         # Documented settings; copy to config.yaml (ignored by git)
├── compose.yaml                # Docker Compose service
├── package.json                # Scripts and dependencies
├── bun.lock                    # Dependency lock file
├── bunfig.toml                 # Bun settings (tests, format, lint)
├── tsconfig.json               # Type-check settings
└── .github/workflows/ci.yml    # CI pipeline
```

Unit tests sit next to the file they test.

### AI providers

Each provider lives in its own folder under `src/ai/providers/` (`openai/`, `gemini/`,
`openrouter/`) and exports one `AiProviderModule` from its `index.ts`: a `create(config)` that
returns the adapter, an optional `apiKeyEnv` (the provider's own name for the key, such as
`OPENAI_API_KEY`, accepted when `AI_API_KEY` is not set), and, on the adapter, an optional
`usageReport()` for `\usage`. A provider with no `usageReport` shows Haru's own daily counts
instead. The registry in `src/ai/providers/index.ts` is the only list of providers, and the first
one in it is the default.

To add a provider, create its folder and register it there. To remove one, delete its folder and its
registry line (and its tests, its settings in `config.yaml` and, for Gemini, the `@google/genai`
dependency). Apart from a provider's own settings, nothing else in the bot names a provider.

---

## Development

### Run Tests

```bash
bun run test
bun run test:transport
```

`test:transport` runs the HTTP/TLS transport tests against loopback servers. Tests block network
calls that are not stubbed.

### Lint & Format

```bash
bun run lint
bun run fmt
bun run fmt:check
```

`lint` uses a pinned Bun canary through `bunx`, because `bun lint` is not in a stable Bun release
yet.

### Type Check

```bash
bun run check
```

### Data Storage

Haru keeps everything that must survive a restart in one SQLite database (`general.db_path`, default
`./data/haru.sqlite3`):

- polls and votes;
- `\reset` markers;
- the autonomous chat watermark, cooldown and last reaction;
- daily AI request and token totals (kept for 30 days);
- Discord action records and event guards, so an action is never repeated.

The schema is created and upgraded on startup. Haru refuses to start on a database written by a
newer version. Per-minute AI request counts, Discord action turns and pending clarifications are
kept in memory only.

### Changes From the Previous Runtime

Haru now runs on Bun and started with a new, empty database. These differences are intentional:

1. A pending clarification (for example, "what time should the event start?") is forgotten on
   restart; repeat the request.
2. A restart resets the per-minute AI request counts. The daily budget is unaffected.
3. Link requests send `User-Agent: HaruBot/1.0`.
4. `\usage` no longer reports AWS cost; it shows OpenAI cost and tokens only.
5. A link path starting with `//` is requested with a single `/`.
6. A gzip body followed by trailing zero bytes fails to decode.
7. An admin HTTP request that sends nothing for 120 seconds is cut off.

Weekly stats no longer drop or duplicate a day across a daylight saving change.

---

## Acknowledgments

- Inspired by [Umamusume Pretty Derby](https://umamusume.jp/)
- Built with [Bun](https://bun.sh/) and the Discord API

---

Made with 💙 by friends who care about each other's mental health.
