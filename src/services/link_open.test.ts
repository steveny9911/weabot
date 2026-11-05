/**
 * Tests for Link Open Service.
 */

import { describe, expect, test } from "bun:test";
import { assert } from "../../test_support/assert.ts";
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

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): {
  restore: () => void;
} {
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

test("open rejects invalid url", async () => {
  const service = createLinkOpenService(createMockConfig());
  const result = await service.open("not-a-url");
  expect(result).toStrictEqual({ ok: false, error: "invalid_url" });
});

test("open rejects unsupported protocol", async () => {
  const service = createLinkOpenService(createMockConfig());
  const result = await service.open("ftp://example.com/file.txt");
  expect(result).toStrictEqual({ ok: false, error: "unsupported_protocol" });
});

test("open rejects blocked hosts", async () => {
  const service = createLinkOpenService(createMockConfig());

  const localhost = await service.open("http://localhost/test");
  expect(localhost).toStrictEqual({ ok: false, error: "blocked_host" });

  const privateIp = await service.open("http://10.0.0.1/test");
  expect(privateIp).toStrictEqual({ ok: false, error: "blocked_host" });

  const metadata = await service.open("http://metadata.google.internal/test");
  expect(metadata).toStrictEqual({ ok: false, error: "blocked_host" });
});

test("open rejects too many redirects", async () => {
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
    expect(result).toStrictEqual({ ok: false, error: "too_many_redirects" });
  } finally {
    mock.restore();
  }
});

test("open rejects redirect to blocked host", async () => {
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
    expect(result).toStrictEqual({ ok: false, error: "redirect_blocked" });
  } finally {
    mock.restore();
  }
});

test("open rejects non-html content", async () => {
  const mock = mockFetch((_url) => {
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  try {
    const service = createLinkOpenService(createMockConfig());
    const result = await service.open("https://safe.example/data.json");
    expect(result).toStrictEqual({ ok: false, error: "unsupported_content_type" });
  } finally {
    mock.restore();
  }
});

test("open rejects oversized response by content-length", async () => {
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
    expect(result).toStrictEqual({ ok: false, error: "response_too_large" });
  } finally {
    mock.restore();
  }
});

test("open returns timeout on abort error", async () => {
  const mock = mockFetch((_url) => {
    throw new DOMException("Aborted", "AbortError");
  });

  try {
    const service = createLinkOpenService(createMockConfig());
    const result = await service.open("https://safe.example/slow");
    expect(result).toStrictEqual({ ok: false, error: "timeout" });
  } finally {
    mock.restore();
  }
});

test("open extracts title and cleaned excerpt from html", async () => {
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
    expect(result.ok).toStrictEqual(true);
    if (result.ok) {
      expect(result.page.domain).toStrictEqual("safe.example");
      expect(result.page.title).toStrictEqual("Hello & World");
      expect(result.page.excerpt).toContain("Welcome Line one. Line two with spacing.");
      expect(result.page.excerpt.includes("secret script text")).toStrictEqual(false);
      expect(result.page.excerpt.includes("hidden text")).toStrictEqual(false);
      expect(result.page.excerpt.includes("vector text")).toStrictEqual(false);
      assert(result.page.excerpt.length <= 3500);
    }
  } finally {
    mock.restore();
  }
});

test("open blocks additional local/private/reserved IPv4 and IPv6 hosts", async () => {
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
    expect(result).toStrictEqual({ ok: false, error: "blocked_host" });
  }
});

