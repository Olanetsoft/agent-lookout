import type { SettingsResponse } from "../../core/api.ts";
import {
  readTimeRules,
  TIME_RULE_NAMES,
  type TimeRuleName,
  type TimeRules,
} from "../../core/time-rules/timeRules.ts";
import {
  readSettingsText,
  writeSettingsText,
  type SettingsSetup,
  type SettingsText,
  type SettingsWrite,
} from "./settingsFile.ts";

/**
 * The settings the collector keeps itself: the time rules. They are read from
 * the settings file once, as the collector starts, held in memory, and written
 * back whole whenever the person changes them in the dashboard. A change that
 * cannot be written changes nothing, so what is in force is always what the
 * file says, or what it will say when Agent Lookout next starts.
 *
 * The file is JSON, with the rules under `timeRules`:
 *
 *     { "timeRules": { "longWait": { "on": true, "minutes": 10 }, ... } }
 *
 * A key the collector does not know is passed over when it is read, and kept
 * as it was when the file is written again, beside the rules or among them, so
 * a later version's settings and rules survive a change made by this one. A
 * file that cannot be read, or a rule in it that cannot be read, leaves that
 * rule off, and says so, at start and in `GET /api/settings`. A file that is
 * there and could not be read at all, as one too large or one the collector
 * may not read, is never written over: a change is refused until it is mended
 * or removed and the collector started again. One that is not JSON is
 * written again, whole, by the first change.
 */
export interface CollectorSettings {
  /** The time rules in force. */
  timeRules(): TimeRules;
  /** What `GET /api/settings` answers. */
  status(): SettingsResponse;
  /** Changes the time rules, once they are saved. Nothing changes when they cannot be. */
  changeTimeRules(rules: TimeRules): SettingsWrite;
  /** The one line to say at start about the file, or null when it was read, or there is none. */
  readonly problemAtStart: string | null;
}

/** What reads and writes the file. Tests pass their own. */
export interface SettingsStore {
  read(setup: SettingsSetup): SettingsText;
  write(setup: SettingsSetup, text: string): SettingsWrite;
}

export const fileSettingsStore: SettingsStore = {
  read: readSettingsText,
  write: writeSettingsText,
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
  /** What else the file holds, beside `timeRules`. */
  rest: Record<string, unknown>;
  /** What else `timeRules` holds, beside the three rules, such as a later version's rule. */
  otherRules: Record<string, unknown>;
  problem: string | null;
  /**
   * Whether a change may write the file whole. Not when it was there and was
   * not read, as one too large or one its owner alone may read: what it holds
   * is not known, so it is not written over.
   */
  writable: boolean;
}

function rulesIn(read: SettingsText, shown: string): FileHeld {
  const off = readTimeRules(undefined).rules;
  if (read.kind === "missing") {
    return { rules: off, rest: {}, otherRules: {}, problem: null, writable: true };
  }
  if (read.kind === "refused") {
    return { rules: off, rest: {}, otherRules: {}, problem: read.problem, writable: false };
  }

  let value: unknown;
  try {
    value = JSON.parse(read.text);
  } catch {
    value = null;
  }
  if (!isRecord(value)) {
    return {
      rules: off,
      rest: {},
      otherRules: {},
      problem: `${shown} is not JSON that Agent Lookout can read, so the time rules are off. Changing one in Settings writes the file again.`,
      writable: true,
    };
  }
  const { timeRules, ...rest } = value;
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
  return { rules, rest, otherRules, problem, writable: true };
}

export function createCollectorSettings(options: CollectorSettingsOptions): CollectorSettings {
  const { setup } = options;
  const store = options.store ?? fileSettingsStore;

  const first = rulesIn(store.read(setup), setup.shown);
  let rules = first.rules;
  /** What else the file held, and what else its rules held, written back as they were. */
  const { rest, otherRules } = first;
  let problem = first.problem;

  return {
    timeRules: () => rules,

    status: () => ({ timeRules: rules, file: setup.shown, problem }),

    changeTimeRules(next) {
      if (!first.writable) {
        return {
          ok: false,
          problem: `${setup.shown} could not be read when Agent Lookout started, so it is not written over and the change was not saved. Mend or remove the file, then start Agent Lookout again.`,
        };
      }
      const text = `${JSON.stringify({ ...rest, timeRules: { ...otherRules, ...next } }, null, 2)}\n`;
      const written = store.write(setup, text);
      if (!written.ok) {
        problem = written.problem;
        return written;
      }
      rules = next;
      problem = null;
      return written;
    },

    problemAtStart: first.problem,
  };
}
