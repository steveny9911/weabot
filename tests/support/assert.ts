/**
 * Assertion helpers for bun:test.
 *
 * - `assert` narrows types, which `expect(x).toBeTruthy()` cannot do.
 * - `rejects` and `throws` check the error class and the message, and return
 *   the typed error. Bun's `toThrow(Class, message)` ignores the message.
 */
import { expect } from "bun:test";

type ErrorClass<T extends Error> = abstract new (...args: never[]) => T;

export function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function checkError<T extends Error>(
  error: unknown,
  ErrorType: ErrorClass<T>,
  messageIncludes: string | undefined,
): T {
  expect(error).toBeInstanceOf(ErrorType);
  if (messageIncludes !== undefined) {
    expect((error as Error).message).toContain(messageIncludes);
  }
  return error as T;
}

export async function rejects<T extends Error = Error>(
  run: () => Promise<unknown>,
  ErrorType: ErrorClass<T> = Error as unknown as ErrorClass<T>,
  messageIncludes?: string,
): Promise<T> {
  try {
    await run();
  } catch (error) {
    return checkError(error, ErrorType, messageIncludes);
  }
  throw new Error(`Expected ${ErrorType.name} to be rejected, but the promise resolved`);
}

export function throws<T extends Error = Error>(
  run: () => unknown,
  ErrorType: ErrorClass<T> = Error as unknown as ErrorClass<T>,
  messageIncludes?: string,
): T {
  let result: unknown;
  try {
    result = run();
  } catch (error) {
    return checkError(error, ErrorType, messageIncludes);
  }
  if (result instanceof Promise) {
    // An async function never throws synchronously; its rejection would surface elsewhere.
    result.catch(() => {});
    throw new Error("throws() got a promise; use rejects() for async functions");
  }
  throw new Error(`Expected ${ErrorType.name} to be thrown, but the function returned`);
}
