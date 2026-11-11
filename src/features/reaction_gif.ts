/** Greeting reaction GIFs for Haru replies. */

export const haruGreetingGifPool: readonly string[] = [
  "https://tenor.com/view/uma-musume-anime-haru-urara-hi-hello-gif-13117639751450924729",
  "https://tenor.com/view/haru-urara-umamusume-uma-musume-wave-waving-gif-14802371873246368923",
  "https://tenor.com/view/haru-urara-gif-21261985",
  "https://tenor.com/view/umazing-uma-musume-haru-urara-uma-gif-8811229770082296989",
  "https://tenor.com/view/haru-urara-haru-urara-punch-uma-gif-3671877342466542406",
];

/** A random greeting GIF when the reply says hello, hi or ciallo; otherwise null. */
export function selectGreetingGifForReply(
  replyText: string,
  random: () => number = Math.random,
): string | null {
  if (!/\b(?:hello|hi|ciallo)\b/i.test(replyText)) return null;
  return haruGreetingGifPool[Math.floor(random() * haruGreetingGifPool.length)];
}
