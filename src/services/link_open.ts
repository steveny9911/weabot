/**
 * Link Open Service
 *
 * Safely fetches and extracts text from user-provided links for AI context.
 * This service is intentionally strict: HTML-only, limited redirects, and
 * blocked local/private/metadata hosts.
 */

import type { AppConfig } from "../config.ts";

const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 1024 * 1024; // 1 MB
const MAX_EXCERPT_CHARS = 3500;

const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
  "metadata.azure.internal",
]);

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

function szNormalizeHost(hostname: string): string {
  let normalized = hostname.trim().toLowerCase().replace(/\.+$/, "");
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  return normalized;
}

function aiParseIpv4(hostname: string): number[] | null {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return null;
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;

  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number.parseInt(p, 10);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out.push(n);
  }
  return out;
}

function bIsBlockedIpv4(octets: number[]): boolean {
  const [a, b, c] = octets;

  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24
  if (a >= 224) return true; // multicast + reserved

  return false;
}

function aiParseIpv6(hostname: string): number[] | null {
  let host = hostname.toLowerCase();
  const zone_idx = host.indexOf("%");
  if (zone_idx >= 0) host = host.slice(0, zone_idx);
  if (!host.includes(":")) return null;

  // Convert trailing IPv4 into 2 hextets if present.
  if (host.includes(".")) {
    const last_colon = host.lastIndexOf(":");
    if (last_colon < 0) return null;
    const ipv4_tail = host.slice(last_colon + 1);
    const octets = aiParseIpv4(ipv4_tail);
    if (!octets) return null;
    const h1 = ((octets[0] << 8) | octets[1]).toString(16);
    const h2 = ((octets[2] << 8) | octets[3]).toString(16);
    host = `${host.slice(0, last_colon)}:${h1}:${h2}`;
  }

  const halves = host.split("::");
  if (halves.length > 2) return null;

  const left_raw = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right_raw = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];

  const parse_h16 = (s: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/.test(s)) return null;
    return Number.parseInt(s, 16);
  };

  const left: number[] = [];
  for (const seg of left_raw) {
    const n = parse_h16(seg);
    if (n === null) return null;
    left.push(n);
  }

  const right: number[] = [];
  for (const seg of right_raw) {
    const n = parse_h16(seg);
    if (n === null) return null;
    right.push(n);
  }

  let hextets: number[] = [];
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    hextets = left;
  } else {
    const zeros = 8 - (left.length + right.length);
    if (zeros < 1) return null;
    hextets = [...left, ...Array(zeros).fill(0), ...right];
  }

  if (hextets.length !== 8) return null;

  const bytes: number[] = [];
  for (const h of hextets) {
    bytes.push((h >> 8) & 0xff, h & 0xff);
  }
  return bytes;
}

function bIsBlockedIpv6(bytes: number[]): boolean {
  const is_all_zero = bytes.every((b) => b === 0);
  if (is_all_zero) return true; // ::

  const is_loopback = bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1;
  if (is_loopback) return true; // ::1

  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10
  if (bytes[0] === 0xff) return true; // ff00::/8

  // 2001:db8::/32 documentation range
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return true;
  }

  // IPv4-mapped IPv6 ::ffff:a.b.c.d
  const is_ipv4_mapped = bytes.slice(0, 10).every((b) => b === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  if (is_ipv4_mapped) {
    const mapped = bytes.slice(12, 16);
    return bIsBlockedIpv4(mapped);
  }

  return false;
}

function bIsBlockedHost(url: URL): boolean {
  const host = szNormalizeHost(url.hostname);
  if (!host) return true;

  if (host === "localhost" || host.endsWith(".local")) return true;
  if (METADATA_HOSTS.has(host)) return true;

  const ipv4 = aiParseIpv4(host);
  if (ipv4) return bIsBlockedIpv4(ipv4);

  const ipv6 = aiParseIpv6(host);
  if (ipv6) return bIsBlockedIpv6(ipv6);

  return false;
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
export function createLinkOpenService(_config: AppConfig): LinkOpenService {
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
          response = await fetch(current.toString(), {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              Accept: "text/html,application/xhtml+xml",
            },
          });
        } catch (err) {
          clearTimeout(timer);
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
