/**
 * Preloaded before every test file (see bunfig.toml). Runs only under `bun test`, never in the bot.
 *
 * - Bun's default per-test timeout is 5 s, and `[test] timeout` in bunfig.toml is ignored in
 *   Bun 1.4.4, so the default is set here.
 * - The global `fetch` is replaced with a function that rejects, so a test that forgets to stub
 *   `fetch` fails instead of reaching the network. This guards the global `fetch` only: `Bun.fetch`,
 *   `node:http`, `WebSocket`, sockets and DNS lookups are not blocked, so tests must inject fakes
 *   for those. Tests that need a real loopback server use `realFetch`.
 */
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(20_000);

export const realFetch = globalThis.fetch;

// Async, so it rejects like a real network failure instead of throwing synchronously.
async function blockedFetch(input: string | URL | Request): Promise<Response> {
  const target = input instanceof Request ? input.url : String(input);
  throw new Error(`Unstubbed network request in a test: ${target}`);
}

globalThis.fetch = Object.assign(blockedFetch, { preconnect() {} }) as typeof fetch;
