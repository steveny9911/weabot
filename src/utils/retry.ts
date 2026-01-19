/**
 * Retry Utility
 *
 * Implements exponential backoff for network requests.
 * Critical for reliability with external APIs.
 */

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** HTTP status codes that should trigger a retry (default: [429, 500, 502, 503, 504]) */
  retryableStatuses?: number[];
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  retryableStatuses: [429, 500, 502, 503, 504],
};

/**
 * Executes a fetch request with exponential backoff retry.
 *
 * @param url - The URL to fetch
 * @param init - Fetch init options
 * @param options - Retry configuration
 * @returns The successful Response
 * @throws Error after all retries are exhausted
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options?: RetryOptions,
): Promise<Response> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let last_error: Error | null = null;
  let delay = opts.initialDelayMs;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);

      // If response is OK or not retryable, return it
      if (response.ok || !opts.retryableStatuses.includes(response.status)) {
        return response;
      }

      // Handle rate limiting with Retry-After header
      if (response.status === 429) {
        const retry_after = response.headers.get("Retry-After");
        if (retry_after) {
          const retry_delay_sec = parseInt(retry_after, 10);
          if (!isNaN(retry_delay_sec)) {
            delay = Math.min(retry_delay_sec * 1000, opts.maxDelayMs);
          }
        }
      }

      // Log retry attempt
      if (attempt < opts.maxRetries) {
        console.warn(
          `[RETRY] Request failed with ${response.status}, attempt ${attempt + 1}/${
            opts.maxRetries + 1
          }, retrying in ${delay}ms`,
        );
      } else {
        // Last attempt, return the response even if it failed
        return response;
      }
    } catch (error) {
      last_error = error instanceof Error ? error : new Error(String(error));

      if (attempt < opts.maxRetries) {
        console.warn(
          `[RETRY] Request error: ${last_error.message}, attempt ${attempt + 1}/${
            opts.maxRetries + 1
          }, retrying in ${delay}ms`,
        );
      } else {
        throw last_error;
      }
    }

    // Wait before retry
    await new Promise((resolve) => setTimeout(resolve, delay));

    // Exponential backoff
    delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelayMs);
  }

  throw last_error ?? new Error("Retry failed with no error captured");
}
