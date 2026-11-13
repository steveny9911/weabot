import { expect, test } from "bun:test";
import { testConfig } from "../../../tests/support/config.ts";
import { throws } from "../../../tests/support/assert.ts";
import { gemini } from "./gemini/index.ts";
import { AI_PROVIDERS, createAiProvider } from "./index.ts";
import { openai } from "./openai/index.ts";

test("the registry lists every provider, each with its own key and settings", () => {
  expect(Object.keys(AI_PROVIDERS)).toStrictEqual(["openai", "gemini", "openrouter"]);
  expect(Object.values(AI_PROVIDERS).map((provider) => provider.apiKeyEnv)).toStrictEqual([
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
  ]);
});

const withSettings = (aiProvider: string | undefined, aiProviderSettings: unknown = {}) =>
  testConfig({ aiProvider, aiProviderSettings });

test("a registry holding only one provider works without the other", () => {
  expect(createAiProvider(withSettings("openai"), { openai }).label).toStrictEqual("OpenAI");
  throws(
    () => createAiProvider(withSettings("gemini"), { openai }),
    Error,
    "Unknown ai.provider: gemini",
  );
  throws(
    () => createAiProvider(withSettings("openai"), { gemini }),
    Error,
    "Unknown ai.provider: openai",
  );
  throws(() => createAiProvider(withSettings(undefined), { openai }), Error, "Unknown ai.provider");
});

test("a provider declares its own usage report", () => {
  expect(typeof createAiProvider(withSettings("openai")).usageReport).toStrictEqual("function");
});
