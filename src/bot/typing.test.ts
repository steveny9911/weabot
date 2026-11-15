import { expect, test } from "bun:test";
import { withTyping } from "./typing.ts";

test("withTyping shows typing at once, renews it while working, then stops", async () => {
  let shown = 0;
  const sendTyping = () => {
    shown += 1;
    return Promise.resolve();
  };
  const { promise: gate, resolve } = Promise.withResolvers<void>();
  const running = withTyping(sendTyping, () => gate.then(() => "done"), 5);
  expect(shown).toStrictEqual(1);
  while (shown < 3) await Bun.sleep(5);
  resolve();
  expect(await running).toStrictEqual("done");
  const atFinish = shown;
  await Bun.sleep(20);
  expect(shown).toStrictEqual(atFinish);
});

test("withTyping waits for a typing call in flight, so it cannot land after the reply", async () => {
  const { promise: slow, resolve } = Promise.withResolvers<void>();
  const events: string[] = [];
  const done = withTyping(
    () => slow.then(() => void events.push("typing sent")),
    () => Promise.resolve(),
  ).then(() => events.push("returned"));
  await Bun.sleep(5);
  expect(events).toStrictEqual([]);
  resolve();
  await done;
  expect(events).toStrictEqual(["typing sent", "returned"]);
});
