import { writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { createCollector } from "@collector/collector";
import { ZONE_LOOK_MS } from "@collector/settings/timeZone";
import { followZone } from "@core/time-rules/localTime";
import { DEFAULT_TIME_RULES, type TimeRules } from "@core/time-rules/timeRules";
import { tempDir } from "@tests/support/node/tempFiles";

/** Where the computer's zone link leads, in place of the real one. */
const link = vi.hoisted(() => ({ target: "" }));

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const realpathSync = Object.assign(() => link.target, { native: () => link.target });
  return { ...fs, realpathSync, default: { ...fs, realpathSync } };
});

afterEach(() => {
  followZone(null);
  vi.unstubAllEnvs();
});

test("a running collector's quiet hours follow the computer to another time zone", async () => {
  vi.stubEnv("TZ", undefined);
  const rules: TimeRules = {
    ...DEFAULT_TIME_RULES,
    quietHours: { ...DEFAULT_TIME_RULES.quietHours, on: true, from: "22:00", to: "08:00" },
  };
  const file = path.join(await tempDir(), "settings.json");
  await writeFile(file, JSON.stringify({ timeRules: rules }));
  // A Tuesday, at 03:00 in New York and 17:00 in Tokyo.
  let now = Date.UTC(2026, 10, 24, 8);
  link.target = "/usr/share/zoneinfo/Etc/UTC";
  const collector = createCollector({
    version: "0.0.0",
    adapters: [],
    env: {
      AGENT_LOOKOUT_HISTORY: "off",
      AGENT_LOOKOUT_ANSWER: "off",
      AGENT_LOOKOUT_SETTINGS_FILE: file,
    },
    notifier: { show() {} },
    now: () => now,
  });
  const quietIn = async (zone: string) => {
    link.target = `/usr/share/zoneinfo/${zone}`;
    now += ZONE_LOOK_MS;
    return (await collector.poller.pollOnce()).quiet;
  };
  expect(await quietIn("America/New_York")).toBe(true);
  expect(await quietIn("Asia/Tokyo")).toBe(false);
  expect(await quietIn("America/New_York")).toBe(true);
  collector.stop();
});
