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
 * The settings for email notifications, read from the environment the
 * collector starts with. Nothing else sets them: they are never written to a
 * file, never sent to the dashboard and never printed. With nothing set, email
 * is off and nothing that could send one is loaded.
 *
 * Email is on only when both the address and the mail server are set and every
 * email setting can be read. Anything that cannot be read turns it off, with one
 * sentence that names the setting and never repeats its value, because the mail
 * server's address holds a password.
 */

/** The one address emails go to. */
export const EMAIL_TO_ENV = "AGENT_LOOKOUT_EMAIL_TO";
/** The mail server, as `smtps://name:password@server:port` or `smtp://...`. */
export const SMTP_URL_ENV = "AGENT_LOOKOUT_SMTP_URL";
/** The address emails come from. Defaults to the address they go to. */
export const EMAIL_FROM_ENV = "AGENT_LOOKOUT_EMAIL_FROM";
/** How many seconds a wait lasts before it is emailed. */
export const EMAIL_AFTER_ENV = "AGENT_LOOKOUT_EMAIL_AFTER";
/** The events that are emailed, as names separated by commas: `needs-you,finished`. */
export const EMAIL_EVENTS_ENV = "AGENT_LOOKOUT_EMAIL_EVENTS";
/** `on` to put what a waiting session is asking in the email for its wait. Off unless set. */
export const EMAIL_ASKING_ENV = "AGENT_LOOKOUT_EMAIL_ASKING";

/**
 * How the connection to the mail server is kept private.
 *
 * tls       `smtps://`: TLS from the first byte.
 * starttls  `smtp://`: the server must offer STARTTLS, and the connection is
 *           upgraded before anything is sent. A server that does not is refused.
 * plain     `smtp://` to 127.0.0.1 or localhost, a relay on this machine, where
 *           nothing leaves the machine on the way to it.
 */
export type MailSecurity = "tls" | "starttls" | "plain";

export interface MailServer {
  host: string;
  port: number;
  security: MailSecurity;
  /** The user name and password to sign in with, or null for a server that asks for none. */
  auth: { user: string; pass: string } | null;
}

export interface EmailSettings {
  to: string;
  from: string;
  /** The events that are emailed, at least one, in the order of `NOTICE_EVENTS`. */
  events: readonly NoticeEvent[];
  /** How long a wait lasts before it is emailed, in milliseconds. */
  afterMs: number;
  /** Whether the email for a wait says what the session is asking. */
  asking: boolean;
  server: MailServer;
}

/**
 * on   every email setting could be read.
 * off  email is off. `problem` says which setting is wrong, or is null when no
 *      address was set, which is the default and needs no word.
 */
export type EmailSetup =
  { on: true; settings: EmailSettings } | { on: false; problem: string | null };

/**
 * One address, and nothing that could be read as a second one, a name or a
 * header: no space, comma, semicolon, quote, angle bracket or line break. The
 * part after the @ is a host name with at least one dot.
 */
const ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** The longest address the mail standards allow. */
const MAX_ADDRESS_LENGTH = 254;

/** A server's name, or an IPv6 address in brackets as a URL writes one. */
const HOST_NAME = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/;
const BRACKETED_IPV6 = /^\[[0-9A-Fa-f:.]+\]$/;

/** Whether a value is one email address, as `ADDRESS` reads one. */
export function isOneAddress(value: string): boolean {
  return value.length <= MAX_ADDRESS_LENGTH && ADDRESS.test(value);
}

const URL_UNREADABLE = `${SMTP_URL_ENV} could not be read. Write it as smtps://name:password@server:port, with any @, :, /, ?, # or % in the name or the password written as %40, %3A, %2F, %3F, %23 or %25.`;

/** `decodeURIComponent`, with a malformed escape counted as a setting that cannot be read. */
function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new SettingProblem(URL_UNREADABLE);
  }
}

