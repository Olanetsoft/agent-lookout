// The shapes the API returns, shared by the collector that writes them and the
// dashboard that reads them. `/api/sessions` returns a `SessionsSnapshot`.

import type { HistoryPoint, SessionEvent } from "./sessions/session.ts";

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

/** The most events one response carries. */
export const MAX_EVENTS_PER_RESPONSE = 200;
