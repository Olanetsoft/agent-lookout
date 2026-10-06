import type { PermissionRule } from "@core/permission-rules/permissionRules";
import type { AnswerDecision } from "@core/sessions/session";
import { DEFAULT_TIME_RULES, type TimeRules } from "@core/time-rules/timeRules";
import type { CollectorState, CollectorStore } from "@dashboard/lib/api/collectorStore";
import { HISTORY_KEPT_MS } from "@dashboard/lib/api/collectorStore";
import type { Feed, Shown, StoppedSession } from "@site-tour/feed/derive";
import type { MomentName } from "@site-tour/feed/hour";

/**
 * The store the landing page's dashboard is given in place of the one that
 * polls the collector.
 *
 * What it holds is worked out from the moment of the hour the tour is on and
 * the present, and from nothing else, so showing a moment again shows it as it
 * was. It is worked out again every two seconds, as the real store polls, so
 * the history and the times of the last check move on as they do in the app,
 * and it holds still while the clock does.
 *
 * The one thing the visit decides is when the wait is answered: when the tour
 * moves on from it. So the log says the wait lasted as long as the visitor saw
 * it last, and a wait never seen was answered as the hour ended.
 *
 * A scene says whether pull requests are on. A session the visitor stops is
 * gone from the list until the tour moves to another moment, as a clearing of
 * the history is, and so are the time rules and the permission rules the
 * visitor sets. A wait the visitor answers with Allow or Deny is answered
 * then, and the log says Agent Lookout answered it.
 */

export interface TourStore extends CollectorStore {
  /** The moment shown. */
  moment(): MomentName;
  /** The moment shown, with when the wait was answered. */
  shown(): Shown;
  /** Moves to a moment, and forgets a clearing of the history. */
  show(moment: MomentName): void;
  /** When the wait was last left, in epoch milliseconds, or null when it has not been shown. */
  waitLeftAt(): number | null;
  /** Back to the start of the visit: the quiet moment, no wait seen and nothing cleared. */
  restart(): void;
  /** When the history was cleared, or null when it was not. */
  clearedAt(): number | null;
  /** Clears the Events log and the history, as of now. */
  clear(at: number): void;
  /** Pull requests on or off, as a scene has them. */
  setPullRequests(on: boolean): void;
  /** Takes stopped sessions out of the list, as of `at`. */
  stop(sessions: readonly Omit<StoppedSession, "at">[], at: number): void;
  /** Answers the wait with what the visitor pressed, as of `at`. False when nothing is waiting. */
  answer(decision: AnswerDecision, at: number): boolean;
  /** The time rules in force. */
  timeRules(): TimeRules;
  /** Puts the time rules the visitor set in force. */
  setTimeRules(rules: TimeRules): void;
  /** The permission rules the visitor set, in their order. None unless they set some. */
  permissionRules(): PermissionRule[];
  /** Keeps the permission rules the visitor set. */
  setPermissionRules(rules: readonly PermissionRule[]): void;
  readonly feed: Feed;
}

export interface TourStoreOptions {
  feed: Feed;
  now: () => number;
  /** Whether the clock is held, which holds the store too. */
  held?: () => boolean;
  beatMs?: number;
}

export function createTourStore({
  feed,
  now,
  held = () => false,
  beatMs = 2_000,
}: TourStoreOptions): TourStore {
  const listeners = new Set<() => void>();
  let moment: MomentName = "quiet";
  let cleared: number | null = null;
  let leftWait: number | null = null;
  let pullRequests = true;
  let stopped: StoppedSession[] = [];
  let decision: AnswerDecision | null = null;
  let rules: TimeRules | null = null;
  let permissionRules: PermissionRule[] | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  function shown(): Shown {
    return {
      ...(moment === "answered" ? { moment, answeredAt: leftWait } : { moment }),
      ...(!pullRequests && { pullRequests }),
      ...(stopped.length > 0 && { stopped }),
      ...(moment === "answered" && decision !== null && { decision }),
      ...(rules !== null && { timeRules: rules }),
    };
  }

  /** Forgets what the visitor did to the moment shown. */
  function forget(): void {
    cleared = null;
    stopped = [];
    decision = null;
    rules = null;
    permissionRules = null;
  }

  function derive(): CollectorState {
    const at = now();
    const where = shown();
    return {
      phase: "live",
      snapshot: feed.snapshot(where, at),
      events: feed.events(where, cleared),
      history: feed.history(where, at, HISTORY_KEPT_MS, cleared),
      lastOkAt: at,
      problem: null,
      problemKind: null,
    };
  }

  let state = derive();

  function emit(): void {
    state = derive();
    for (const listener of listeners) listener();
  }

  return {
    feed,
    subscribe(listener) {
      listeners.add(listener);
      timer ??= setInterval(() => {
        if (!held()) emit();
      }, beatMs);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    getState: () => state,
    refresh: emit,
    moment: () => moment,
    shown,
    show(next) {
      if (
        next === moment &&
        cleared === null &&
        stopped.length === 0 &&
        rules === null &&
        permissionRules === null
      ) {
        return;
      }
      // Moving on from the wait answers it, now.
      if (moment === "waiting" && next !== "waiting") leftWait = now();
      moment = next;
      forget();
      emit();
    },
    waitLeftAt: () => leftWait,
    restart() {
      moment = "quiet";
      leftWait = null;
      pullRequests = true;
      forget();
      emit();
    },
    clearedAt: () => cleared,
    clear(at) {
      cleared = at;
      emit();
    },
    setPullRequests(on) {
      if (on === pullRequests) return;
      pullRequests = on;
      emit();
    },
    stop(sessions, at) {
      const known = new Set(stopped.map((one) => one.id));
      const added = sessions.filter((one) => !known.has(one.id));
      if (added.length === 0) return;
      stopped = [...stopped, ...added.map(({ id, name, status }) => ({ id, name, status, at }))];
      emit();
    },
    answer(pressed, at) {
      if (moment !== "waiting") return false;
      leftWait = at;
      moment = "answered";
      decision = pressed;
      emit();
      return true;
    },
    timeRules: () => rules ?? DEFAULT_TIME_RULES,
    setTimeRules(next) {
      rules = next;
      emit();
    },
    permissionRules: () => [...(permissionRules ?? [])],
    setPermissionRules(next) {
      // The sessions do not show the permission rules, so nothing is drawn again.
      permissionRules = [...next];
    },
  };
}
