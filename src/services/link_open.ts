/**
 * Link Open Service
 *
 * Safely fetches and extracts text from user-provided links for AI context.
 * This service is intentionally strict: HTML-only, limited redirects, and
 * blocked local/private/metadata hosts.
 */

import type { AppConfig } from "../config.ts";
import {
  bIsBlockedHost,
  BlockedDestinationError,
  createPublicFetch,
  type LinkFetch,
  szNormalizeHost,
} from "./public_fetch.ts";

const MAX_REDIRECTS = 3;
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

function szDecodeHtmlEntities(text: string): string {
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

function szNormalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function szExtractTitle(html: string): string {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  const plain = match[1].replace(/<[^>]+>/g, " ");
  return szNormalizeWhitespace(szDecodeHtmlEntities(plain));
}

function szExtractTextExcerpt(html: string, max_chars: number): string {
  let body = html;
  body = body.replace(/<!--[\s\S]*?-->/g, " ");
  body = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  body = body.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  body = body.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  body = body.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ");
  body = body.replace(/<math\b[^>]*>[\s\S]*?<\/math>/gi, " ");
  body = body.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ");
  body = body.replace(/<[^>]+>/g, " ");

  const plain = szNormalizeWhitespace(szDecodeHtmlEntities(body));
  if (plain.length <= max_chars) return plain;
  return plain.slice(0, max_chars - 3) + "...";
}

async function aReadBodyWithLimit(
  response: Response,
  max_bytes: number,
): Promise<
  { ok: true; text: string; bytes: number } | {
    ok: false;
    error: "response_too_large" | "fetch_failed";
  }
> {
  const reader = response.body?.getReader();
  if (!reader) return { ok: false, error: "fetch_failed" };

  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max_bytes) return { ok: false, error: "response_too_large" };
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
}

function bIsRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

/**
 * Create link open service.
 */
export function createLinkOpenService(
  _config: AppConfig,
  dependencies: { fetch?: LinkFetch } = {},
): LinkOpenService {
  const fetchPage = dependencies.fetch ?? createPublicFetch();
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

      if (bIsBlockedHost(current)) {
        console.log(`[LINK] blocked: blocked_host (${current.hostname})`);
        return { ok: false, error: "blocked_host" };
      }

      let redirects = 0;
      while (true) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        let response: Response;
        try {
          response = await fetchPage(current.toString(), {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              Accept: "text/html,application/xhtml+xml",
            },
          });
        } catch (err) {
          clearTimeout(timer);
          if (err instanceof BlockedDestinationError) {
            return { ok: false, error: redirects ? "redirect_blocked" : "blocked_host" };
          }
          if (err instanceof DOMException && err.name === "AbortError") {
            return { ok: false, error: "timeout" };
          }
          return { ok: false, error: "fetch_failed" };
        }
        clearTimeout(timer);

        if (bIsRedirectStatus(response.status)) {
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
          if (bIsBlockedHost(next)) {
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

        const content_type = (response.headers.get("content-type") ?? "").toLowerCase();
        if (!content_type.includes("text/html")) {
          return { ok: false, error: "unsupported_content_type" };
        }

        const content_length = response.headers.get("content-length");
        if (content_length) {
          const len = Number.parseInt(content_length, 10);
          if (Number.isFinite(len) && len > MAX_HTML_BYTES) {
            return { ok: false, error: "response_too_large" };
          }
        }

        const body_result = await aReadBodyWithLimit(response, MAX_HTML_BYTES);
        if (!body_result.ok) return { ok: false, error: body_result.error };

        const title = szExtractTitle(body_result.text);
        const excerpt = szExtractTextExcerpt(body_result.text, MAX_EXCERPT_CHARS);

        console.log(
          `[LINK] fetched: domain=${
            szNormalizeHost(current.hostname)
          } bytes=${body_result.bytes} redirects=${redirects}`,
        );
        return {
          ok: true,
          page: {
            domain: szNormalizeHost(current.hostname),
            title,
            excerpt,
          },
        };
      }
    },
  };
}
