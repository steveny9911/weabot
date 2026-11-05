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

  test("fails when the message does not match", async () => {
    let failed = false;
    try {
      await rejects(() => Promise.reject(new NotFoundError("boom")), NotFoundError, "zzz");
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  test("fails when the class does not match", async () => {
    let failed = false;
    try {
      await rejects(() => Promise.reject(new Error("user missing")), NotFoundError);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  test("fails when the promise resolves", async () => {
    let failed = false;
    try {
      await rejects(() => Promise.resolve(1));
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
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
    expect(() => throws(() => 1)).toThrow("to be thrown");
  });
});

describe("setup preload", () => {
  test("blocks unstubbed network requests", () => {
    expect(() => fetch("http://example.com/")).toThrow("Unstubbed network request");
  });

  test("keeps the real fetch available for loopback tests", () => {
    expect(typeof realFetch).toBe("function");
    expect(realFetch).not.toBe(globalThis.fetch);
  });
});
