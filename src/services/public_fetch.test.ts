import { assert, assertEquals, assertRejects } from "@std/assert";
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

Deno.test("DNS addresses: every private/reserved IPv4 and IPv6 answer blocks before request", async (t) => {
  for (const address of blocked) {
    await t.step(address, async () => {
      let requests = 0;
      const fetch = createPublicFetch({
        resolve: () => Promise.resolve([address]),
        request: () => {
          requests++;
          return Promise.resolve(new Response("unexpected"));
        },
      });
      await assertRejects(
        () => fetch("https://attacker.example/trigger", {}),
        BlockedDestinationError,
      );
      assertEquals(requests, 0);
    });
  }
});

Deno.test("DNS mixed families and answer order fail closed before any connection", async () => {
  for (
    const answers of [[publicV4, "127.0.0.1"], ["::1", publicV6], [publicV4, "fd00::1"], [
      publicV6,
      "10.0.0.1",
    ]]
  ) {
    let requests = 0;
    const fetch = createPublicFetch({
      resolve: () => Promise.resolve(answers),
      request: () => {
        requests++;
        return Promise.resolve(new Response());
      },
    });
    await assertRejects(() => fetch("https://mixed.example/", {}), BlockedDestinationError);
    assertEquals(requests, 0);
  }
});

Deno.test("DNS rebinding cannot change the pinned address, including on repeated requests", async () => {
  let lookups = 0;
  const destinations: string[] = [];
  const fetch = createPublicFetch({
    resolve: () => Promise.resolve(++lookups === 1 ? [publicV4] : ["127.0.0.1"]),
    request: (url, address) => {
      assertEquals(url.hostname, "rebind.example");
      destinations.push(address);
      return Promise.resolve(new Response("public page"));
    },
  });
  assertEquals(await (await fetch("http://rebind.example/", {})).text(), "public page");
  await assertRejects(() => fetch("http://rebind.example/", {}), BlockedDestinationError);
  assertEquals(lookups, 2);
  assertEquals(destinations, [publicV4]);
});

Deno.test("public HTTP, HTTPS, literal IPs and multiple public answers remain supported", async () => {
  for (
    const input of [
      "http://public.example/a?b=1",
      "https://PUBLIC.example./",
      `http://${publicV4}/`,
      `https://[${publicV6}]/`,
      "http://[::ffff:8.8.8.8]/",
    ]
  ) {
    let requests = 0;
    const fetch = createPublicFetch({
      resolve: (host) => {
        assertEquals(host, "public.example");
        return Promise.resolve([publicV4, publicV6]);
      },
      request: (url, address) => {
        assertEquals(url.toString(), new URL(input).toString());
        assertEquals(
          address === publicV4 || address === publicV6 || address === "::ffff:808:808",
          true,
        );
        requests++;
        return Promise.resolve(new Response("ok"));
      },
    });
    assertEquals(await (await fetch(input, {})).text(), "ok");
    assertEquals(requests, 1);
  }
});

Deno.test("empty/failed/malformed DNS and credential-bearing URLs never reach transport", async () => {
  let requests = 0;
  for (
    const resolve of [
      () => Promise.resolve([]),
      () => Promise.resolve(["not-an-ip"]),
      () => Promise.reject(new Error("DNS failed")),
    ]
  ) {
    const fetch = createPublicFetch({
      resolve,
      request: () => {
        requests++;
        return Promise.resolve(new Response());
      },
    });
    await assertRejects(() => fetch("https://public.example/", {}));
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
  for (
    const url of [
      "https://user:password@public.example/",
      "ftp://public.example/",
      "http://localhost./",
      "http://a.localhost/",
    ]
  ) {
    await assertRejects(() => fetch(url, {}), BlockedDestinationError);
  }
  assertEquals(requests, 0);
});

Deno.test("abort during DNS prevents a late answer from opening a socket", async () => {
  const controller = new AbortController();
  let requests = 0;
  const fetch = createPublicFetch({
    resolve: (_host, signal) => {
      assertEquals(signal, controller.signal);
      controller.abort();
      return Promise.resolve([publicV4]);
    },
    request: () => {
      requests++;
      return Promise.resolve(new Response());
    },
  });
  await assertRejects(
    () => fetch("https://public.example/", { signal: controller.signal }),
    DOMException,
    "aborted",
  );
  assertEquals(requests, 0);
});

Deno.test("DNS resolver requires both families, tolerates only missing records, and propagates signal", async () => {
  const original = Deno.resolveDns;
  const controller = new AbortController();
  const calls: string[] = [];
  try {
    Deno.resolveDns = ((_host: string, type: string, options?: Deno.ResolveDnsOptions) => {
      assert(options?.signal instanceof AbortSignal);
      assertEquals(options.signal.aborted, false);
      calls.push(type);
      if (type === "AAAA") return Promise.reject(new Deno.errors.NotFound());
      return Promise.resolve([publicV4]);
    }) as typeof Deno.resolveDns;
    assertEquals(await resolveAddresses("public.example", controller.signal), [publicV4]);
    assertEquals(calls.sort(), ["A", "AAAA"]);
    assertEquals(controller.signal.aborted, false);
    Deno.resolveDns = (() => Promise.reject(new Deno.errors.TimedOut())) as typeof Deno.resolveDns;
    await assertRejects(() => resolveAddresses("public.example"), Deno.errors.TimedOut);
  } finally {
    Deno.resolveDns = original;
  }
});

Deno.test("link service validates DNS at every redirect, including same-host rebinding", async () => {
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
    assertEquals(await service.open("http://public.example/start"), {
      ok: false,
      error: "redirect_blocked",
    });
    assertEquals(requests, [publicV4]);
  }
});

