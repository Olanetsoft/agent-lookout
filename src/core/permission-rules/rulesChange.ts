import {
  isRuleId,
  MAX_RULES,
  ruleWordsIn,
  sameWords,
  type PermissionRule,
  type RuleWords,
} from "./permissionRules.ts";

/**
 * One change to the list of permission rules, as the Permission rules card
 * in Settings asks for it, and what it makes of the list. Pure.
 *
 * Each change names one rule by its id, so a change asked from a page that
 * shows an older list moves, edits or removes the rule it showed, or nothing:
 *
 *     {"add": {"decision": "allow", "tool": "Bash", "command": "npm test:*"}}
 *     {"edit": {"id": "…", "decision": "deny", "tool": "WebFetch"}}
 *     {"move": {"id": "…", "to": "up"}}
 *     {"remove": {"id": "…"}}
 *
 * A new rule goes to the end of the list.
 */
export type RulesChange =
  | { kind: "add"; words: RuleWords }
  | { kind: "edit"; id: string; words: RuleWords }
  | { kind: "move"; id: string; to: "up" | "down" }
  | { kind: "remove"; id: string };

/** The sentence that refuses a body that is not one change. */
export const CHANGE_SHAPE =
  'The body must be one change: {"add": rule}, {"edit": rule with its "id"}, {"move": {"id", "to": "up" or "down"}} or {"remove": {"id"}}, and nothing else.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The change a body asks for, read strictly, or the sentence that says why it is none. */
export function rulesChangeIn(
  value: unknown,
): { ok: true; change: RulesChange } | { ok: false; problem: string } {
  const refused = { ok: false, problem: CHANGE_SHAPE } as const;
  if (!isRecord(value) || Object.keys(value).length !== 1) return refused;
  const [kind] = Object.keys(value) as [string];
  const body = value[kind];
  if (!isRecord(body)) return refused;
  switch (kind) {
    case "add": {
      const read = ruleWordsIn(body);
      return read.ok ? { ok: true, change: { kind, words: read.words } } : read;
    }
    case "edit": {
      const { id, ...words } = body;
      if (!isRuleId(id)) return refused;
      const read = ruleWordsIn(words);
      return read.ok ? { ok: true, change: { kind, id, words: read.words } } : read;
    }
    case "move": {
      const { id, to } = body;
      if (Object.keys(body).length !== 2 || !isRuleId(id)) return refused;
      if (to !== "up" && to !== "down") return refused;
      return { ok: true, change: { kind, id, to } };
    }
    case "remove": {
      const { id } = body;
      if (Object.keys(body).length !== 1 || !isRuleId(id)) return refused;
      return { ok: true, change: { kind, id } };
    }
    default:
      return refused;
  }
}

/**
 * Why a change could not be made to the list:
 *
 * no-rule    the list holds no rule of that id: it was removed, perhaps in another tab
 * full       the list holds 100 rules already
 * duplicate  the list holds a rule that says the same already
 */
export type RulesChangeRefusal = "no-rule" | "full" | "duplicate";

export type RulesChangeResult =
  | { ok: true; rules: PermissionRule[]; changed: boolean }
  | { ok: false; reason: RulesChangeRefusal; problem: string };

const NO_RULE = {
  ok: false,
  reason: "no-rule",
  problem: "The list holds no such rule. It may have been changed in another tab.",
} as const;

const DUPLICATE = {
  ok: false,
  reason: "duplicate",
  problem: "The list holds that rule already.",
} as const;

/** The list once the change is made, or why it cannot be. `newId` names a rule that is added. */
export function applyRulesChange(
  rules: readonly PermissionRule[],
  change: RulesChange,
  newId: () => string,
): RulesChangeResult {
  if (change.kind === "add") {
    if (rules.length >= MAX_RULES) {
      return {
        ok: false,
        reason: "full",
        problem: `The list holds ${MAX_RULES} rules, the most it can. Remove one to add another.`,
      };
    }
    if (rules.some((rule) => sameWords(rule, change.words))) return DUPLICATE;
    let id = newId();
    while (rules.some((rule) => rule.id === id)) id = newId();
    return { ok: true, rules: [...rules, { id, ...change.words }], changed: true };
  }

  const at = rules.findIndex((rule) => rule.id === change.id);
  if (at < 0) return NO_RULE;
  const rule = rules[at] as PermissionRule;

  if (change.kind === "remove") {
    return { ok: true, rules: rules.filter((_, index) => index !== at), changed: true };
  }
  if (change.kind === "edit") {
    if (sameWords(rule, change.words)) return { ok: true, rules: [...rules], changed: false };
    if (rules.some((other) => other.id !== rule.id && sameWords(other, change.words))) {
      return DUPLICATE;
    }
    const next = [...rules];
    next[at] = { id: rule.id, ...change.words };
    return { ok: true, rules: next, changed: true };
  }

  const to = change.to === "up" ? at - 1 : at + 1;
  if (to < 0 || to >= rules.length) return { ok: true, rules: [...rules], changed: false };
  const next = [...rules];
  next[at] = next[to] as PermissionRule;
  next[to] = rule;
  return { ok: true, rules: next, changed: true };
}
