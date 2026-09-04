/**
 * Web Search Service
 *
 * Provides a simple, injectable interface for internet search.
 * Uses Brave Search API for reliable results and easy setup.
 */

import type { AppConfig } from "../config.ts";
import { fetchWithRetry } from "../utils/retry.ts";

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const MAX_RESULTS_CAP = 10;

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebSearchService {
  /**
   * Perform a web search and return top results.
   */
  search(
    query: string,
    maxResults?: number,
  ): Promise<{ ok: true; results: SearchResult[] } | { ok: false; error: string }>;
}

interface BraveSearchResultItem {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResultItem[];
  };
}

function szTruncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

/**
 * Extract a search query for auto-search from a mention message.
 * This is a conservative heuristic to avoid searching small talk.
 */
export function szExtractAutoSearchQuery(content: string | undefined): string | null {
  if (!content) return null;

  const cleaned = content.replace(/<@!?\d+>/g, "").trim();
  if (!cleaned) return null;

  // Skip explicit commands
  if (/^\\search\b/i.test(cleaned) || /^search[:\s]/i.test(cleaned)) return null;
  if (/\\reset\b/i.test(cleaned)) return null;

  // Avoid small talk or subjective prompts
  if (
    /^(hi|hello|hey|yo|sup|how are you|how r u|how's it going|what's up|whats up)\b/i
      .test(cleaned)
  ) {
    return null;
  }
  if (
    /\b(what do you think|how do you feel|what's your favorite|should I)\b/i.test(
      cleaned,
    )
  ) {
    return null;
  }
  if (
    /\b(what are you talking about|what do you mean|what's that about|who are you|why are you|how are you)\b/i
      .test(cleaned)
  ) {
    return null;
  }

  const questionLike = /\?$/.test(cleaned) ||
    /^(who|what|when|where|why|how|define|explain|meaning of|difference between|compare|best|top)\b/i
      .test(cleaned) ||
    /\b(what is|who is|when is|where is|how to|define|explain|meaning of|difference between|compare|best|top)\b/i
      .test(cleaned);

  if (!questionLike) return null;

  return cleaned;
}

/**
 * Format search results for AI context (neutral, no character voice).
 */
export function formatSearchResultsForContext(
  query: string,
  results: SearchResult[],
): string {
  const cleanQuery = query.trim();
  if (results.length === 0) {
    return `Reference notes for "${cleanQuery}": none`;
  }

  const header = `Reference notes for "${cleanQuery}":`;
  const lines = results.map((result, index) => {
    const title = result.title?.trim() || "Source";
    const snippet = result.snippet ? ` - ${szTruncate(result.snippet.trim(), 200)}` : "";
    return `${index + 1}. ${title}${snippet}`;
  });

  return [header, ...lines].join("\n");
}

/**
 * Create a web search service using Brave Search API.
 */
export function createWebSearchService(config: AppConfig): WebSearchService {
  return {
    async search(query: string, maxResults?: number) {
      if (!config.webSearchEnabled) {
        return { ok: false, error: "Web search is disabled" };
      }
      if (!config.webSearchApiKey) {
        return { ok: false, error: "BRAVE_SEARCH_API_KEY not set" };
      }

      const trimmed = query.trim();
      if (!trimmed) {
        return { ok: false, error: "Empty search query" };
      }

      const requested = maxResults ?? config.webSearchMaxResults;
      const count = Math.max(1, Math.min(requested, MAX_RESULTS_CAP));

      const url = new URL(BRAVE_SEARCH_URL);
      url.searchParams.set("q", trimmed);
      url.searchParams.set("count", String(count));
      url.searchParams.set("source", "web");
      url.searchParams.set("safesearch", "strict");

      try {
        const response = await fetchWithRetry(url.toString(), {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": config.webSearchApiKey,
          },
        });

        if (!response.ok) {
          const body = await response.text();
          return { ok: false, error: `Brave Search error ${response.status}: ${body}` };
        }

        const data = (await response.json()) as BraveSearchResponse;
        const items = data.web?.results ?? [];

        const results: SearchResult[] = items
          .map((item) => ({
            title: item.title?.trim() || "",
            url: item.url?.trim() || "",
            snippet: item.description?.trim() || "",
          }))
          .filter((item) => item.url.length > 0)
          .slice(0, count);

        return { ok: true, results };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  };
}