/**
 * The mail server named by `AGENT_LOOKOUT_SMTP_URL`. Only the scheme, the user
 * name, the password, the server and the port are read. Anything after them, a
 * path, a query or a fragment, makes the address one that cannot be read: it is
 * most often a password with a /, ? or # left unescaped, which would otherwise
 * be taken for the server and the port. So nothing in the address can turn off
 * a check made here.
 */
function readServer(value: string): MailServer {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // The error repeats the address, password and all, so it goes no further.
    throw new SettingProblem(URL_UNREADABLE);
  }

  const scheme = url.protocol;
  if (scheme !== "smtps:" && scheme !== "smtp:") {
    throw new SettingProblem(`${SMTP_URL_ENV} must begin with smtps:// or smtp://.`);
  }
  if (url.search !== "" || url.hash !== "" || (url.pathname !== "" && url.pathname !== "/")) {
    throw new SettingProblem(URL_UNREADABLE);
  }

  const hostname = url.hostname.toLowerCase();
  if (!HOST_NAME.test(hostname) && !BRACKETED_IPV6.test(hostname)) {
    throw new SettingProblem(`${SMTP_URL_ENV} does not name a mail server after the @.`);
  }
  const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;

  const port = url.port === "" ? (scheme === "smtps:" ? 465 : 587) : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new SettingProblem(`${SMTP_URL_ENV} has a port that is not a number from 1 to 65535.`);
  }

  const user = decoded(url.username);
  const pass = decoded(url.password);
  if (user === "" && pass !== "") {
    throw new SettingProblem(`${SMTP_URL_ENV} has a password but no user name.`);
  }

  const security: MailSecurity =
    scheme === "smtps:" ? "tls" : LOCAL_HOSTS.has(host) ? "plain" : "starttls";
  return { host, port, security, auth: user === "" ? null : { user, pass } };
}

function readAddress(name: string, value: string): string {
  if (!isOneAddress(value)) {
    throw new SettingProblem(`${name} must be one email address, such as you@example.com.`);
  }
  return value;
}

/**
 * Reads the email settings from the environment. It never throws, and no
 * sentence it returns holds the value of a setting.
 */
export function readEmailSetup(env: NodeJS.ProcessEnv): EmailSetup {
  const to = valueOf(env, EMAIL_TO_ENV);
  const url = valueOf(env, SMTP_URL_ENV);
  const from = valueOf(env, EMAIL_FROM_ENV);
  const after = valueOf(env, EMAIL_AFTER_ENV);
  const events = valueOf(env, EMAIL_EVENTS_ENV);
  const asking = valueOf(env, EMAIL_ASKING_ENV);

  // Without an address email is off, and there is nothing to say. That is the
  // default, and the way to turn it off, which the guide and every email give,
  // so the other settings may stay where they are kept.
  if (to === undefined) return { on: false, problem: null };
  if (url === undefined) return { on: false, problem: `${SMTP_URL_ENV} is not set.` };

  try {
    return {
      on: true,
      settings: {
        to: readAddress(EMAIL_TO_ENV, to),
        from: from === undefined ? to : readAddress(EMAIL_FROM_ENV, from),
        events: readEvents(EMAIL_EVENTS_ENV, events),
        afterMs: readAfter(EMAIL_AFTER_ENV, after),
        asking: readAsking(EMAIL_ASKING_ENV, asking),
        server: readServer(url),
      },
    };
  } catch (error) {
    if (error instanceof SettingProblem) return { on: false, problem: error.message };
    return { on: false, problem: `${SMTP_URL_ENV} could not be read.` };
  }
}

/** The line the collector prints once at start when email is off because of a setting. */
export function emailProblemLine(problem: string): string {
  return `Email notifications are off: ${problem}`;
}

/**
 * The address emails go to, as the dashboard may show it: the first letter
 * before the @, then an ellipsis, then the domain. `name@example.com` is
 * `n…@example.com`.
 */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf("@");
  return `${address.slice(0, 1)}…${address.slice(at)}`;
}
