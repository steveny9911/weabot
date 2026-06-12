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
    autonomousChatEnabled: false,
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
    const mockMissingLocation = mockFetch((_url) =>
      new Response(null, { status: 301 })
    );
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
