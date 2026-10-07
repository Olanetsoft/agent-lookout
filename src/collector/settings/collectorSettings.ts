import type { SettingsResponse } from "../../core/api.ts";
import {
  readPermissionRules,
  type PermissionRule,
} from "../../core/permission-rules/permissionRules.ts";
import type { RulesChangeResult } from "../../core/permission-rules/rulesChange.ts";
import {
  readTimeRules,
  TIME_RULE_NAMES,
  type TimeRuleName,
  type TimeRules,
} from "../../core/time-rules/timeRules.ts";
import {
  readSettingsStamp,
  readSettingsText,
  writeSettingsText,
  type SettingsSetup,
  type SettingsText,
  type SettingsWrite,
} from "./settingsFile.ts";

/**
 * The settings the collector keeps itself: the time rules and the permission
 * rules. They are read from the settings file as the collector starts, held in
 * memory, and written back whole whenever the person changes them in the
 * dashboard. A change that cannot be written changes nothing, so what is in
 * force is always what the file says, or what it will say when Agent Lookout
 * next starts.
 *
 * Two copies of Agent Lookout can run at once, such as the Mac app and
 * `npx agent-lookout`, and share the file. So the file is read again just
 * before each change, and the change is made to what it holds then, never to
 * what this copy read earlier. And once a poll, `readAgain` reads it again when
 * it is not the file last read, so a change the other copy saved is in force
 * here by the next poll.
 *
 * The file is JSON, with the time rules under `timeRules` and the permission
 * rules, in their order, under `permissionRules`:
 *
 *     { "timeRules": { "longWait": { "on": true, "minutes": 10 }, ... },
 *       "permissionRules": [{ "id": "…", "decision": "allow", "tool": "Bash", "command": "npm test:*" }] }
 *
 * The permission rules are read whole or not at all (`readPermissionRules`):
 * a list that cannot be read is no rule in force, and says so, and is kept in
 * the file as it was until the person changes a permission rule, which
 * writes the list again with the rules then shown.
 *
 * A key the collector does not know is passed over when it is read, and kept
 * as it was when the file is written again, beside the rules or among them, so
 * a later version's settings and rules survive a change made by this one. A
 * file that cannot be read, or a rule in it that cannot be read, leaves that
 * rule off, and says so, at start and in `GET /api/settings`. A file that is
 * there and could not be read at all, as one too large or one the collector
 * may not read, is never written over: a change is refused until it is mended
 * or removed. One that is not JSON is written again, whole, by the first
 * change.
 */
/** What `GET /api/settings` answers of the settings the file keeps. */
export type KeptSettings = Omit<SettingsResponse, "ruleAnswers" | "ruleAnswersSince">;

export interface CollectorSettings {
  /** The time rules in force. */
  timeRules(): TimeRules;
  /** The permission rules in force, in their order. */
  permissionRules(): readonly PermissionRule[];
  /** What `GET /api/settings` answers of these. */
  status(): KeptSettings;
  /**
   * Reads the file again when it is not the one last read, as after the other
   * copy of Agent Lookout saved a change, and puts what it holds in force. When
   * it is the same, this costs one look at the file's size and time.
   */
  readAgain(): void;
  /** Changes the time rules, once they are saved. Nothing changes when they cannot be. */
  changeTimeRules(rules: TimeRules): SettingsWrite;
  /**
   * Makes one change to the permission rules: `change` is given the list the
   * file holds, read again just before, and the list it makes is saved and put
   * in force. Nothing changes when it refuses, or when the list cannot be saved.
   */
  changePermissionRules(
    change: (rules: readonly PermissionRule[]) => RulesChangeResult,
  ): PermissionRulesChange;
  /** The one line to say at start about the file and the time rules, or null when they were read, or there is none. */
  readonly problemAtStart: string | null;
  /** The one line to say at start about the permission rules, when it is not that one. */
  readonly rulesProblemAtStart: string | null;
}

/** How a change to the permission rules went: as `change` made it, or not saved. */
export type PermissionRulesChange =
  RulesChangeResult | { ok: false; reason: "not-saved"; problem: string };

/** What reads and writes the file. Tests pass their own. */
export interface SettingsStore {
  read(setup: SettingsSetup): SettingsText;
  write(setup: SettingsSetup, text: string): SettingsWrite;
  /** What tells this file from the next one written, or null when there is none. */
  stamp(setup: SettingsSetup): string | null;
}

export const fileSettingsStore: SettingsStore = {
  read: readSettingsText,
  write: writeSettingsText,
  stamp: readSettingsStamp,
};

export interface CollectorSettingsOptions {
  setup: SettingsSetup;
  store?: SettingsStore;
}

