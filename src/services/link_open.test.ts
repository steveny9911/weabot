/**
 * Tests for Link Open Service.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createLinkOpenService } from "./link_open.ts";
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
    webSearchEnabled: false,
    webSearchApiKey: undefined,
    webSearchMaxResults: 3,
    linkOpenEnabled: true,
    ...overrides,
  };
}

function mockFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): { restore: () => void } {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;

  return {
    restore: () => {
      globalThis.fetch = originalFetch;
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
