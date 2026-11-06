/**
 * The subset of `fetch` that services call. Injected fetchers (and test stubs) use this instead
 * of `typeof fetch`, which in Bun's types also requires a `preconnect` method.
 */
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
