import { expect, test } from "bun:test";
import { assert } from "../../tests/support/assert.ts";
import { createLinkOpenService } from "./link_open.ts";

const html = (body: string | null) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html" } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

/** Opens `url` on a service whose every page fetch is answered by `handler`. */
function openWith(url: string, handler: (url: string) => Response) {
  return createLinkOpenService({ fetch: async (target) => handler(target) }).open(url);
}

test("open rejects invalid url", async () => {
  const service = createLinkOpenService();
  const result = await service.open("not-a-url");
  expect(result).toStrictEqual({ ok: false, error: "invalid_url" });
});
test("open rejects blocked hosts", async () => {
  const service = createLinkOpenService();

  const localhost = await service.open("http://localhost/test");
  expect(localhost).toStrictEqual({ ok: false, error: "blocked_host" });

  const privateIp = await service.open("http://10.0.0.1/test");
  expect(privateIp).toStrictEqual({ ok: false, error: "blocked_host" });

  const metadata = await service.open("http://metadata.google.internal/test");
  expect(metadata).toStrictEqual({ ok: false, error: "blocked_host" });
});

test("open rejects too many redirects", async () => {
  let hop = 0;
  const result = await openWith("https://start.example/", () =>
    redirect(`https://hop${++hop}.example/`),
  );
  expect(result).toStrictEqual({ ok: false, error: "too_many_redirects" });
});

test("open rejects redirect to blocked host", async () => {
  const result = await openWith("https://safe.example/start", () =>
    redirect("http://127.0.0.1/internal"),
  );
  expect(result).toStrictEqual({ ok: false, error: "redirect_blocked" });
});

test("open rejects non-html content", async () => {
  const result = await openWith(
    "https://safe.example/data.json",
    () => new Response("{}", { headers: { "content-type": "application/json" } }),
  );
  expect(result).toStrictEqual({ ok: false, error: "unsupported_content_type" });
});

test("open rejects oversized response by content-length", async () => {
  const result = await openWith(
    "https://safe.example/large",
    () =>
      new Response("<html>tiny</html>", {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-length": String(1024 * 1024 + 1),
        },
      }),
  );
  expect(result).toStrictEqual({ ok: false, error: "response_too_large" });
});

test("open returns timeout on abort error", async () => {
  const result = await openWith("https://safe.example/slow", () => {
    throw new DOMException("Aborted", "AbortError");
  });
  expect(result).toStrictEqual({ ok: false, error: "timeout" });
});

test("open extracts title and cleaned excerpt from html", async () => {
  const page = `
    <html>
      <head>
        <title> Hello &amp; World </title>
        <style>.x { color: red; }</style>
        <script>console.log("secret script text")</script>
      </head>
      <body>
        <h1>Welcome</h1>
        <p>Line one.</p>
        <noscript>hidden text</noscript>
        <svg><text>vector text</text></svg>
        <p>Line two&nbsp;with spacing.</p>
      </body>
    </html>
  `;

  const result = await openWith("https://safe.example/page", () => html(page));
  assert(result.ok);
  expect(result.page.domain).toStrictEqual("safe.example");
  expect(result.page.title).toStrictEqual("Hello & World");
  expect(result.page.excerpt).toContain("Welcome Line one. Line two with spacing.");
  expect(result.page.excerpt.includes("secret script text")).toStrictEqual(false);
  expect(result.page.excerpt.includes("hidden text")).toStrictEqual(false);
  expect(result.page.excerpt.includes("vector text")).toStrictEqual(false);
  assert(result.page.excerpt.length <= 3500);
});

test("open blocks additional local/private/reserved IPv4 and IPv6 hosts", async () => {
  const service = createLinkOpenService();
  const blockedUrls = [
    "http://abc.local/path",
    "http://instance-data/test",
    "http://metadata.azure.internal/test",
    "http://0.1.2.3/x",
    "http://100.64.0.1/x",
    "http://127.0.0.2/x",
    "http://169.254.1.1/x",
    "http://172.16.0.1/x",
    "http://192.168.1.2/x",
    "http://192.0.0.1/x",
    "http://192.0.2.10/x",
    "http://192.88.99.1/x",
    "http://198.18.0.1/x",
    "http://198.51.100.1/x",
    "http://203.0.113.1/x",
    "http://224.0.0.1/x",
    "http://[::]/x",
    "http://[::1]/x",
    "http://[fc00::1]/x",
    "http://[fe80::1]/x",
    "http://[ff02::1]/x",
    "http://[2001:db8::1]/x",
    "http://[::ffff:10.0.0.1]/x",
  ];

  for (const url of blockedUrls) {
    const result = await service.open(url);
    expect(result).toStrictEqual({ ok: false, error: "blocked_host" });
  }
});

test("open allows public hosts including normalized hostname and public IPv6 mapped IPv4", async () => {
  const service = createLinkOpenService({
    fetch: async () => html("<html><title>Hi</title><body>ok</body></html>"),
  });

  const normalized = await service.open("https://Example.COM./test");
  assert(normalized.ok);
  expect(normalized.page.domain).toStrictEqual("example.com");

  expect((await service.open("http://[::ffff:8.8.8.8]/x")).ok).toStrictEqual(true);
});

test("open follows a safe relative redirect and succeeds", async () => {
  let calls = 0;
  const result = await openWith("https://safe.example/start", (url) => {
    calls++;
    if (url === "https://safe.example/start") return redirect("/page");
    if (url === "https://safe.example/page") {
      return html("<html><title>Redirected</title><body>hello</body></html>");
    }
    return new Response("unexpected", { status: 500 });
  });
  assert(result.ok);
  expect(calls).toStrictEqual(2);
  expect(result.page.title).toStrictEqual("Redirected");
  expect(result.page.excerpt).toContain("hello");
});

test("open reports a server error, a missing body and a network error as fetch_failed", async () => {
  const failed = { ok: false, error: "fetch_failed" } as const;
  const serverError = await openWith(
    "https://safe.example/fail",
    () => new Response("oops", { status: 500 }),
  );
  const noBody = await openWith("https://safe.example/nobody", () => html(null));
  const thrown = await openWith("https://safe.example/throw", () => {
    throw new Error("network down");
  });
  expect([serverError, noBody, thrown]).toStrictEqual([failed, failed, failed]);
});

test("open enforces stream body size limit when content-length is absent", async () => {
  const chunk = new Uint8Array(400_000).fill(65);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.close();
    },
  });

  const result = await openWith(
    "https://safe.example/stream-large",
    () => new Response(stream, { headers: { "content-type": "text/html; charset=utf-8" } }),
  );
  expect(result).toStrictEqual({ ok: false, error: "response_too_large" });
});

test("open deadline covers a stalled body and releases the reader", async () => {
  let canceled = 0;
  let seenSignal: AbortSignal | null | undefined;
  const body = new ReadableStream<Uint8Array>({
    cancel: () => {
      canceled++;
    },
  });
  const service = createLinkOpenService({
    timeoutMs: 30,
    fetch: (_url, init) => {
      seenSignal = init.signal;
      return Promise.resolve(new Response(body, { headers: { "content-type": "text/html" } }));
    },
  });
  const start = performance.now();
  expect(await service.open("https://safe.example/stall")).toStrictEqual({
    ok: false,
    error: "timeout",
  });
  assert(performance.now() - start < 1000, "stalled body must return within its overall deadline");
  expect(seenSignal?.aborted).toStrictEqual(true);
  expect(canceled).toStrictEqual(1);
  expect(body.locked).toStrictEqual(false);
});
