import type { NoticeEvent } from "../../core/notices/sessionChanges.ts";
import {
  readAfter,
  readAsking,
  readEvents,
  SettingProblem,
  valueOf,
} from "../outbound/outboundSettings.ts";

/**
 * The settings for pushes through Pushover, read from the environment the
 * collector starts with. Nothing else sets them: they are never written to a
 * file, never sent to the dashboard and never printed. With neither the app's
 * token nor the user key set, Pushover is off and nothing is ever pushed.
 *
 * Both are secrets. Whoever has the two can push to every device of that
 * Pushover account, so no sentence made here repeats either, and the
 * dashboard is told neither.
 */

/** The API token of the Pushover application the pushes come from. */
export const PUSHOVER_TOKEN_ENV = "AGENT_LOOKOUT_PUSHOVER_TOKEN";
/** The user key, or a group key, the pushes go to. */
export const PUSHOVER_USER_ENV = "AGENT_LOOKOUT_PUSHOVER_USER";
/** The events that are pushed, as names separated by commas: `needs-you,finished`. */
export const PUSHOVER_EVENTS_ENV = "AGENT_LOOKOUT_PUSHOVER_EVENTS";
/** How many seconds a wait lasts before it is pushed. */
export const PUSHOVER_AFTER_ENV = "AGENT_LOOKOUT_PUSHOVER_AFTER";
/** `on` to put what a waiting session is asking in the push for its wait. Off unless set. */
export const PUSHOVER_ASKING_ENV = "AGENT_LOOKOUT_PUSHOVER_ASKING";

export interface PushoverSettings {
  /** The application's API token. Never shown or printed. */
  token: string;
  /** The user key, or a group key. Never shown or printed. */
  user: string;
  /** The events that are pushed, at least one, in the order of `NOTICE_EVENTS`. */
  events: readonly NoticeEvent[];
  /** How long a wait lasts before it is pushed, in milliseconds. */
  afterMs: number;
  /** Whether the push for a wait says what the session is asking. */
  asking: boolean;
}

/**
 * on   every Pushover setting could be read.
 * off  Pushover is off. `problem` says which setting is wrong or missing, or
 *      is null when neither key was set, which is the default and needs no word.
 */
export type PushoverSetup =
  { on: true; settings: PushoverSettings } | { on: false; problem: string | null };

/** A token or a key as Pushover makes them: 30 letters and digits. */
const KEY = /^[A-Za-z0-9]{30}$/;

function readKey(name: string, value: string, what: string): string {
  if (!KEY.test(value)) throw new SettingProblem(`${name} must be ${what}: 30 letters and digits.`);
  return value;
}

/**
 * Reads the Pushover settings from the environment. It never throws, and no
 * sentence it returns holds the value of a setting.
 */
export function readPushoverSetup(env: NodeJS.ProcessEnv): PushoverSetup {
  const token = valueOf(env, PUSHOVER_TOKEN_ENV);
  const user = valueOf(env, PUSHOVER_USER_ENV);
  // With neither, Pushover is off, and there is nothing to say. That is the
  // default and the way to turn it off, so the others may stay set. With one
  // alone, it is off too, and the other is named.
  if (token === undefined && user === undefined) return { on: false, problem: null };
  if (token === undefined) return { on: false, problem: `${PUSHOVER_TOKEN_ENV} is not set.` };
  if (user === undefined) return { on: false, problem: `${PUSHOVER_USER_ENV} is not set.` };

  try {
    return {
      on: true,
      settings: {
        token: readKey(PUSHOVER_TOKEN_ENV, token, "the API token of your Pushover application"),
        user: readKey(PUSHOVER_USER_ENV, user, "your Pushover user key, or a group key"),
        events: readEvents(PUSHOVER_EVENTS_ENV, valueOf(env, PUSHOVER_EVENTS_ENV)),
        afterMs: readAfter(PUSHOVER_AFTER_ENV, valueOf(env, PUSHOVER_AFTER_ENV)),
        asking: readAsking(PUSHOVER_ASKING_ENV, valueOf(env, PUSHOVER_ASKING_ENV)),
      },
    };
  } catch (error) {
    if (error instanceof SettingProblem) return { on: false, problem: error.message };
    return { on: false, problem: `${PUSHOVER_TOKEN_ENV} could not be read.` };
  }
}

/** The line the collector prints once at start when Pushover is off because of a setting. */
export function pushoverProblemLine(problem: string): string {
  return `Pushover pushes are off: ${problem}`;
}
