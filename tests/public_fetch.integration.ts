/** Real transport tests: only loopback networking, no public DNS. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { createServer } from "node:net";
import { requestPinned } from "../src/services/public_fetch.ts";
import { realFetch } from "../test_support/setup.ts";
import { rejects } from "../test_support/assert.ts";
import { ca } from "./fixtures/link_tls.ts";
import { serveFixture } from "./fixtures/serve.ts";

// requestPinned uses the global fetch; this file needs real loopback connections.
globalThis.fetch = realFetch;

/** True when this machine can listen on the IPv6 loopback address. */
async function hasIpv6Loopback(): Promise<boolean> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "::1", resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    server.close();
  }
}
const ipv6 = await hasIpv6Loopback();
if (!ipv6) console.warn("IPv6 loopback is unavailable here; skipping the IPv6 pinning test.");

test("pinned HTTP connects to numeric IP with original Host/path and no credentials", async () => {
  let seen = 0;
  let headers: Headers | undefined;
  let path = "";
  const server = serveFixture((req) => {
    seen++;
    headers = req.headers;
    path = new URL(req.url).pathname + new URL(req.url).search;
    return new Response("<html>HTTP works</html>", { headers: { "content-type": "text/html" } });
  });
  try {
    const response = await requestPinned(
      new URL(`http://public.example:${server.port}/page?q=1`),
      "127.0.0.1",
    );
    expect(await response.text()).toBe("<html>HTTP works</html>");
    expect(seen).toBe(1);
    expect(headers?.get("host")).toBe(`public.example:${server.port}`);
    expect(path).toBe("/page?q=1");
    expect(headers?.get("authorization")).toBeNull();
    expect(headers?.get("cookie")).toBeNull();
    expect(headers?.get("accept")).toBe("text/html,application/xhtml+xml");
    expect(headers?.get("accept-encoding")).toBe("gzip, deflate, br");
    expect(headers?.get("user-agent")).toBe("HaruBot/1.0");
  } finally {
    await server.shutdown();
  }
});

test("pinned HTTPS verifies original hostname using trusted SAN and preserves Host", async () => {
  let host = null as string | null;
  const server = serveFixture(
    (req) => {
      host = req.headers.get("host");
      return new Response("<html>HTTPS works</html>");
    },
    { tls: true },
  );
  try {
    const response = await requestPinned(
      new URL(`https://public.example:${server.port}/`),
      "127.0.0.1",
      undefined,
      ca,
    );
    expect(await response.text()).toBe("<html>HTTPS works</html>");
    expect(host).toBe(`public.example:${server.port}`);
  } finally {
    await server.shutdown();
  }
});

test("pinned HTTPS refuses hostname mismatch and untrusted certificates before HTTP", async () => {
  let requests = 0;
  const server = serveFixture(
    () => {
      requests++;
      return new Response("must not reach handler");
    },
    { tls: true },
  );
  try {
    await rejects(() =>
      requestPinned(new URL(`https://wrong.example:${server.port}/`), "127.0.0.1", undefined, ca),
    );
    await rejects(() =>
      requestPinned(new URL(`https://public.example:${server.port}/`), "127.0.0.1"),
    );
    expect(requests).toBe(0);
  } finally {
    await server.shutdown();
  }
});

