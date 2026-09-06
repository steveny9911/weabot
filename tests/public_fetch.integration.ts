/** Actual Deno transport tests: only loopback networking, no public DNS. */
import { assertEquals, assertRejects } from "@std/assert";
import { requestPinned } from "../src/services/public_fetch.ts";
import { ca, cert, key } from "./fixtures/link_tls.ts";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";

Deno.test("pinned HTTP connects to numeric IP with original Host/path and no credentials", async () => {
  let seen = 0;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req) => {
    seen++;
    assertEquals(req.headers.get("host"), `public.example:${server.addr.port}`);
    assertEquals(new URL(req.url).pathname + new URL(req.url).search, "/page?q=1");
    assertEquals(req.headers.get("authorization"), null);
    assertEquals(req.headers.get("cookie"), null);
    return new Response("<html>HTTP works</html>", { headers: { "content-type": "text/html" } });
  });
  try {
    const response = await requestPinned(
      new URL(`http://public.example:${server.addr.port}/page?q=1`),
      "127.0.0.1",
    );
    assertEquals(await response.text(), "<html>HTTP works</html>");
    assertEquals(seen, 1);
  } finally {
    await server.shutdown();
  }
});

Deno.test("pinned HTTPS verifies original hostname using trusted SAN and preserves Host", async () => {
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, cert, key, onListen() {} }, (req) => {
    assertEquals(req.headers.get("host"), `public.example:${server.addr.port}`);
    return new Response("<html>HTTPS works</html>");
  });
  try {
    const response = await requestPinned(
      new URL(`https://public.example:${server.addr.port}/`),
      "127.0.0.1",
      undefined,
      ca,
    );
    assertEquals(await response.text(), "<html>HTTPS works</html>");
  } finally {
    await server.shutdown();
  }
});

Deno.test("pinned HTTPS refuses hostname mismatch and untrusted certificates before HTTP", async () => {
  let requests = 0;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, cert, key, onListen() {} }, () => {
    requests++;
    return new Response("must not reach handler");
  });
  try {
    await assertRejects(() =>
      requestPinned(
        new URL(`https://wrong.example:${server.addr.port}/`),
        "127.0.0.1",
        undefined,
        ca,
      )
    );
    await assertRejects(() =>
      requestPinned(new URL(`https://public.example:${server.addr.port}/`), "127.0.0.1")
    );
    assertEquals(requests, 0);
  } finally {
    await server.shutdown();
  }
});

Deno.test("pinned transport never automatically follows a redirect", async () => {
  let requests = 0;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, () => {
    requests++;
    return new Response(null, { status: 302, headers: { location: "/private" } });
  });
  try {
    const response = await requestPinned(
      new URL(`http://public.example:${server.addr.port}/`),
      "127.0.0.1",
    );
    assertEquals(response.status, 302);
    assertEquals(response.headers.get("location"), "/private");
    await response.body?.cancel();
    assertEquals(requests, 1);
  } finally {
    await server.shutdown();
  }
});

Deno.test("pinned transport decodes gzip, deflate, and brotli before size-limited reading", async (t) => {
  const html = "<html><title>Compressed</title><body>hello</body></html>";
  for (
    const [encoding, compressed] of [["gzip", gzipSync(html)], ["deflate", deflateSync(html)], [
      "br",
      brotliCompressSync(html),
    ]] as const
  ) {
    await t.step(encoding, async () => {
      const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        () =>
          new Response(new Uint8Array(compressed), {
            headers: { "content-encoding": encoding, "content-length": String(compressed.length) },
          }),
      );
      try {
        const response = await requestPinned(
          new URL(`http://public.example:${server.addr.port}/`),
          "127.0.0.1",
        );
        assertEquals(response.headers.get("content-length"), null);
        assertEquals(await response.text(), html);
      } finally {
        await server.shutdown();
      }
    });
  }
});

Deno.test("pinned request abort closes a connection waiting for headers", async () => {
  const controller = new AbortController();
  let finish: (() => void) | undefined;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async () => {
    controller.abort();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return new Response("late");
  });
  try {
    await assertRejects(
      () =>
        requestPinned(
          new URL(`http://public.example:${server.addr.port}/`),
          "127.0.0.1",
          controller.signal,
        ),
      DOMException,
      "Aborted",
    );
  } finally {
    finish?.();
    await server.shutdown();
  }
});
