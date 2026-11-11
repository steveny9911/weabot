/** A scratch directory for a test, deleted when the test scope ends (`using`). */
export function tempDir() {
  const path = `${Bun.env.TMPDIR ?? "/tmp"}/haru-test-${crypto.randomUUID()}`;
  Bun.spawnSync(["mkdir", "-p", path]);
  return { path, [Symbol.dispose]: () => void Bun.spawnSync(["rm", "-rf", path]) };
}