test("open allows public hosts including normalized hostname and public IPv6 mapped IPv4", async () => {
  const mock = mockFetch((_url) => {
    return new Response("<html><title>Hi</title><body>ok</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  });

  try {
    const service = createLinkOpenService(createMockConfig());

    const normalized = await service.open("https://Example.COM./test");
    expect(normalized.ok).toStrictEqual(true);
    if (normalized.ok) {
      expect(normalized.page.domain).toStrictEqual("example.com");
    }

    const mappedPublic = await service.open("http://[::ffff:8.8.8.8]/x");
    expect(mappedPublic.ok).toStrictEqual(true);
  } finally {
    mock.restore();
  }
});

test("open follows a safe relative redirect and succeeds", async () => {
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
    expect(result.ok).toStrictEqual(true);
    expect(calls).toStrictEqual(2);
    if (result.ok) {
      expect(result.page.title).toStrictEqual("Redirected");
      expect(result.page.excerpt).toContain("hello");
    }
  } finally {
    mock.restore();
  }
});

test("open handles redirect edge failures", async () => {
  {
    const mockMissingLocation = mockFetch((_url) => new Response(null, { status: 301 }));
    try {
      const service = createLinkOpenService(createMockConfig());
      const result = await service.open("https://safe.example/start");
      expect(result).toStrictEqual({ ok: false, error: "fetch_failed" });
    } finally {
      mockMissingLocation.restore();
    }
  }

  {
    const mockBadLocation = mockFetch(
      (_url) => new Response(null, { status: 302, headers: { location: "http://[::1" } }),
    );
    try {
      const service = createLinkOpenService(createMockConfig());
      const result = await service.open("https://safe.example/start");
      expect(result).toStrictEqual({ ok: false, error: "redirect_blocked" });
    } finally {
      mockBadLocation.restore();
    }
  }

  {
    const mockUnsupportedScheme = mockFetch(
      (_url) =>
        new Response(null, { status: 302, headers: { location: "ftp://example.com/file" } }),
    );
    try {
      const service = createLinkOpenService(createMockConfig());
      const result = await service.open("https://safe.example/start");
      expect(result).toStrictEqual({ ok: false, error: "redirect_blocked" });
    } finally {
      mockUnsupportedScheme.restore();
    }
  }
});

test("open handles non-ok, missing-body, and fetch error responses", async () => {
  {
    const mockServerError = mockFetch(
      (_url) =>
        new Response("server error", { status: 500, headers: { "content-type": "text/html" } }),
    );
    try {
      const service = createLinkOpenService(createMockConfig());
      const result = await service.open("https://safe.example/fail");
      expect(result).toStrictEqual({ ok: false, error: "fetch_failed" });
    } finally {
      mockServerError.restore();
    }
  }

  {
    const mockMissingBody = mockFetch(
      (_url) => new Response(null, { status: 200, headers: { "content-type": "text/html" } }),
    );
    try {
      const service = createLinkOpenService(createMockConfig());
      const result = await service.open("https://safe.example/nobody");
      expect(result).toStrictEqual({ ok: false, error: "fetch_failed" });
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
      expect(result).toStrictEqual({ ok: false, error: "fetch_failed" });
    } finally {
      mockThrown.restore();
    }
  }
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

  const mock = mockFetch((_url) => {
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });

  try {
    const service = createLinkOpenService(createMockConfig());
    const result = await service.open("https://safe.example/stream-large");
    expect(result).toStrictEqual({ ok: false, error: "response_too_large" });
  } finally {
    mock.restore();
  }
});

test("open decodes numeric entities and truncates long excerpt", async () => {
  const longBody = "word ".repeat(1000);
  const html = `<html><head><title> A&#66; &#x43; &unknown; </title></head><body>${longBody}</body></html>`;
  const mock = mockFetch((_url) => {
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  });

  try {
    const service = createLinkOpenService(createMockConfig());
    const result = await service.open("https://safe.example/entities");
    expect(result.ok).toStrictEqual(true);
    if (result.ok) {
      expect(result.page.title).toStrictEqual("AB C");
      expect(result.page.excerpt.length).toStrictEqual(3500);
      expect(result.page.excerpt.endsWith("...")).toStrictEqual(true);
    }
  } finally {
    mock.restore();
  }
});

test("open allows full public IPv6 literals and dotted non-IP hostnames", async () => {
  const mock = mockFetch((_url) => {
    return new Response("<html><title>IPv6</title><body>ok</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  });

  try {
    const service = createLinkOpenService(createMockConfig());

    const publicIpv6 = await service.open("http://[2606:4700:4700:0000:0000:0000:0000:1111]/x");
    expect(publicIpv6.ok).toStrictEqual(true);

    const dottedHostname = await service.open("http://1.2.3.example/x");
    expect(dottedHostname.ok).toStrictEqual(true);
  } finally {
    mock.restore();
  }
});

test("open ignores non-numeric content-length header and reads body", async () => {
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
    expect(result.ok).toStrictEqual(true);
    if (result.ok) {
      expect(result.page.excerpt).toContain("hello");
    }
  } finally {
    mock.restore();
  }
});

test("open deadline covers a stalled body and releases the reader", async () => {
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
  expect(await service.open("https://safe.example/stall")).toStrictEqual({
    ok: false,
    error: "timeout",
  });
  assert(performance.now() - start < 1000, "stalled body must return within its overall deadline");
  expect(seenSignal?.aborted).toStrictEqual(true);
  expect(canceled).toStrictEqual(1);
  expect(body.locked).toStrictEqual(false);
});

test("open deadline is not extended by slow chunks below the size limit", async () => {
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
    expect(await service.open("https://safe.example/trickle")).toStrictEqual({
      ok: false,
      error: "timeout",
    });
    assert(chunks > 1, "several chunks should arrive before the deadline");
    expect(canceled).toStrictEqual(true);
    expect(body.locked).toStrictEqual(false);
  } finally {
    clearInterval(interval);
  }
});

describe("open maps body failures to structured errors and releases its reader", () => {
  for (const error of [new Error("socket reset"), new DOMException("Aborted", "AbortError")]) {
    test(error.name, async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(error);
        },
      });
      const service = createService(createMockConfig(), {
        fetch: () =>
          Promise.resolve(new Response(body, { headers: { "content-type": "text/html" } })),
      });
      expect(await service.open("https://safe.example/broken")).toStrictEqual({
        ok: false,
        error: error.name === "AbortError" ? "timeout" : "fetch_failed",
      });
      expect(body.locked).toStrictEqual(false);
    });
  }
});

