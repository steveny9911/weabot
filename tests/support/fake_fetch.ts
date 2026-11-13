import type { Fetcher } from "../../src/types/fetch.ts";

/** Records each request a provider makes and answers it with `respond`; `images` are served by URL. */
export function fakeFetch<Body = Record<string, unknown>>(
  respond: () => Response,
  images: Record<string, Response> = {},
) {
  const calls: Array<{ url: string; headers: Headers; body: Body }> = [];
  const fetcher: Fetcher = async (input, init) => {
    const url = String(input);
    if (url in images) return images[url]!;
    calls.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return respond();
  };
  return { calls, fetcher };
}
