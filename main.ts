// Environment variables
const DISCORD_TOKEN = Deno.env.get("DISCORD_TOKEN");
const GUILD_ID = Deno.env.get("GUILD_ID");

if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error("Error: Missing DISCORD_TOKEN or GUILD_ID environment variables.");
}

// Discord API Base URL
const API_BASE = "https://discord.com/api/v10";

// Headers for requests
const HEADERS = {
  Authorization: `Bot ${DISCORD_TOKEN}`,
  "Content-Type": "application/json",
};

// Interface for partial Channel object
interface DiscordChannel {
  id: string;
  name: string;
  type: number; // 0 is GUILD_TEXT
}

/**
 * Fetches all channels for the configured guild and finds the one named "sprint-retro".
 */
async function getChannelIdByName(channelName: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/guilds/${GUILD_ID}/channels`, {
      headers: HEADERS,
    });

    if (!res.ok) {
      console.error(`Failed to fetch channels: ${res.status} ${res.statusText}`);
      const body = await res.text();
      console.error(body);
      return null;
    }

    const channels: DiscordChannel[] = await res.json();
    const target = channels.find(
      (c) => c.name === channelName && c.type === 0 // Ensure it's a text channel
    );

    return target ? target.id : null;
  } catch (error) {
    console.error("Error fetching channels:", error);
    return null;
  }
}

/**
 * Posts the poll to the specified channel.
 */
async function postPoll(channelId: string) {
  const pollPayload = {
    poll: {
      question: { text: "Mood" },
      answers: [
        { poll_media: { text: "umazing" } },
        { poll_media: { text: "great" } },
        { poll_media: { text: "good" } },
        { poll_media: { text: "normal" } },
        { poll_media: { text: "bad" } },
        { poll_media: { text: "awful" } },
        { poll_media: { text: "glue" } },
      ],
      duration: 24, // Duration in hours
      allow_multiselect: false,
    },
  };

  try {
    const res = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(pollPayload),
    });

    if (res.ok) {
      console.log("Poll posted successfully!");
    } else {
      console.error(`Failed to post poll: ${res.status} ${res.statusText}`);
      const body = await res.text();
      console.error(body);
    }
  } catch (error) {
    console.error("Error posting poll:", error);
  }
}

// Cron Schedule: 05:00 UTC (which is 21:00 PST / 22:00 PDT)
// Deno Deploy cron format: minute hour day month day-of-week
Deno.cron("Daily Retro Poll", "0 5 * * *", async () => {
  if (!DISCORD_TOKEN || !GUILD_ID) {
    console.error("Skipping job due to missing env vars.");
    return;
  }

  console.log("Starting scheduled poll job...");

  const channelName = "sprint-retro";
  const channelId = await getChannelIdByName(channelName);

  if (channelId) {
    console.log(`Found channel '${channelName}' with ID: ${channelId}`);
    await postPoll(channelId);
  } else {
    console.error(`Channel '${channelName}' not found in guild '${GUILD_ID}'.`);
  }
});

// Keep the process alive for Deno Deploy (though cron usually handles this, serving a basic response is good practice)
Deno.serve((_req) => new Response("Discord Poll Bot is active."));