describe("open cancels every abandoned response body", () => {
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
    test(`${index}: ${fixture.error}`, async () => {
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
      expect(await service.open("https://safe.example/rejected")).toStrictEqual({
        ok: false,
        error: fixture.error,
      });
      expect(canceled).toStrictEqual(fetched);
      expect(fetched).toStrictEqual(fixture.error === "too_many_redirects" ? 4 : 1);
      assert(streams.every((stream) => !stream.locked));
    });
  }
});

test("open cancels oversized streamed body and releases its reader", async () => {
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
  expect(await service.open("https://safe.example/large")).toStrictEqual({
    ok: false,
    error: "response_too_large",
  });
  expect(canceled).toStrictEqual(1);
  expect(body.locked).toStrictEqual(false);
});

test("open clears its deadline and releases the reader after success", async () => {
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
  expect(await service.open("https://safe.example/done")).toStrictEqual({
    ok: true,
    page: { domain: "safe.example", title: "Done", excerpt: "Done success" },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  // A completed operation must not leave its abort timer armed.
  expect(signal?.aborted).toStrictEqual(false);
  expect(body.locked).toStrictEqual(false);
});

test("open shares one abort signal across all redirect hops and the final body", async () => {
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
  expect(await service.open("https://safe.example/start")).toStrictEqual({
    ok: false,
    error: "timeout",
  });
  expect(requests).toStrictEqual(4);
  expect(canceled).toStrictEqual(4);
  assert(signals.every((signal) => signal === signals[0] && signal?.aborted));
});

test("open cancels headers arriving after the overall deadline", async () => {
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
  expect(await service.open("https://safe.example/late")).toStrictEqual({
    ok: false,
    error: "timeout",
  });
  pending.resolve(new Response(body, { headers: { "content-type": "text/html" } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(canceled).toStrictEqual(1);
  expect(body.locked).toStrictEqual(false);
});

describe("open cannot hang on a rejected or oversized body's cancellation hook", () => {
  for (const oversized of [false, true]) {
    test(oversized ? "reader cancellation" : "unread response cancellation", async () => {
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
      expect(await service.open("https://safe.example/cancel-hang")).toStrictEqual({
        ok: false,
        error: oversized ? "response_too_large" : "unsupported_content_type",
      });
      assert(performance.now() - start < 1000);
      expect(canceled).toStrictEqual(1);
      expect(body.locked).toStrictEqual(false);
    });
  }
});
