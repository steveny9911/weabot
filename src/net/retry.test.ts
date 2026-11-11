import { expect, test } from "bun:test";
import { asFetch } from "../../tests/support/fetch.ts";
import { rejects } from "../../tests/support/assert.ts";
import { fetchWithRetry } from "./retry.ts";

/** Each call takes the next reply; "hang" never answers, so only an abort ends it. */
function mockFetchSequence(sequence: Array<Response | Error | "hang">): {
  restore: () => void;
  getCalls: () => number;
} {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = asFetch((_input: string | URL | Request, init?: RequestInit) => {
    const next = sequence[calls] ?? sequence[sequence.length - 1];
    calls++;
    if (next === "hang") {
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    }
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    return Promise.resolve(next);
  });

  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    getCalls: () => calls,
  };
}

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
        }),
      Error,
      "boom-2",
    );
    expect(mock.getCalls()).toStrictEqual(2);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry does not retry a POST after a server error or network error", async () => {
  for (const failure of [new Response("temporary", { status: 503 }), new Error("reset")]) {
    const mock = mockFetchSequence([failure, new Response("ok", { status: 200 })]);
    try {
      const run = fetchWithRetry("https://example.com", { method: "POST" }, { initialDelayMs: 1 });
      if (failure instanceof Error) await rejects(() => run, Error, "reset");
      else expect((await run).status).toStrictEqual(503);
      expect(mock.getCalls()).toStrictEqual(1);
    } finally {
      mock.restore();
    }
  }
});

test("fetchWithRetry retries a POST that was rate limited", async () => {
  const mock = mockFetchSequence([
    new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }),
    new Response("ok", { status: 200 }),
  ]);

  try {
    const response = await fetchWithRetry("https://example.com", { method: "POST" });
    expect(response.status).toStrictEqual(200);
    expect(mock.getCalls()).toStrictEqual(2);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry times out a hung attempt and retries it", async () => {
  const mock = mockFetchSequence(["hang", new Response("ok", { status: 200 })]);

  try {
    const response = await fetchWithRetry("https://example.com", undefined, {
      initialDelayMs: 1,
      timeoutMs: 10,
    });
    expect(response.status).toStrictEqual(200);
    expect(mock.getCalls()).toStrictEqual(2);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry stops without retrying when the caller aborts", async () => {
  const mock = mockFetchSequence(["hang"]);

  try {
    await rejects(() =>
      fetchWithRetry(
        "https://example.com",
        { signal: AbortSignal.timeout(10) },
        {
          initialDelayMs: 1,
        },
      ),
    );
    expect(mock.getCalls()).toStrictEqual(1);
  } finally {
    mock.restore();
  }
});
