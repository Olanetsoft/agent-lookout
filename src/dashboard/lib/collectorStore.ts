import { MAX_EVENTS_PER_RESPONSE, type HistoryResponse } from "@core/api";
import { DEFAULT_HISTORY_WINDOW_MS } from "@core/history";
import type { SessionEvent, SessionsSnapshot } from "@core/session";
import { apiRequest } from "@dashboard/lib/apiHost";
import { timerBeat, type Beat } from "@dashboard/lib/beat";
import { mergeHistory } from "@dashboard/lib/historyChart";
import { readEvents, readHistory, readSnapshot } from "@dashboard/lib/readApi";

/**
 * The dashboard's copy of what the collector knows.
 *
 * One store polls the three routes on one beat and never overlaps a slow poll.
 * It keeps the last good answer when the collector stops answering, so a failure
 * shows as stale data rather than as an empty screen.
 */

export const POLL_INTERVAL_MS = 2_000;
/** Every request is bounded, so a dead server cannot pile up open connections. */
export const REQUEST_TIMEOUT_MS = 4_000;
/** Data older than this is called stale. Shorter gaps are blips and are not shown. */
export const STALE_AFTER_MS = 5_000;
/**
 * The window asked for on every beat, and the shortest a history dialog offers:
 * the collector's default, the last 15 minutes.
 */
export const HISTORY_WINDOW_MS = DEFAULT_HISTORY_WINDOW_MS;
/** How much history the store holds: the last hour, which is what the timeline covers. */
export const HISTORY_KEPT_MS = 60 * 60 * 1000;
/**
 * Points this much older than the hour are kept as well. The present moves on
 * between polls, and whatever draws the hour has to know whether the poll just
 * before its left edge was there.
 */
const HISTORY_SLACK_MS = 60 * 1000;
/** The log holds as many events as one answer from the collector can carry. */
export const MAX_EVENTS = MAX_EVENTS_PER_RESPONSE;
/** Failed first requests before the dashboard stops saying "loading". */
const FAILURES_BEFORE_UNREACHABLE = 2;

/**
 * connecting   no answer yet, and too early to call it a failure
 * live         the last poll was answered
 * stalled      there is data on screen, but the collector has stopped answering
 * unreachable  the collector has never answered
 */
export type CollectorPhase = "connecting" | "live" | "stalled" | "unreachable";

/** The answer of `/api/history`: one point per poll, and when the collector began. */
export type CollectorHistory = HistoryResponse;

/**
 * What kind of failure a poll ran into. The three are told apart on screen,
 * because "nothing answered" and "something answered, but not with data" call
 * for different things to check.
 *
 * no-answer     the request failed or timed out
 * error-status  the server answered with an error status
 * not-data      the server answered, but not with what this route sends
 */
export type ProblemKind = "no-answer" | "error-status" | "not-data";

export interface CollectorState {
  phase: CollectorPhase;
  snapshot: SessionsSnapshot | null;
  /** Newest first. */
  events: SessionEvent[];
  /**
   * The counts over the last hour, or null until that answer arrives. It is asked
   * for once and then kept current from the 15 minutes polled on every beat.
   */
  history: CollectorHistory | null;
  /** This browser's clock at the last answered poll. */
  lastOkAt: number | null;
  /** What went wrong with the latest poll, in plain words. Null when it was answered. */
  problem: string | null;
  /** The kind of failure that was. Null when the poll was answered. */
  problemKind: ProblemKind | null;
}

export interface CollectorStore {
  subscribe(listener: () => void): () => void;
  getState(): CollectorState;
  /** Polls now instead of waiting for the next beat. */
  refresh(): void;
}

export interface CollectorStoreOptions {
  now?: () => number;
  intervalMs?: number;
  /** What calls for a poll every `intervalMs`. The page's own timer unless another is given. */
  beat?: Beat;
}

const INITIAL_STATE: CollectorState = {
  phase: "connecting",
  snapshot: null,
  events: [],
  history: null,
  lastOkAt: null,
  problem: null,
  problemKind: null,
};

/** A failure with a message that is fit to show to a person. */
class ApiProblem extends Error {
  readonly kind: ProblemKind;

