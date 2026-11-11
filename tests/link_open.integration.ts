/** Caller lifecycle over real pinned loopback HTTP/TLS sockets. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { createServer, type Socket } from "node:net";
import { requestPinned } from "../src/net/public_fetch.ts";
import { createLinkOpenService } from "../src/net/link_open.ts";
import { realFetch } from "./support/setup.ts";
import { assert } from "./support/assert.ts";
import { ca } from "./fixtures/link_tls.ts";
import { serveFixture } from "./fixtures/serve.ts";

// requestPinned uses the global fetch; this file needs real loopback connections.
const blockedFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = realFetch;
});
afterAll(() => {
  globalThis.fetch = blockedFetch;
});

/** Bypass only DNS policy for isolated transport fixtures, retaining the actual
 * production HTTP/TLS implementation and all service-level response handling. */
function fixtureService(timeoutMs = 200) {
  return createLinkOpenService({
    timeoutMs,
    fetch: (url, init) => requestPinned(new URL(url), "127.0.0.1", init.signal ?? undefined, ca),
  });
}

async function assertClosed(closed: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("client connection was not closed")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("open times out stalled and trickling HTTP/TLS bodies and closes sockets", () => {
  for (const tls of [false, true]) {
    for (const trickle of [false, true]) {
      test(`${tls ? "HTTPS" : "HTTP"} ${trickle ? "trickle" : "stall"}`, async () => {
        let interval: ReturnType<typeof setInterval> | undefined;
        const closed = Promise.withResolvers<void>();
        const server = serveFixture(
          () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("<html>headers received"));
                  if (trickle) {
                    interval = setInterval(() => controller.enqueue(new Uint8Array([32])), 5);
                  }
                },
                cancel() {
                  clearInterval(interval);
                  closed.resolve();
                },
              }),
              { headers: { "content-type": "text/html" } },
            ),
          { tls },
        );
        try {
          const start = performance.now();
          expect(
            await fixtureService(100).open(
              `${tls ? "https" : "http"}://public.example:${server.port}/stall`,
            ),
          ).toStrictEqual({
            ok: false,
            error: "timeout",
          });
          assert(performance.now() - start < 1000);
          await assertClosed(closed.promise);
        } finally {
          clearInterval(interval);
          await server.shutdown();
        }
      });
    }
  }
});
describe("open bounds decompressed bytes and closes a compressed streaming response", () => {
  for (const [encoding, compressed] of [
    ["gzip", gzipSync("x".repeat(1024 * 1024 + 1))],
    ["deflate", deflateSync("x".repeat(1024 * 1024 + 1))],
    ["br", brotliCompressSync("x".repeat(1024 * 1024 + 1))],
  ] as const) {
    test(encoding, async () => {
      const closed = Promise.withResolvers<void>();
      const server = serveFixture(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(compressed));
              },
              cancel() {
                closed.resolve();
              },
            }),
            { headers: { "content-type": "text/html", "content-encoding": encoding } },
          ),
      );
      try {
        expect(
          await fixtureService().open(`http://public.example:${server.port}/large`),
        ).toStrictEqual({
          ok: false,
          error: "response_too_large",
        });
        await assertClosed(closed.promise);
      } finally {
        await server.shutdown();
      }
    });
  }
});

/** A raw TCP server for responses Bun.serve cannot produce. Accepts one connection. */
async function rawServer(onConnection: (socket: Socket) => Promise<void>) {
  const sockets = new Set<Socket>();
  const handled = Promise.withResolvers<void>();
  const server = createServer((socket) => {
    sockets.add(socket);
    // Respond once the request has arrived.
    socket.once("data", () => {
      onConnection(socket).then(handled.resolve, handled.reject);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    port: address.port,
    handled: handled.promise,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

test("open rejects oversized Content-Length before downloading the remaining body", async () => {
  const server = await rawServer(async (socket) => {
    socket.write(
      "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 1048577\r\nConnection: close\r\n\r\n<html>beginning",
    );
    // The client must close without waiting for the advertised body length.
    await new Promise<void>((resolve, reject) => {
      socket.once("data", () => reject(new Error("client sent more data")));
      socket.once("end", resolve);
      socket.once("close", resolve);
    });
  });
  try {
    expect(
      await fixtureService().open(`http://public.example:${server.port}/declared-large`),
    ).toStrictEqual({ ok: false, error: "response_too_large" });
    await assertClosed(server.handled);
  } finally {
    server.close();
  }
});
