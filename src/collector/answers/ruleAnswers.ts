import { MAX_RULE_ANSWERS, type RuleAnswer } from "../../core/api.ts";
import type { PermissionRule } from "../../core/permission-rules/permissionRules.ts";
import { decideByRules, type RuleVerdict } from "../../core/permission-rules/ruleDecision.ts";
import type { AnswerDecision, Session, SessionEvent } from "../../core/sessions/session.ts";
import type { EventStore } from "../eventStore.ts";
import type { Poller } from "../poller.ts";
import type { HookRequest } from "./heldAsks.ts";

/**
 * The permission rules, applied to the requests Agent Lookout holds, and the
 * record of what they answered.
 *
 * A held request is put to the rules once the session's registry file has
 * said it waits for permission, the moment it would be shown on the dashboard
 * (`heldAsks.ts`). When a deny or an allow rule decides it, it is answered at
 * once through the same path as a press of Deny or Allow, which reads the
 * registry file again, answers only in the same wait, allows only what the
 * person could allow by hand, and writes only one of the two fixed outputs.
 * An ask rule, and no rule, leave it for the person, as before there were
 * rules.
 *
 * Each answer is one event in the Events log, as a press is, with the tool
 * and the rule, and one line in the list of the last 100 kept in memory for
 * Settings. Neither holds the command or anything else of what was asked.
 */
export interface RuleAnswers {
  /** The rule that answers a held request now, allow or deny, or null to leave it to the person. */
  verdictFor(request: HookRequest): AutoAnswer | null;
  /** Records a request a rule answered: an event, and a line in the list. */
  answered(request: HookRequest, verdict: AutoAnswer): void;
  /** The requests the rules answered since Agent Lookout started, newest first, 100 at most. */
  recent(): RuleAnswer[];
}

/** A verdict that answers: allow or deny, and the rule that gave it. */
export interface AutoAnswer extends RuleVerdict {
  decision: AnswerDecision;
}

export interface RuleAnswersOptions {
  /** The rules in force, read again for each request. */
  rules: () => readonly PermissionRule[];
  /** Agent Lookout's own settings file and socket, which no command a rule allows may name. */
  ownPaths?: readonly string[];
  poller: Pick<Poller, "getSnapshot" | "pollOnce">;
  events: Pick<EventStore, "add">;
  now?: () => number;
}

/** The event that says a rule answered a request: the tool and the rule, and nothing of what was asked. */
export function ruleAnsweredEvent(
  session: Pick<Session, "id" | "name" | "status"> | null,
  sessionId: string,
  tool: string,
  verdict: AutoAnswer,
  at: number,
): SessionEvent {
  const { rule } = verdict;
  return {
    id: `${sessionId}@${at}:answered`,
    at,
    sessionId,
    sessionName: session?.name ?? sessionId,
    kind: "answered",
    ...(session && { from: session.status }),
    severity: "advisory",
    by: "agent-lookout",
    decision: verdict.decision,
    tool,
    rule: { tool: rule.tool, ...(rule.command !== undefined && { command: rule.command }) },
  };
}

export function createRuleAnswers(options: RuleAnswersOptions): RuleAnswers {
  const { poller, events } = options;
  const now = options.now ?? Date.now;
  /** Newest first. */
  let recent: RuleAnswer[] = [];

  return {
    verdictFor({ shown }) {
      const rules = options.rules();
      if (rules.length === 0) return null;
      const verdict = decideByRules(rules, {
        tool: shown.tool,
        ...(shown.command !== undefined && { command: shown.command }),
        inputNames:
          shown.command === undefined ? [] : (shown.inputs ?? []).map((input) => input.name),
        // The one rule for what may be allowed: what the dashboard would offer Allow for.
        allowable: shown.allow,
        ownPaths: options.ownPaths ?? [],
      });
      if (verdict === null || verdict.decision === "ask") return null;
      return { decision: verdict.decision, rule: verdict.rule };
    },

    answered({ sessionId, shown }, verdict) {
      const at = now();
      const session =
        poller.getSnapshot().sessions.find((listed) => listed.id === sessionId) ?? null;
      const event = ruleAnsweredEvent(session, sessionId, shown.tool, verdict, at);
      events.add([event]);
      const { id: _id, ...rule } = verdict.rule;
      recent = [
        {
          at,
          sessionId,
          sessionName: event.sessionName,
          tool: shown.tool,
          decision: verdict.decision,
          rule,
        },
        ...recent,
      ].slice(0, MAX_RULE_ANSWERS);
      // The page's next request finds the session moving on, as after a press.
      void poller.pollOnce().catch(() => {});
    },

    recent: () => [...recent],
  };
}
