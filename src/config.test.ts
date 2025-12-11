/**
 * Tests for Configuration Module
 */

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { loadConfig } from "./config.ts";

// Helper to run tests with specific env vars
function withEnv(
  envVars: Record<string, string>,
  fn: () => void,
) {
  // Save original values
  const originalValues: Record<string, string | undefined> = {};
  const allKeys = new Set([
    ...Object.keys(envVars),
    "DISCORD_TOKEN",
    "CHANNEL_ID",
    "TIME_ZONE",
    "GLUE_ALERT_THRESHOLD",
  ]);

  for (const key of allKeys) {
    originalValues[key] = Deno.env.get(key);
    Deno.env.delete(key);
  }

  // Set test values
  for (const [key, value] of Object.entries(envVars)) {
    Deno.env.set(key, value);
  }

  try {
    fn();
  } finally {
    // Restore original values
    for (const key of allKeys) {
      const original = originalValues[key];
      if (original !== undefined) {
        Deno.env.set(key, original);
      } else {
        Deno.env.delete(key);
      }
    }
  }
}

// =============================================================================
// loadConfig - Required Variables
// =============================================================================

Deno.test("loadConfig throws when DISCORD_TOKEN is missing", () => {
  withEnv({ CHANNEL_ID: "123" }, () => {
    assertThrows(
      () => loadConfig(),
      Error,
      "Missing required environment variable: DISCORD_TOKEN",
    );
  });
});

Deno.test("loadConfig throws when CHANNEL_ID is missing", () => {
  withEnv({ DISCORD_TOKEN: "token123" }, () => {
    assertThrows(
      () => loadConfig(),
      Error,
      "Missing required environment variable: CHANNEL_ID",
    );
  });
});

Deno.test("loadConfig returns config when required vars are present", () => {
  withEnv(
    {
      DISCORD_TOKEN: "my-token",
      CHANNEL_ID: "my-channel",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.discordToken, "my-token");
      assertEquals(config.channelId, "my-channel");
    },
  );
});

// =============================================================================
// loadConfig - Optional Variables with Defaults
// =============================================================================

Deno.test("loadConfig uses default TIME_ZONE when not set", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.timeZone, "America/Los_Angeles");
    },
  );
});

Deno.test("loadConfig uses custom TIME_ZONE when set", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      TIME_ZONE: "Europe/London",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.timeZone, "Europe/London");
    },
  );
});

Deno.test("loadConfig uses default GLUE_ALERT_THRESHOLD when not set", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.glueAlertThreshold, 7);
    },
  );
});

Deno.test("loadConfig uses custom GLUE_ALERT_THRESHOLD when set", () => {
  withEnv(
    {
      DISCORD_TOKEN: "token",
      CHANNEL_ID: "channel",
      GLUE_ALERT_THRESHOLD: "3",
    },
    () => {
      const config = loadConfig();
      assertEquals(config.glueAlertThreshold, 3);
    },
  );
});

Deno.test("loadConfig returns complete config with all values", () => {
  withEnv(
    {
      DISCORD_TOKEN: "secret-token",
      CHANNEL_ID: "123456789",
      TIME_ZONE: "Asia/Tokyo",
      GLUE_ALERT_THRESHOLD: "5",
    },
    () => {
      const config = loadConfig();
      assertEquals(config, {
        discordToken: "secret-token",
        channelId: "123456789",
        timeZone: "Asia/Tokyo",
        glueAlertThreshold: 5,
      });
    },
  );
});
