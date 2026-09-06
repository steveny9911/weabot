/** Public-only link transport. DNS answers are checked once and the connection
 * uses a numeric address, preserving the original HTTP Host and TLS identity. */
import { Agent as HttpAgent, request as requestHttp } from "node:http";
import { Agent as HttpsAgent, request as requestHttps } from "node:https";
import { createConnection, isIP } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
  "metadata.azure.internal",
]);

export function szNormalizeHost(hostname: string): string {
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
  // Only native global unicast and validated IPv4-mapped addresses are allowed.
  // This also excludes translation/tunnel prefixes, deprecated site-local space,
  // unspecified/compatible IPv4, and future reserved allocations.
  const mapped = bytes.slice(0, 10).every((b) => b === 0) &&
    bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return bIsBlockedIpv4(bytes.slice(12));
  if ((bytes[0] & 0xe0) !== 0x20) return true; // outside 2000::/3
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] < 2) return true; // 2001::/23
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return true; // 6to4
  if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0) return true; // 3fff::/20
  // 2001:db8::/32 documentation range
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return true;
  }

  return false;
}

export function bIsBlockedHost(url: URL): boolean {
  const host = szNormalizeHost(url.hostname);
  if (!host) return true;

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (METADATA_HOSTS.has(host)) return true;

  const ipv4 = aiParseIpv4(host);
  if (ipv4) return bIsBlockedIpv4(ipv4);

  const ipv6 = aiParseIpv6(host);
  if (ipv6) return bIsBlockedIpv6(ipv6);

  return false;
}

export class BlockedDestinationError extends Error {
  constructor() {
    super("Link destination is not public");
    this.name = "BlockedDestinationError";
  }
}

export type LinkFetch = (url: string, init: RequestInit) => Promise<Response>;
export type ResolveAddresses = (hostname: string, signal?: AbortSignal) => Promise<string[]>;
export type PinnedRequest = (
  url: URL,
  address: string,
  signal?: AbortSignal,
) => Promise<Response>;

/** Resolve both families before connecting; an incomplete lookup fails closed. */
export async function resolveAddresses(hostname: string, signal?: AbortSignal): Promise<string[]> {
  const answers = await Promise.all(["A", "AAAA"].map(async (type) => {
    try {
      return await Deno.resolveDns(hostname, type as "A" | "AAAA", { signal });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
  }));
  return answers.flat();
}

/** Low-level transport: callers must validate address before calling this.
 * Exported separately so CI can prove numeric pinning and TLS verification on
 * isolated loopback fixtures without weakening production destination policy.
 */
export function requestPinned(
  url: URL,
  address: string,
  signal?: AbortSignal,
  ca?: string,
): Promise<Response> {
  if (!isIP(address)) return Promise.reject(new BlockedDestinationError());
  signal?.throwIfAborted();
  const secure = url.protocol === "https:";
  const hostname = szNormalizeHost(url.hostname);
  const port = Number(url.port || (secure ? 443 : 80));
  const agent = secure
    ? new HttpsAgent({ keepAlive: false, ca })
    : new HttpAgent({ keepAlive: false });
  // Deno 2.6 upgrades HTTPS agent sockets to TLS using the request URL's
  // hostname. Pin the TCP factory, not the URL, so certificate verification
  // and SNI retain the intended identity. Runtime CI verifies this contract.
  agent.createConnection = () => createConnection({ host: address, port });
  return new Promise((resolve, reject) => {
    const request = (secure ? requestHttps : requestHttp)({
      protocol: url.protocol,
      hostname,
      port,
      path: url.pathname + url.search,
      method: "GET",
      // A fresh connection per hop prevents pooled sockets bypassing validation.
      agent,
      servername: secure ? hostname : undefined,
      rejectUnauthorized: true,
      signal,
      headers: {
        Host: url.host,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "close",
      },
    }, (incoming) => {
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      }
      let source: Readable = incoming;
      const encoding = headers.get("content-encoding")?.trim().toLowerCase();
      if (encoding && encoding !== "identity") {
        const decoder = encoding === "gzip"
          ? createGunzip()
          : encoding === "deflate"
          ? createInflate()
          : encoding === "br"
          ? createBrotliDecompress()
          : undefined;
        if (!decoder) {
          incoming.destroy();
          reject(new Error("Unsupported content encoding"));
          return;
        }
        incoming.on("error", (error) => decoder.destroy(error));
        decoder.on("close", () => incoming.destroy());
        source = incoming.pipe(decoder);
        headers.delete("content-encoding");
        // The link reader limits decoded bytes, including compressed payloads.
        headers.delete("content-length");
      }
      const status = incoming.statusCode ?? 500;
      // Response forbids bodies for these statuses.
      if (status === 204 || status === 205 || status === 304) {
        incoming.destroy();
        resolve(new Response(null, { status, headers }));
        return;
      }
      resolve(
        new Response(Readable.toWeb(source) as ReadableStream<Uint8Array>, {
          status,
          headers,
        }),
      );
    });
    request.on("error", (error) => {
      // Node uses Error with code ABORT_ERR; retain the link service contract.
      reject(signal?.aborted ? new DOMException("Aborted", "AbortError") : error);
    });
    request.end();
  });
}

/** Every invocation validates all DNS answers and pins the actual connection.
 * Neither redirects, environment proxies, cookies, nor URL credentials are
 * followed/forwarded by this transport. Redirect policy stays in link_open.
 */
export function createPublicFetch(dependencies: {
  resolve?: ResolveAddresses;
  request?: PinnedRequest;
} = {}): LinkFetch {
  const resolve = dependencies.resolve ?? resolveAddresses;
  const request = dependencies.request ?? requestPinned;
  return async (input, init) => {
    const url = new URL(input);
    if (
      !["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      bIsBlockedHost(url)
    ) throw new BlockedDestinationError();
    const hostname = szNormalizeHost(url.hostname);
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    const addresses = isIP(hostname) ? [hostname] : await resolve(hostname, signal);
    signal?.throwIfAborted();
    if (addresses.length === 0) throw new Error("No addresses found");
    if (
      addresses.some((address) => {
        const family = isIP(address);
        if (!family) return true;
        return family === 4
          ? bIsBlockedIpv4(aiParseIpv4(address)!)
          : bIsBlockedIpv6(aiParseIpv6(address)!);
      })
    ) throw new BlockedDestinationError();
    // Pass an IP, never the hostname, to the socket implementation. A DNS
    // rebind after validation cannot change this destination.
    return await request(url, addresses[0], signal);
  };
}
