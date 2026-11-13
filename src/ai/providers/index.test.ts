import { expect, test } from "bun:test";
import { testConfig } from "../../../tests/support/config.ts";
import { throws } from "../../../tests/support/assert.ts";
import { gemini } from "./gemini/index.ts";
import { AI_PROVIDERS, createAiProvider, DEFAULT_AI_PROVIDER } from "./index.ts";
import { openai } from "./openai/index.ts";

test("the registry lists every provider and defaults to the first", () => {
  expect(Object.keys(AI_PROVIDERS)).toStrictEqual(["openai", "gemini", "openrouter"]);
  expect(DEFAULT_AI_PROVIDER).toStrictEqual("openai");
});

test("a registry holding only one provider works without the other", () => {
  expect(createAiProvider(testConfig({ aiProvider: "openai" }), { openai }).label).toStrictEqual(
    "OpenAI",
  );
  throws(
    () => createAiProvider(testConfig({ aiProvider: "gemini" }), { openai }),
    Error,
    "Unknown ai.provider: gemini",
  );
  throws(
    () => createAiProvider(testConfig({ aiProvider: "gemini", aiModels: ["m"] }), { gemini }),
    Error,
    "ai.system_prompt_file",
  );
  throws(
    () => createAiProvider(testConfig({ aiProvider: "openai" }), { gemini }),
    Error,
    "Unknown ai.provider: openai",
  );
});

test("a provider declares its own usage report and key name", () => {
  expect(typeof createAiProvider(testConfig({ aiProvider: "openai" })).usageReport).toStrictEqual(
    "function",
  );
  expect(openai.apiKeyEnv).toStrictEqual("OPENAI_API_KEY");
  expect(gemini.apiKeyEnv).toBeUndefined();
});
