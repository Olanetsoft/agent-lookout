import { useCallback, useEffect, useRef, useState } from "react";

import type { SettingsResponse } from "@core/api";
import type { TimeRules } from "@core/time-rules/timeRules";
import { fetchSettings, requestTimeRules } from "@dashboard/lib/time-rules/timeRulesApi";

/** The app's answer, "unknown" when it did not give one, or null before the first. */
export type TimeRulesReading = SettingsResponse | "unknown" | null;

/** The rules a snapshot was made by, and when the app made it, by its clock. */
export interface RulesInForce {
  timeRules: TimeRules;
  generatedAt: number;
}

export interface TimeRulesSetting {
  reading: TimeRulesReading;
  /**
   * Why the last change was not taken, in the app's words, or a sentence of
   * the page's own when the app did not answer. Null after one that was.
   */
  refused: string | null;
  /**
   * Asks the app to put in force the rules `update` makes. Changes go one at
   * a time, in order, and each is made, when its turn comes, of the rules the
   * app last answered with, so one the app refused is never sent again with
   * the change after it.
   */
  change: (update: (rules: TimeRules) => TimeRules) => void;
}

/** Said when the app did not answer a change at all. */
export const NOT_ANSWERED = "Agent Lookout did not answer, so nothing changed.";

const same = (a: TimeRules, b: TimeRules) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The time rules as the app keeps them, read once when the card mounts, then
 * followed in the snapshots the page reads, so rules changed in another tab
 * show here too, and the change that saves new ones. The card shows the app's
 * answer, so a change the app did not take does not look taken. `onChanged`
 * is told once one was, so the page can read the sessions again at once.
 *
 * A snapshot made before the app last answered may hold the rules from before
 * that answer, so the rules of one are taken only when it was made after it,
 * and never while a change is on its way.
 */
export function useTimeRules(
  onChanged?: () => void,
  inForce?: RulesInForce | null,
): TimeRulesSetting {
  const [reading, setReading] = useState<TimeRulesReading>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const mounted = useRef(true);
  const told = useRef(onChanged);
  /** The rules as they will be once every change asked for is taken: what a change asked twice is told by. */
  const latest = useRef<TimeRules | null>(null);
  /** The rules the app last answered with. Each change is made of these when its turn comes. */
  const answered = useRef<TimeRules | null>(null);
  /** When the app last answered, by this page's clock. */
  const answeredAt = useRef(0);
  /** How many changes are asked for and not yet answered. */
  const pending = useRef(0);
  /** The changes go one after another. */
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    told.current = onChanged;
  });

  useEffect(() => {
    mounted.current = true;
    void fetchSettings().then((answer) => {
      if (!mounted.current) return;
      setReading(answer ?? "unknown");
      if (answer) {
        latest.current = answer.timeRules;
        answered.current = answer.timeRules;
        answeredAt.current = Date.now();
      }
    });
    return () => {
      mounted.current = false;
    };
  }, []);

  const followed = inForce?.timeRules;
  const followedAt = inForce?.generatedAt;
  useEffect(() => {
    if (followed === undefined || followedAt === undefined) return;
    if (answered.current === null || pending.current > 0) return;
    if (followedAt <= answeredAt.current || same(followed, answered.current)) return;
    answered.current = followed;
    latest.current = followed;
    setReading((was) =>
      was !== null && was !== "unknown" ? { ...was, timeRules: followed } : was,
    );
  }, [followed, followedAt]);

  const change = useCallback((update: (rules: TimeRules) => TimeRules) => {
    if (latest.current === null) return;
    const expected = update(latest.current);
    // The same change asked for twice, as a switch does when a press also moves
    // focus to the option, is sent once.
    if (same(expected, latest.current)) return;
    latest.current = expected;
    pending.current += 1;
    queue.current = queue.current.then(async () => {
      try {
        const from = answered.current;
        if (!mounted.current || from === null) return;
        const next = update(from);
        if (same(next, from)) return;
        const outcome = await requestTimeRules(next);
        if (!mounted.current) return;
        answeredAt.current = Date.now();
        if (outcome.ok) {
          answered.current = outcome.rules;
          setRefused(null);
          setReading((was) =>
            was !== null && was !== "unknown"
              ? { ...was, timeRules: outcome.rules, problem: null }
              : was,
          );
          told.current?.();
        } else {
          setRefused(outcome.error ?? NOT_ANSWERED);
        }
      } finally {
        pending.current -= 1;
        // With nothing more on its way, what follows is made of what the app holds.
        if (pending.current === 0 && answered.current !== null) latest.current = answered.current;
      }
    });
  }, []);

  return { reading, refused, change };
}
