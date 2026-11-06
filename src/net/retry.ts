const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];
const MAX_DELAY_MS = 30_000;

/**
 * Fetches with exponential backoff on network errors and retryable statuses (429 honours
 * Retry-After). After the last attempt the failed response is returned or the error thrown.
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  { maxRetries = 3, initialDelayMs = 1000 } = {},
): Promise<Response> {
  let delay = initialDelayMs;
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= maxRetries;
    const tries = `attempt ${attempt + 1}/${maxRetries + 1}`;
    try {
      const response = await fetch(url, init);
      if (response.ok || !RETRYABLE_STATUSES.includes(response.status) || last) return response;
      const retryAfter = parseInt(response.headers.get("Retry-After") ?? "", 10);
      if (response.status === 429 && !isNaN(retryAfter)) {
        delay = Math.min(retryAfter * 1000, MAX_DELAY_MS);
      }
      console.warn(
        `[RETRY] Request failed with ${response.status}, ${tries}, retrying in ${delay}ms`,
      );
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (last) throw failure;
      console.warn(`[RETRY] Request error: ${failure.message}, ${tries}, retrying in ${delay}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
}
