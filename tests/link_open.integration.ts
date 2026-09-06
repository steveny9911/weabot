/** Caller lifecycle over real pinned loopback HTTP/TLS sockets. */
import { assert, assertEquals } from "@std/assert";
import { requestPinned } from "../src/services/public_fetch.ts";
import { ca, cert, key } from "./fixtures/link_tls.ts";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { createLinkOpenService } from "../src/services/link_open.ts";
import type { AppConfig } from "../src/config.ts";

/** Bypass only DNS policy for isolated transport fixtures, retaining the actual
 * production HTTP/TLS implementation and all service-level response handling. */
function fixtureService(timeoutMs = 200) {
  return createLinkOpenService({} as AppConfig, {
    timeoutMs,
    fetch: (url, init) => requestPinned(new URL(url), "127.0.0.1", init.signal ?? undefined, ca),
  });
}

/** Teardown also closes active fixture sockets if an assertion fails, so a
 * future cancellation regression fails CI instead of hanging graceful shutdown. */
function serveFixture(
  options: { hostname: string; port: number; onListen: () => void; cert?: string; key?: string },
  handler: (request: Request) => Response,
) {
  const controller = new AbortController();
  const server = Deno.serve({ ...options, signal: controller.signal }, handler);
  return {
    addr: server.addr,
    async shutdown() {
      controller.abort();
      await server.finished;
    },
  };
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

Deno.test("open times out stalled and trickling HTTP/TLS bodies and closes sockets", async (t) => {
  for (const tls of [false, true]) {
    for (const trickle of [false, true]) {
      await t.step(`${tls ? "HTTPS" : "HTTP"} ${trickle ? "trickle" : "stall"}`, async () => {
        let interval: ReturnType<typeof setInterval> | undefined;
        const closed = Promise.withResolvers<void>();
        const server = serveFixture({
          hostname: "127.0.0.1",
          port: 0,
          ...(tls ? { cert, key } : {}),
          onListen() {},
        }, () =>
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
          ));
        try {
          const start = performance.now();
          assertEquals(
            await fixtureService(100).open(
              `${tls ? "https" : "http"}://public.example:${server.addr.port}/stall`,
            ),
            {
              ok: false,
              error: "timeout",
            },
          );
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

Deno.test("open closes live rejected and oversized response sockets", async (t) => {
  for (const reason of ["status", "content-type", "stream-limit"] as const) {
    await t.step(reason, async () => {
      const closed = Promise.withResolvers<void>();
      const server = serveFixture({ hostname: "127.0.0.1", port: 0, onListen() {} }, () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new Uint8Array(reason === "stream-limit" ? 1024 * 1024 + 1 : 16),
            );
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
        assertEquals(
          await fixtureService().open(`http://public.example:${server.addr.port}/reject`),
          {
            ok: false,
            error: reason === "status"
              ? "fetch_failed"
              : reason === "content-type"
              ? "unsupported_content_type"
              : "response_too_large",
          },
        );
        await assertClosed(closed.promise);
      } finally {
        await server.shutdown();
      }
    });
  }
});

Deno.test("open cancels a live redirect body before fetching the next page", async () => {
  const closed = Promise.withResolvers<void>();
  let requests = 0;
  const server = serveFixture({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
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
    assertEquals(await fixtureService().open(`http://public.example:${server.addr.port}/start`), {
      ok: true,
      page: {
        domain: "public.example",
        title: "Redirect",
        excerpt: "Redirect ordinary page works",
      },
    });
    await assertClosed(closed.promise);
    assertEquals(requests, 2);
  } finally {
    await server.shutdown();
  }
});

Deno.test("open handles malformed compressed bodies as structured fetch failures", async (t) => {
  // Deno 2.6 silently accepts some malformed Brotli payloads; use gzip and
  // deflate to verify errors actually emitted by the runtime become failures.
  for (const encoding of ["gzip", "deflate", "unsupported"]) {
    await t.step(encoding, async () => {
      const server = serveFixture(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        () =>
          new Response(new Uint8Array([0xff, 0xff, 0xff]), {
            headers: { "content-type": "text/html", "content-encoding": encoding },
          }),
      );
      try {
        assertEquals(await fixtureService().open(`http://public.example:${server.addr.port}/bad`), {
          ok: false,
          error: "fetch_failed",
        });
      } finally {
        await server.shutdown();
      }
    });
  }
});

Deno.test("open bounds decompressed bytes and closes a compressed streaming response", async (t) => {
  for (
    const [encoding, compressed] of [
      ["gzip", gzipSync("x".repeat(1024 * 1024 + 1))],
      ["deflate", deflateSync("x".repeat(1024 * 1024 + 1))],
      ["br", brotliCompressSync("x".repeat(1024 * 1024 + 1))],
    ] as const
  ) {
    await t.step(encoding, async () => {
      const closed = Promise.withResolvers<void>();
      const server = serveFixture(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
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
        assertEquals(
          await fixtureService().open(`http://public.example:${server.addr.port}/large`),
          {
            ok: false,
            error: "response_too_large",
          },
        );
        await assertClosed(closed.promise);
      } finally {
        await server.shutdown();
      }
    });
  }
});

Deno.test("open times out incomplete compressed streams and closes their sockets", async (t) => {
  for (
    const [encoding, compressed] of [
      ["gzip", gzipSync("<html>partial compressed body</html>")],
      ["deflate", deflateSync("<html>partial compressed body</html>")],
      ["br", brotliCompressSync("<html>partial compressed body</html>")],
    ] as const
  ) {
    await t.step(encoding, async () => {
      const closed = Promise.withResolvers<void>();
      const server = serveFixture(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
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
        assertEquals(
          await fixtureService(100).open(
            `http://public.example:${server.addr.port}/compressed-stall`,
          ),
          {
            ok: false,
            error: "timeout",
          },
        );
        await assertClosed(closed.promise);
      } finally {
        await server.shutdown();
      }
    });
  }
});

Deno.test("open returns structured failure after a socket closes mid-body", async (t) => {
  for (const framing of ["content-length", "chunked"] as const) {
    await t.step(framing, async () => {
      const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const server = (async () => {
        using connection = await listener.accept();
        await connection.read(new Uint8Array(4096));
        const headers = framing === "content-length"
          ? "Content-Length: 100"
          : "Transfer-Encoding: chunked";
        const body = framing === "content-length" ? "<html>truncated" : "ff\r\n<html>truncated";
        const response = new TextEncoder().encode(
          `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n${headers}\r\nConnection: close\r\n\r\n${body}`,
        );
        let offset = 0;
        while (offset < response.length) {
          offset += await connection.write(response.subarray(offset));
        }
      })();
      try {
        assertEquals(
          await fixtureService().open(`http://public.example:${listener.addr.port}/broken`),
          {
            ok: false,
            error: "fetch_failed",
          },
        );
        await server;
      } finally {
        listener.close();
      }
    });
  }
});

Deno.test("open rejects oversized Content-Length before downloading the remaining body", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  let connection: Deno.Conn | undefined;
  const server = (async () => {
    connection = await listener.accept();
    try {
      await connection.read(new Uint8Array(4096));
      const response = new TextEncoder().encode(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 1048577\r\nConnection: close\r\n\r\n<html>beginning",
      );
      let offset = 0;
      while (offset < response.length) offset += await connection.write(response.subarray(offset));
      // The client must close without waiting for the advertised body length.
      assertEquals(await connection.read(new Uint8Array(4096)), null);
    } finally {
      connection.close();
      connection = undefined;
    }
  })();
  try {
    assertEquals(
      await fixtureService().open(`http://public.example:${listener.addr.port}/declared-large`),
      {
        ok: false,
        error: "response_too_large",
      },
    );
    await assertClosed(server);
  } finally {
    connection?.close();
    listener.close();
  }
});