  constructor(kind: ProblemKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Requests a route and reads its answer. Every way it can fail becomes an `ApiProblem`. */
async function getJson(path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await apiRequest(path, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new ApiProblem(
      "no-answer",
      timedOut ? "The local server took too long to answer." : "The local server did not answer.",
    );
  }
  if (!response.ok) {
    throw new ApiProblem(
      "error-status",
      `The local server answered ${path} with error ${response.status}.`,
    );
  }
  try {
    return await response.json();
  } catch {
    // A dev server with no collector mounted answers with its HTML page.
    throw new ApiProblem(
      "not-data",
      `The local server answered ${path} with something that is not data.`,
    );
  }
}

/** Each item inside an answer is read on its own in `readApi`; a bad one never reaches the page. */
function parseSnapshot(data: unknown): SessionsSnapshot {
  const snapshot = readSnapshot(data);
  if (!snapshot) {
    throw new ApiProblem(
      "not-data",
      "The local server sent session data in a shape this page cannot read.",
    );
  }
  return snapshot;
}

function parseEvents(data: unknown): SessionEvent[] {
  const events = readEvents(data);
  if (!events) {
    throw new ApiProblem(
      "not-data",
      "The local server sent events in a shape this page cannot read.",
    );
  }
  return events;
}

function parseHistory(data: unknown): CollectorHistory {
  const history = readHistory(data);
  if (!history) {
    throw new ApiProblem(
      "not-data",
      "The local server sent history in a shape this page cannot read.",
    );
  }
  return history;
}

/**
 * The counts over a window longer than the one the store holds, for a history
 * panel. It is asked for when a panel needs it, not on every beat: six hours is
 * thousands of points.
 */
export function fetchHistory(windowMs: number): Promise<CollectorHistory> {
  return getJson(`/api/history?windowMs=${Math.round(windowMs)}`).then(parseHistory);
}

/** Adds events the page has not seen yet. Keeps newest first and a bounded length. */
export function mergeEvents(
  known: readonly SessionEvent[],
  incoming: readonly SessionEvent[],
): SessionEvent[] {
  if (incoming.length === 0) return known as SessionEvent[];
  const seen = new Set(known.map((event) => event.id));
  const fresh = incoming.filter((event) => !seen.has(event.id));
  if (fresh.length === 0) return known as SessionEvent[];
  return [...fresh, ...known].sort((a, b) => b.at - a.at).slice(0, MAX_EVENTS);
}

export function createCollectorStore(options: CollectorStoreOptions = {}): CollectorStore {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const beat = options.beat ?? timerBeat;
  const listeners = new Set<() => void>();

  let state = INITIAL_STATE;
  /** Stops the beat while it is running. Null while nothing is listening. */
  let stopBeat: (() => void) | null = null;
  let inFlight = false;
  let failures = 0;
  /**
   * This browser's clock when history was last answered, while what the store
   * holds reaches back the whole hour. Null means the hour has to be asked for:
   * at the start, after the collector restarts, and after a silence so long that
   * the 15 minutes polled on each beat would no longer join on to what is held.
   */
  let hourCurrentAt: number | null = null;

  function setState(next: CollectorState): void {
    state = next;
    for (const listener of listeners) listener();
  }

  async function poll(): Promise<void> {
    // A slow poll is never joined by a second one.
    if (inFlight) return;
    inFlight = true;
    try {
      const since = state.events[0]?.at ?? 0;
      const askedAt = now();
      const wholeHour =
        hourCurrentAt === null || askedAt - hourCurrentAt > HISTORY_WINDOW_MS - STALE_AFTER_MS;
      const [sessions, events, history] = await Promise.allSettled([
        getJson("/api/sessions").then(parseSnapshot),
        getJson(`/api/events?since=${since}`).then(parseEvents),
        getJson(`/api/history?windowMs=${wholeHour ? HISTORY_KEPT_MS : HISTORY_WINDOW_MS}`).then(
          parseHistory,
        ),
      ]);

      let next: CollectorState = state;

      if (history.status === "fulfilled") {
        // A new start time means the collector restarted. Its event ids start
        // again, so the old list is dropped rather than merged into.
        const restarted =
          state.history !== null && state.history.startedAt !== history.value.startedAt;
        let held: CollectorHistory;
        if (wholeHour) {
          held = history.value;
          hourCurrentAt = askedAt;
        } else if (restarted || state.history === null) {
          // These 15 minutes are all there is of the new collector for now. The
          // hour is asked for on the next beat, in case it has run for longer.
          held = history.value;
          hourCurrentAt = null;
        } else {
          held = mergeHistory(state.history, history.value);
          hourCurrentAt = askedAt;
        }
        const oldest = now() - HISTORY_KEPT_MS - HISTORY_SLACK_MS;
        next = {
          ...next,
          history: {
            startedAt: held.startedAt,
            points: held.points.filter((point) => point.at >= oldest),
          },
          events: restarted ? [] : next.events,
        };
      }
      if (events.status === "fulfilled") {
        next = { ...next, events: mergeEvents(next.events, events.value) };
      }

      if (sessions.status === "fulfilled") {
        failures = 0;
        next = {
          ...next,
          phase: "live",
          snapshot: sessions.value,
          lastOkAt: now(),
          problem: null,
          problemKind: null,
        };
      } else {
        failures += 1;
        const reason: unknown = sessions.reason;
        const known = reason instanceof ApiProblem ? reason : null;
        const problem = known?.message ?? "The local server did not answer.";
        const problemKind = known?.kind ?? "no-answer";
        let phase: CollectorPhase;
        if (next.snapshot !== null && next.lastOkAt !== null) {
          phase = now() - next.lastOkAt > STALE_AFTER_MS ? "stalled" : next.phase;
        } else {
          phase = failures >= FAILURES_BEFORE_UNREACHABLE ? "unreachable" : "connecting";
        }
        next = { ...next, phase, problem, problemKind };
      }

      setState(next);
    } finally {
      inFlight = false;
    }
  }

  function start(): void {
    if (stopBeat !== null) return;
    void poll();
    stopBeat = beat(() => void poll(), intervalMs);
  }

  function stop(): void {
    if (stopBeat === null) return;
    stopBeat();
    stopBeat = null;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    getState: () => state,
    refresh: () => void poll(),
  };
}
