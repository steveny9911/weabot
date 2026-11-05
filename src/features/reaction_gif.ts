/**
 * Greeting reaction GIFs for Haru replies.
 */

export const haruGreetingGifPool: readonly string[] = [
  "https://tenor.com/view/uma-musume-anime-haru-urara-hi-hello-gif-13117639751450924729",
  "https://tenor.com/view/haru-urara-umamusume-uma-musume-wave-waving-gif-14802371873246368923",
  "https://tenor.com/view/haru-urara-gif-21261985",
  "https://tenor.com/view/umazing-uma-musume-haru-urara-uma-gif-8811229770082296989",
  "https://tenor.com/view/haru-urara-haru-urara-punch-uma-gif-3671877342466542406",
];

const GREETING_TRIGGER_RE = /\b(?:hello|hi|ciallo)\b/i;

export function hasGreetingTrigger(text: string): boolean {
  if (!text) return false;
  return GREETING_TRIGGER_RE.test(text);
}

export function pickRandomGreetingGif(random: () => number = Math.random): string {
  const poolSize = haruGreetingGifPool.length;
  if (poolSize === 0) return "";

  const sample = random();
  const safeSample = Number.isFinite(sample) ? sample : 0;
  const index = Math.max(0, Math.min(poolSize - 1, Math.floor(safeSample * poolSize)));

  return haruGreetingGifPool[index];
}

export function selectGreetingGifForReply(
  replyText: string,
  random: () => number = Math.random,
): string | null {
  if (!hasGreetingTrigger(replyText)) return null;
  return pickRandomGreetingGif(random);
}
