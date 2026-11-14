/** The \gacha command: a picture of an Arknights ten-pull, from the arknights-gacha-result-generator. */
import { generateTenPullImage } from "arknights-gacha-result-generator";

/** One user may pull again this long after a pull was drawn. A render costs about two seconds of CPU. */
export const GACHA_COOLDOWN_MS = 30_000;
/** After a failed draw: short, so a blip is retried soon but a broken setup is not hammered. */
export const GACHA_FAILURE_COOLDOWN_MS = 5_000;
/** Pulls waiting or rendering at once; one more is refused. */
export const GACHA_MAX_PENDING = 5;
/** A draw that takes longer is given up, so one stuck render cannot block everyone behind it. */
export const GACHA_RENDER_TIMEOUT_MS = 60_000;

export type GachaResult =
  | { ok: true; image: Uint8Array<ArrayBuffer>; altText: string }
  | { ok: false; reason: "cooldown"; retryInMs: number }
  /** This user's earlier pull is still waiting or rendering. */
  | { ok: false; reason: "pending" }
  /** Too many pulls are waiting. */
  | { ok: false; reason: "busy" }
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
  renderTimeoutMs?: number;
}

export function createGachaService(deps: GachaDependencies): GachaService {
  const {
    cacheDir,
    generate = generateTenPullImage,
    now = Date.now,
    renderTimeoutMs = GACHA_RENDER_TIMEOUT_MS,
  } = deps;
  /** Users with a pull waiting or rendering. */
  const pendingUsers = new Set<string>();
  /** When each user may pull again, set once their pull is drawn. */
  const blockedUntil = new Map<string, number>();
  let queue: Promise<unknown> = Promise.resolve();

  async function draw(): Promise<GachaResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${renderTimeoutMs} ms`)),
          renderTimeoutMs,
        );
      });
      // A render that outlives its timeout is left to finish; the queue moves on without it.
      const { image, pulls } = await Promise.race([generate({ cacheDir }), timeout]);
      const altText = `Arknights ten-pull: ${pulls.map((p) => `${p.rarity}★ ${p.name}`).join(", ")}`;
      // Discord's alt text limit is 1024 characters.
      return { ok: true, image: new Uint8Array(image), altText: altText.slice(0, 1024) };
    } catch (error) {
      return { ok: false, reason: "failed", error: String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    pull(userId) {
      const time = now();
      for (const [id, until] of blockedUntil) if (until <= time) blockedUntil.delete(id);
      const until = blockedUntil.get(userId);
      if (until !== undefined) {
        return Promise.resolve({ ok: false, reason: "cooldown", retryInMs: until - time });
      }
      if (pendingUsers.has(userId)) return Promise.resolve({ ok: false, reason: "pending" });
      if (pendingUsers.size >= GACHA_MAX_PENDING)
        return Promise.resolve({ ok: false, reason: "busy" });

      // Added before the draw, so two quick commands cannot both pass.
      pendingUsers.add(userId);
      const result = queue.then(draw);
      queue = result;
      return result.then((outcome) => {
        pendingUsers.delete(userId);
        blockedUntil.set(
          userId,
          now() + (outcome.ok ? GACHA_COOLDOWN_MS : GACHA_FAILURE_COOLDOWN_MS),
        );
        return outcome;
      });
    },
  };
}
