import { expect, test } from "bun:test";
import { testConfig } from "../../../tests/support/config.ts";
import { throws } from "../../../tests/support/assert.ts";
import { gemini } from "./gemini/index.ts";
import { createAiProvider } from "./index.ts";
import { openai } from "./openai/index.ts";

const named = (aiProvider: string | undefined) =>
  testConfig({ aiProvider, aiProviderSettings: {} });

test("a registry holding only one provider works without the other", () => {
  expect(createAiProvider(named("openai"), { openai }).label).toStrictEqual("OpenAI");
  throws(() => createAiProvider(named("gemini"), { openai }), Error, "Unknown ai.provider: gemini");
  throws(() => createAiProvider(named("openai"), { gemini }), Error, "Unknown ai.provider: openai");
});

test("a name that is not a registered provider is unknown, even an inherited one", () => {
  for (const name of [undefined, "", "constructor", "toString"]) {
    throws(() => createAiProvider(named(name), { openai }), Error, "Unknown ai.provider");
  }
});
