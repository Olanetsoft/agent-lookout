import {
  DEFAULT_NOTICE_EVENTS,
  NOTICE_EVENTS,
  readNoticeEvents,
  type NoticeEvent,
} from "../../core/notices/sessionChanges.ts";

/**
 * The settings email and the webhook read the same way, each under its own
 * names: which events are sent, how long a wait lasts first, and whether what a
 * waiting session is asking goes too. Nothing here ever puts a setting's value
 * in a sentence.
 */

/** How long a wait lasts before it is sent when the setting is left out. */
export const DEFAULT_AFTER_SECONDS = 60;

/** The longest delay that can be set: a day. */
const MAX_AFTER_SECONDS = 86_400;

/**
 * The hosts on this computer that a channel may reach without TLS: a mail
 * server over plain SMTP, or a webhook over `http://`.
 */
export const LOCAL_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

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
  if (!(seconds <= MAX_AFTER_SECONDS)) {
    throw new SettingProblem(
      `${name} must be a whole number of seconds from 0 to ${MAX_AFTER_SECONDS}, such as 60.`,
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

/**
 * Whether what a waiting session is asking goes too, from `on` or `off` in the
 * setting called `name`. Left out, it does not: the line can hold a command, a
 * web address or a file's full path, so it leaves this computer only when the
 * person says so. Anything else is a setting that cannot be read, as for every
 * other setting of the channel, so a typing slip never sends more than was asked.
 */
export function readAsking(name: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  const said = value.toLowerCase();
  if (said === "on") return true;
  if (said === "off") return false;
  throw new SettingProblem(`${name} must be on or off.`);
}