/** Each rule as a sentence names it. */
const RULE_WORDS: Record<TimeRuleName, string> = {
  longWait: "the long wait reminder",
  idle: "the idle rule",
  quietHours: "the quiet hours",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "the idle rule", "the idle rule and the quiet hours". */
function listOf(names: readonly TimeRuleName[]): string {
  const words = names.map((name) => RULE_WORDS[name]);
  return words.length <= 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** What the file holds: the rules, the rest of it and of its rules, and what could not be read. */
interface FileHeld {
  rules: TimeRules;
  /** The permission rules, or null when the file holds a list that cannot be read. */
  permissionRules: PermissionRule[] | null;
  /** What the file holds under `permissionRules`, as it is, to write back while it cannot be read. */
  heldRules: unknown;
  /** What else the file holds, beside `timeRules` and `permissionRules`. */
  rest: Record<string, unknown>;
  /** What else `timeRules` holds, beside the three rules, such as a later version's rule. */
  otherRules: Record<string, unknown>;
  /** What could not be read of the time rules, or of the file as a whole. */
  problem: string | null;
  /** What could not be read of the permission rules, or of the file as a whole. */
  rulesProblem: string | null;
  /**
   * Whether a change may write the file whole. Not when it was there and was
   * not read, as one too large or one its owner alone may read: what it holds
   * is not known, so it is not written over.
   */
  writable: boolean;
}

function rulesIn(read: SettingsText, shown: string): FileHeld {
  const off = readTimeRules(undefined).rules;
  const none = { permissionRules: [], heldRules: undefined };
  if (read.kind === "missing") {
    return {
      rules: off,
      ...none,
      rest: {},
      otherRules: {},
      problem: null,
      rulesProblem: null,
      writable: true,
    };
  }
  if (read.kind === "refused") {
    return {
      rules: off,
      ...none,
      rest: {},
      otherRules: {},
      problem: read.problem,
      rulesProblem: read.problem,
      writable: false,
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(read.text);
  } catch {
    value = null;
  }
  if (!isRecord(value)) {
    const notJson = `${shown} is not JSON that Agent Lookout can read, so the time rules and the permission rules are off. Changing one in Settings writes the file again.`;
    return {
      rules: off,
      ...none,
      rest: {},
      otherRules: {},
      problem: notJson,
      rulesProblem: notJson,
      writable: true,
    };
  }
  const { timeRules, permissionRules: heldRules, ...rest } = value;
  const permissions = readPermissionRules(heldRules);
  const { rules, unread } = readTimeRules(timeRules);
  const otherRules = isRecord(timeRules)
    ? Object.fromEntries(
        Object.entries(timeRules).filter(
          ([name]) => !(TIME_RULE_NAMES as readonly string[]).includes(name),
        ),
      )
    : {};
  const problem =
    unread.length === 0
      ? null
      : `${shown} holds ${listOf(unread)} in a form Agent Lookout cannot read, so ${unread.length === 1 ? "it is" : "they are"} off.`;
  return {
    rules,
    permissionRules: permissions.ok ? permissions.rules : null,
    heldRules,
    rest,
    otherRules,
    problem,
    rulesProblem: permissions.ok ? null : unreadRulesLine(shown),
    writable: true,
  };
}

/** What is said while the file holds permission rules that cannot be read. */
function unreadRulesLine(shown: string): string {
  return `${shown} holds permission rules Agent Lookout cannot read, so no rule is used. Changing a rule in Settings writes the list again with only the rules shown there.`;
}

export function createCollectorSettings(options: CollectorSettingsOptions): CollectorSettings {
  const { setup } = options;
  const store = options.store ?? fileSettingsStore;

  /** What told the file last read from the next one written, and what it held. */
  let stamp = store.stamp(setup);
  let held = rulesIn(store.read(setup), setup.shown);
  const first = held;
  let rules = held.rules;
  let problem = held.problem;
  /** The permission rules in force. None while the list in the file cannot be read. */
  let permissionRules: readonly PermissionRule[] = held.permissionRules ?? [];
  /** Whether what the file holds under `permissionRules` is written back as it was, unread. */
  let keepHeld = held.permissionRules === null;
  let rulesProblem = held.rulesProblem;

  /** Reads the file again and puts what it holds in force. */
  function read(): void {
    // Taken first, so a file written while it is read is read again next time.
    stamp = store.stamp(setup);
    held = rulesIn(store.read(setup), setup.shown);
    rules = held.rules;
    problem = held.problem;
    permissionRules = held.permissionRules ?? [];
    keepHeld = held.permissionRules === null;
    rulesProblem = held.rulesProblem;
  }

  const notWritable = (): { ok: false; problem: string } => ({
    ok: false,
    problem: `${setup.shown} could not be read, so it is not written over and the change was not saved. Mend or remove the file, then make the change again.`,
  });

  /** The file's text with these rules: everything else it held when last read, as it was. */
  function textWith(
    time: TimeRules,
    permissions: readonly PermissionRule[],
    keep: boolean,
  ): string {
    const listed = keep
      ? { permissionRules: held.heldRules }
      : permissions.length > 0 || held.heldRules !== undefined
        ? { permissionRules: permissions }
        : {};
    const whole = { ...held.rest, timeRules: { ...held.otherRules, ...time }, ...listed };
    return `${JSON.stringify(whole, null, 2)}\n`;
  }

  return {
    timeRules: () => rules,

    permissionRules: () => permissionRules,

    status: () => ({
      timeRules: rules,
      file: setup.shown,
      problem,
      permissionRules: [...permissionRules],
      permissionRulesProblem: rulesProblem,
    }),

    readAgain() {
      if (store.stamp(setup) !== stamp) read();
    },

    changeTimeRules(next) {
      read();
      if (!held.writable) return notWritable();
      const written = store.write(setup, textWith(next, permissionRules, keepHeld));
      if (!written.ok) {
        problem = written.problem;
        return written;
      }
      rules = next;
      problem = null;
      // The file is whole again. Permission rules it could not read are still there, unread.
      if (!keepHeld) rulesProblem = null;
      return written;
    },

    changePermissionRules(change) {
      read();
      if (!held.writable) return { reason: "not-saved", ...notWritable() };
      const made = change(permissionRules);
      if (!made.ok || !made.changed) return made;
      const written = store.write(setup, textWith(rules, made.rules, false));
      if (!written.ok) {
        rulesProblem = written.problem;
        return { ok: false, reason: "not-saved", problem: written.problem };
      }
      permissionRules = [...made.rules];
      keepHeld = false;
      rulesProblem = null;
      // The file is whole again, the time rules written as they are in force.
      problem = null;
      return made;
    },

    problemAtStart: first.problem,

    rulesProblemAtStart: first.rulesProblem === first.problem ? null : first.rulesProblem,
  };
}
