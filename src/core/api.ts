// The shapes the API returns, shared by the collector that writes them and the
// dashboard that reads them. `/api/sessions` returns a `SessionsSnapshot`.

import type { HistoryPoint, JumpTarget, SessionEvent } from "./sessions/session.ts";
import {
  DEFAULT_NOTICE_EVENTS,
  readNoticeEvents,
  writeNoticeEvents,
  type NoticeEvent,
} from "./notices/sessionChanges.ts";

/** `GET /api/health` */
export interface HealthResponse {
  ok: true;
  version: string;
}

/** `GET /api/events?since=<epoch ms>`: newest first, at most `MAX_EVENTS_PER_RESPONSE`. */
export interface EventsResponse {
  events: SessionEvent[];
}

/** `GET /api/history?windowMs=<n>`: one point per poll, oldest first. */
export interface HistoryResponse {
  points: HistoryPoint[];
  /**
   * When this run of the collector began. A new one means it was started
   * again. Without `since`, time before this was not measured.
   */
  startedAt: number;
  /**
   * How far back the history the collector holds reaches, and what began it.
   * Time before `since.at` was not measured. With history kept on disk it can
   * be before `startedAt`; in memory only it is `startedAt`, or when the
   * history was cleared. Left out, it is `startedAt`, as `historySince` reads it.
   */
  since?: HistorySince;
  /** Where the history is kept, and how much it holds. */
  kept?: HistoryKept;
  /**
   * Each time Agent Lookout started again after `since`, with history kept
   * from before it, oldest first: this run's start among them. Nothing was
   * measured between the two moments each gives, however close they are.
   * Left out, or empty, when there were none.
   */
  restarts?: HistoryRestart[];
}

/** A start of Agent Lookout that followed history kept from an earlier run. */
export interface HistoryRestart {
  /** When it started watching again. */
  at: number;
  /** The newest moment the history from before it holds. */
  lastBefore: number;
}

/**
 * What the history held begins with:
 *
 * started  Agent Lookout started watching
 * cleared  the history was cleared
 * trimmed  the oldest history kept: what came before was let go, for its age or the size
 */
export const HISTORY_BEGINNINGS = ["started", "cleared", "trimmed"] as const;

export type HistoryBeginning = (typeof HISTORY_BEGINNINGS)[number];

/** Where the history held begins. */
export interface HistorySince {
  at: number;
  by: HistoryBeginning;
}

/**
 * Where the history is kept: in files in a folder on this computer, so the
 * Events log and the charts are still there after a restart, or in memory
 * only, with `AGENT_LOOKOUT_HISTORY=off`, and gone when Agent Lookout stops.
 */
export interface HistoryKept {
  where: "disk" | "memory";
  /** The folder the files are in, with the home folder written `~`. Null in memory. */
  folder: string | null;
  /** How many bytes the files hold now. Null in memory. */
  bytes: number | null;
  /** The most the files may hold in all, in bytes. Past it the oldest go. */
  maxBytes: number;
  /** How long after its day a day's history is kept, in milliseconds. */
  maxAgeMs: number;
  /**
   * Whether this copy of Agent Lookout writes the files and can clear them.
   * False in memory, while another copy writes them, and while they cannot be
   * written.
   */
  canClear: boolean;
  /** While this copy is not writing the files: one sentence saying why. Null otherwise. */
  problem: string | null;
}

/** What `ACTION_HEADER` says on a request that clears the history. */
export const CLEAR_HISTORY_ACTION = "clear-history";

/** `POST /api/history/clear`, when the history was cleared. */
export interface ClearHistoryResponse {
  ok: true;
  clearedAt: number;
}

/**
 * Why the history was not cleared:
 *
 * memory-only  409: history is kept in memory only, and nothing is on disk to clear
 * not-writing  409: another copy of Agent Lookout writes the files, or they cannot be written
 * failed       500: the files could not all be deleted
 */
export type ClearHistoryFailure = "memory-only" | "not-writing" | "failed";

/** The body of an answer of `POST /api/history/clear` that says why it was not cleared. */
export interface ClearHistoryRefusal extends ErrorResponse {
  reason: ClearHistoryFailure;
}

/** The body of every response that is not a 200. */
export interface ErrorResponse {
  error: string;
}

/**
 * The body of `POST /api/jump`: the id of the session to go to, and nothing
 * else. The collector looks the session up in its own list and acts on what it
 * found there, so nothing in the request can choose what is run.
 */
export interface JumpRequest {
  sessionId: string;
}

/**
 * `POST /api/jump`, when the place was selected. For a tmux pane, `place` is
 * where, as tmux gives it now. For a terminal tab, it is the app.
 */
export type JumpResponse = JumpTarget & { ok: true };

/**
 * Why a jump was not made, for the dashboard to say in its own words.
 *
 * no-pane       404: the session is not listed, or no pane or tab is known for it
 * pane-gone     409: tmux says the pane is no longer there
 * tmux-stopped  409: no tmux server answered
 * tab-gone      409: Terminal or iTerm2 has no tab on the session's terminal
 * not-allowed   403: macOS did not allow Agent Lookout to control the app
 * too-soon      429: another jump was made less than a second ago, or one is under way
 * failed        500: tmux or osascript could not be run, or did not answer in time
 */
export type JumpFailure =
  "no-pane" | "pane-gone" | "tmux-stopped" | "tab-gone" | "not-allowed" | "too-soon" | "failed";

/**
 * How long the collector waits for Terminal or iTerm2 to bring a tab forward.
 * The first time, macOS asks the person whether it may, and the app does not
 * answer until they have, so this is long enough to read the question.
 */
