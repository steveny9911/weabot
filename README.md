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

- **Daily Polls**: Automatically posts a mood poll at a scheduled time.
- **Stats Dashboard**: View aggregated mood statistics as a Discord embed.
- **Wellness Alerts**: Get notified when a user reports "glue" for 7 consecutive days.
- **Test Endpoints**: HTTP endpoints for testing without waiting for scheduled jobs.

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

### 5. Configure Environment Variables

Create a `.env` file in the project root:

```bash
# Required
DISCORD_TOKEN=your_bot_token_here
CHANNEL_ID=your_channel_id_here

# Optional
TIME_ZONE=America/Los_Angeles
GLUE_ALERT_THRESHOLD=7
```

| Variable               | Required | Description                                                   |
| ---------------------- | -------- | ------------------------------------------------------------- |
| `DISCORD_TOKEN`        | Yes      | Your Discord bot token                                        |
| `CHANNEL_ID`           | Yes      | The channel ID where polls are posted                         |
| `TIME_ZONE`            | No       | Timezone for date formatting (default: `America/Los_Angeles`) |
| `GLUE_ALERT_THRESHOLD` | No       | Days of consecutive "glue" before alert (default: `7`)        |

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
   Channel: 123456789012345678
   Timezone: America/Los_Angeles
   Glue Alert Threshold: 7 days
```

---

## Testing the Bot

Weabot provides HTTP endpoints for testing without waiting for scheduled jobs.

### Available Endpoints

| Endpoint                      | Description                     |
| ----------------------------- | ------------------------------- |
| `GET /health`                 | Health check (returns "OK")     |
| `GET /trigger`                | Manually post a poll to Discord |
| `GET /vote?user=ID&mood=MOOD` | Record a test vote              |
| `GET /stats?days=7&post=true` | View or post stats embed        |
| `GET /check-alerts?send=true` | Check/send wellness alerts      |
| `GET /user-history?user=ID`   | View a user's vote history      |

### Test Workflow

1. **Start the bot**:
   ```bash
   deno task dev
   ```

2. **Trigger a poll manually**:
   ```bash
   curl http://localhost:8000/trigger
   ```
   Check your Discord channel – a poll should appear!

3. **Simulate votes** (for testing alerts):
   ```bash
   # Simulate 7 days of "glue" votes for user "test123"
   curl "http://localhost:8000/vote?user=test123&name=TestUser&mood=glue&date=2025-12-05"
   curl "http://localhost:8000/vote?user=test123&name=TestUser&mood=glue&date=2025-12-06"
   curl "http://localhost:8000/vote?user=test123&name=TestUser&mood=glue&date=2025-12-07"
   curl "http://localhost:8000/vote?user=test123&name=TestUser&mood=glue&date=2025-12-08"
   curl "http://localhost:8000/vote?user=test123&name=TestUser&mood=glue&date=2025-12-09"
   curl "http://localhost:8000/vote?user=test123&name=TestUser&mood=glue&date=2025-12-10"
   curl "http://localhost:8000/vote?user=test123&name=TestUser&mood=glue&date=2025-12-11"
   ```

4. **Check for alerts**:
   ```bash
   # Preview who's at risk
   curl http://localhost:8000/check-alerts

   # Actually send alerts to Discord
   curl "http://localhost:8000/check-alerts?send=true"
   ```

5. **View stats**:
   ```bash
   # Get stats as JSON
   curl http://localhost:8000/stats?days=7

   # Post stats embed to Discord
   curl "http://localhost:8000/stats?days=7&post=true"
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
│   │   └── storage.ts          # Deno KV storage service
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

---

## Deployment

Weabot is designed to run on [Deno Deploy](https://deno.com/deploy), which provides:

- Automatic HTTPS
- Built-in Deno KV for data persistence
- Cron job support

To deploy:

1. Push your code to GitHub.
2. Connect your repo to Deno Deploy.
3. Set the environment variables in the Deno Deploy dashboard.
4. Deploy!

## Acknowledgments

- Inspired by [Umamusume Pretty Derby](https://umamusume.jp/)
- Built with [Deno](https://deno.land/) and the Discord API

---

Made with 💙 by friends who care about each other's mental health.
