import { asFetch } from "./fetch.ts";

export type MockResponse = Record<string, unknown> | Response | Error;

/**
 * Answers the model requests made inside `run`, one `responses` entry per request, and passes
 * `run` the request bodies sent so far. A request beyond the list fails the test.
 */
export async function withResponses<T>(
  responses: MockResponse[],
  run: (requests: Array<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  const requests: Array<Record<string, unknown>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = asFetch((_input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const response = responses[requests.length - 1];
    if (response instanceof Error) return Promise.reject(response);
    if (!response) return Promise.reject(new Error("Unexpected model request"));
    return Promise.resolve(response instanceof Response ? response : Response.json(response));
  });
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = original;
  }
}