export const TERMINAL_JUMP_TIMEOUT_MS = 60_000;

/** The body of an answer of `POST /api/jump` that says why no jump was made. */
export interface JumpRefusal extends ErrorResponse {
  reason: JumpFailure;
}

/**
 * The least time between two jumps, since each one starts tmux several times.
 * The collector refuses one that comes sooner, and a dashboard page does not
 * send a press it knows would be refused.
 */
export const JUMP_INTERVAL_MS = 1_000;

/**
 * The request header a dashboard page sends with a request that does something,
 * naming what: `jump`, or `clear-history`. A browser sends no header of this
 * kind to another origin without asking first, and the collector never says
 * yes, so a page at another address cannot send it.
 */
export const ACTION_HEADER = "X-Agent-Lookout-Action";

/** The most events one response carries. */
export const MAX_EVENTS_PER_RESPONSE = 200;

/**
 * The request header in which a dashboard page says, on every request, whether
 * its own notifications are on, and for which events. The collector keeps the
 * last thing a page said and shows its own notifications only of those events,
 * so the switches in Settings cover both.
 */
export const NOTIFICATIONS_HEADER = "X-Agent-Lookout-Notifications";

/**
 * What a page says in `NOTIFICATIONS_HEADER`: the events it shows a
 * notification of. None is off.
 */
export type NotificationsSaid = readonly NoticeEvent[];

/**
 * The header's value for these events:
 *
 * - `off` for none.
 * - `on` for a wait alone, which is all `on` meant before the events could be
 *   chosen, so a page from then still says the same.
 * - `on; events=` and the names, such as `on; events=needs-you,finished`, for
 *   any other choice.
 */
export function notificationsHeaderValue(events: NotificationsSaid): string {
  const written = writeNoticeEvents(events);
  if (written === "") return "off";
  if (written === writeNoticeEvents(DEFAULT_NOTICE_EVENTS)) return "on";
  return `on; events=${written}`;
}

const EVENTS_GIVEN = /^on\s*;\s*events\s*=(.*)$/;

/**
 * What a header's value says, as `notificationsHeaderValue` writes it, or null
 * when it is anything else. Spaces and case do not matter. A name that is not
 * an event makes the whole value say nothing, as does a header sent twice,
 * which arrives as the two values joined by a comma.
 */
export function readNotificationsHeader(value: string): NotificationsSaid | null {
  const said = value.trim().toLowerCase();
  if (said === "off") return [];
  if (said === "on") return DEFAULT_NOTICE_EVENTS;
  const list = EVENTS_GIVEN.exec(said)?.[1];
  return list === undefined ? null : readNoticeEvents(list);
}

/**
 * The most the collector sends off this computer in any hour, by each way of
 * sending: emails, and posts to the webhook, each counted on its own. Past it,
 * none go that way until the hour has passed.
 */
export const SENDS_PER_HOUR = 20;

/** How the last email or post went: when it was tried, and whether it was sent or why it was not. */
export type SendResult = { at: number; sent: true } | { at: number; sent: false; reason: string };

/**
 * `GET /api/email`: whether the collector sends emails, to whom, for which
 * events and after how long a wait, and how the last one went. It is
 * read-only. The settings live in the environment the collector was started
 * with, and this never holds the mail server's address, its user name or its
 * password.
 */
export interface EmailStatusResponse {
  on: boolean;
  /** The address, with all but the first letter before the @ hidden: `n…@example.com`. Null while off. */
  to: string | null;
  /** The events that are emailed, in the order of `NOTICE_EVENTS`. Null while off. */
  events: NoticeEvent[] | null;
  /** How long a wait lasts before it is emailed, in milliseconds. Null while off. */
  afterMs: number | null;
  /** While off because a setting is wrong: one sentence naming the setting, never its value. */
  problem: string | null;
  /** The last email that was tried, or null when none has been. */
  last: SendResult | null;
  /** While the hourly limit holds emails back, when the next may go. */
  limitedUntil: number | null;
}

/** A host name of letters, digits, dashes and underscores separated by dots, perhaps ending in one, or an address in brackets. */
const WEBHOOK_HOST = /^(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.?|\[[0-9A-Fa-f:.]+\])$/;

/** The longest host name DNS allows. */
const MAX_HOST_LENGTH = 253;

/**
 * Whether a host is one the collector posts to and the page shows. The
 * collector takes no other at start, and the page counts the webhook as on
 * only with one, so the page never says off while posts go out.
 */
export function isWebhookHost(host: string): boolean {
  return host.length <= MAX_HOST_LENGTH && WEBHOOK_HOST.test(host);
}

/**
 * `GET /api/webhook`: whether the collector posts to a webhook, to which host,
 * for which events and after how long a wait, and how the last post went. It
 * is read-only. The address lives in the environment the collector was started
 * with, and this never holds more of it than the host: whoever has the whole
 * address can post to the channel behind it.
 */
export interface WebhookStatusResponse {
  on: boolean;
  /** The host the posts go to, such as `hooks.slack.com`, and never the path. Null while off. */
  host: string | null;
  /** The events that are posted, in the order of `NOTICE_EVENTS`. Null while off. */
  events: NoticeEvent[] | null;
  /** How long a wait lasts before it is posted, in milliseconds. Null while off. */
  afterMs: number | null;
  /** While off because a setting is wrong: one sentence naming the setting, never its value. */
  problem: string | null;
  /** The last post that was tried, or null when none has been. */
  last: SendResult | null;
  /** While the hourly limit holds posts back, when the next may go. */
  limitedUntil: number | null;
}
