import { expect, test } from "bun:test";
import { asFetch } from "../../tests/support/fetch.ts";
import { createTweetService, extractTweetId } from "./tweet.ts";

const photo = (
  name: string,
  altText?: string,
  url = `https://pbs.twimg.com/media/${name}.jpg?name=orig`,
) => ({
  type: "photo",
  url,
  altText,
});

/** Fake fetch that answers each call from the list in order and records the URLs. */
function fakeFetch(...replies: Array<Response | Error>) {
  const urls: string[] = [];
  const fetchImpl = asFetch((input: string | URL | Request) => {
    urls.push(String(input));
    const reply = replies.shift();
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply as Response);
  });
  return { fetchImpl, urls };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

test("extractTweetId accepts tweet links on known hosts", () => {
  for (const host of ["x.com", "twitter.com", "vxtwitter.com", "fixvx.com", "www.fxtwitter.com"]) {
    expect(extractTweetId(`<@1> look https://${host}/someone/status/123?s=20`)).toBe("123");
  }
  expect(extractTweetId("https://x.com/someone/status/123/photo/1")).toBe("123");
});

test("extractTweetId ignores other links", () => {
  expect(extractTweetId("https://x.com/someone")).toBeNull();
  expect(extractTweetId("https://x.com.evil.io/someone/status/123")).toBeNull();
  expect(extractTweetId("https://x.com@evil.io/someone/status/123")).toBeNull();
  expect(extractTweetId("no link here")).toBeNull();
});

test("read returns text, large photos, alt text and a quoted tweet", async () => {
  const { fetchImpl, urls } = fakeFetch(
    json({
      tweet: {
        text: "hello",
        author: { screen_name: "kay" },
        media: { all: [photo("a", "a cat"), photo("b")] },
        quote: { text: "original", author: { screen_name: "sam" }, media: { all: [] } },
      },
    }),
  );

  const result = await createTweetService(fetchImpl).read("123");

  expect(urls).toEqual(["https://api.fxtwitter.com/status/123"]);
  expect(result).toEqual({
    ok: true,
    tweet: {
      author: "kay",
      text: "hello",
      photoUrls: [
        "https://pbs.twimg.com/media/a.jpg?name=large",
        "https://pbs.twimg.com/media/b.jpg?name=large",
      ],
      altTexts: ["a cat"],
      hasVideo: false,
      quoted: { author: "sam", text: "original", photoUrls: [], altTexts: [], hasVideo: false },
    },
  });
});

test("read keeps at most 4 photos, only from pbs.twimg.com, and flags videos", async () => {
  const media = [1, 2, 3, 4, 5].map((n) => photo(`p${n}`));
  media.push(photo("x", undefined, "https://pbs.twimg.com@evil.example/x.jpg"));
  media.push(photo("y", undefined, "https://"));
  media.push({ type: "video", url: "https://video.twimg.com/v.mp4", altText: undefined });
  const { fetchImpl } = fakeFetch(json({ tweet: { text: "t", media: { all: media } } }));

  const result = await createTweetService(fetchImpl).read("1");

  expect(result.ok && result.tweet.photoUrls).toHaveLength(4);
  expect(result.ok && result.tweet.hasVideo).toBe(true);
});

test("read falls back to VxTwitter when FxTwitter fails", async () => {
  const { fetchImpl, urls } = fakeFetch(
    new Response("down", { status: 503 }),
    json({
      text: "from vx",
      user_screen_name: "kay",
      media_extended: [{ type: "image", url: "https://pbs.twimg.com/media/a.jpg" }],
      qrt: { text: "quoted", user_screen_name: "sam", media_extended: [] },
    }),
  );

  const result = await createTweetService(fetchImpl).read("1");

  expect(urls[1]).toBe("https://api.vxtwitter.com/status/1");
  expect(result.ok && result.tweet.photoUrls).toEqual([
    "https://pbs.twimg.com/media/a.jpg?name=large",
  ]);
  expect(result.ok && result.tweet.quoted?.text).toBe("quoted");
});

test("read falls back when FxTwitter answers 200 with a non-JSON page", async () => {
  const { fetchImpl, urls } = fakeFetch(new Response("<html></html>"), json({ text: "from vx" }));
  const result = await createTweetService(fetchImpl).read("1");
  expect(urls).toHaveLength(2);
  expect(result.ok && result.tweet.text).toBe("from vx");
});

test("read ignores a 200 body that is not a tweet", async () => {
  const { fetchImpl } = fakeFetch(json({ error: "x" }), json({ error: "y" }));
  expect(await createTweetService(fetchImpl).read("1")).toEqual({ ok: false, error: "failed" });
});

test("read reports not_found without trying the fallback", async () => {
  const { fetchImpl, urls } = fakeFetch(json({ code: 404 }, 404));
  expect(await createTweetService(fetchImpl).read("1")).toEqual({ ok: false, error: "not_found" });
  expect(urls).toHaveLength(1);
});

test("read reports failed when both APIs are down", async () => {
  const { fetchImpl } = fakeFetch(new Error("timeout"), new Response("no", { status: 500 }));
  expect(await createTweetService(fetchImpl).read("1")).toEqual({ ok: false, error: "failed" });
});
