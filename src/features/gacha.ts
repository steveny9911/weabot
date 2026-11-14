/** The \gacha command: a picture of an Arknights ten-pull, from the arknights-gacha-result-generator. */
import { generateTenPullImage } from "arknights-gacha-result-generator";

/** One user may pull again after this long. A render costs about two seconds of CPU. */
export const GACHA_COOLDOWN_MS = 30_000;

export type GachaResult =
  | { ok: true; image: Uint8Array<ArrayBuffer>; altText: string }
  | { ok: false; reason: "cooldown"; retryInMs: number }
  | { ok: false; reason: "failed"; error: string };

export interface GachaService {
  /** Draws a ten-pull for a user. Draws run one at a time. Never throws. */
  pull(userId: string): Promise<GachaResult>;
}

/** The generator's `generateTenPullImage`, as far as this service uses it. */
type GenerateTenPull = (options: { cacheDir: string }) => Promise<{
  image: Uint8Array;
  pulls: Array<{ name: string; rarity: number }>;
}>;

export interface GachaDependencies {
  /** Folder for the game art the generator downloads. It must be absolute or stable across restarts. */
  cacheDir: string;
  generate?: GenerateTenPull;
  now?: () => number;
}

export function createGachaService(deps: GachaDependencies): GachaService {
  const { cacheDir, generate = generateTenPullImage, now = Date.now } = deps;
  const lastPull = new Map<string, number>();
  let queue: Promise<unknown> = Promise.resolve();

  async function draw(): Promise<GachaResult> {
    try {
      const { image, pulls } = await generate({ cacheDir });
      const altText = `Arknights ten-pull: ${pulls.map((p) => `${p.rarity}★ ${p.name}`).join(", ")}`;
      // Discord's alt text limit is 1024 characters.
      return { ok: true, image: new Uint8Array(image), altText: altText.slice(0, 1024) };
    } catch (error) {
      return { ok: false, reason: "failed", error: String(error) };
    }
  }

  return {
    pull(userId) {
      const time = now();
      for (const [id, at] of lastPull) if (time - at >= GACHA_COOLDOWN_MS) lastPull.delete(id);
      const last = lastPull.get(userId);
      if (last !== undefined) {
        return Promise.resolve({
          ok: false,
          reason: "cooldown",
          retryInMs: GACHA_COOLDOWN_MS - (time - last),
        });
      }
      // Claimed before the draw, so two quick commands cannot both pass.
      lastPull.set(userId, time);

      const result = queue.then(draw);
      queue = result;
      return result.then((outcome) => {
        // A failed draw cost the user nothing.
        if (!outcome.ok) lastPull.delete(userId);
        return outcome;
      });
    },
  };
}
