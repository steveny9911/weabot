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

### Scheduled Jobs

| Job                  | Schedule              | Description                            |
| -------------------- | --------------------- | -------------------------------------- |
| Daily Retro Poll     | 05:00 UTC (9 PM PST)  | Posts the daily mood poll              |
| Daily Wellness Check | 06:00 UTC (10 PM PST) | Sends alerts for consecutive glue days |
| Weekly Stats Summary | Sundays 06:00 UTC     | Posts weekly mood trends               |

---

## Quick Start

### Prerequisites

- [Deno](https://deno.land/) v2.x installed
- A Discord Bot Token ([create one here](https://discord.com/developers/applications))
- A Discord Server where you have admin permissions

### 1. Clone the Repository

```bash
git clone https://github.com/YOUR_USERNAME/weabot.git
cd weabot
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
4. Copy the generated URL and open it in your browser.
5. Select your server and authorize the bot.

### 4. Get Your Channel ID

1. In Discord, go to **User Settings → Advanced** and enable **Developer Mode**.
2. Right-click the channel where you want the bot to post.
3. Click **Copy Channel ID**.
4. Repeat for each server/channel if using `CHANNEL_IDS`.

### 5. Configure Environment Variables

Create a `.env` file in the project root:

```bash
# Required
DISCORD_TOKEN=your_bot_token_here
CHANNEL_ID=your_channel_id_here

# Optional
TIME_ZONE=America/Los_Angeles
GLUE_ALERT_THRESHOLD=7
LINK_OPEN_ENABLED=true
AI_CONTEXT_MAX_MESSAGES=40
AI_CONTEXT_INACTIVITY_MINUTES=20

# Multi-server (optional)
# CHANNEL_IDS=channel_id_1,channel_id_2
```

| Variable                        | Required | Description                                                   |
| ------------------------------- | -------- | ------------------------------------------------------------- |
| `DISCORD_TOKEN`                 | Yes      | Your Discord bot token                                        |
| `CHANNEL_ID`                    | Yes*     | Default channel ID (used if `CHANNEL_IDS` not set)            |
| `CHANNEL_IDS`                   | Yes*     | Comma-separated channel IDs for multi-server posting          |
| `TIME_ZONE`                     | No       | Timezone for date formatting (default: `America/Los_Angeles`) |
| `GLUE_ALERT_THRESHOLD`          | No       | Days of consecutive "glue" before alert (default: `7`)        |
| `LINK_OPEN_ENABLED`             | No       | Enable `\open` link command (default: `true`)                 |
| `AI_CONTEXT_MAX_MESSAGES`       | No       | Max messages from the current conversation (default: `40`)    |
| `AI_CONTEXT_INACTIVITY_MINUTES` | No       | Silence that starts a new context (default: `20`)             |

_Set either `CHANNEL_ID` or `CHANNEL_IDS`._

### 6. Run the Bot

```bash
# Production
deno task start

# Development (with hot reload)
deno task dev
```

You should see:

```
🐴 Weabot is running!
   Channels: 123456789012345678
   Timezone: America/Los_Angeles
   Glue Alert Threshold: 7 days
```

---

## Using Haru in Discord

Mention Haru to chat, or use a command:

- `@Haru hello there`
- `@Haru \reset` (persistently clear context for this channel or thread)
- `@Haru \open https://example.com [optional question]` (open and summarize one link safely)

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
only when Discord confirms it. Cancelling an event does not revoke its server invitation.

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

`DISCORD_ACTIONS_ENABLED` defaults to `true`; set it to `false` to disable these tools.
`DISCORD_ACTIONS_GUILD_IDS` optionally restricts tools to comma-separated server IDs. An empty list
allows actions in joined servers, subject to requester and bot permissions. This setting restricts
event/invite tools, not ordinary chat or scheduled jobs. `TIME_ZONE` supplies the default timezone
when the user does not name one. Daylight saving gaps and repeated times require clarification.

This version creates individual events and invitations and cancels scheduled events. Ending active
events, cancelling recurring series or occurrences, other event edits/deletion, and bulk invitations
are not exposed to the AI. Autonomous chat and opened web pages cannot invoke these tools. Mutation
attempts are recorded in Deno KV; ambiguous network outcomes are not automatically retried.
Read-only requests can retry a confirmed rate limit twice, respecting Discord's delay (up to 15
seconds per wait). If Haru cannot confirm a write, inspect Discord before issuing another request.

### Test event creation in Bot Sandbox

For an interactive local instance in Bot Sandbox's `#general`:

```bash
deno run --unstable-kv --env-file=.env --allow-env \
  --allow-net=discord.com,gateway.discord.gg,api.openai.com scripts/run_discord_sandbox.ts
```

Send `Haru local, create a game night event tomorrow at 8 PM in General voice, ending at 10 PM.`
Then try `Haru local, cancel the game night event.` Use the same `Haru local,` prefix for
clarification replies. Do not mention `@Haru`: the prefix isolates local testing when AWS uses the
same bot identity. The runner accepts human messages only in that exact sandbox channel, uses
in-memory state and the current test message as context, and does not start scheduled jobs,
autonomous chat, or the HTTP server. Events and invitations are real; stop with Ctrl-C and remove
test artifacts when finished. Normal mentions are ignored locally.

The API smoke-test runner (`scripts/test_discord_events.ts`) uses the configured bot token and
OpenAI key, but never starts the gateway, scheduled jobs, or HTTP server. It checks the exact Bot
Sandbox server and General channels, uses an in-memory database, and explicitly simulates a request
from the sandbox owner. It does not post chat messages. This permits API testing even when the bot
identity is also used in production.

```bash
# Real AI interpretation and sandbox metadata; event/invite writes are simulated.
deno run --unstable-kv --env-file=.env --allow-env \
  --allow-net=discord.com,api.openai.com scripts/test_discord_events.ts --dry-run

# Create and verify one real sandbox event and a 60-second, one-use invite, then clean up.
deno run --unstable-kv --env-file=.env --allow-env \
  --allow-net=discord.com,api.openai.com scripts/test_discord_events.ts
```

The runner prints the verified times, links, and cleanup results. Add `--keep` to the live command
to leave the event visible. Only newly created test artifacts are eligible for cleanup; an invite
that the bot cannot delete expires after 60 seconds. Use the sandbox runner above for interactive
testing, or use a separate test bot identity with `dev`. The normal `dev` command also starts
scheduled jobs and can respond in any server the bot can access.

## Testing the Bot

Weabot provides HTTP endpoints for testing without waiting for scheduled jobs.

### Available Endpoints

**Trigger Endpoints** (post to Discord):

| Endpoint                       | Description           |
| ------------------------------ | --------------------- |
| `GET /trigger_poll`            | Post a mood poll      |
| `GET /trigger_stats?days=7`    | Post stats embed      |
| `GET /trigger_alert?name=Test` | Post a wellness alert |

**Data Endpoints** (view/modify data):

| Endpoint                      | Description                |
| ----------------------------- | -------------------------- |
| `GET /vote?user=ID&mood=MOOD` | Record a test vote         |
| `GET /stats?days=7`           | View stats as JSON         |
| `GET /check-alerts`           | Check who's at risk        |
| `GET /user-history?user=ID`   | View a user's vote history |

**Other**:

| Endpoint      | Description         |
| ------------- | ------------------- |
| `GET /health` | Health check ("OK") |

### Test Workflow

1. **Start the bot**:
   ```bash
   deno task dev
   ```

2. **Test the poll**:
   ```bash
   curl http://localhost:8000/trigger_poll
   ```
   Check your Discord channel – a poll should appear!

3. **Test the stats embed**:
   ```bash
   curl http://localhost:8000/trigger_stats
   ```

4. **Test the wellness alert**:
   ```bash
   # Post a sample alert (customize name and days)
   curl "http://localhost:8000/trigger_alert?name=TestUser&days=7"
   ```

5. **Simulate votes** (for testing real alerts):
   ```bash
   # Record some votes to populate data
   curl "http://localhost:8000/vote?user=test123&name=TestUser&mood=glue&date=2025-12-05"
   curl "http://localhost:8000/vote?user=test123&name=TestUser&mood=umazing&date=2025-12-06"
   curl "http://localhost:8000/vote?user=test123&name=TestUser&mood=ok&date=2025-12-07"

   # View stats as JSON
   curl http://localhost:8000/stats?days=7

   # Check who's at risk
   curl http://localhost:8000/check-alerts
   ```

---

## Project Structure

```
weabot/
├── main.ts                     # Entry point
├── src/
│   ├── config.ts               # Environment configuration
│   ├── server.ts               # HTTP server & endpoints
│   ├── scheduler.ts            # Cron job definitions
│   ├── types/
│   │   ├── bot.ts              # Domain types (Mood, MoodPollConfig)
│   │   ├── discord.ts          # Discord API types
│   │   └── storage.ts          # Storage types (VoteRecord, etc.)
│   ├── services/
│   │   ├── discord.ts          # Discord API client
│   │   ├── storage.ts          # Deno KV storage service
│   │   ├── web_search.ts       # Brave web search integration
│   │   ├── link_open.ts        # Safe HTML link opener for \open command
│   │   └── rate_limit.ts       # AI usage/rate limiting
│   └── features/
│       ├── poll/               # Poll creation logic
│       │   ├── mod.ts
│       │   ├── payload.ts
│       │   └── poll.test.ts
│       └── stats/              # Stats & embed generation
│           ├── mod.ts
│           └── embed.ts
├── deno.json                   # Task definitions
├── deno.lock                   # Dependency lock file
└── .github/workflows/ci.yml    # CI pipeline
```

---

## Development

### Run Tests

```bash
deno task test
```

### Lint & Format

```bash
deno task lint
deno task fmt
```

### Type Check

```bash
deno task check
```

### Local Issue Automation (Codex + GitHub Issues)

If Haru is running locally, you can still automate issue triage and PR creation from this Mac.

Prerequisites:

1. `gh` is installed and authenticated (`gh auth status`).
2. Token has `repo` scope (for labels/comments/closing/PRs).
3. Commands run from this repository root.

Agent state labels used by automation:

1. `agent:accepted`
2. `agent:needs-info`
3. `agent:rejected`
4. `agent:in-progress`
5. `agent:pr-open`
6. `agent:closed-inactive`

These labels are auto-created/updated by the scripts below.

Run triage:

```bash
deno task agent:triage
```

Run stale close (close rejected/needs-info issues after 3 days inactive):

```bash
deno task agent:stale-close
```

Run the full triage + stale-close + claim-next cycle:

```bash
deno task agent:run-once
```

Claim next accepted issue for implementation (prints JSON):

```bash
deno task agent:next-issue -- --claim
```

Mark an issue as PR-open after a PR is created:

```bash
deno task agent:mark-pr-open -- 123 https://github.com/OWNER/REPO/pull/456
```

Suggested recurring loop:

1. `deno task agent:triage`
2. `deno task agent:stale-close`
3. `deno task agent:next-issue -- --claim`
4. If issue found: implement + test + open PR
5. `deno task agent:mark-pr-open -- <issue_number> <pr_url>`

---

## AWS Deployment

The production deployment uses a small ARM EC2 instance in the account's default VPC. It has no
inbound ports, is administered through AWS Systems Manager, restarts Haru after process or health
check failures, and backs up Deno KV to a private versioned S3 bucket each day.

Prerequisites:

- AWS CLI v2 with an authenticated profile
- `jq` and `sqlite3`
- A pushed Git commit that the EC2 instance can fetch

Deploy from the repository root, migrating the current local KV database if desired:

```bash
AWS_PROFILE=mochi-admin ./scripts/deploy_aws.sh \
  --migrate-kv /path/to/deno/location_data/project/kv.sqlite3
```

Useful operations:

```bash
# Show the instance ID and backup bucket
aws cloudformation describe-stacks --profile mochi-admin --region us-west-2 \
  --stack-name haru-bot --query 'Stacks[0].Outputs'

# Open a shell without SSH or an inbound firewall rule
aws ssm start-session --profile mochi-admin --region us-west-2 --target INSTANCE_ID

# Inside the instance
sudo systemctl status haru
sudo journalctl -u haru -n 100 --no-pager
```

Secrets from `.env` are copied to an encrypted SSM `SecureString`; they are never embedded in the
CloudFormation template. The `/health` and manual trigger endpoints remain accessible only from the
instance itself.

## Acknowledgments

- Inspired by [Umamusume Pretty Derby](https://umamusume.jp/)
- Built with [Deno](https://deno.land/) and the Discord API

---

Made with 💙 by friends who care about each other's mental health.
