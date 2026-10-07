import { isWebhookHost } from "../../core/api.ts";
import type { NoticeEvent } from "../../core/notices/sessionChanges.ts";
import {
  LOCAL_HOSTS,
  readAfter,
  readAsking,
  readEvents,
  SettingProblem,
  valueOf,
} from "../outbound/outboundSettings.ts";

/**
 * The settings for pushes through ntfy, read from the environment the
 * collector starts with. Nothing else sets them: they are never written to a
 * file, never sent to the dashboard and never printed. With no topic address
 * set, ntfy is off and nothing is ever pushed.
 *
 * The topic is a secret. On ntfy.sh, and on a server of one's own without
 * access control, anyone who knows a topic's name can read every push sent to
 * it, and send to it. So no sentence made here repeats the address, and the
 * dashboard is told the host alone. The access token is a secret too, and
 * the dashboard is told only whether one is set.
 */

/** The topic's address: `https://ntfy.sh/<topic>`, or a server of one's own. */
export const NTFY_URL_ENV = "AGENT_LOOKOUT_NTFY_URL";
/** An access token for the topic, sent as `Authorization: Bearer`. Left out, none is sent. */
export const NTFY_TOKEN_ENV = "AGENT_LOOKOUT_NTFY_TOKEN";
/** The events that are pushed, as names separated by commas: `needs-you,finished`. */
export const NTFY_EVENTS_ENV = "AGENT_LOOKOUT_NTFY_EVENTS";
/** How many seconds a wait lasts before it is pushed. */
export const NTFY_AFTER_ENV = "AGENT_LOOKOUT_NTFY_AFTER";
/** `on` to put what a waiting session is asking in the push for its wait. Off unless set. */
export const NTFY_ASKING_ENV = "AGENT_LOOKOUT_NTFY_ASKING";

export interface NtfySettings {
  /**
   * Where a push is posted: the server, and any path before the topic, ending
   * in `/`. ntfy takes a push written as JSON only there, with the topic in it.
   */
  server: URL;
  /** The topic. Never shown or printed. */
  topic: string;
  /** The access token, or null when none is set. Never shown or printed. */
  token: string | null;
  /** The events that are pushed, at least one, in the order of `NOTICE_EVENTS`. */
  events: readonly NoticeEvent[];
  /** How long a wait lasts before it is pushed, in milliseconds. */
  afterMs: number;
  /** Whether the push for a wait says what the session is asking. */
  asking: boolean;
}

/**
 * on   every ntfy setting could be read.
 * off  ntfy is off. `problem` says which setting is wrong, or is null when no
 *      topic address was set, which is the default and needs no word.
 */
export type NtfySetup =
  { on: true; settings: NtfySettings } | { on: false; problem: string | null };

/** The longest address that is read. */
const MAX_URL_LENGTH = 2_048;

/** A topic's name as ntfy takes one. */
const TOPIC = /^[-_A-Za-z0-9]{1,64}$/;

/** A part of the path before the topic, for a server behind a path of its own. */
const PATH_PART = /^[-_.~A-Za-z0-9]+$/;

/**
 * A token as an `Authorization` header can carry it: ntfy's own begin `tk_`,
 * and nothing in it can end the header or add another.
 */
const TOKEN = /^[-A-Za-z0-9._~+/=]{1,128}$/;

const URL_UNREADABLE = `${NTFY_URL_ENV} could not be read. Copy the topic's whole address, beginning https://.`;

/** The address in `AGENT_LOOKOUT_NTFY_URL`, checked, as the server and the topic. */
function readTopicUrl(value: string): Pick<NtfySettings, "server" | "topic"> {
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
      `${NTFY_URL_ENV} must begin with https://, or with http:// for a server on this computer, 127.0.0.1 or localhost.`,
    );
  }
  if (url.hostname === "") throw new SettingProblem(URL_UNREADABLE);
  // The page shows the host, by the rule the webhook's is shown by.
  if (!isWebhookHost(url.hostname)) {
    throw new SettingProblem(
      `${NTFY_URL_ENV} must name its host in letters, digits, dots and dashes, such as ntfy.sh.`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new SettingProblem(
      `${NTFY_URL_ENV} must not hold a user name or a password. Put an access token in ${NTFY_TOKEN_ENV}.`,
    );
  }
  // A query could carry `?auth=`, which would put a secret where a log might
  // keep it, so none is taken.
  if (url.search !== "" || url.hash !== "" || value.includes("?") || value.includes("#")) {
    throw new SettingProblem(
      `${NTFY_URL_ENV} must end with the topic, with no ? or # after it. Put an access token in ${NTFY_TOKEN_ENV}.`,
    );
  }

  const parts = url.pathname.split("/").filter((part) => part !== "");
  const topic = parts.pop();
  if (topic === undefined || !TOPIC.test(topic) || !parts.every((part) => PATH_PART.test(part))) {
    throw new SettingProblem(
      `${NTFY_URL_ENV} must end with the topic, up to 64 letters, digits, dashes and underscores, as in https://ntfy.sh/your-topic.`,
    );
  }
  const server = new URL(url.origin);
  server.pathname = `/${parts.map((part) => `${part}/`).join("")}`;
  return { server, topic };
}

function readToken(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!TOKEN.test(value)) {
    throw new SettingProblem(
      `${NTFY_TOKEN_ENV} must be an access token of letters, digits and . _ ~ + / = -, such as one that begins tk_.`,
    );
  }
  return value;
}

/**
 * Reads the ntfy settings from the environment. It never throws, and no
 * sentence it returns holds the value of a setting.
 */
export function readNtfySetup(env: NodeJS.ProcessEnv): NtfySetup {
  const url = valueOf(env, NTFY_URL_ENV);
  // Without a topic address ntfy is off, and there is nothing to say. That is
  // the default and the way to turn it off, so the others may stay set.
  if (url === undefined) return { on: false, problem: null };

  try {
    return {
      on: true,
      settings: {
        ...readTopicUrl(url),
        token: readToken(valueOf(env, NTFY_TOKEN_ENV)),
        events: readEvents(NTFY_EVENTS_ENV, valueOf(env, NTFY_EVENTS_ENV)),
        afterMs: readAfter(NTFY_AFTER_ENV, valueOf(env, NTFY_AFTER_ENV)),
        asking: readAsking(NTFY_ASKING_ENV, valueOf(env, NTFY_ASKING_ENV)),
      },
    };
  } catch (error) {
    if (error instanceof SettingProblem) return { on: false, problem: error.message };
    return { on: false, problem: URL_UNREADABLE };
  }
}

/** The line the collector prints once at start when ntfy is off because of a setting. */
export function ntfyProblemLine(problem: string): string {
  return `ntfy pushes are off: ${problem}`;
}
