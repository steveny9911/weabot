import { expect, test } from "bun:test";
import { asFetch } from "../../tests/support/fetch.ts";
import { rejects } from "../../tests/support/assert.ts";
import { fetchWithRetry } from "./retry.ts";

function mockFetchSequence(sequence: Array<Response | Error>): {
  restore: () => void;
  getCalls: () => number;
} {
  const original_fetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = asFetch((_input: string | URL | Request, _init?: RequestInit) => {
    const next = sequence[calls] ?? sequence[sequence.length - 1];
    calls++;
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    return Promise.resolve(next);
  });

  return {
    restore: () => {
      globalThis.fetch = original_fetch;
    },
    getCalls: () => calls,
  };
}

test("fetchWithRetry returns immediately on success", async () => {
  const mock = mockFetchSequence([new Response("ok", { status: 200 })]);

  try {
    const response = await fetchWithRetry("https://example.com");
    expect(response.status).toStrictEqual(200);
    expect(mock.getCalls()).toStrictEqual(1);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry does not retry non-retryable status", async () => {
  const mock = mockFetchSequence([new Response("bad request", { status: 400 })]);

  try {
    const response = await fetchWithRetry("https://example.com");
    expect(response.status).toStrictEqual(400);
    expect(mock.getCalls()).toStrictEqual(1);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry retries retryable status and eventually succeeds", async () => {
  const mock = mockFetchSequence([
    new Response("temporary", { status: 503 }),
    new Response("ok", { status: 200 }),
  ]);

  try {
    const response = await fetchWithRetry("https://example.com", undefined, {
      maxRetries: 2,
      initialDelayMs: 1,
      maxDelayMs: 2,
    });
    expect(response.status).toStrictEqual(200);
    expect(mock.getCalls()).toStrictEqual(2);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry retries with Retry-After on 429", async () => {
  const mock = mockFetchSequence([
    new Response("rate limited", {
      status: 429,
      headers: { "Retry-After": "0" },
    }),
    new Response("ok", { status: 200 }),
  ]);

  try {
    const response = await fetchWithRetry("https://example.com", undefined, {
      maxRetries: 1,
      initialDelayMs: 1,
      maxDelayMs: 5,
    });
    expect(response.status).toStrictEqual(200);
    expect(mock.getCalls()).toStrictEqual(2);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry returns last failed retryable response after max retries", async () => {
  const mock = mockFetchSequence([
    new Response("temporary-1", { status: 503 }),
    new Response("temporary-2", { status: 503 }),
  ]);

  try {
    const response = await fetchWithRetry("https://example.com", undefined, {
      maxRetries: 1,
      initialDelayMs: 1,
      maxDelayMs: 2,
    });
    expect(response.status).toStrictEqual(503);
    expect(mock.getCalls()).toStrictEqual(2);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry retries fetch errors and succeeds", async () => {
  const mock = mockFetchSequence([new Error("network down"), new Response("ok", { status: 200 })]);

  try {
    const response = await fetchWithRetry("https://example.com", undefined, {
      maxRetries: 2,
      initialDelayMs: 1,
      maxDelayMs: 2,
    });
    expect(response.status).toStrictEqual(200);
    expect(mock.getCalls()).toStrictEqual(2);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry throws after repeated fetch errors", async () => {
  const mock = mockFetchSequence([new Error("boom-1"), new Error("boom-2")]);

  try {
    await rejects(
      () =>
        fetchWithRetry("https://example.com", undefined, {
          maxRetries: 1,
          initialDelayMs: 1,
          maxDelayMs: 2,
        }),
      Error,
      "boom-2",
    );
    expect(mock.getCalls()).toStrictEqual(2);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry wraps non-Error thrown values", async () => {
  const original_fetch = globalThis.fetch;
  globalThis.fetch = asFetch((_input: string | URL | Request, _init?: RequestInit) => {
    return Promise.reject("string failure");
  });

  try {
    await rejects(
      () => fetchWithRetry("https://example.com", undefined, { maxRetries: 0 }),
      Error,
      "string failure",
    );
  } finally {
    globalThis.fetch = original_fetch;
  }
});

test("fetchWithRetry throws fallback error when retries are disabled with negative maxRetries", async () => {
  await rejects(
    () => fetchWithRetry("https://example.com", undefined, { maxRetries: -1 }),
    Error,
    "Retry failed with no error captured",
  );
});
