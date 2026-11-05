import { describe, expect, test } from "bun:test";
import { assert, rejects, throws } from "./assert.ts";
import { realFetch } from "./setup.ts";

class NotFoundError extends Error {
  constructor(
    message: string,
    readonly status = 404,
  ) {
    super(message);
    this.name = "NotFoundError";
  }
}

describe("assert", () => {
  test("passes on truthy values and narrows the type", () => {
    const value: { ok: true; data: string } | { ok: false } = { ok: true, data: "x" };
    assert(value.ok);
    expect(value.data).toBe("x");
  });

  test("throws with the given message on falsy values", () => {
    expect(() => assert(0, "custom message")).toThrow("custom message");
  });
});

describe("rejects", () => {
  test("returns the typed error when class and message match", async () => {
    const error = await rejects(
      () => Promise.reject(new NotFoundError("user missing")),
      NotFoundError,
      "missing",
    );
    expect(error.status).toBe(404);
  });

  test("fails on a message mismatch", async () => {
    await rejects(
      () => rejects(() => Promise.reject(new NotFoundError("boom")), NotFoundError, "zzz"),
      Error,
      'Expected to contain: "zzz"',
    );
  });

  test("fails on a class mismatch", async () => {
    await rejects(
      () => rejects(() => Promise.reject(new Error("user missing")), NotFoundError),
      Error,
      "toBeInstanceOf",
    );
  });

  test("fails when the promise resolves", async () => {
    await rejects(() => rejects(() => Promise.resolve(1)), Error, "but the promise resolved");
  });
});

describe("throws", () => {
  test("returns the typed error when class and message match", () => {
    const error = throws(
      () => {
        throw new NotFoundError("user missing");
      },
      NotFoundError,
      "missing",
    );
    expect(error.status).toBe(404);
  });

  test("fails when the function returns", () => {
    throws(() => throws(() => 1), Error, "but the function returned");
  });

  test("refuses async functions and points to rejects()", () => {
    throws(
      () =>
        throws(async () => {
          throw new Error("async failure");
        }),
      Error,
      "use rejects() for async functions",
    );
  });
});

describe("setup preload", () => {
  test("unstubbed fetch rejects instead of reaching the network", async () => {
    await rejects(() => fetch("http://example.com/"), Error, "Unstubbed network request");
  });

  test("realFetch reaches a loopback server", async () => {
    using server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    const response = await realFetch(`http://127.0.0.1:${server.port}/`);
    expect(await response.text()).toBe("ok");
  });
});
