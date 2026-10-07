import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createCollectorSettings,
  fileSettingsStore,
  type SettingsStore,
} from "@collector/settings/collectorSettings";
import type { SettingsSetup } from "@collector/settings/settingsFile";
import type { PermissionRule } from "@core/permission-rules/permissionRules";
import { applyRulesChange, type RulesChange } from "@core/permission-rules/rulesChange";
import { DEFAULT_TIME_RULES, type TimeRules } from "@core/time-rules/timeRules";
import { tempDir } from "@tests/support/node/tempFiles";

const ALLOW: PermissionRule = {
  id: "aaaaaaaaaaaa",
  decision: "allow",
  tool: "Bash",
  command: "npm test:*",
};

const IDLE_ON: TimeRules = { ...DEFAULT_TIME_RULES, idle: { on: true, hours: 6 } };

/** One settings file in a temporary folder, holding this. */
async function fileHolding(value: unknown): Promise<SettingsSetup> {
  const file = path.join(await tempDir(), "settings.json");
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  return { file, shown: "~/.agent-lookout/settings.json" };
}

const held = async (setup: SettingsSetup) => JSON.parse(await readFile(setup.file, "utf8"));

/** Two copies of Agent Lookout, as the Mac app and `npx agent-lookout`, on one file. */
function twoCopies(setup: SettingsSetup) {
  return [createCollectorSettings({ setup }), createCollectorSettings({ setup })] as const;
}

/** One change to the permission rules, as the route makes it, with this ID for a new rule. */
const making =
  (change: RulesChange, id = "dddddddddddd") =>
  (rules: readonly PermissionRule[]) =>
    applyRulesChange(rules, change, () => id);

describe("two copies of Agent Lookout on one settings file", () => {
  test("a rule removed in one is no longer in force in the other by its next look, and its next change does not bring it back", async () => {
    const setup = await fileHolding({ permissionRules: [ALLOW] });
    const [app, npx] = twoCopies(setup);

    expect(npx.changePermissionRules(making({ kind: "remove", id: ALLOW.id }))).toMatchObject({
      ok: true,
    });
    expect((await held(setup)).permissionRules).toEqual([]);

    // The app still holds the rule until it looks again, at its next poll.
    expect(app.permissionRules()).toEqual([ALLOW]);
    app.readAgain();
    expect(app.permissionRules()).toEqual([]);

    expect(app.changeTimeRules(IDLE_ON)).toEqual({ ok: true });
    expect(await held(setup)).toEqual({ timeRules: IDLE_ON, permissionRules: [] });
  });

  test("a change in one copy that has not looked again keeps what the other saved, and what neither knows", async () => {
    const setup = await fileHolding({
      timeRules: { ...DEFAULT_TIME_RULES, laterRule: { on: true } },
      theme: "night",
    });
    const [app, npx] = twoCopies(setup);

    npx.changePermissionRules(making({ kind: "add", words: { decision: "deny", tool: "Write" } }));
    // The app has not looked again: its change is made to the file, not to what it read at start.
    app.changeTimeRules(IDLE_ON);
    const deny = { id: "dddddddddddd", decision: "deny", tool: "Write" };
    expect(await held(setup)).toEqual({
      theme: "night",
      timeRules: { laterRule: { on: true }, ...IDLE_ON },
      permissionRules: [deny],
    });
    expect(app.permissionRules()).toEqual([deny]);

    // And a rule the app adds goes beside the one the other copy added.
    const { id, ...words } = ALLOW;
    app.changePermissionRules(making({ kind: "add", words }, id));
    expect((await held(setup)).permissionRules).toEqual([deny, ALLOW]);
  });

  test("the time rules one copy saves are in force in the other by its next look", async () => {
    const setup = await fileHolding({});
    const [app, npx] = twoCopies(setup);

    npx.changeTimeRules(IDLE_ON);
    expect(app.timeRules()).toEqual(DEFAULT_TIME_RULES);
    app.readAgain();
    expect(app.timeRules()).toEqual(IDLE_ON);
    expect(app.status().timeRules).toEqual(IDLE_ON);
  });

  test("a rule removed in one copy cannot be edited in the other, which says there is no such rule", async () => {
    const setup = await fileHolding({ permissionRules: [ALLOW] });
    const [app, npx] = twoCopies(setup);

    npx.changePermissionRules(making({ kind: "remove", id: ALLOW.id }));
    expect(
      app.changePermissionRules(
        making({ kind: "edit", id: ALLOW.id, words: { decision: "allow", tool: "Read" } }),
      ),
    ).toMatchObject({ ok: false, reason: "no-rule" });
    expect((await held(setup)).permissionRules).toEqual([]);
  });

  test("a look at a file that has not changed reads nothing", async () => {
    const setup = await fileHolding({ timeRules: IDLE_ON });
    let reads = 0;
    const counting: SettingsStore = {
      ...fileSettingsStore,
      read: (named) => {
        reads += 1;
        return fileSettingsStore.read(named);
      },
    };
    const app = createCollectorSettings({ setup, store: counting });
    expect(reads).toBe(1);
    app.readAgain();
    app.readAgain();
    expect(reads).toBe(1);

    // A file put in its place, as a write by the other copy does, is read again.
    await writeFile(`${setup.file}.new`, JSON.stringify({ timeRules: DEFAULT_TIME_RULES }));
    await rename(`${setup.file}.new`, setup.file);
    app.readAgain();
    expect(reads).toBe(2);
    expect(app.timeRules()).toEqual(DEFAULT_TIME_RULES);
  });

  test("a file the other copy removed leaves every rule off at the next look", async () => {
    const setup = await fileHolding({ timeRules: IDLE_ON, permissionRules: [ALLOW] });
    const app = createCollectorSettings({ setup });
    await rm(setup.file);
    app.readAgain();
    expect(app.timeRules()).toEqual(DEFAULT_TIME_RULES);
    expect(app.permissionRules()).toEqual([]);
  });
});
