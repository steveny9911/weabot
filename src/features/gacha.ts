/** The \gacha command: a picture of an Arknights ten-pull, from arknights-gacha-result-generator. */

export type GachaResult =
  | { ok: true; image: Uint8Array<ArrayBuffer>; altText: string }
  | { ok: false; reason: "cooldown"; retryInMs: number }
  | { ok: false; reason: "busy" | "failed" };

export interface GachaService {
  /** Draws a ten-pull. One draw runs at a time, across all users. Never throws. */
  pull(userId: string): Promise<GachaResult>;
}

/** The generator's `generateTenPullImage`, as far as this service uses it. */
type GenerateTenPull = (options: { cacheDir: string }) => Promise<{
  image: Uint8Array;
  pulls: Array<{ name: string; rarity: number }>;
}>;

export interface GachaDependencies {
  /** Where the generator caches the game art it downloads. */
  cacheDir: string;
  generate?: GenerateTenPull;
  renderTimeoutMs?: number;
}

const COOLDOWN_MS = 30_000;

/** Loaded on first use, so the image library costs nothing (and cannot break startup) until then. */
const generateWithLibrary: GenerateTenPull = async (options) =>
  (await import("arknights-gacha-result-generator")).generateTenPullImage(options);

export function createGachaService(deps: GachaDependencies): GachaService {
  const { cacheDir, generate = generateWithLibrary, renderTimeoutMs = 60_000 } = deps;
  const readyAt = new Map<string, number>();
  let busy = false;

  return {
    async pull(userId) {
      const wait = (readyAt.get(userId) ?? 0) - Date.now();
      if (wait > 0) return { ok: false, reason: "cooldown", retryInMs: wait };
      if (busy) return { ok: false, reason: "busy" };

      busy = true;
      readyAt.set(userId, Date.now() + COOLDOWN_MS);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // A render that outlives the timeout is left to finish; the next pull does not wait for it.
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("render timed out")), renderTimeoutMs);
        });
        const { image, pulls } = await Promise.race([generate({ cacheDir }), timeout]);
        const altText = `Arknights ten-pull: ${pulls.map((p) => `${p.rarity}★ ${p.name}`).join(", ")}`;
        // Discord's alt text limit is 1024 characters.
        return { ok: true, image: new Uint8Array(image), altText: altText.slice(0, 1024) };
      } catch (error) {
        console.error("[GACHA] Failed:", error);
        readyAt.delete(userId); // a failed draw costs the user nothing
        return { ok: false, reason: "failed" };
      } finally {
        clearTimeout(timer);
        busy = false;
      }
    },
  };
}
