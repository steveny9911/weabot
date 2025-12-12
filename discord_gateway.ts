import { handleMessage } from "./bot_actions.ts";

const DISCORD_TOKEN = Deno.env.get("DISCORD_TOKEN");

function startGateway() {
  if (!DISCORD_TOKEN) {
    console.warn("DISCORD_TOKEN not set — gateway will not start");
    return;
  }

  const GATEWAY_URL = `wss://gateway.discord.gg/?v=10&encoding=json`;
  let ws: WebSocket | null = null;
  let heartbeatHandle: number | undefined;
  let seq: number | null = null;

  function connect() {
    console.log("Connecting to Discord Gateway...");
    ws = new WebSocket(GATEWAY_URL);

    ws.onopen = () => console.log("Gateway connected");

    ws.onmessage = async (ev) => {
      try {
        const payload = JSON.parse(ev.data as string) as Record<string, unknown>;
        const op = payload.op as number | undefined;
        const t = payload.t as string | undefined;
        const d = payload.d as Record<string, unknown> | undefined;
        const s = payload.s as number | undefined;
        if (typeof s === "number") seq = s;

        if (op === 10 && d) {
          const interval = (d["heartbeat_interval"] as number) ?? 45000;
          if (heartbeatHandle) clearInterval(heartbeatHandle);
          heartbeatHandle = setInterval(() => {
            try {
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ op: 1, d: seq }));
              }
            } catch (e) {
              console.error("Heartbeat error", e);
            }
          }, interval) as unknown as number;

          const identify = {
            op: 2,
            d: {
              token: DISCORD_TOKEN,
              intents: 33280, // GUILD_MESSAGES + MESSAGE_CONTENT + DIRECT_MESSAGES
              properties: { $os: "deno", $browser: "deno", $device: "deno" },
            },
          };
          ws?.send(JSON.stringify(identify));
        } else if (op === 0 && t === "MESSAGE_CREATE" && d) {
          await handleMessage(d as Record<string, unknown>);
        } else if (op === 9) {
          console.warn("Invalid session, reconnecting");
          ws?.close();
        }
      } catch (err) {
        console.error("Gateway message error", err);
      }
    };

    ws.onclose = (ev) => {
      console.warn("Gateway socket closed", ev.code, ev.reason);
      if (heartbeatHandle) clearInterval(heartbeatHandle);
      setTimeout(connect, 5000);
    };

    ws.onerror = (ev) => console.error("Gateway socket error", ev);
  }

  connect();
}

export { startGateway };
