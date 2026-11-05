/**
 * Tests for Link Open Service.
 */

import { expect, test } from "bun:test";
import { assert } from "../../tests/support/assert.ts";
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
