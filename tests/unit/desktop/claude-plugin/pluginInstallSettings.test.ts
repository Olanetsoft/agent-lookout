import { describe, expect, test } from "vitest";

import {
  PLUGIN_INSTALL_FILE,
  readPluginInstallRecord,
  writePluginInstallRecord,
  type PluginInstallRecord,
} from "@desktop/claude-plugin/pluginInstallSettings";

const TRIED_AT = 1_767_600_000_000;

describe("the record of the Claude Code plugin's install", () => {
  test("is plugin-install-state.json", () => {
    expect(PLUGIN_INSTALL_FILE).toBe("plugin-install-state.json");
  });

  test.each<PluginInstallRecord>([
    { triedAt: TRIED_AT, outcome: "running", step: null, told: false },
    { triedAt: TRIED_AT, outcome: "installed", step: null, told: false },
    { triedAt: TRIED_AT, outcome: "installed", step: null, told: true },
    { triedAt: TRIED_AT, outcome: "already-installed", step: null, told: false },
    { triedAt: TRIED_AT, outcome: "turned-off", step: null, told: false },
    { triedAt: TRIED_AT, outcome: "failed", step: "check", told: false },
    { triedAt: TRIED_AT, outcome: "failed", step: "marketplace", told: true },
    { triedAt: TRIED_AT, outcome: "failed", step: "install", told: false },
    { triedAt: TRIED_AT, outcome: "failed", step: "confirm", told: false },
    { triedAt: TRIED_AT, outcome: "failed", step: "unfinished", told: false },
  ])("reads back what it wrote: $outcome $step", (record) => {
    const text = writePluginInstallRecord(record);
    expect(text.endsWith("}\n")).toBe(true);
    expect(readPluginInstallRecord(text)).toEqual(record);
  });

  test("is written as plain JSON, two spaces in, with a newline at the end", () => {
    expect(
      writePluginInstallRecord({
        triedAt: TRIED_AT,
        outcome: "installed",
        step: null,
        told: false,
      }),
    ).toBe(
      `{\n  "triedAt": ${TRIED_AT},\n  "outcome": "installed",\n  "step": null,\n  "told": false\n}\n`,
    );
  });

  test("a record that does not say whether it was told has not been, and keys it does not know are dropped", () => {
    expect(
      readPluginInstallRecord(
        JSON.stringify({ triedAt: TRIED_AT, outcome: "installed", extra: "kept nowhere" }),
      ),
    ).toEqual({ triedAt: TRIED_AT, outcome: "installed", step: null, told: false });
  });

  test.each([
    ["not JSON", "{"],
    ["empty", ""],
    ["null", "null"],
    ["an array", "[]"],
    ["a string", '"installed"'],
    ["no time", JSON.stringify({ outcome: "installed" })],
    ["a time of 0", JSON.stringify({ triedAt: 0, outcome: "installed" })],
    ["a time before 1970", JSON.stringify({ triedAt: -1, outcome: "installed" })],
    ["a time that is not whole", JSON.stringify({ triedAt: 1.5, outcome: "installed" })],
    ["a time in words", JSON.stringify({ triedAt: String(TRIED_AT), outcome: "installed" })],
    ["no outcome", JSON.stringify({ triedAt: TRIED_AT })],
    ["an outcome it does not know", JSON.stringify({ triedAt: TRIED_AT, outcome: "removed" })],
    ["a failure without a step", JSON.stringify({ triedAt: TRIED_AT, outcome: "failed" })],
    [
      "a failure at a step it does not know",
      JSON.stringify({ triedAt: TRIED_AT, outcome: "failed", step: "uninstall" }),
    ],
    [
      "a step on another outcome",
      JSON.stringify({ triedAt: TRIED_AT, outcome: "installed", step: "install" }),
    ],
    [
      "told that is not true or false",
      JSON.stringify({ triedAt: TRIED_AT, outcome: "installed", told: "yes" }),
    ],
  ])("is not a record when it is %s", (_what, text) => {
    expect(readPluginInstallRecord(text)).toBeNull();
  });
});
