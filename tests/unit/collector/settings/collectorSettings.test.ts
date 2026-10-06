import { describe, expect, test } from "vitest";

import { createCollectorSettings, type SettingsStore } from "@collector/settings/collectorSettings";
import type { SettingsText, SettingsWrite } from "@collector/settings/settingsFile";
import { DEFAULT_TIME_RULES, type TimeRules } from "@core/time-rules/timeRules";

const SETUP = {
  file: "/Users/example/.agent-lookout/settings.json",
  shown: "~/.agent-lookout/settings.json",
};

const SET: TimeRules = {
  longWait: { on: true, minutes: 5 },
  idle: { on: true, hours: 6 },
  quietHours: { ...DEFAULT_TIME_RULES.quietHours, on: true, days: ["sat", "sun"] },
};

/** A settings file held in memory: what it reads, and every text written to it. */
function store(read: SettingsText, write: SettingsWrite = { ok: true }) {
  const written: string[] = [];
  const fake: SettingsStore = {
    read: () => read,
    write: (_setup, text) => {
      written.push(text);
      return write;
    },
  };
  return { fake, written };
}

const text = (value: unknown): SettingsText => ({ kind: "read", text: JSON.stringify(value) });

describe("the settings, read as the collector starts", () => {
  test("with no file, every rule is off and nothing is said", () => {
    const settings = createCollectorSettings({
      setup: SETUP,
      store: store({ kind: "missing" }).fake,
    });
    expect(settings.timeRules()).toEqual(DEFAULT_TIME_RULES);
    expect(settings.problemAtStart).toBeNull();
    expect(settings.status()).toEqual({
      timeRules: DEFAULT_TIME_RULES,
      file: "~/.agent-lookout/settings.json",
      problem: null,
    });
  });

  test("the rules in the file are in force, and keys not known are passed over", () => {
    const settings = createCollectorSettings({
      setup: SETUP,
      store: store(text({ timeRules: { ...SET, laterRule: { on: true } }, theme: "night" })).fake,
    });
    expect(settings.timeRules()).toEqual(SET);
    expect(settings.problemAtStart).toBeNull();
  });

  test("a file that is not JSON leaves every rule off, and says so, naming the file", () => {
    const settings = createCollectorSettings({
      setup: SETUP,
      store: store({ kind: "read", text: '{"timeRules": {' }).fake,
    });
    expect(settings.timeRules()).toEqual(DEFAULT_TIME_RULES);
    const line =
      "~/.agent-lookout/settings.json is not JSON that Agent Lookout can read, so the time rules are off. Changing one in Settings writes the file again.";
    expect(settings.problemAtStart).toBe(line);
    expect(settings.status().problem).toBe(line);
  });

  test("JSON that is not an object is the same", () => {
    const settings = createCollectorSettings({ setup: SETUP, store: store(text([SET])).fake });
    expect(settings.timeRules()).toEqual(DEFAULT_TIME_RULES);
    expect(settings.problemAtStart).toMatch(/is not JSON that Agent Lookout can read/);
  });

  test("a rule that cannot be read is off, the others are in force, and the line names it", () => {
    const settings = createCollectorSettings({
      setup: SETUP,
      store: store(text({ timeRules: { ...SET, quietHours: { on: true, from: "late" } } })).fake,
    });
    expect(settings.timeRules()).toEqual({ ...SET, quietHours: DEFAULT_TIME_RULES.quietHours });
    expect(settings.problemAtStart).toBe(
      "~/.agent-lookout/settings.json holds the quiet hours in a form Agent Lookout cannot read, so it is off.",
    );

    const two = createCollectorSettings({
      setup: SETUP,
      store: store(text({ timeRules: { longWait: 3, idle: { on: true } } })).fake,
    });
    expect(two.problemAtStart).toBe(
      "~/.agent-lookout/settings.json holds the long wait reminder and the idle rule in a form Agent Lookout cannot read, so they are off.",
    );
  });

  test("a file that was refused, as a link is, leaves every rule off with the reason", () => {
    const problem =
      "~/.agent-lookout/settings.json is a link, which Agent Lookout does not follow, so the time rules are off.";
    const settings = createCollectorSettings({
      setup: SETUP,
      store: store({ kind: "refused", problem }).fake,
    });
    expect(settings.timeRules()).toEqual(DEFAULT_TIME_RULES);
    expect(settings.problemAtStart).toBe(problem);
  });
});

describe("changing the time rules", () => {
  test("writes the file whole, keeping what else it held, and puts them in force", () => {
    const later = { sleepNudge: { on: true, minutes: 30 } };
    const { fake, written } = store(
      text({ timeRules: { ...DEFAULT_TIME_RULES, ...later }, theme: "night" }),
    );
    const settings = createCollectorSettings({ setup: SETUP, store: fake });
    expect(settings.changeTimeRules(SET)).toEqual({ ok: true });
    expect(settings.timeRules()).toEqual(SET);
    expect(written).toHaveLength(1);
    // A later version's setting and rule are kept as they were.
    expect(JSON.parse(written[0] as string)).toEqual({
      theme: "night",
      timeRules: { ...later, ...SET },
    });
    expect((written[0] as string).endsWith("}\n")).toBe(true);
  });

  test("a change that is saved clears what was said of the file at start", () => {
    const settings = createCollectorSettings({
      setup: SETUP,
      store: store({ kind: "read", text: "not json" }).fake,
    });
    settings.changeTimeRules(SET);
    expect(settings.status().problem).toBeNull();
    // What was said at start stays what it was.
    expect(settings.problemAtStart).not.toBeNull();
  });

  test("a file that was there and could not be read is never written over: a change is refused, and says why", () => {
    const problem =
      "~/.agent-lookout/settings.json is larger than 64 KB, so it was not read and the time rules are off.";
    const { fake, written } = store({ kind: "refused", problem });
    const settings = createCollectorSettings({ setup: SETUP, store: fake });
    expect(settings.changeTimeRules(SET)).toEqual({
      ok: false,
      problem:
        "~/.agent-lookout/settings.json could not be read when Agent Lookout started, so it is not written over and the change was not saved. Mend or remove the file, then start Agent Lookout again.",
    });
    expect(written).toEqual([]);
    expect(settings.timeRules()).toEqual(DEFAULT_TIME_RULES);
    expect(settings.status().problem).toBe(problem);
  });

  test("a change that cannot be saved changes nothing, and says why", () => {
    const problem =
      "~/.agent-lookout/settings.json could not be written, so the change was not saved.";
    const settings = createCollectorSettings({
      setup: SETUP,
      store: store({ kind: "missing" }, { ok: false, problem }).fake,
    });
    expect(settings.changeTimeRules(SET)).toEqual({ ok: false, problem });
    expect(settings.timeRules()).toEqual(DEFAULT_TIME_RULES);
    expect(settings.status().problem).toBe(problem);
  });
});