Deno.test("allowed redirects still yield HTML context through the protected transport", async () => {
  const requests: string[] = [];
  const fetch = createPublicFetch({
    resolve: () => Promise.resolve([publicV4, publicV6]),
    request: (url, address) => {
      assertEquals(address, publicV4);
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
  assertEquals(await service.open("http://public.example/start"), {
    ok: true,
    page: { domain: "second.example", title: "Working", excerpt: "Public links work." },
  });
  assertEquals(requests, ["/start", "/page"]);
});

Deno.test("DNS family failure cancels and settles the pending sibling before returning", async (t) => {
  for (const failedFamily of ["A", "AAAA"]) {
    await t.step(failedFamily, async () => {
      const original = Deno.resolveDns;
      const caller = new AbortController();
      const pending = Promise.withResolvers<string[]>();
      let siblingSettled = false;
      let siblingSignal: AbortSignal | undefined;
      try {
        Deno.resolveDns = ((_host: string, type: string, options?: Deno.ResolveDnsOptions) => {
          if (type === failedFamily) return Promise.reject(new Error("resolver failure"));
          siblingSignal = options?.signal;
          siblingSignal?.addEventListener("abort", () => pending.reject(siblingSignal?.reason), {
            once: true,
          });
          return pending.promise.finally(() => {
            siblingSettled = true;
          });
        }) as typeof Deno.resolveDns;
        await assertRejects(
          () => resolveAddresses("public.example", caller.signal),
          Error,
          "resolver failure",
        );
        assertEquals(siblingSignal?.aborted, true);
        assertEquals(siblingSettled, true);
        assertEquals(caller.signal.aborted, false, "lookup failure must not abort its caller");
      } finally {
        pending.resolve([]);
        Deno.resolveDns = original;
      }
    });
  }
});

Deno.test("DNS caller cancellation aborts and settles both pending address families", async () => {
  const original = Deno.resolveDns;
  const caller = new AbortController();
  const reason = new DOMException("Deadline expired", "AbortError");
  const signals: AbortSignal[] = [];
  const pending: ReturnType<typeof Promise.withResolvers<string[]>>[] = [];
  let settled = 0;
  try {
    Deno.resolveDns = ((_host: string, _type: string, options?: Deno.ResolveDnsOptions) => {
      assert(options?.signal);
      const signal = options.signal;
      signals.push(signal);
      const lookup = Promise.withResolvers<string[]>();
      pending.push(lookup);
      signal.addEventListener("abort", () => lookup.reject(signal.reason), { once: true });
      return lookup.promise.finally(() => {
        settled++;
      });
    }) as typeof Deno.resolveDns;
    const result = resolveAddresses("public.example", caller.signal);
    caller.abort(reason);
    const error = await assertRejects(() => result, DOMException, "Deadline expired");
    assertEquals(error, reason);
    assertEquals(signals.length, 2);
    assert(signals.every((signal) => signal.aborted && signal.reason === reason));
    assertEquals(settled, 2);
  } finally {
    for (const lookup of pending) lookup.resolve([]);
    Deno.resolveDns = original;
  }
});

Deno.test("DNS resolver starts no queries when its caller is already aborted", async () => {
  const original = Deno.resolveDns;
  const caller = new AbortController();
  caller.abort();
  let queries = 0;
  try {
    Deno.resolveDns = (() => {
      queries++;
      return Promise.resolve([]);
    }) as typeof Deno.resolveDns;
    await assertRejects(() => resolveAddresses("public.example", caller.signal), DOMException);
    assertEquals(queries, 0);
  } finally {
    Deno.resolveDns = original;
  }
});
