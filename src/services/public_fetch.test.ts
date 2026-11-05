import { describe, expect, spyOn, test } from "bun:test";
import { rejects } from "../../test_support/assert.ts";
import { BlockedDestinationError, createPublicFetch, resolveAddresses } from "./public_fetch.ts";
import { createLinkOpenService } from "./link_open.ts";
import type { AppConfig } from "../config.ts";

const publicV4 = "93.184.216.34";
const publicV6 = "2606:4700:4700::1111";
const blocked = [
  "0.0.0.0",
  "10.1.2.3",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.169.254",
  "172.31.1.1",
  "192.0.0.8",
  "192.0.2.1",
  "192.88.99.1",
  "192.168.0.1",
  "198.18.1.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "240.0.0.1",
  "255.255.255.255",
  "::",
  "::1",
  "::127.0.0.1",
  "::ffff:127.0.0.1",
  "64:ff9b::a00:1",
  "100::1",
  "2001::1",
  "2001:2::1",
  "2001:db8::1",
  "2002:7f00:1::",
  "3fff::1",
  "fc00::1",
  "fd12::1",
  "fe80::1",
  "fec0::1",
  "ff02::1",
];

describe("DNS addresses: every private/reserved IPv4 and IPv6 answer blocks before request", () => {
  for (const address of blocked) {
    test(address, async () => {
      let requests = 0;
      const fetch = createPublicFetch({
        resolve: () => Promise.resolve([address]),
        request: () => {
          requests++;
          return Promise.resolve(new Response("unexpected"));
        },
      });
      await rejects(() => fetch("https://attacker.example/trigger", {}), BlockedDestinationError);
      expect(requests).toStrictEqual(0);
    });
  }
});

test("DNS mixed families and answer order fail closed before any connection", async () => {
  for (const answers of [
    [publicV4, "127.0.0.1"],
    ["::1", publicV6],
    [publicV4, "fd00::1"],
    [publicV6, "10.0.0.1"],
  ]) {
    let requests = 0;
    const fetch = createPublicFetch({
      resolve: () => Promise.resolve(answers),
      request: () => {
        requests++;
        return Promise.resolve(new Response());
      },
    });
    await rejects(() => fetch("https://mixed.example/", {}), BlockedDestinationError);
    expect(requests).toStrictEqual(0);
  }
});

test("DNS rebinding cannot change the pinned address, including on repeated requests", async () => {
  let lookups = 0;
  const destinations: string[] = [];
  const fetch = createPublicFetch({
    resolve: () => Promise.resolve(++lookups === 1 ? [publicV4] : ["127.0.0.1"]),
    request: (url, address) => {
      expect(url.hostname).toStrictEqual("rebind.example");
      destinations.push(address);
      return Promise.resolve(new Response("public page"));
    },
  });
  expect(await (await fetch("http://rebind.example/", {})).text()).toStrictEqual("public page");
  await rejects(() => fetch("http://rebind.example/", {}), BlockedDestinationError);
  expect(lookups).toStrictEqual(2);
  expect(destinations).toStrictEqual([publicV4]);
});

test("public HTTP, HTTPS, literal IPs and multiple public answers remain supported", async () => {
  for (const input of [
    "http://public.example/a?b=1",
    "https://PUBLIC.example./",
    `http://${publicV4}/`,
    `https://[${publicV6}]/`,
    "http://[::ffff:8.8.8.8]/",
  ]) {
    let requests = 0;
    const fetch = createPublicFetch({
      resolve: (host) => {
        expect(host).toStrictEqual("public.example");
        return Promise.resolve([publicV4, publicV6]);
      },
      request: (url, address) => {
        expect(url.toString()).toStrictEqual(new URL(input).toString());
        expect(
          address === publicV4 || address === publicV6 || address === "::ffff:808:808",
        ).toStrictEqual(true);
        requests++;
        return Promise.resolve(new Response("ok"));
      },
    });
    expect(await (await fetch(input, {})).text()).toStrictEqual("ok");
    expect(requests).toStrictEqual(1);
  }
});

test("empty/failed/malformed DNS and credential-bearing URLs never reach transport", async () => {
  let requests = 0;
  for (const resolve of [
    () => Promise.resolve([]),
    () => Promise.resolve(["not-an-ip"]),
    () => Promise.reject(new Error("DNS failed")),
  ]) {
    const fetch = createPublicFetch({
      resolve,
      request: () => {
        requests++;
        return Promise.resolve(new Response());
      },
    });
    await rejects(() => fetch("https://public.example/", {}));
  }
  const fetch = createPublicFetch({
    resolve: () => {
      throw new Error("DNS must not be reached");
    },
    request: () => {
      requests++;
      return Promise.resolve(new Response());
    },
  });
  for (const url of [
    "https://user:password@public.example/",
    "ftp://public.example/",
    "http://localhost./",
    "http://a.localhost/",
  ]) {
    await rejects(() => fetch(url, {}), BlockedDestinationError);
  }
  expect(requests).toStrictEqual(0);
});

test("abort during DNS prevents a late answer from opening a socket", async () => {
  const controller = new AbortController();
  let requests = 0;
  const fetch = createPublicFetch({
    resolve: (_host, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      return Promise.resolve([publicV4]);
    },
    request: () => {
      requests++;
      return Promise.resolve(new Response());
    },
  });
  await rejects(
    () => fetch("https://public.example/", { signal: controller.signal }),
    DOMException,
    "aborted",
  );
  expect(requests).toStrictEqual(0);
});

