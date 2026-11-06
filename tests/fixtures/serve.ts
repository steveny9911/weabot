/** Loopback fixture servers for the transport tests. */
import { cert, key } from "./link_tls.ts";

export interface Fixture {
  port: number;
  /** Closes the listener and every open connection, so a cancellation bug fails instead of hanging. */
  shutdown(): Promise<void>;
}

export function serveFixture(
  handler: (request: Request) => Response | Promise<Response>,
  options: { tls?: boolean; hostname?: string } = {},
): Fixture {
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: 0,
    // Longer than the 20 s test timeout, so a client that never closes fails the test instead of
    // being rescued by the server dropping the idle connection.
    idleTimeout: 30,
    ...(options.tls ? { tls: { cert, key } } : {}),
    fetch: handler,
  });
  return {
    port: server.port!,
    async shutdown() {
      await server.stop(true);
    },
  };
}
