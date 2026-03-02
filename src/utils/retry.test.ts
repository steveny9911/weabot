import { assertEquals, assertRejects } from "@std/assert";
import { fetchWithRetry } from "./retry.ts";

function mockFetchSequence(
  sequence: Array<Response | Error>,
): { restore: () => void; getCalls: () => number } {
  const original_fetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
    const next = sequence[calls] ?? sequence[sequence.length - 1];
    calls++;
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    return Promise.resolve(next);
  }) as typeof fetch;

  return {
    restore: () => {
      globalThis.fetch = original_fetch;
    },
    getCalls: () => calls,
  };
}

Deno.test("fetchWithRetry returns immediately on success", async () => {
  const mock = mockFetchSequence([
    new Response("ok", { status: 200 }),
  ]);

  try {
    const response = await fetchWithRetry("https://example.com");
    assertEquals(response.status, 200);
    assertEquals(mock.getCalls(), 1);
  } finally {
    mock.restore();
  }
});

Deno.test("fetchWithRetry does not retry non-retryable status", async () => {
  const mock = mockFetchSequence([
    new Response("bad request", { status: 400 }),
  ]);

  try {
    const response = await fetchWithRetry("https://example.com");
    assertEquals(response.status, 400);
    assertEquals(mock.getCalls(), 1);
  } finally {
    mock.restore();
  }
});

Deno.test("fetchWithRetry retries retryable status and eventually succeeds", async () => {
  const mock = mockFetchSequence([
    new Response("temporary", { status: 503 }),
    new Response("ok", { status: 200 }),
  ]);

  try {
    const response = await fetchWithRetry(
      "https://example.com",
      undefined,
      { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 2 },
    );
    assertEquals(response.status, 200);
    assertEquals(mock.getCalls(), 2);
  } finally {
    mock.restore();
  }
});

Deno.test("fetchWithRetry retries with Retry-After on 429", async () => {
  const mock = mockFetchSequence([
    new Response("rate limited", {
      status: 429,
      headers: { "Retry-After": "0" },
    }),
    new Response("ok", { status: 200 }),
  ]);

  try {
    const response = await fetchWithRetry(
      "https://example.com",
      undefined,
      { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 5 },
    );
    assertEquals(response.status, 200);
    assertEquals(mock.getCalls(), 2);
  } finally {
    mock.restore();
  }
});

Deno.test("fetchWithRetry returns last failed retryable response after max retries", async () => {
  const mock = mockFetchSequence([
    new Response("temporary-1", { status: 503 }),
    new Response("temporary-2", { status: 503 }),
  ]);

  try {
    const response = await fetchWithRetry(
      "https://example.com",
      undefined,
      { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 2 },
    );
    assertEquals(response.status, 503);
    assertEquals(mock.getCalls(), 2);
  } finally {
    mock.restore();
  }
});

Deno.test("fetchWithRetry retries fetch errors and succeeds", async () => {
  const mock = mockFetchSequence([
    new Error("network down"),
    new Response("ok", { status: 200 }),
  ]);

  try {
    const response = await fetchWithRetry(
      "https://example.com",
      undefined,
      { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 2 },
    );
    assertEquals(response.status, 200);
    assertEquals(mock.getCalls(), 2);
  } finally {
    mock.restore();
  }
});

Deno.test("fetchWithRetry throws after repeated fetch errors", async () => {
  const mock = mockFetchSequence([
    new Error("boom-1"),
    new Error("boom-2"),
  ]);

  try {
    await assertRejects(
      () =>
        fetchWithRetry(
          "https://example.com",
          undefined,
          { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 2 },
        ),
      Error,
      "boom-2",
    );
    assertEquals(mock.getCalls(), 2);
  } finally {
    mock.restore();
  }
});

Deno.test("fetchWithRetry wraps non-Error thrown values", async () => {
  const original_fetch = globalThis.fetch;
  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
    return Promise.reject("string failure");
  }) as typeof fetch;

  try {
    await assertRejects(
      () =>
        fetchWithRetry(
          "https://example.com",
          undefined,
          { maxRetries: 0 },
        ),
      Error,
      "string failure",
    );
  } finally {
    globalThis.fetch = original_fetch;
  }
});

Deno.test("fetchWithRetry throws fallback error when retries are disabled with negative maxRetries", async () => {
  await assertRejects(
    () =>
      fetchWithRetry(
        "https://example.com",
        undefined,
        { maxRetries: -1 },
      ),
    Error,
    "Retry failed with no error captured",
  );
});
