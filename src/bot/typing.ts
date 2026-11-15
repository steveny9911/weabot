/** Discord shows a typing indicator for about 10 s, so it is renewed a little sooner. */
const RENEW_MS = 8_000;

/** Runs `work` while showing "Haru is typing…", so a slow reply is visibly acknowledged. */
export async function withTyping<T>(
  sendTyping: () => Promise<void>,
  work: () => Promise<T>,
  renewMs = RENEW_MS,
): Promise<T> {
  let latest = sendTyping();
  const timer = setInterval(() => (latest = sendTyping()), renewMs);
  try {
    return await work();
  } finally {
    clearInterval(timer);
    // A typing call still in flight would land after a quick reply and leave the indicator showing.
    await latest;
  }
}
