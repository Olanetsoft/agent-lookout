import { useCallback, useEffect, useRef, useState } from "react";

import type { SettingsResponse } from "@core/api";
import {
  requestRulesChange,
  type RulesChangeAsked,
} from "@dashboard/lib/permission-rules/permissionRulesApi";
import { fetchSettings } from "@dashboard/lib/time-rules/timeRulesApi";

/** The app's answer, "unknown" when it did not give one, or null before the first. */
export type PermissionRulesReading = SettingsResponse | "unknown" | null;

/** How often Settings reads the rules and their answers again while it shows them. */
export const PERMISSION_RULES_REFRESH_MS = 5_000;

/** Said when the app did not answer a change at all. */
export const RULES_NOT_ANSWERED = "Agent Lookout did not answer, so nothing changed.";

/** What a change came to: taken, or not, with why in the app's words or the page's own. */
export type RulesChangeTaken = { taken: true } | { taken: false; problem: string };

/**
 * Where a change was asked from: a rule's own buttons in the list, whose
 * refusal the card's note says, or the form, which says it under its own
 * buttons, where the person is looking.
 */
export type RulesChangeFrom = "list" | "form";

export interface PermissionRulesSetting {
  reading: PermissionRulesReading;
  /**
   * Why the last change asked from the list was not taken, in the app's
   * words, or a sentence of the page's own when the app did not answer. Null
   * after any change that was taken.
   */
  refused: string | null;
  /** Asks the app for one change. Resolves to what came of it. Changes go one at a time, in order. */
  change: (change: RulesChangeAsked, from?: RulesChangeFrom) => Promise<RulesChangeTaken>;
}

/**
 * The permission rules as the app keeps them, with the requests they
 * answered, read when the card mounts and every few seconds while it stays,
 * and the change that saves new ones. The card shows the app's answer, so a
 * change the app did not take does not look taken. A reading that arrives
 * while a change is on its way is passed over, so the list never jumps back.
 */
export function usePermissionRules(): PermissionRulesSetting {
  const [reading, setReading] = useState<PermissionRulesReading>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const mounted = useRef(true);
  /** How many changes are asked for and not yet answered. */
  const pending = useRef(0);
  /** The changes go one after another. */
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    mounted.current = true;
    const read = () => {
      void fetchSettings().then((answer) => {
        if (!mounted.current || pending.current > 0) return;
        // A reading that fails after one that worked keeps what was read.
        setReading((was) => answer ?? (was !== null && was !== "unknown" ? was : "unknown"));
      });
    };
    read();
    const timer = setInterval(read, PERMISSION_RULES_REFRESH_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, []);

  const change = useCallback(
    (asked: RulesChangeAsked, from: RulesChangeFrom = "list"): Promise<RulesChangeTaken> => {
      pending.current += 1;
      const done = queue.current.then(async (): Promise<RulesChangeTaken> => {
        try {
          const outcome = await requestRulesChange(asked);
          if (outcome.ok) {
            if (!mounted.current) return { taken: true };
            setRefused(null);
            setReading((was) =>
              was !== null && was !== "unknown"
                ? { ...was, permissionRules: outcome.rules, permissionRulesProblem: null }
                : was,
            );
            return { taken: true };
          }
          const problem = outcome.error ?? RULES_NOT_ANSWERED;
          if (mounted.current && from === "list") setRefused(problem);
          return { taken: false, problem };
        } finally {
          pending.current -= 1;
        }
      });
      queue.current = done;
      return done;
    },
    [],
  );

  return { reading, refused, change };
}
