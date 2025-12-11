import { startGateway } from "./discord_gateway.ts";
import { postPoll } from "./bot_actions.ts";

// Start gateway in background
startGateway();

// Re-add daily poll cron: 05:00 UTC
Deno.cron("Daily Retro Poll", "0 5 * * *", async () => {
	const channel = Deno.env.get("CHANNEL_ID");
	if (!channel) {
		console.error("Skipping daily poll: CHANNEL_ID not set");
		return;
	}
	try {
		console.log("Running scheduled poll job for channel", channel);
		await postPoll(channel);
	} catch (err) {
		console.error("Error running scheduled poll:", err);
	}
});

// Keep a simple HTTP health endpoint available for platforms that expect it
Deno.serve((_req) => new Response("Discord Poll Bot is active."));
