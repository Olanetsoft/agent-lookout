import {
  DEFAULT_NOTICE_EVENTS,
  NOTICE_EVENTS,
  readNoticeEvents,
  type NoticeEvent,
} from "../../core/sessions/waitChanges.ts";

/**
 * The settings email and the webhook read the same way, each under its own
 * names: which events are sent, and how long a wait lasts first. Nothing here
 * ever puts a setting's value in a sentence.
 */

/** How long a wait lasts before it is sent when the setting is left out. */
export const DEFAULT_AFTER_SECONDS = 60;

/** The longest delay that can be set: a day. */
const MOST_AFTER_SECONDS = 86_400;

/** Thrown while reading a setting that cannot be read, with the sentence to say. */
export class SettingProblem extends Error {}

/** A setting's value, or undefined when it is not set or holds only spaces. */
export function valueOf(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/** The delay in milliseconds, from a whole number of seconds in the setting called `name`. */
export function readAfter(name: string, value: string | undefined): number {
  if (value === undefined) return DEFAULT_AFTER_SECONDS * 1_000;
  const seconds = /^\d{1,6}$/.test(value) ? Number(value) : Number.NaN;
  if (!(seconds <= MOST_AFTER_SECONDS)) {
    throw new SettingProblem(
      `${name} must be a whole number of seconds from 0 to ${MOST_AFTER_SECONDS}, such as 60.`,
    );
  }
  return seconds * 1_000;
}

/** The events, from names separated by commas in the setting called `name`. Left out, a wait alone. */
export function readEvents(name: string, value: string | undefined): readonly NoticeEvent[] {
  if (value === undefined) return DEFAULT_NOTICE_EVENTS;
  const events = readNoticeEvents(value);
  if (events === null || events.length === 0) {
    throw new SettingProblem(
      `${name} must be one or more of ${NOTICE_EVENTS.join(", ")}, separated by commas, such as needs-you,finished.`,
    );
  }
  return events;
}
