import { expect, test } from "bun:test";
import { testConfig } from "../../../tests/support/config.ts";
import { throws } from "../../../tests/support/assert.ts";
import { createAiProvider } from "./index.ts";
import type { AiProviderModule } from "./module.ts";

/** A stand-in module, so these tests name no real provider. */
const fake = (label: string) => ({ create: () => ({ label }) }) as unknown as AiProviderModule;
const [one, two] = [fake("One"), fake("Two")];

const named = (aiProvider: string | undefined) =>
  testConfig({ aiProvider, aiProviderSettings: {} });

test("a registry holding only one provider works without the other", () => {
  expect(createAiProvider(named("one"), { one }).label).toStrictEqual("One");
  throws(() => createAiProvider(named("two"), { one }), Error, "Unknown ai.provider: two");
  throws(() => createAiProvider(named("one"), { two }), Error, "Unknown ai.provider: one");
});

test("a name that is not a registered provider is unknown, even an inherited one", () => {
  for (const name of [undefined, "", "constructor", "toString"]) {
    throws(() => createAiProvider(named(name), { one }), Error, "Unknown ai.provider");
  }
});
