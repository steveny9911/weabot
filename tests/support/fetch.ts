/**
 * Bun's `typeof fetch` also requires a `preconnect` method, so a plain stub function cannot be
 * assigned to `globalThis.fetch`. `asFetch` adds a no-op `preconnect` and returns the stub as a
 * full `fetch`.
 */
import type { Fetcher } from "../../src/types/fetch.ts";

export function asFetch(stub: Fetcher | (() => Promise<Response>)): typeof fetch {
  return Object.assign(stub, { preconnect() {} }) as typeof fetch;
}