test("pinned transport never automatically follows a redirect", async () => {
  let requests = 0;
  const server = serveFixture(() => {
    requests++;
    return new Response(null, { status: 302, headers: { location: "/private" } });
  });
  try {
    const response = await requestPinned(
      new URL(`http://public.example:${server.port}/`),
      "127.0.0.1",
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/private");
    await response.body?.cancel();
    expect(requests).toBe(1);
  } finally {
    await server.shutdown();
  }
});

describe("pinned transport decodes gzip, deflate, and brotli before size-limited reading", () => {
  const html = "<html><title>Compressed</title><body>hello</body></html>";
  for (const [encoding, compressed] of [
    ["gzip", gzipSync(html)],
    ["deflate", deflateSync(html)],
    ["br", brotliCompressSync(html)],
  ] as const) {
    test(encoding, async () => {
      const server = serveFixture(
        () =>
          new Response(new Uint8Array(compressed), {
            headers: {
              "content-encoding": encoding,
              "content-length": String(compressed.length),
            },
          }),
      );
      try {
        const response = await requestPinned(
          new URL(`http://public.example:${server.port}/`),
          "127.0.0.1",
        );
        expect(response.headers.get("content-length")).toBeNull();
        expect(await response.text()).toBe(html);
      } finally {
        await server.shutdown();
      }
    });
  }
});

test("pinned request abort closes a connection waiting for headers", async () => {
  const controller = new AbortController();
  let finish: (() => void) | undefined;
  const server = serveFixture(async () => {
    controller.abort();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return new Response("late");
  });
  try {
    await rejects(
      () =>
        requestPinned(
          new URL(`http://public.example:${server.port}/`),
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

describe("pinned HTTP and HTTPS body cancellation release a stalled connection", () => {
  for (const secure of [false, true]) {
    test(secure ? "HTTPS" : "HTTP", async () => {
      const closed = Promise.withResolvers<void>();
      const server = serveFixture(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("first"));
              },
              cancel() {
                closed.resolve();
              },
            }),
          ),
        { tls: secure },
      );
      try {
        const response = await requestPinned(
          new URL(`${secure ? "https" : "http"}://public.example:${server.port}/`),
          "127.0.0.1",
          undefined,
          ca,
        );
        const reader = response.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
        await reader.cancel();
        reader.releaseLock();
        await closed.promise;
      } finally {
        await server.shutdown();
      }
    });
  }
});

describe("pinned HTTP and HTTPS abort reject a pending body read without uncaught errors", () => {
  for (const secure of [false, true]) {
    test(secure ? "HTTPS" : "HTTP", async () => {
      const abort = new AbortController();
      const server = serveFixture(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("first"));
              },
            }),
          ),
        { tls: secure },
      );
      try {
        const response = await requestPinned(
          new URL(`${secure ? "https" : "http"}://public.example:${server.port}/`),
          "127.0.0.1",
          abort.signal,
          ca,
        );
        const reader = response.body!.getReader();
        await reader.read();
        const pending = reader.read();
        abort.abort();
        await rejects(() => pending);
        reader.releaseLock();
      } finally {
        await server.shutdown();
      }
    });
  }
});

describe("pinned transport reports corrupt or unsupported compression and closes resources", () => {
  for (const encoding of ["gzip", "deflate", "br", "zstd", "constructor", "unsupported"]) {
    test(encoding, async () => {
      const abort = new AbortController();
      const deadline = setTimeout(() => abort.abort(), 1000);
      const server = serveFixture(
        () =>
          new Response(new Uint8Array([1, 2, 3]), { headers: { "content-encoding": encoding } }),
      );
      try {
        await rejects(async () => {
          const response = await requestPinned(
            new URL(`http://public.example:${server.port}/`),
            "127.0.0.1",
            abort.signal,
          );
          await response.text();
        });
        // Invalid bodies must fail before the deadline.
        expect(abort.signal.aborted).toBe(false);
      } finally {
        clearTimeout(deadline);
        await server.shutdown();
      }
    });
  }
});

test("pinned transport returns no body for 204, 205 and 304", async () => {
  for (const status of [204, 205, 304]) {
    const server = serveFixture(() => new Response(null, { status }));
    try {
      const response = await requestPinned(
        new URL(`http://public.example:${server.port}/`),
        "127.0.0.1",
      );
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
    } finally {
      await server.shutdown();
    }
  }
});

test("pinned transport ignores proxy environment variables", async () => {
  let proxied = 0;
  const proxy = serveFixture(() => {
    proxied++;
    return new Response("proxied");
  });
  const server = serveFixture(() => new Response("direct"));
  const saved = { ...process.env };
  try {
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
      process.env[name] = process.env[name.toLowerCase()] = `http://127.0.0.1:${proxy.port}`;
    }
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    const response = await requestPinned(
      new URL(`http://public.example:${server.port}/`),
      "127.0.0.1",
    );
    expect(await response.text()).toBe("direct");
    expect(proxied).toBe(0);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    await server.shutdown();
    await proxy.shutdown();
  }
});

describe("pinned transport over IPv6", () => {
  let server: ReturnType<typeof serveFixture> | undefined;
  let host: string | null = null;
  beforeAll(() => {
    if (!ipv6) return;
    server = serveFixture(
      (req) => {
        host = req.headers.get("host");
        return new Response("v6 works");
      },
      { hostname: "::1" },
    );
  });
  afterAll(() => server?.shutdown());

  test.skipIf(!ipv6)("connects to an IPv6 literal with the original Host", async () => {
    const response = await requestPinned(new URL(`http://public.example:${server!.port}/`), "::1");
    expect(await response.text()).toBe("v6 works");
    expect(host).toBe(`public.example:${server!.port}`);
  });
});
