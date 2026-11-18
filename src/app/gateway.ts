/** Discord Gateway WebSocket: receives MESSAGE_CREATE events and hands them to the bot. */

import { type BotDependencies, handleMessage } from "../bot/handle_message.ts";
import type { AppConfig } from "../config.ts";
import { log } from "./log.ts";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

export function startGateway(
  config: AppConfig,
  deps: BotDependencies,
  onMessage: typeof handleMessage = handleMessage,
): void {
  if (!config.discordToken) {
    log.warn("gateway", "DISCORD_TOKEN not set; the gateway will not start");
    return;
  }

  let ws: WebSocket | null = null;
  let heartbeatStart: ReturnType<typeof setTimeout> | undefined;
  let heartbeatHandle: ReturnType<typeof setInterval> | undefined;
  let heartbeatIntervalMs = 45000;
  let seq: number | null = null;
  let awaitingHeartbeatAck = false;

  function sendHeartbeat(): void {
    try {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ op: 1, d: seq }));
      awaitingHeartbeatAck = true;
    } catch (e) {
      log.error("gateway", "Heartbeat error", { err: e });
    }
  }

  /** A scheduled beat: reconnects instead if Discord never acknowledged the last one. */
  function heartbeatTick(): void {
    if (awaitingHeartbeatAck && ws?.readyState === WebSocket.OPEN) {
      log.warn("gateway", "Missed heartbeat ACK, reconnecting");
      ws.close();
      return;
    }
    sendHeartbeat();
  }

  function stopHeartbeat(): void {
    clearTimeout(heartbeatStart);
    clearInterval(heartbeatHandle);
    heartbeatStart = heartbeatHandle = undefined;
    awaitingHeartbeatAck = false;
  }

  function startHeartbeatLoop(interval: number): void {
    stopHeartbeat();
    heartbeatIntervalMs = interval;
    // Discord asks for the first beat after a random part of the interval.
    heartbeatStart = setTimeout(
      () => {
        heartbeatTick();
        heartbeatHandle = setInterval(heartbeatTick, heartbeatIntervalMs);
      },
      Math.floor(heartbeatIntervalMs * Math.random()),
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
    log.info("gateway", "Connecting to Discord");
    ws = new WebSocket(GATEWAY_URL);

    ws.onopen = () => log.info("gateway", "Connected");

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
          log.info("gateway", "Bot ready", {
            bot: `${user?.username}#${user?.discriminator}`,
            botId: user?.id,
            guilds: guilds?.length ?? 0,
          });
          sendOnlinePresence();
        } else if (op === 0 && t === "GUILD_CREATE" && d) {
          const guildName = d["name"] as string | undefined;
          const guildId = d["id"] as string | undefined;
          log.info("gateway", "Guild available", { guildId, guildName });
        } else if (op === 0 && t === "MESSAGE_CREATE" && d) {
          await onMessage(d as Record<string, unknown>, deps);
        } else if (op === 1) {
          // Discord asks for a beat now; answer even if the last one is unacknowledged.
          sendHeartbeat();
        } else if (op === 11) {
          awaitingHeartbeatAck = false;
        } // Op 9: Invalid session
        else if (op === 9) {
          log.warn("gateway", "Invalid session, reconnecting");
          ws?.close();
        }
      } catch (err) {
        log.error("gateway", "Message handling failed", { err });
      }
    };

    ws.onclose = (ev: CloseEvent) => {
      log.warn("gateway", "Socket closed", { code: ev.code, reason: ev.reason });
      stopHeartbeat();
      setTimeout(connect, 5000);
    };

    ws.onerror = (ev: Event) => log.error("gateway", "Socket error", { type: ev.type });
  }

  connect();
}
