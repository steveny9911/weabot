/** Caller lifecycle over real pinned loopback HTTP/TLS sockets. */
import { describe, expect, test } from "bun:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { createServer, type Socket } from "node:net";
import { requestPinned } from "../src/services/public_fetch.ts";
import { createLinkOpenService } from "../src/services/link_open.ts";
import type { AppConfig } from "../src/config.ts";
import { realFetch } from "../test_support/setup.ts";
import { assert } from "../test_support/assert.ts";
import { ca } from "./fixtures/link_tls.ts";
import { serveFixture } from "./fixtures/serve.ts";

// requestPinned uses the global fetch; this file needs real loopback connections.
globalThis.fetch = realFetch;

/** Bypass only DNS policy for isolated transport fixtures, retaining the actual
 * production HTTP/TLS implementation and all service-level response handling. */
function fixtureService(timeoutMs = 200) {
  return createLinkOpenService({} as AppConfig, {
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

describe("open closes live rejected and oversized response sockets", () => {
  for (const reason of ["status", "content-type", "stream-limit"] as const) {
    test(reason, async () => {
      const closed = Promise.withResolvers<void>();
      const server = serveFixture(() => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(reason === "stream-limit" ? 1024 * 1024 + 1 : 16));
          },
          cancel() {
            closed.resolve();
          },
        });
        return new Response(body, {
          status: reason === "status" ? 503 : 200,
          headers: {
            "content-type": reason === "content-type" ? "application/json" : "text/html",
          },
        });
      });
      try {
        expect(
          await fixtureService().open(`http://public.example:${server.port}/reject`),
        ).toStrictEqual({
          ok: false,
          error:
            reason === "status"
              ? "fetch_failed"
              : reason === "content-type"
                ? "unsupported_content_type"
                : "response_too_large",
        });
        await assertClosed(closed.promise);
      } finally {
        await server.shutdown();
      }
    });
  }
});

test("open cancels a live redirect body before fetching the next page", async () => {
  const closed = Promise.withResolvers<void>();
  let requests = 0;
  const server = serveFixture((request) => {
    requests++;
    if (new URL(request.url).pathname === "/start") {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([32]));
          },
          cancel() {
            closed.resolve();
          },
        }),
        { status: 302, headers: { location: "/page" } },
      );
    }
    return new Response("<title>Redirect</title><p>ordinary page works</p>", {
      headers: { "content-type": "text/html" },
    });
  });
  try {
    expect(await fixtureService().open(`http://public.example:${server.port}/start`)).toStrictEqual(
      {
        ok: true,
        page: {
          domain: "public.example",
          title: "Redirect",
          excerpt: "Redirect ordinary page works",
        },
      },
    );
    await assertClosed(closed.promise);
    expect(requests).toStrictEqual(2);
  } finally {
    await server.shutdown();
  }
});

describe("open handles malformed compressed bodies as structured fetch failures", () => {
  for (const encoding of ["gzip", "deflate", "br", "unsupported"]) {
    test(encoding, async () => {
      const server = serveFixture(
        () =>
          new Response(new Uint8Array([0xff, 0xff, 0xff]), {
            headers: { "content-type": "text/html", "content-encoding": encoding },
          }),
      );
      try {
        expect(
          await fixtureService().open(`http://public.example:${server.port}/bad`),
        ).toStrictEqual({
          ok: false,
          error: "fetch_failed",
        });
      } finally {
        await server.shutdown();
      }
    });
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

describe("open times out incomplete compressed streams and closes their sockets", () => {
  for (const [encoding, compressed] of [
    ["gzip", gzipSync("<html>partial compressed body</html>")],
    ["deflate", deflateSync("<html>partial compressed body</html>")],
    ["br", brotliCompressSync("<html>partial compressed body</html>")],
  ] as const) {
    test(encoding, async () => {
      const closed = Promise.withResolvers<void>();
      const server = serveFixture(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(compressed.subarray(0, 3)));
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
          await fixtureService(100).open(`http://public.example:${server.port}/compressed-stall`),
        ).toStrictEqual({
          ok: false,
          error: "timeout",
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

describe("open returns structured failure after a socket closes mid-body", () => {
  for (const framing of ["content-length", "chunked"] as const) {
    test(framing, async () => {
      const server = await rawServer(async (socket) => {
        const headers =
          framing === "content-length" ? "Content-Length: 100" : "Transfer-Encoding: chunked";
        const body = framing === "content-length" ? "<html>truncated" : "ff\r\n<html>truncated";
        await new Promise<void>((resolve) =>
          socket.end(
            `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n${headers}\r\nConnection: close\r\n\r\n${body}`,
            resolve,
          ),
        );
      });
      try {
        expect(
          await fixtureService().open(`http://public.example:${server.port}/broken`),
        ).toStrictEqual({ ok: false, error: "fetch_failed" });
        await server.handled;
      } finally {
        server.close();
      }
    });
  }
});

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
