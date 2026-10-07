import {
  looseCommandWords,
  looselyMatches,
  plainCommandWords,
  ruleCommandOf,
  wordsMatch,
} from "./commandWords.ts";
import {
  COMMAND_TOOL,
  EVERY_TOOL,
  isServerName,
  MCP_SEPARATOR,
  type PermissionRule,
  type RuleDecision,
} from "./permissionRules.ts";

/**
 * Which rule, if any, decides a permission request. Pure.
 *
 * Deny goes first, then ask, then allow, as Claude Code's own permission
 * rules do: a deny rule that matches wins over any other, and an ask rule
 * over an allow rule, however much narrower the allow rule is. Of the rules
 * of one kind, the first in the list is the one named. No rule matching is no
 * decision, and the request waits for the person as it would with no rules.
 *
 * A deny or an ask rule only holds a request back, so it may match loosely:
 * a rule for a tool matches every request of that tool, a rule for an MCP
 * server alone, `mcp__docs`, every tool of that server, as in Claude Code's
 * own rules, and a rule for a command matches when any command in the line
 * has its words, read loosely (`looselyMatches`): the program by its name
 * whatever its capitals and folder, the other words in order with any words
 * between them. An allow rule matches only:
 *
 * - a request the person could allow by hand on the dashboard right now:
 *   `allowable`, which is the request's own `allow`, worked out by
 *   `shownAsk` in the collector, the one rule for it;
 * - for Bash, one plain command (`plainCommandWords`) whose words are the
 *   rule's, with no other input but `timeout` and `run_in_background`, which
 *   do not change what runs. Any other, such as one that would run it outside
 *   Claude Code's sandbox, leaves it to the person.
 *
 * An allow rule for every tool, or for Bash with no command, never matches,
 * should a file hold one: the rules refuse such a rule when it is written.
 */

/** A request, as much of it as the rules read. */
export interface RuleRequest {
  tool: string;
  /** For Bash: the whole command, as shown. */
  command?: string;
  /** For Bash: the names of its other inputs, such as `run_in_background`. */
  inputNames: readonly string[];
  /** Whether the person could allow it by hand on the dashboard now. */
  allowable: boolean;
}

/** The decision, and the rule that made it. */
export interface RuleVerdict {
  decision: RuleDecision;
  rule: PermissionRule;
}

/** The other inputs of a Bash request an allow rule may answer: they change nothing of what runs. */
export const INPUTS_AN_ALLOW_RULE_TAKES: readonly string[] = ["timeout", "run_in_background"];

/** The order the kinds of rule are tried in. */
const ORDER: readonly RuleDecision[] = ["deny", "ask", "allow"];

/** Whether a deny or an ask rule names the request's tool: that tool, every tool, or its MCP server. */
function toolMatches(rule: PermissionRule, request: RuleRequest): boolean {
  if (rule.tool === EVERY_TOOL || rule.tool === request.tool) return true;
  return isServerName(rule.tool) && request.tool.startsWith(`${rule.tool}${MCP_SEPARATOR}`);
}

/** Whether a deny or an ask rule takes the request: loosely, by the words of any command in it. */
function holdsBack(rule: PermissionRule, request: RuleRequest): boolean {
  if (!toolMatches(rule, request)) return false;
  if (rule.command === undefined) return true;
  if (request.tool !== COMMAND_TOOL || request.command === undefined) return false;
  const wanted = ruleCommandOf(rule.command);
  return looseCommandWords(request.command).some((words) => looselyMatches(wanted, words));
}

/**
 * Whether an allow rule takes the request: strictly, and only what could be
 * allowed by hand. Its tool is the request's own: an MCP server alone never
 * allows, should a file hold such a rule.
 */
function lets(rule: PermissionRule, request: RuleRequest): boolean {
  if (!request.allowable || rule.tool === EVERY_TOOL || isServerName(rule.tool)) return false;
  if (rule.tool !== request.tool) return false;
  if (request.tool !== COMMAND_TOOL) return rule.command === undefined;
  if (rule.command === undefined || request.command === undefined) return false;
  if (!request.inputNames.every((name) => INPUTS_AN_ALLOW_RULE_TAKES.includes(name))) return false;
  const words = plainCommandWords(request.command);
  return words !== null && wordsMatch(ruleCommandOf(rule.command), words);
}

/** The rule that decides the request, deny first, then ask, then allow, or null when none does. */
export function decideByRules(
  rules: readonly PermissionRule[],
  request: RuleRequest,
): RuleVerdict | null {
  for (const decision of ORDER) {
    const matches = decision === "allow" ? lets : holdsBack;
    const rule = rules.find(
      (candidate) => candidate.decision === decision && matches(candidate, request),
    );
    if (rule !== undefined) return { decision, rule };
  }
  return null;
}
