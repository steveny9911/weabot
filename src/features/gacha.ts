/** The \gacha command: a picture of an Arknights ten-pull, from arknights-gacha-result-generator. */
import type { GachaPityQueries } from "../db/gacha_pity.ts";

export type GachaResult =
  | { ok: true; image: Uint8Array<ArrayBuffer>; altText: string }
  | { ok: false; reason: "cooldown"; retryInMs: number }
  /** `busy`: too many pulls are already waiting. */
  | { ok: false; reason: "busy" | "failed" };

export interface GachaService {
  /** Draws a ten-pull. Draws queue up and run one at a time, across all users. Never throws. */
  pull(userId: string): Promise<GachaResult>;
}

/** The generator's `generateTenPullImage`, as far as this service uses it. */
type GenerateTenPull = (options: {
  cacheDir: string;
  format: "webp";
  startPity: number;
  guaranteeFiveStar: boolean;
}) => Promise<{
  image: Uint8Array;
  pulls: Array<{ name: string; nameEn: string; rarity: number }>;
  result: { finalPity: number };
}>;

export interface GachaDependencies {
  /** Where the generator caches the game art it downloads. */
  cacheDir: string;
  /** Each user's pity, kept between pulls. */
  pity: GachaPityQueries;
  generate?: GenerateTenPull;
  /** How long a user waits between pulls. */
  cooldownMs?: number;
  /** How long a render may take before it is given up on. */
  renderTimeoutMs?: number;
  /** How many pulls may wait or draw at once; more are refused as busy. */
  queueSize?: number;
}

/** Loaded on first use, so the image library costs nothing (and cannot break startup) until then. */
const generateWithLibrary: GenerateTenPull = async (options) =>
  (await import("arknights-gacha-result-generator")).generateTenPullImage(options);

export function createGachaService(deps: GachaDependencies): GachaService {
  const {
    cacheDir,
    pity,
    generate = generateWithLibrary,
    cooldownMs = 10_000,
    renderTimeoutMs = 30_000,
    queueSize = 8,
  } = deps;
  const readyAt = new Map<string, number>();
  let waiting = 0;
  let queue: Promise<unknown> = Promise.resolve();

  async function draw(userId: string, cooldownEnd: number): Promise<GachaResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A render that outlives the timeout is left to finish; the queue does not wait for it.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("render timed out")), renderTimeoutMs);
      });
      // Read here, not in pull(): draws run one at a time, so a user's second queued pull sees the
      // pity their first one left. No saved pity means a first pull, which gets the 5-star guarantee.
      const saved = pity.get(userId);
      const { image, pulls, result } = await Promise.race([
        generate({
          cacheDir,
          format: "webp",
          startPity: saved ?? 0,
          guaranteeFiveStar: saved === null,
        }),
        timeout,
      ]);
      // Only a draw that finished in time gets here, so a failure or a late render leaves pity alone.
      pity.save(userId, result.finalPity);
      const names = pulls.map((p) => `${p.rarity}★ ${p.name} (${p.nameEn})`).join(", ");
      // Discord's alt text limit is 1024 characters.
      const altText = `${result.finalPity} pulls since last 6★: ${names}`.slice(0, 1024);
      return { ok: true, image: new Uint8Array(image), altText };
    } catch (error) {
      console.error("[GACHA] Failed:", error);
      // A failed draw costs the user nothing, unless a newer pull has set a cooldown since.
      if (readyAt.get(userId) === cooldownEnd) readyAt.delete(userId);
      return { ok: false, reason: "failed" };
    } finally {
      clearTimeout(timer);
      waiting--;
    }
  }

  return {
    pull(userId) {
      const wait = (readyAt.get(userId) ?? 0) - Date.now();
      if (wait > 0)
        return Promise.resolve({
          ok: false,
          reason: "cooldown",
          retryInMs: wait,
        });
      if (waiting >= queueSize) return Promise.resolve({ ok: false, reason: "busy" });

      // Both set before the first await, so two quick commands cannot both pass.
      waiting++;
      const cooldownEnd = Date.now() + cooldownMs;
      readyAt.set(userId, cooldownEnd);
      const turn = queue.then(() => draw(userId, cooldownEnd));
      queue = turn;
      return turn;
    },
  };
}
