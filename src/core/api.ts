// The shapes the API returns, shared by the collector that writes them and the
// dashboard that reads them. `/api/sessions` returns a `SessionsSnapshot`.

import type { HistoryPoint, JumpTarget, SessionEvent } from "./sessions/session.ts";

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
  /** When the collector began. Time before this was not measured. */
  startedAt: number;
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

/** `POST /api/jump`, when the place was selected. `place` is where, as tmux gives it now. */
export interface JumpResponse extends JumpTarget {
  ok: true;
}

/**
 * Why a jump was not made, for the dashboard to say in its own words.
 *
 * no-pane       404: the session is not listed, or no pane is known for it
 * pane-gone     409: tmux says the pane is no longer there
 * tmux-stopped  409: no tmux server answered
 * too-soon      429: another jump was made less than a second ago
 * failed        500: tmux could not be run, or did not answer in time
 */
export type JumpFailure = "no-pane" | "pane-gone" | "tmux-stopped" | "too-soon" | "failed";

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
 * naming what: `jump`. A browser sends no header of this kind to another origin
 * without asking first, and the collector never says yes, so a page at another
 * address cannot send it.
 */
export const ACTION_HEADER = "X-Agent-Lookout-Action";

/** The most events one response carries. */
export const MAX_EVENTS_PER_RESPONSE = 200;

/**
 * The request header in which a dashboard page says, on every request, whether
 * its own notifications are on. The collector keeps the last thing a page said
 * and shows its own notifications only while that is "on", so the one switch in
 * Settings covers both.
 */
export const NOTIFICATIONS_HEADER = "X-Agent-Lookout-Notifications";

/** What a page says in `NOTIFICATIONS_HEADER`. Any other value says nothing. */
export type NotificationsSaid = "on" | "off";
