/** Discord Gateway WebSocket: receives MESSAGE_CREATE events and hands them to the bot. */

import { type BotDependencies, handleMessage } from "../bot/handle_message.ts";
import type { AppConfig } from "../config.ts";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

export function startGateway(
  config: AppConfig,
  deps: BotDependencies,
  onMessage: typeof handleMessage = handleMessage,
): void {
  if (!config.discordToken) {
    console.warn("DISCORD_TOKEN not set — gateway will not start");
    return;
  }

  let ws: WebSocket | null = null;
  let heartbeatHandle: number | undefined;
  let heartbeatIntervalMs = 45000;
  let seq: number | null = null;
  let awaitingHeartbeatAck = false;

  function sendHeartbeat(): void {
    try {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      if (awaitingHeartbeatAck) {
        console.warn("Missed heartbeat ACK, reconnecting gateway");
        ws.close();
        return;
      }

      ws.send(JSON.stringify({ op: 1, d: seq }));
      awaitingHeartbeatAck = true;
    } catch (e) {
      console.error("Heartbeat error", e);
    }
  }

  function startHeartbeatLoop(interval: number): void {
    heartbeatIntervalMs = interval;
    awaitingHeartbeatAck = false;

    if (heartbeatHandle) clearInterval(heartbeatHandle);

    const jitter = Math.random();
    setTimeout(
      () => {
        sendHeartbeat();

        heartbeatHandle = setInterval(() => {
          sendHeartbeat();
        }, heartbeatIntervalMs) as unknown as number;
      },
      Math.floor(heartbeatIntervalMs * jitter),
    );
  }

  function sendOnlinePresence(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(
      JSON.stringify({
        op: 3,
        d: {
          since: null,
          activities: [],
          status: "online",
          afk: false,
        },
      }),
    );
  }

  function connect(): void {
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
          startHeartbeatLoop(interval);

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
                os: "bun",
                browser: "bun",
                device: "bun",
              },
              presence: {
                since: null,
                activities: [],
                status: "online",
                afk: false,
              },
            },
          };
          ws?.send(JSON.stringify(identify));
        } // Op 0: Dispatch events
        else if (op === 0 && t === "READY" && d) {
          const user = d["user"] as Record<string, unknown> | undefined;
          const guilds = d["guilds"] as Array<Record<string, unknown>> | undefined;
          console.log(
            `[GATEWAY] Bot ready as: ${user?.username}#${user?.discriminator} (${user?.id})`,
          );
          console.log(`[GATEWAY] Connected to ${guilds?.length ?? 0} guild(s)`);
          sendOnlinePresence();
        } else if (op === 0 && t === "GUILD_CREATE" && d) {
          const guildName = d["name"] as string | undefined;
          const guildId = d["id"] as string | undefined;
          console.log(`[GATEWAY] Guild available: "${guildName}" (${guildId})`);
        } else if (op === 0 && t === "MESSAGE_CREATE" && d) {
          await onMessage(d as Record<string, unknown>, deps);
        } else if (op === 1) {
          sendHeartbeat();
        } else if (op === 11) {
          awaitingHeartbeatAck = false;
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
      if (heartbeatHandle) clearInterval(heartbeatHandle);
      heartbeatHandle = undefined;
      awaitingHeartbeatAck = false;
      setTimeout(connect, 5000);
    };

    ws.onerror = (ev: Event) => console.error("Gateway socket error", ev);
  }

  connect();
}
