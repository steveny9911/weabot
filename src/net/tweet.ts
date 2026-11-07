/**
 * Reads a tweet (text, photos, quoted tweet) through the public FxTwitter API, falling back to
 * VxTwitter. Videos are never fetched; they are only reported.
 */

const TWEET_HOSTS = new Set([
  "x.com",
  "twitter.com",
  "mobile.twitter.com",
  "vxtwitter.com",
  "fixvx.com",
  "fxtwitter.com",
  "fixupx.com",
]);
const TWEET_PATH = /^\/[^/]+\/status\/(\d+)/;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_PHOTOS = 4;
const MAX_TEXT_CHARS = 1000;

export interface Tweet {
  author: string;
  text: string;
  photoUrls: string[];
  altTexts: string[];
  hasVideo: boolean;
  quoted?: Tweet;
}

export type TweetReadResult =
  { ok: true; tweet: Tweet } | { ok: false; error: "not_found" | "failed" };

export interface TweetService {
  read(id: string): Promise<TweetReadResult>;
}

// The two APIs name the same things differently, so each gets a small reader into this shape.
interface RawMedia {
  type?: string;
  url?: string;
  altText?: string | null;
}

interface RawTweet {
  text?: string;
  author?: { screen_name?: string };
  media?: { all?: RawMedia[] };
  quote?: RawTweet | null;
  user_screen_name?: string;
  media_extended?: RawMedia[];
  qrt?: RawTweet | null;
}

/** Returns the ID of the first tweet link in the text, or null. */
export function extractTweetId(text: string): string | null {
  for (const match of text.matchAll(/https?:\/\/[^\s<>]+/g)) {
    try {
      const url = new URL(match[0]);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      const id = TWEET_PATH.exec(url.pathname)?.[1];
      if (TWEET_HOSTS.has(host) && id) return id;
    } catch {
      // Not a valid URL; keep looking.
    }
  }
  return null;
}

function toTweet(raw: RawTweet, media: RawMedia[], author: string | undefined): Tweet {
  const photos = media.filter((m) => m.type === "photo" || m.type === "image");
  const photoUrls = photos
    .map((m) => m.url ?? "")
    .filter((url) => new URL(url, "https://invalid").hostname === "pbs.twimg.com")
    .slice(0, MAX_PHOTOS)
    .map((url) => `${url.split("?")[0]}?name=large`);

  return {
    author: author ?? "unknown",
    text: (raw.text ?? "").slice(0, MAX_TEXT_CHARS),
    photoUrls,
    altTexts: photos.flatMap((m) => (m.altText ? [m.altText] : [])),
    hasVideo: media.some((m) => m.type !== "photo" && m.type !== "image"),
  };
}

function fromFx(raw: RawTweet): Tweet {
  const tweet = toTweet(raw, raw.media?.all ?? [], raw.author?.screen_name);
  if (raw.quote) tweet.quoted = fromFx({ ...raw.quote, quote: null });
  return tweet;
}

function fromVx(raw: RawTweet): Tweet {
  const tweet = toTweet(raw, raw.media_extended ?? [], raw.user_screen_name);
  if (raw.qrt) tweet.quoted = fromVx({ ...raw.qrt, qrt: null });
  return tweet;
}

export function createTweetService(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch,
): TweetService {
  // Returns the HTTP status and parsed body; the body is null when the request or JSON failed.
  async function getJson(url: string): Promise<{ status: number; body: unknown }> {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      return { status: response.status, body: response.ok ? await response.json() : null };
    } catch {
      return { status: 0, body: null };
    }
  }

  return {
    async read(id) {
      const fx = await getJson(`https://api.fxtwitter.com/status/${id}`);
      if (fx.status === 404) return { ok: false, error: "not_found" };
      const fxTweet = (fx.body as { tweet?: RawTweet } | null)?.tweet;
      if (fxTweet) return { ok: true, tweet: fromFx(fxTweet) };

      const vx = await getJson(`https://api.vxtwitter.com/status/${id}`);
      if (vx.status === 404) return { ok: false, error: "not_found" };
      if (vx.body) return { ok: true, tweet: fromVx(vx.body as RawTweet) };

      return { ok: false, error: "failed" };
    },
  };
}
