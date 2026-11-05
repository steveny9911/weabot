/**
 * Link Open Service
 *
 * Safely fetches and extracts text from user-provided links for AI context.
 * This service is intentionally strict: HTML-only, limited redirects, and
 * blocked local/private/metadata hosts.
 */

import type { AppConfig } from "../config.ts";
import {
  isBlockedHost,
  BlockedDestinationError,
  createPublicFetch,
  type LinkFetch,
  normalizeHost,
} from "./public_fetch.ts";

const MAX_REDIRECTS = 3;
// One deadline for the entire open(), including DNS, every redirect and body decoding.
const REQUEST_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 1024 * 1024; // 1 MB
const MAX_EXCERPT_CHARS = 3500;

export interface LinkPageContext {
  domain: string;
  title: string;
  excerpt: string;
}

export type LinkOpenError =
  | "invalid_url"
  | "unsupported_protocol"
  | "blocked_host"
  | "redirect_blocked"
  | "too_many_redirects"
  | "timeout"
  | "unsupported_content_type"
  | "response_too_large"
  | "fetch_failed";

export interface LinkOpenService {
  open(
    url: string,
  ): Promise<{ ok: true; page: LinkPageContext } | { ok: false; error: LinkOpenError }>;
}

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };

  return text
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number.parseInt(dec, 10);
      if (!Number.isFinite(code)) return "";
      return String.fromCodePoint(code);
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      if (!Number.isFinite(code)) return "";
      return String.fromCodePoint(code);
    })
    .replace(/&([a-zA-Z]+);/g, (_, name) => named[name] ?? "");
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractTitle(html: string): string {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  const plain = match[1].replace(/<[^>]+>/g, " ");
  return normalizeWhitespace(decodeHtmlEntities(plain));
}

function extractTextExcerpt(html: string, maxChars: number): string {
  let body = html;
  body = body.replace(/<!--[\s\S]*?-->/g, " ");
  body = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  body = body.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  body = body.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  body = body.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ");
  body = body.replace(/<math\b[^>]*>[\s\S]*?<\/math>/gi, " ");
  body = body.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ");
  body = body.replace(/<[^>]+>/g, " ");

  const plain = normalizeWhitespace(decodeHtmlEntities(body));
  if (plain.length <= maxChars) return plain;
  return plain.slice(0, maxChars - 3) + "...";
}

/** Bound even a stalled stream or cancellation hook that ignores the signal. */
async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    signal.throwIfAborted();
  }
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function cancelBody(response: Response | undefined, signal: AbortSignal): Promise<void> {
  if (!response?.body || response.body.locked) return;
  // Start cancellation even after the deadline, but never let cleanup extend it.
  const canceled = response.body.cancel().catch(() => {});
  if (!signal.aborted) await withAbort(canceled, signal).catch(() => {});
}

async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<
  | { ok: true; text: string; bytes: number }
  | {
      ok: false;
      error: "response_too_large" | "fetch_failed";
    }
> {
  const reader = response.body?.getReader();
  if (!reader) return { ok: false, error: "fetch_failed" };

  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) {
        complete = true;
        break;
      }
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) return { ok: false, error: "response_too_large" };
      chunks.push(value);
    }

    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const text = new TextDecoder().decode(buffer);
    return { ok: true, text, bytes: total };
  } finally {
    try {
      if (!complete) {
        const canceled = reader.cancel().catch(() => {});
        if (!signal.aborted) await withAbort(canceled, signal).catch(() => {});
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

/**
 * Create link open service.
 */
export function createLinkOpenService(
  _config: AppConfig,
  dependencies: { fetch?: LinkFetch; timeoutMs?: number } = {},
): LinkOpenService {
  const fetchPage = dependencies.fetch ?? createPublicFetch();
  const timeoutMs = dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Link timeout must be a positive finite number");
  }
  return {
    async open(url: string) {
      let current: URL;
      try {
        current = new URL(url);
      } catch {
        return { ok: false, error: "invalid_url" };
      }

      if (!(current.protocol === "http:" || current.protocol === "https:")) {
        return { ok: false, error: "unsupported_protocol" };
      }

      if (isBlockedHost(current)) {
        console.log(`[LINK] blocked: blocked_host (${current.hostname})`);
        return { ok: false, error: "blocked_host" };
      }

      let redirects = 0;
      const controller = new AbortController();
      const signal = controller.signal;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        while (true) {
          let response: Response | undefined;
          try {
            signal.throwIfAborted();
            response = await withAbort<Response>(
              fetchPage(current.toString(), {
                method: "GET",
                redirect: "manual",
                signal,
                headers: {
                  Accept: "text/html,application/xhtml+xml",
                },
              }).then(async (fetched) => {
                // An injected/late transport must not leave a response abandoned
                // if its headers arrive after open() has already timed out.
                if (signal.aborted) {
                  await cancelBody(fetched, signal);
                  signal.throwIfAborted();
                }
                return fetched;
              }),
              signal,
            );

            if (isRedirectStatus(response.status)) {
              const location = response.headers.get("location");
              if (!location) return { ok: false, error: "fetch_failed" };
              if (redirects >= MAX_REDIRECTS) return { ok: false, error: "too_many_redirects" };

              let next: URL;
              try {
                next = new URL(location, current);
              } catch {
                return { ok: false, error: "redirect_blocked" };
              }

              if (!(next.protocol === "http:" || next.protocol === "https:")) {
                return { ok: false, error: "redirect_blocked" };
              }
              if (isBlockedHost(next)) {
                console.log(`[LINK] blocked: redirect_blocked (${next.hostname})`);
                return { ok: false, error: "redirect_blocked" };
              }

              current = next;
              redirects++;
              continue;
            }

            if (!response.ok) {
              return { ok: false, error: "fetch_failed" };
            }

            const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
            if (!contentType.includes("text/html")) {
              return { ok: false, error: "unsupported_content_type" };
            }

            const contentLength = response.headers.get("content-length");
            if (contentLength) {
              const len = Number.parseInt(contentLength, 10);
              if (Number.isFinite(len) && len > MAX_HTML_BYTES) {
                return { ok: false, error: "response_too_large" };
              }
            }

            const bodyResult = await readBodyWithLimit(response, MAX_HTML_BYTES, signal);
            if (!bodyResult.ok) return { ok: false, error: bodyResult.error };

            const title = extractTitle(bodyResult.text);
            const excerpt = extractTextExcerpt(bodyResult.text, MAX_EXCERPT_CHARS);

            console.log(
              `[LINK] fetched: domain=${normalizeHost(
                current.hostname,
              )} bytes=${bodyResult.bytes} redirects=${redirects}`,
            );
            return {
              ok: true,
              page: {
                domain: normalizeHost(current.hostname),
                title,
                excerpt,
              },
            };
          } finally {
            await cancelBody(response, signal);
          }
        }
      } catch (err) {
        if (signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
          return { ok: false, error: "timeout" };
        }
        if (err instanceof BlockedDestinationError) {
          return { ok: false, error: redirects ? "redirect_blocked" : "blocked_host" };
        }
        return { ok: false, error: "fetch_failed" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