test("DNS resolver returns both families, maps missing names to none, and rejects failures", async () => {
  const lookups: unknown[][] = [];
  const spy = spyOn(Bun.dns, "lookup").mockImplementation(((...args: unknown[]) => {
    lookups.push(args);
    return Promise.resolve([
      { address: publicV4, family: 4, ttl: 0 },
      { address: publicV6, family: 6, ttl: 0 },
    ]);
  }) as typeof Bun.dns.lookup);
  try {
    // The default lookup asks c-ares for both families in one query.
    expect(await resolveAddresses("public.example")).toStrictEqual([publicV4, publicV6]);
    expect(lookups).toStrictEqual([["public.example", { backend: "c-ares" }]]);
  } finally {
    spy.mockRestore();
  }
  for (const code of ["DNS_ENOTFOUND", "DNS_ENODATA"]) {
    const missing = () => Promise.reject(Object.assign(new Error("not found"), { code }));
    expect(await resolveAddresses("public.example", undefined, missing)).toStrictEqual([]);
  }
  const failure = () =>
    Promise.reject(Object.assign(new Error("timed out"), { code: "DNS_ETIMEOUT" }));
  await rejects(() => resolveAddresses("public.example", undefined, failure), Error, "timed out");
});

test("link service validates DNS at every redirect, including same-host rebinding", async () => {
  for (const sameHost of [false, true]) {
    let lookups = 0;
    const requests: string[] = [];
    const fetch = createPublicFetch({
      resolve: () => Promise.resolve(++lookups === 1 ? [publicV4] : ["127.0.0.1"]),
      request: (_url, address) => {
        requests.push(address);
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: sameHost ? "/internal" : "http://internal.example/trigger" },
          }),
        );
      },
    });
    const service = createLinkOpenService({} as AppConfig, { fetch });
    expect(await service.open("http://public.example/start")).toStrictEqual({
      ok: false,
      error: "redirect_blocked",
    });
    expect(requests).toStrictEqual([publicV4]);
  }
});

test("allowed redirects still yield HTML context through the protected transport", async () => {
  const requests: string[] = [];
  const fetch = createPublicFetch({
    resolve: () => Promise.resolve([publicV4, publicV6]),
    request: (url, address) => {
      expect(address).toStrictEqual(publicV4);
      requests.push(url.pathname);
      return Promise.resolve(
        url.pathname === "/start"
          ? new Response(null, {
              status: 302,
              headers: { location: "https://second.example/page" },
            })
          : new Response(
              "<html><head><title>Working</title></head><body>Public links work.</body></html>",
              {
                headers: { "content-type": "text/html" },
              },
            ),
      );
    },
  });
  const service = createLinkOpenService({} as AppConfig, { fetch });
  expect(await service.open("http://public.example/start")).toStrictEqual({
    ok: true,
    page: { domain: "second.example", title: "Working", excerpt: "Public links work." },
  });
  expect(requests).toStrictEqual(["/start", "/page"]);
});

describe("partial family results are validated before connecting", () => {
  const resolveWith = (records: string[]) => (hostname: string, signal?: AbortSignal) =>
    resolveAddresses(hostname, signal, () =>
      Promise.resolve(records.map((address) => ({ address }))),
    );

  test("an IPv4-only answer opens over IPv4", async () => {
    const destinations: string[] = [];
    const fetch = createPublicFetch({
      resolve: resolveWith([publicV4]),
      request: (_url, address) => {
        destinations.push(address);
        return Promise.resolve(new Response("ok"));
      },
    });
    expect(await (await fetch("https://public.example/", {})).text()).toBe("ok");
    expect(destinations).toStrictEqual([publicV4]);
  });

  test("a private address in either family blocks before any connection", async () => {
    for (const answers of [
      [publicV4, "fd00::1"],
      ["10.0.0.1", publicV6],
    ]) {
      let requests = 0;
      const fetch = createPublicFetch({
        resolve: resolveWith(answers),
        request: () => {
          requests++;
          return Promise.resolve(new Response());
        },
      });
      await rejects(() => fetch("https://public.example/", {}), BlockedDestinationError);
      expect(requests).toBe(0);
    }
  });
});

test("a hung DNS lookup ends at the caller's deadline with its reason", async () => {
  const caller = new AbortController();
  const reason = new DOMException("Deadline expired", "AbortError");
  let started = 0;
  const hung = () => {
    started++;
    return new Promise<never>(() => {});
  };
  const removed: string[] = [];
  const remove = caller.signal.removeEventListener.bind(caller.signal);
  caller.signal.removeEventListener = ((type: string, ...rest: [never]) => {
    removed.push(type);
    return remove(type, ...rest);
  }) as typeof caller.signal.removeEventListener;
  const result = resolveAddresses("public.example", caller.signal, hung);
  caller.abort(reason);
  const error = await rejects(() => result, DOMException, "Deadline expired");
  expect(error).toBe(reason);
  expect(started).toBe(1);
  // The abort listener is removed once the wait ends.
  expect(removed).toStrictEqual(["abort"]);
});

test("DNS resolver starts no lookup when its caller is already aborted", async () => {
  const caller = new AbortController();
  caller.abort();
  let lookups = 0;
  const lookup = () => {
    lookups++;
    return Promise.resolve([]);
  };
  await rejects(() => resolveAddresses("public.example", caller.signal, lookup), DOMException);
  expect(lookups).toBe(0);
});
