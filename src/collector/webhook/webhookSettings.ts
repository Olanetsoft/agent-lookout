import { isWebhookHost } from "../../core/api.ts";
import type { NoticeEvent } from "../../core/notices/sessionChanges.ts";
import {
  LOCAL_HOSTS,
  readAfter,
  readEvents,
  SettingProblem,
  valueOf,
} from "../outbound/outboundSettings.ts";

/**
 * The settings for posting notices to a webhook, read from the environment the
 * collector starts with. Nothing else sets them: they are never written to a
 * file, never sent to the dashboard and never printed. With no address set,
 * the webhook is off and nothing is ever posted.
 *
 * The address is a secret. Whoever has a Slack incoming webhook's address can
 * post to its channel, and the token is in the path. So no sentence made here
 * repeats it, and the dashboard is told the host alone.
 */

/** The one address posts go to: `https://...`, or `http://` to this computer. */
export const WEBHOOK_URL_ENV = "AGENT_LOOKOUT_WEBHOOK_URL";
/** The events that are posted, as names separated by commas: `needs-you,finished`. */
export const WEBHOOK_EVENTS_ENV = "AGENT_LOOKOUT_WEBHOOK_EVENTS";
/** How many seconds a wait lasts before it is posted. */
export const WEBHOOK_AFTER_ENV = "AGENT_LOOKOUT_WEBHOOK_AFTER";

export interface WebhookSettings {
  /** The whole address, path and query included. Never shown or printed. */
  url: URL;
  /** The events that are posted, at least one, in the order of `NOTICE_EVENTS`. */
  events: readonly NoticeEvent[];
  /** How long a wait lasts before it is posted, in milliseconds. */
  afterMs: number;
}

/**
 * on   every webhook setting could be read.
 * off  the webhook is off. `problem` says which setting is wrong, or is null
 *      when no address was set, which is the default and needs no word.
 */
export type WebhookSetup =
  { on: true; settings: WebhookSettings } | { on: false; problem: string | null };

/** The longest address that is read. */
const MAX_URL_LENGTH = 2_048;

const URL_UNREADABLE = `${WEBHOOK_URL_ENV} could not be read. Copy the whole address, beginning https://.`;

/** The address in `AGENT_LOOKOUT_WEBHOOK_URL`, checked. */
function readUrl(value: string): URL {
  let url: URL;
  try {
    if (value.length > MAX_URL_LENGTH) throw new Error();
    url = new URL(value);
  } catch {
    // The error repeats the address, so it goes no further.
    throw new SettingProblem(URL_UNREADABLE);
  }

  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new SettingProblem(
      `${WEBHOOK_URL_ENV} must begin with https://, or with http:// for an address on this computer, 127.0.0.1 or localhost.`,
    );
  }
  if (url.hostname === "") throw new SettingProblem(URL_UNREADABLE);
  // The page shows the host and says the webhook is off for any other kind, so
  // no other kind is posted to.
  if (!isWebhookHost(url.hostname)) {
    throw new SettingProblem(
      `${WEBHOOK_URL_ENV} must name its host in letters, digits, dots and dashes, such as hooks.slack.com.`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new SettingProblem(`${WEBHOOK_URL_ENV} must not hold a user name or a password.`);
  }
  return url;
}

/**
 * Reads the webhook settings from the environment. It never throws, and no
 * sentence it returns holds the value of a setting.
 */
export function readWebhookSetup(env: NodeJS.ProcessEnv): WebhookSetup {
  const url = valueOf(env, WEBHOOK_URL_ENV);
  // Without an address the webhook is off, and there is nothing to say. That is
  // the default and the way to turn it off, so the other two may stay set.
  if (url === undefined) return { on: false, problem: null };

  try {
    return {
      on: true,
      settings: {
        url: readUrl(url),
        events: readEvents(WEBHOOK_EVENTS_ENV, valueOf(env, WEBHOOK_EVENTS_ENV)),
        afterMs: readAfter(WEBHOOK_AFTER_ENV, valueOf(env, WEBHOOK_AFTER_ENV)),
      },
    };
  } catch (error) {
    if (error instanceof SettingProblem) return { on: false, problem: error.message };
    return { on: false, problem: URL_UNREADABLE };
  }
}

/** The line the collector prints once at start when the webhook is off because of a setting. */
export function webhookProblemLine(problem: string): string {
  return `Webhook notifications are off: ${problem}`;
}
