import type { RuleAnswer } from "@core/api";
import {
  COMMAND_TOOL,
  EVERY_TOOL,
  ruleProblem,
  ruleText,
  type RuleDecision,
  type RuleWords,
} from "@core/permission-rules/permissionRules";

/**
 * What the Permission rules card in Settings says, and how it reads what the
 * person types. The collector checks every rule again: these are only there
 * to help.
 */

/** Each decision's word, on its switch and on each rule. */
export const DECISION_LABEL: Record<RuleDecision, string> = {
  allow: "Allow",
  ask: "Ask",
  deny: "Deny",
};

/** What each decision does, in one plain sentence under its switch. */
export const DECISION_SENTENCE: Record<RuleDecision, string> = {
  allow:
    "Allow: Claude Code runs it without asking you. Only what you could allow here by hand, and for Bash one plain command.",
  ask: "Ask: the prompt waits for you, even when an allow rule matches it too.",
  deny: "Deny: Claude Code is told no, and carries on without it.",
};

/**
 * What the decision the form holds does, under its switch: the decision's
 * sentence, and for an allow rule for a tool that is not Bash, one such a
 * rule can name, that it allows every request of that tool, whatever it
 * asks, since only Bash's rules name what is asked.
 */
export function decisionSentence(form: RuleForm): string {
  const sentence = DECISION_SENTENCE[form.decision];
  const tool = form.tool.trim();
  if (form.decision !== "allow" || tool === COMMAND_TOOL) return sentence;
  if (ruleProblem({ decision: "allow", tool }) !== null) return sentence;
  return `${sentence} A rule for ${tool} allows every ${tool} request, whatever it asks for.`;
}

/** What the person typed, as the form holds it. */
export interface RuleForm {
  decision: RuleDecision;
  tool: string;
  command: string;
}

/** A form with nothing typed: an allow rule, which is the one asked for most. */
export const EMPTY_FORM: RuleForm = { decision: "allow", tool: "", command: "" };

/** The form for a rule that is there, to edit it. */
export function formOf(rule: RuleWords): RuleForm {
  return { decision: rule.decision, tool: rule.tool, command: rule.command ?? "" };
}

/** What the form says, as a rule's words: the tool with its spaces trimmed, and an empty command none. */
export function wordsOf(form: RuleForm): RuleWords {
  const tool = form.tool.trim();
  const command = form.command.trim();
  return { decision: form.decision, tool, ...(command !== "" && { command }) };
}

/** The rule the form makes, or the sentence that says why it makes none: the same the app refuses by. */
export function readForm(
  form: RuleForm,
): { ok: true; words: RuleWords } | { ok: false; problem: string } {
  const words = wordsOf(form);
  const problem = ruleProblem(words);
  return problem === null ? { ok: true, words } : { ok: false, problem };
}

/** A rule in words for assistive technology and a tooltip: "Allow Bash(npm test:*)", "Deny every tool". */
export function ruleName(rule: RuleWords): string {
  return `${DECISION_LABEL[rule.decision]} ${ruleText(rule) ?? "every tool"}`;
}

/** Whether a rule is for every tool, which is said in words rather than as `*`. */
export function forEveryTool(rule: Pick<RuleWords, "tool">): boolean {
  return rule.tool === EVERY_TOOL;
}

/**
 * The words of a request a rule answered, before the rule: "Allowed Bash by
 * the rule", or "Denied Write by the rule for every tool".
 */
export function answerLead(answer: Pick<RuleAnswer, "decision" | "tool" | "rule">): string {
  const done = answer.decision === "deny" ? "Denied" : "Allowed";
  const lead = `${done} ${answer.tool} by the rule`;
  return forEveryTool(answer.rule) ? `${lead} for every tool` : lead;
}
