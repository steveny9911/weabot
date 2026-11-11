const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];
const MAX_DELAY_MS = 30_000;
/** Methods that are safe to repeat: a retry after a lost response cannot apply them twice. */
const IDEMPOTENT_METHODS = ["GET", "HEAD", "PUT", "DELETE"];

/**
 * Fetches with exponential backoff; each attempt times out after `timeoutMs`.
 *
 * - Idempotent requests retry network errors, timeouts and retryable statuses.
 * - Other requests (POST, PATCH) retry only 429, which is refused before anything happens, so
 *   a message is never posted twice.
 * - 429 honours Retry-After. The caller's `signal` aborting stops at once, without a retry.
 *
 * After the last attempt the failed response is returned or the error thrown.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  { maxRetries = 3, initialDelayMs = 1000, timeoutMs = 15_000 } = {},
): Promise<Response> {
  const idempotent = IDEMPOTENT_METHODS.includes((init.method ?? "GET").toUpperCase());
  let backoff = initialDelayMs;
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= maxRetries;
    const tries = `attempt ${attempt + 1}/${maxRetries + 1}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let delay = backoff;
    try {
      const response = await fetch(url, { ...init, signal });
      const retryable =
        response.status === 429 || (idempotent && RETRYABLE_STATUSES.includes(response.status));
      if (response.ok || !retryable || last) return response;
      const retryAfter = Number.parseFloat(response.headers.get("Retry-After") ?? "");
      if (response.status === 429 && retryAfter >= 0) {
        delay = Math.min(retryAfter * 1000, MAX_DELAY_MS);
      }
      await response.body?.cancel();
      console.warn(
        `[RETRY] Request failed with ${response.status}, ${tries}, retrying in ${delay}ms`,
      );
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (last || !idempotent || init.signal?.aborted) throw failure;
      console.warn(`[RETRY] Request error: ${failure.message}, ${tries}, retrying in ${delay}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    backoff = Math.min(backoff * 2, MAX_DELAY_MS);
  }
}
