/**
 * Preloaded before every test file (see bunfig.toml).
 *
 * - Bun's default per-test timeout is 5 s, and `[test] timeout` in bunfig.toml
 *   is ignored in Bun 1.4.4, so the default is set here.
 * - Deno ran tests without network permission. Here, any fetch that a test has
 *   not stubbed throws instead of reaching the network. Tests that need a real
 *   loopback server restore `realFetch` explicitly.
 */
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(20_000);

export const realFetch = globalThis.fetch;

function blockedFetch(input: string | URL | Request): Promise<Response> {
  const target = input instanceof Request ? input.url : String(input);
  throw new Error(`Unstubbed network request in a test: ${target}`);
}

globalThis.fetch = Object.assign(blockedFetch, { preconnect() {} }) as typeof fetch;
