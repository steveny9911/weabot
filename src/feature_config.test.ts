import { expect, test } from "bun:test";
import { isActiveIn } from "./feature_config.ts";

test("a feature is active in its listed channels only", () => {
  const feature = { enabled: true, channelIds: ["a", "b"] };
  expect(isActiveIn(feature, "a")).toBe(true);
  expect(isActiveIn(feature, "c")).toBe(false);
});

test("a feature for all channels is active everywhere", () => {
  expect(isActiveIn({ enabled: true, channelIds: "all" }, "anything")).toBe(true);
});

test("a disabled feature is active nowhere", () => {
  expect(isActiveIn({ enabled: false, channelIds: ["a"] }, "a")).toBe(false);
  expect(isActiveIn({ enabled: false, channelIds: "all" }, "a")).toBe(false);
});
