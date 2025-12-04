// Environment variables
const DISCORD_TOKEN = Deno.env.get("DISCORD_TOKEN");
const CHANNEL_ID = Deno.env.get("CHANNEL_ID");

if (!DISCORD_TOKEN || !CHANNEL_ID) {
  console.error(
    "Error: Missing DISCORD_TOKEN or CHANNEL_ID environment variables.",
  );
}

// Discord API Base URL
const API_BASE = "https://discord.com/api/v10";

// Headers for requests
const HEADERS = {
  Authorization: `Bot ${DISCORD_TOKEN}`,
  "Content-Type": "application/json",
};

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

/**
 * Posts the poll to the specified channel.
 */
async function postPoll(channelId: string) {
  const pollPayload = {
    poll: {
      question: { text: `Mood (${dateFormatter.format(new Date())})` },
      answers: [
        { poll_media: { text: "umazing" } },
        { poll_media: { text: "ok" } },
        { poll_media: { text: "glue" } },
      ],
      duration: 24, // Duration in hours
      allow_multiselect: false,
    },
  };

  try {
    const response = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(pollPayload),
    });

    if (response.ok) {
      console.log("Poll posted successfully!");
    } else {
      console.error(`Failed to post poll: ${response.status} ${response.statusText}`);
      const body = await response.text();
      console.error(body);
    }
  } catch (error) {
    console.error("Error posting poll:", error);
  }
}

// Cron Schedule: 05:00 UTC (which is 21:00 PST / 22:00 PDT)
// Deno Deploy cron format: minute hour day month day-of-week
Deno.cron("Daily Retro Poll", "0 5 * * *", async () => {
  if (!DISCORD_TOKEN || !CHANNEL_ID) {
    console.error("Skipping job due to missing env vars.");
    return;
  }

  console.log("Starting scheduled poll job...");
  await postPoll(CHANNEL_ID);

  return;
});

// todo create and delete nightly channel

// Keep the process alive for Deno Deploy (though cron usually handles this, serving a basic response is good practice)
Deno.serve((_req) => new Response("Discord Poll Bot is active."));
