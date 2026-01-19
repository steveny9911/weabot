/**
 * Discord Gateway
 *
 * Establishes a WebSocket connection to Discord's Gateway API
 * to receive real-time events like MESSAGE_CREATE.
 */

import { type BotDependencies, handleMessage } from "./bot_actions.ts";
import type { AppConfig } from "./src/config.ts";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

/**
 * Starts the Discord Gateway WebSocket connection.
 * Receives real-time events and dispatches them to handlers.
 */
export function startGateway(config: AppConfig, deps: BotDependencies): void {
  if (!config.discordToken) {
    console.warn("DISCORD_TOKEN not set — gateway will not start");
    return;
  }

  let ws: WebSocket | null = null;
  let heartbeat_handle: number | undefined;
  let seq: number | null = null;

  function vConnect(): void {
    console.log("Connecting to Discord Gateway...");
    ws = new WebSocket(GATEWAY_URL);

    ws.onopen = () => console.log("Gateway connected");

    ws.onmessage = async (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data as string) as Record<string, unknown>;
        const op = payload.op as number | undefined;
        const t = payload.t as string | undefined;
        const d = payload.d as Record<string, unknown> | undefined;
        const s = payload.s as number | undefined;

        if (typeof s === "number") seq = s;

        // Op 10: Hello - start heartbeat and identify
        if (op === 10 && d) {
          const interval = (d["heartbeat_interval"] as number) ?? 45000;

          if (heartbeat_handle) clearInterval(heartbeat_handle);

          heartbeat_handle = setInterval(() => {
            try {
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ op: 1, d: seq }));
              }
            } catch (e) {
              console.error("Heartbeat error", e);
            }
          }, interval) as unknown as number;

          // Send identify payload
          // Intents breakdown:
          // - GUILDS (1 << 0 = 1) - Required to receive GUILD_CREATE events
          // - GUILD_MESSAGES (1 << 9 = 512) - Receive messages in guilds
          // - DIRECT_MESSAGES (1 << 12 = 4096) - Receive DMs
          // - MESSAGE_CONTENT (1 << 15 = 32768) - Read message content (privileged)
          const intents = 1 + 512 + 4096 + 32768; // = 37377
          const identify = {
            op: 2,
            d: {
              token: config.discordToken,
              intents,
              properties: {
                os: "deno",
                browser: "deno",
                device: "deno",
              },
            },
          };
          ws?.send(JSON.stringify(identify));
        } // Op 0: Dispatch events
        else if (op === 0 && t === "READY" && d) {
          // Log bot info and guilds on ready
          const user = d["user"] as Record<string, unknown> | undefined;
          const guilds = d["guilds"] as Array<Record<string, unknown>> | undefined;
          console.log(`[GATEWAY] Bot ready as: ${user?.username}#${user?.discriminator} (${user?.id})`);
          console.log(`[GATEWAY] Connected to ${guilds?.length ?? 0} guild(s)`);
        } else if (op === 0 && t === "GUILD_CREATE" && d) {
          // Log when we receive guild info
          const guild_name = d["name"] as string | undefined;
          const guild_id = d["id"] as string | undefined;
          console.log(`[GATEWAY] Guild available: "${guild_name}" (${guild_id})`);
        } else if (op === 0 && t === "MESSAGE_CREATE" && d) {
          await handleMessage(d as Record<string, unknown>, deps);
        } // Op 9: Invalid session
        else if (op === 9) {
          console.warn("Invalid session, reconnecting");
          ws?.close();
        }
      } catch (err) {
        console.error("Gateway message error", err);
      }
    };

    ws.onclose = (ev: CloseEvent) => {
      console.warn("Gateway socket closed", ev.code, ev.reason);
      if (heartbeat_handle) clearInterval(heartbeat_handle);
      // Reconnect after 5 seconds
      setTimeout(vConnect, 5000);
    };

    ws.onerror = (ev: Event) => console.error("Gateway socket error", ev);
  }

  vConnect();
}
