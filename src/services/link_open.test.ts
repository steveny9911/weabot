/**
 * Tests for Link Open Service.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createLinkOpenService as createService } from "./link_open.ts";
import { type LinkFetch } from "./public_fetch.ts";

let fetchPage: LinkFetch | undefined;
function createLinkOpenService(config: AppConfig) {
  return createService(config, { fetch: fetchPage });
}
import type { AppConfig } from "../config.ts";

function createMockConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    discordToken: "test-token",
    channelId: "test-channel",
    channelIds: ["test-channel"],
    timeZone: "UTC",
    glueAlertThreshold: 7,
    aiEnabled: true,
    openaiApiKey: "sk-test-key",
    aiRateLimitPerUser: 2,
    aiDailyTokenBudget: 10000000,
    aiMaxInputChars: 0,
    aiEnableUwu: false,
    aiContextMaxMessages: 40,
    aiContextInactivityMinutes: 20,
    webSearchEnabled: false,
    webSearchApiKey: undefined,
    webSearchMaxResults: 3,
    linkOpenEnabled: true,
    autonomousChatEnabled: false,
    autonomousChatChannelIds: ["test-channel"],
    autonomousChatMinHumanMessages: 4,
    autonomousChatActivityWindowMinutes: 20,
    autonomousChatCooldownMinutes: 1,
    autonomousChatReplyChance: 0.35,
    autonomousChatMaxContextMessages: 40,
    ...overrides,
  };
}

function mockFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): { restore: () => void } {
  const originalFetch = fetchPage;

  fetchPage = (input: string, init?: RequestInit) => {
    const url = input;
    return Promise.resolve(handler(url, init));
  };

  return {
    restore: () => {
      fetchPage = originalFetch;
    },
  };
}

Deno.test("open rejects invalid url", async () => {
  const service = createLinkOpenService(createMockConfig());
  const result = await service.open("not-a-url");
  assertEquals(result, { ok: false, error: "invalid_url" });
});

Deno.test("open rejects unsupported protocol", async () => {
  const service = createLinkOpenService(createMockConfig());
  const result = await service.open("ftp://example.com/file.txt");
  assertEquals(result, { ok: false, error: "unsupported_protocol" });
});

Deno.test("open rejects blocked hosts", async () => {
  const service = createLinkOpenService(createMockConfig());

  const localhost = await service.open("http://localhost/test");
  assertEquals(localhost, { ok: false, error: "blocked_host" });

  const privateIp = await service.open("http://10.0.0.1/test");
  assertEquals(privateIp, { ok: false, error: "blocked_host" });

  const metadata = await service.open("http://metadata.google.internal/test");
  assertEquals(metadata, { ok: false, error: "blocked_host" });
});

Deno.test("open rejects too many redirects", async () => {
  const mock = mockFetch((url) => {
    if (url === "https://a.example/start") {
      return new Response(null, { status: 302, headers: { location: "https://b.example/1" } });
    }
    if (url === "https://b.example/1") {
      return new Response(null, { status: 302, headers: { location: "https://c.example/2" } });
    }
    if (url === "https://c.example/2") {
      return new Response(null, { status: 302, headers: { location: "https://d.example/3" } });
    }
    if (url === "https://d.example/3") {
      return new Response(null, { status: 302, headers: { location: "https://e.example/4" } });
    }
    return new Response("unexpected", { status: 500 });
  });

  try {
    const service = createLinkOpenService(createMockConfig());
    const result = await service.open("https://a.example/start");
    assertEquals(result, { ok: false, error: "too_many_redirects" });
  } finally {
    mock.restore();
  }
});

Deno.test("open rejects redirect to blocked host", async () => {
  const mock = mockFetch((url) => {
    if (url === "https://safe.example/start") {
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/internal" },
      });
    }
    return new Response("unexpected", { status: 500 });
  });

  try {
    const service = createLinkOpenService(createMockConfig());
    const result = await service.open("https://safe.example/start");
    assertEquals(result, { ok: false, error: "redirect_blocked" });
  } finally {
    mock.restore();
  }
});

Deno.test("open rejects non-html content", async () => {
  const mock = mockFetch((_url) => {
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  try {
    const service = createLinkOpenService(createMockConfig());
    const result = await service.open("https://safe.example/data.json");
    assertEquals(result, { ok: false, error: "unsupported_content_type" });
  } finally {
    mock.restore();
  }
});

Deno.test("open rejects oversized response by content-length", async () => {
  const mock = mockFetch((_url) => {
    return new Response("<html>tiny</html>", {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(1024 * 1024 + 1),
      },
    });
  });

  try {
    const service = createLinkOpenService(createMockConfig());
    const result = await service.open("https://safe.example/large");
    assertEquals(result, { ok: false, error: "response_too_large" });
  } finally {
    mock.restore();
  }
});

Deno.test("open returns timeout on abort error", async () => {
  const mock = mockFetch((_url) => {
    throw new DOMException("Aborted", "AbortError");
  });

  try {
    const service = createLinkOpenService(createMockConfig());
    const result = await service.open("https://safe.example/slow");
    assertEquals(result, { ok: false, error: "timeout" });
  } finally {
    mock.restore();
  }
});

Deno.test("open extracts title and cleaned excerpt from html", async () => {
  const html = `
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

  const mock = mockFetch((_url) => {
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });

  try {
    const service = createLinkOpenService(createMockConfig());
    const result = await service.open("https://safe.example/page");
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.page.domain, "safe.example");
      assertEquals(result.page.title, "Hello & World");
      assertStringIncludes(result.page.excerpt, "Welcome Line one. Line two with spacing.");
      assertEquals(result.page.excerpt.includes("secret script text"), false);
      assertEquals(result.page.excerpt.includes("hidden text"), false);
      assertEquals(result.page.excerpt.includes("vector text"), false);
      assert(result.page.excerpt.length <= 3500);
    }
  } finally {
    mock.restore();
  }
});

Deno.test("open blocks additional local/private/reserved IPv4 and IPv6 hosts", async () => {
  const service = createLinkOpenService(createMockConfig());
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
    assertEquals(result, { ok: false, error: "blocked_host" });
  }
});

Deno.test("open allows public hosts including normalized hostname and public IPv6 mapped IPv4", async () => {
  const mock = mockFetch((_url) => {
    return new Response("<html><title>Hi</title><body>ok</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  });

  try {
    const service = createLinkOpenService(createMockConfig());

    const normalized = await service.open("https://Example.COM./test");
    assertEquals(normalized.ok, true);
    if (normalized.ok) {
      assertEquals(normalized.page.domain, "example.com");
    }

    const mappedPublic = await service.open("http://[::ffff:8.8.8.8]/x");
    assertEquals(mappedPublic.ok, true);
  } finally {
    mock.restore();
  }
});

Deno.test("open follows a safe relative redirect and succeeds", async () => {
  let calls = 0;
  const mock = mockFetch((url) => {
    calls++;
    if (url === "https://safe.example/start") {
      return new Response(null, {
        status: 302,
        headers: { location: "/page" },
      });
    }
    if (url === "https://safe.example/page") {
      return new Response("<html><title>Redirected</title><body>hello</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    return new Response("unexpected", { status: 500 });
  });

  try {
    const service = createLinkOpenService(createMockConfig());
    const result = await service.open("https://safe.example/start");
    assertEquals(result.ok, true);
    assertEquals(calls, 2);
    if (result.ok) {
      assertEquals(result.page.title, "Redirected");
      assertStringIncludes(result.page.excerpt, "hello");
    }
  } finally {
    mock.restore();
  }
});

Deno.test("open handles redirect edge failures", async () => {
  {
    const mockMissingLocation = mockFetch((_url) => new Response(null, { status: 301 }));
    try {
      const service = createLinkOpenService(createMockConfig());
      const result = await service.open("https://safe.example/start");
      assertEquals(result, { ok: false, error: "fetch_failed" });
    } finally {
      mockMissingLocation.restore();
    }
  }

  {
    const mockBadLocation = mockFetch((_url) =>
      new Response(null, { status: 302, headers: { location: "http://[::1" } })
    );
    try {
      const service = createLinkOpenService(createMockConfig());
      const result = await service.open("https://safe.example/start");
      assertEquals(result, { ok: false, error: "redirect_blocked" });
    } finally {
      mockBadLocation.restore();
    }
  }

  {
    const mockUnsupportedScheme = mockFetch((_url) =>
      new Response(null, { status: 302, headers: { location: "ftp://example.com/file" } })
    );
    try {
      const service = createLinkOpenService(createMockConfig());
      const result = await service.open("https://safe.example/start");
      assertEquals(result, { ok: false, error: "redirect_blocked" });
    } finally {
      mockUnsupportedScheme.restore();
    }
  }
});

Deno.test("open handles non-ok, missing-body, and fetch error responses", async () => {
  {
    const mockServerError = mockFetch((_url) =>
      new Response("server error", { status: 500, headers: { "content-type": "text/html" } })
    );
    try {
      const service = createLinkOpenService(createMockConfig());
      const result = await service.open("https://safe.example/fail");
      assertEquals(result, { ok: false, error: "fetch_failed" });
    } finally {
      mockServerError.restore();
    }
  }

  {
    const mockMissingBody = mockFetch((_url) =>
      new Response(null, { status: 200, headers: { "content-type": "text/html" } })
    );
    try {
      const service = createLinkOpenService(createMockConfig());
      const result = await service.open("https://safe.example/nobody");
      assertEquals(result, { ok: false, error: "fetch_failed" });
    } finally {
      mockMissingBody.restore();
    }
  }

  {
    const mockThrown = mockFetch((_url) => {
      throw new Error("network down");
    });
    try {
      const service = createLinkOpenService(createMockConfig());
      const result = await service.open("https://safe.example/throw");
      assertEquals(result, { ok: false, error: "fetch_failed" });
    } finally {
      mockThrown.restore();
    }
  }
});

Deno.test("open enforces stream body size limit when content-length is absent", async () => {
  const chunk = new Uint8Array(400_000).fill(65);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.close();
    },
  });

  const mock = mockFetch((_url) => {
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });

  try {
    const service = createLinkOpenService(createMockConfig());
    const result = await service.open("https://safe.example/stream-large");
    assertEquals(result, { ok: false, error: "response_too_large" });
  } finally {
    mock.restore();
  }
});

Deno.test("open decodes numeric entities and truncates long excerpt", async () => {
  const longBody = "word ".repeat(1000);
  const html =
    `<html><head><title> A&#66; &#x43; &unknown; </title></head><body>${longBody}</body></html>`;
  const mock = mockFetch((_url) => {
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  });

  try {
    const service = createLinkOpenService(createMockConfig());
    const result = await service.open("https://safe.example/entities");
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.page.title, "AB C");
      assertEquals(result.page.excerpt.length, 3500);
      assertEquals(result.page.excerpt.endsWith("..."), true);
    }
  } finally {
    mock.restore();
  }
});

Deno.test("open allows full public IPv6 literals and dotted non-IP hostnames", async () => {
  const mock = mockFetch((_url) => {
    return new Response("<html><title>IPv6</title><body>ok</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  });

  try {
    const service = createLinkOpenService(createMockConfig());

    const publicIpv6 = await service.open("http://[2606:4700:4700:0000:0000:0000:0000:1111]/x");
    assertEquals(publicIpv6.ok, true);

    const dottedHostname = await service.open("http://1.2.3.example/x");
    assertEquals(dottedHostname.ok, true);
  } finally {
    mock.restore();
  }
});

Deno.test("open ignores non-numeric content-length header and reads body", async () => {
  const mock = mockFetch((_url) => {
    return new Response("<html><body>hello</body></html>", {
      status: 200,
      headers: {
        "content-type": "text/html",
        "content-length": "abc",
      },
    });
  });

  try {
    const service = createLinkOpenService(createMockConfig());
    const result = await service.open("https://safe.example/content-length");
    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(result.page.excerpt, "hello");
    }
  } finally {
    mock.restore();
  }
});

Deno.test("open deadline covers a stalled body and releases the reader", async () => {
  let canceled = 0;
  let seenSignal: AbortSignal | null | undefined;
  const body = new ReadableStream<Uint8Array>({
    cancel: () => {
      canceled++;
    },
  });
  const service = createService(createMockConfig(), {
    timeoutMs: 30,
    fetch: (_url, init) => {
      seenSignal = init.signal;
      return Promise.resolve(new Response(body, { headers: { "content-type": "text/html" } }));
    },
  });
  const start = performance.now();
  assertEquals(await service.open("https://safe.example/stall"), { ok: false, error: "timeout" });
  assert(performance.now() - start < 1000, "stalled body must return within its overall deadline");
  assertEquals(seenSignal?.aborted, true);
  assertEquals(canceled, 1);
  assertEquals(body.locked, false);
});

Deno.test("open deadline is not extended by slow chunks below the size limit", async () => {
  let chunks = 0;
  let interval: ReturnType<typeof setInterval> | undefined;
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      interval = setInterval(() => {
        chunks++;
        controller.enqueue(new TextEncoder().encode("still streaming "));
      }, 5);
    },
    cancel() {
      canceled = true;
      clearInterval(interval);
    },
  });
  const service = createService(createMockConfig(), {
    timeoutMs: 60,
    fetch: () => Promise.resolve(new Response(body, { headers: { "content-type": "text/html" } })),
  });
  try {
    assertEquals(await service.open("https://safe.example/trickle"), {
      ok: false,
      error: "timeout",
    });
    assert(chunks > 1, "several chunks should arrive before the deadline");
    assertEquals(canceled, true);
    assertEquals(body.locked, false);
  } finally {
    clearInterval(interval);
  }
});

Deno.test("open maps body failures to structured errors and releases its reader", async (t) => {
  for (const error of [new Error("socket reset"), new DOMException("Aborted", "AbortError")]) {
    await t.step(error.name, async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(error);
        },
      });
      const service = createService(createMockConfig(), {
        fetch: () =>
          Promise.resolve(new Response(body, { headers: { "content-type": "text/html" } })),
      });
      assertEquals(await service.open("https://safe.example/broken"), {
        ok: false,
        error: error.name === "AbortError" ? "timeout" : "fetch_failed",
      });
      assertEquals(body.locked, false);
    });
  }
});

Deno.test("open cancels every abandoned response body", async (t) => {
  const cases = [
    { status: 500, headers: {}, error: "fetch_failed" },
    {
      status: 200,
      headers: { "content-type": "application/json" },
      error: "unsupported_content_type",
    },
    {
      status: 200,
      headers: { "content-type": "text/html", "content-length": "1048577" },
      error: "response_too_large",
    },
    { status: 301, headers: {}, error: "fetch_failed" },
    { status: 302, headers: { location: "http://[invalid" }, error: "redirect_blocked" },
    { status: 302, headers: { location: "ftp://safe.example/file" }, error: "redirect_blocked" },
    { status: 302, headers: { location: "http://127.0.0.1/private" }, error: "redirect_blocked" },
    { status: 302, headers: { location: "/loop" }, error: "too_many_redirects" },
  ] as const;
  for (const [index, fixture] of cases.entries()) {
    await t.step(`${index}: ${fixture.error}`, async () => {
      let fetched = 0;
      let canceled = 0;
      const streams: ReadableStream<Uint8Array>[] = [];
      const service = createService(createMockConfig(), {
        fetch: () => {
          fetched++;
          const body = new ReadableStream<Uint8Array>({
            cancel() {
              canceled++;
            },
          });
          streams.push(body);
          return Promise.resolve(
            new Response(body, { status: fixture.status, headers: fixture.headers }),
          );
        },
      });
      assertEquals(await service.open("https://safe.example/rejected"), {
        ok: false,
        error: fixture.error,
      });
      assertEquals(canceled, fetched);
      assertEquals(fetched, fixture.error === "too_many_redirects" ? 4 : 1);
      assert(streams.every((stream) => !stream.locked));
    });
  }
});

Deno.test("open cancels oversized streamed body and releases its reader", async () => {
  let canceled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() {
      canceled++;
    },
  });
  const service = createService(createMockConfig(), {
    fetch: () => Promise.resolve(new Response(body, { headers: { "content-type": "text/html" } })),
  });
  assertEquals(await service.open("https://safe.example/large"), {
    ok: false,
    error: "response_too_large",
  });
  assertEquals(canceled, 1);
  assertEquals(body.locked, false);
});

Deno.test("open clears its deadline and releases the reader after success", async () => {
  let signal: AbortSignal | null | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("<title>Done</title><p>success</p>"));
      controller.close();
    },
  });
  const service = createService(createMockConfig(), {
    timeoutMs: 20,
    fetch: (_url, init) => {
      signal = init.signal;
      return Promise.resolve(new Response(body, { headers: { "content-type": "text/html" } }));
    },
  });
  assertEquals(await service.open("https://safe.example/done"), {
    ok: true,
    page: { domain: "safe.example", title: "Done", excerpt: "Done success" },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assertEquals(signal?.aborted, false, "completed operation must not leave its abort timer armed");
  assertEquals(body.locked, false);
});

Deno.test("open shares one abort signal across all redirect hops and the final body", async () => {
  let requests = 0;
  let canceled = 0;
  const signals: (AbortSignal | null | undefined)[] = [];
  const service = createService(createMockConfig(), {
    timeoutMs: 60,
    fetch: (_url, init) => {
      requests++;
      signals.push(init.signal);
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          canceled++;
        },
      });
      return Promise.resolve(
        new Response(
          body,
          requests < 4
            ? { status: 302, headers: { location: `/hop${requests}` } }
            : { headers: { "content-type": "text/html" } },
        ),
      );
    },
  });
  assertEquals(await service.open("https://safe.example/start"), { ok: false, error: "timeout" });
  assertEquals(requests, 4);
  assertEquals(canceled, 4);
  assert(signals.every((signal) => signal === signals[0] && signal?.aborted));
});

Deno.test("open cancels headers arriving after the overall deadline", async () => {
  const pending = Promise.withResolvers<Response>();
  let canceled = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      canceled++;
    },
  });
  const service = createService(createMockConfig(), {
    timeoutMs: 20,
    fetch: () => pending.promise,
  });
  assertEquals(await service.open("https://safe.example/late"), { ok: false, error: "timeout" });
  pending.resolve(new Response(body, { headers: { "content-type": "text/html" } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(canceled, 1);
  assertEquals(body.locked, false);
});

Deno.test("open cannot hang on a rejected or oversized body's cancellation hook", async (t) => {
  for (const oversized of [false, true]) {
    await t.step(oversized ? "reader cancellation" : "unread response cancellation", async () => {
      let canceled = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (oversized) controller.enqueue(new Uint8Array(1024 * 1024 + 1));
        },
        cancel() {
          canceled++;
          return new Promise<void>(() => {});
        },
      });
      const service = createService(createMockConfig(), {
        timeoutMs: 30,
        fetch: () =>
          Promise.resolve(
            new Response(body, {
              headers: { "content-type": oversized ? "text/html" : "application/json" },
            }),
          ),
      });
      const start = performance.now();
      assertEquals(await service.open("https://safe.example/cancel-hang"), {
        ok: false,
        error: oversized ? "response_too_large" : "unsupported_content_type",
      });
      assert(performance.now() - start < 1000);
      assertEquals(canceled, 1);
      assertEquals(body.locked, false);
    });
  }
});
