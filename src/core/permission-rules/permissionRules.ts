import { EDIT_TOOLS, NOT_YES_OR_NO_TOOLS } from "../sessions/session.ts";
import {
  ASSIGNMENT,
  plainCommandWords,
  PREFIX_MARK,
  runsAnotherCommand,
  sendsOrRunsCode,
} from "./commandWords.ts";

/**
 * The permission rules: an ordered list the person keeps in Settings, each
 * saying what Agent Lookout does with a Claude Code permission request that
 * matches it. Pure.
 *
 * - `allow`: Agent Lookout allows it at once, so Claude Code runs it without
 *   asking the person, and only when the person could allow it by hand on the
 *   dashboard right then, and, for Bash, only one plain command
 *   (`commandWords.ts`). An allow rule names one tool: never every tool, an
 *   MCP server's every tool, Bash with no command, a command that begins
 *   with a program that runs another, such as `sudo` or `bash`
 *   (`COMMAND_RUNNERS`), or one that begins with a program that sends
 *   requests or runs the code it is given, such as `curl` or `python`, which
 *   could reach Agent Lookout itself (`NETWORK_CLIENTS_AND_INTERPRETERS`).
 * - `ask`: the prompt waits for the person, as with no rule, even when an
 *   allow rule matches too.
 * - `deny`: Agent Lookout denies it at once.
 *
 * Deny goes first, then ask, then allow, as Claude Code's own rules do, and of
 * the rules of one kind the first in the list is the one that decides
 * (`ruleDecision.ts`). With no rule, nothing is answered on its own.
 *
 * A rule names a tool as Claude Code names it, such as `Bash`, `WebFetch` or
 * `mcp__docs__search`, or every tool with `*`, and for Bash a command: one
 * exactly, `npm test`, or every command beginning with some words, written as
 * Claude Code writes one, `npm test:*`. A deny or an ask rule may name an MCP
 * server alone, `mcp__docs`, for every tool of that server, as Claude Code's
 * own rules do; an allow rule names one tool.
 */

/** What a rule does with a request it matches. */
export const RULE_DECISIONS = ["allow", "ask", "deny"] as const;

export type RuleDecision = (typeof RULE_DECISIONS)[number];

/** A rule as the list keeps it. */
export interface PermissionRule {
  /** The list's own name for the rule, which Agent Lookout gives it when it is added. */
  id: string;
  decision: RuleDecision;
  /** A tool's name as Claude Code gives it, or `*` for every tool. */
  tool: string;
  /** For Bash only: a command, `npm test`, or a prefix, `npm test:*`. Left out, every command. */
  command?: string;
}

/** What a rule says, without its id: what the person writes. */
export type RuleWords = Omit<PermissionRule, "id">;

/** The tool a rule names to match every tool. */
export const EVERY_TOOL = "*";

/** The one tool whose rules can name a command. */
export const COMMAND_TOOL = "Bash";

/** What begins the name of a tool an MCP server gives, `mcp__docs__search`, and parts server and tool. */
export const MCP_PREFIX = "mcp__";
export const MCP_SEPARATOR = "__";

/**
 * Whether a tool's name is an MCP server's alone, `mcp__docs`, which Claude
 * Code's own rules read as every tool of that server, rather than one tool,
 * `mcp__docs__search`.
 */
export function isServerName(tool: string): boolean {
  if (!tool.startsWith(MCP_PREFIX)) return false;
  const server = tool.slice(MCP_PREFIX.length);
  return server !== "" && !server.includes(MCP_SEPARATOR);
}

/** The most rules the list holds. */
export const MAX_RULES = 100;

/** The longest tool name a rule takes. */
export const MAX_RULE_TOOL_CHARS = 128;

/** The longest command a rule takes. */
export const MAX_RULE_COMMAND_CHARS = 200;

/**
 * A tool's name as Claude Code writes them: a letter, then letters, digits,
 * underscores and dashes, as in `Bash`, `WebFetch` and `mcp__docs__search`.
 */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** A rule's id: letters, digits and dashes. Agent Lookout makes twelve hexadecimal digits. */
const RULE_ID = /^[A-Za-z0-9-]{1,40}$/;

/** Plain ASCII words separated by single spaces, nothing at either end. */
const ASCII_WORDS = /^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/;

/**
 * A character a rule's command may not hold at all: one that joins commands,
 * redirects, quotes, starts an expansion or a group, or a wildcard.
 */
const NOT_IN_A_RULE = /[;&|<>()`'"\\{}$*]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether an object holds exactly these keys, each of them, and the optional ones if any. */
function holdsOnly(
  value: Record<string, unknown>,
  keys: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const there = Object.keys(value);
  return (
    keys.every((key) => there.includes(key)) &&
    there.every((key) => keys.includes(key) || optional.includes(key))
  );
}

/** The sentence that says what is wrong with a tool's name, or null when it is one. */
function toolProblem(tool: string): string | null {
  if (tool === EVERY_TOOL) return null;
  if (tool === "") return "Name a tool, such as Bash or WebFetch, or * for every tool.";
  if (tool.includes("(")) {
    return "Write the tool's name alone, such as Bash, and the command in its own field.";
  }
  if (tool !== COMMAND_TOOL && tool.toLowerCase() === COMMAND_TOOL.toLowerCase()) {
    return `Claude Code writes this tool's name ${COMMAND_TOOL}.`;
  }
  if (
    tool.length > MAX_RULE_TOOL_CHARS ||
    !TOOL_NAME.test(tool) ||
    tool === MCP_PREFIX ||
    (tool.startsWith(MCP_PREFIX) && tool.endsWith(MCP_SEPARATOR))
  ) {
    return "A tool's name is written as Claude Code writes it: a letter, then letters, digits, _ and -, such as Bash, WebFetch or mcp__docs__search.";
  }
  return null;
}

/** The sentence that says what is wrong with a rule's command, or null when it can be one. */
function commandProblem(command: string, decision: RuleDecision): string | null {
  if (command.length > MAX_RULE_COMMAND_CHARS) {
    return `A command in a rule is ${MAX_RULE_COMMAND_CHARS} characters at most.`;
  }
  if (!ASCII_WORDS.test(command)) {
    return "Write the command in plain ASCII letters, digits and marks, with one space between words and none at either end.";
  }
  const prefix = command.endsWith(PREFIX_MARK);
  const words = prefix ? command.slice(0, -PREFIX_MARK.length) : command;
  if (words === "" || words.endsWith(" ")) {
    return "Write :* straight after the words a command begins with, as in npm test:*.";
  }
  if (command.endsWith(" *")) {
    return "Write a prefix with :* straight after its words, as in npm test:*.";
  }
  if (NOT_IN_A_RULE.test(words)) {
    return "A rule names one command by its words: no ;, &, |, <, >, ( ), quotes, backslashes, $, { }, or * other than the :* that ends a prefix.";
  }
  if (decision === "allow" && plainCommandWords(words) === null) {
    return "An allow rule names one plain command: no ~, !, ^, #, ?, [ ], no word starting with =, and no variable set before it.";
  }
  const [program = ""] = words.split(" ");
  if (ASSIGNMENT.test(program)) {
    return "Begin the command with the program's name: the variables set before a command are passed over when it is matched.";
  }
  if (decision === "allow" && runsAnotherCommand(program)) {
    return `${program} runs another command, so an allow rule for it would let Claude Code run anything without asking you. Name the command it would run instead.`;
  }
  if (decision === "allow" && sendsOrRunsCode(program)) {
    return `${program} can send requests, or run code that does, so an allow rule for it would let Claude Code reach Agent Lookout on this computer and add a rule or answer its own prompts without asking you. Answer such commands by hand, or allow a script the project owns, such as ./scripts/test.sh, knowing Claude can edit it.`;
  }
  return null;
}

/**
 * The sentence that says why these words make no rule, or null when they make
 * one. The page shows the same sentences as help, and the collector refuses
 * by them.
 */
export function ruleProblem(words: RuleWords): string | null {
  const { decision, tool, command } = words;
  const toolWrong = toolProblem(tool);
  if (toolWrong !== null) return toolWrong;
  if (command !== undefined) {
    if (tool !== COMMAND_TOOL)
      return "A command goes with Bash only. Leave it empty for any other tool.";
    const commandWrong = commandProblem(command, decision);
    if (commandWrong !== null) return commandWrong;
  }
  if (decision !== "allow") return null;
  if (tool === EVERY_TOOL) {
    return "An allow rule names one tool. Allowing every tool would let Claude Code run anything without asking you.";
  }
  if (tool === COMMAND_TOOL && command === undefined) {
    return "An allow rule for Bash names a command. Allowing every command would let Claude Code run anything without asking you.";
  }
  if (isServerName(tool)) {
    return `An allow rule names one tool of a server, such as ${tool}${MCP_SEPARATOR}search. Allowing every tool of ${tool} would let Claude Code use each without asking you.`;
  }
  if (EDIT_TOOLS.includes(tool)) {
    return `Agent Lookout does not show the change ${tool} makes, so it never allows one, by hand or by a rule.`;
  }
  if (NOT_YES_OR_NO_TOOLS.includes(tool)) {
    return `${tool} is answered with more than yes or no, so Agent Lookout never allows it, by hand or by a rule.`;
  }
  return null;
}

/** A rule's words, read strictly: exactly `decision`, `tool` and perhaps `command`, each right. */
export function ruleWordsIn(
  value: unknown,
): { ok: true; words: RuleWords } | { ok: false; problem: string } {
  const shape =
    'A rule is {"decision": "allow", "ask" or "deny", "tool": "...", "command": "..."}, with the command for Bash only, and nothing else.';
  if (!isRecord(value) || !holdsOnly(value, ["decision", "tool"], ["command"])) {
    return { ok: false, problem: shape };
  }
  const { decision, tool, command } = value;
  if (!(RULE_DECISIONS as readonly unknown[]).includes(decision))
    return { ok: false, problem: shape };
  if (typeof tool !== "string" || (command !== undefined && typeof command !== "string")) {
    return { ok: false, problem: shape };
  }
  const words: RuleWords = {
    decision: decision as RuleDecision,
    tool,
    ...(command !== undefined && { command }),
  };
  const problem = ruleProblem(words);
  return problem === null ? { ok: true, words } : { ok: false, problem };
}

/** Whether text is a rule's id. */
export function isRuleId(value: unknown): value is string {
  return typeof value === "string" && RULE_ID.test(value);
}

/** One rule as the file keeps it, read strictly, or null. */
function readRule(value: unknown): PermissionRule | null {
  if (!isRecord(value)) return null;
  const { id, ...rest } = value;
  if (!isRuleId(id)) return null;
  const read = ruleWordsIn(rest);
  return read.ok ? { id, ...read.words } : null;
}

/** What a list read as: its rules, or nothing at all when any part of it could not be read. */
export type PermissionRulesRead = { ok: true; rules: PermissionRule[] } | { ok: false };

/**
 * The rules as a file or an answer holds them. Nothing is half read: a list
 * that is not a list, holds more than 100 rules, two with one id, or a rule
 * that cannot be read whole, as a later version's with a field this one does
 * not know, is read as no rule at all. Leaving out one rule could let an
 * allow rule answer what an ask rule beside it held back. Nothing there is
 * no rule.
 */
export function readPermissionRules(value: unknown): PermissionRulesRead {
  if (value === undefined) return { ok: true, rules: [] };
  if (!Array.isArray(value) || value.length > MAX_RULES) return { ok: false };
  const rules: PermissionRule[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    const rule = readRule(item);
    if (rule === null || ids.has(rule.id)) return { ok: false };
    ids.add(rule.id);
    rules.push(rule);
  }
  return { ok: true, rules };
}

/** Whether two rules say the same, whatever their ids. */
export function sameWords(a: RuleWords, b: RuleWords): boolean {
  return a.decision === b.decision && a.tool === b.tool && a.command === b.command;
}

/**
 * A rule as Claude Code writes one, without its decision: `Bash(npm test:*)`,
 * `WebFetch`, or null for every tool, which is said in words.
 */
export function ruleText(rule: Pick<RuleWords, "tool" | "command">): string | null {
  if (rule.tool === EVERY_TOOL) return null;
  return rule.command === undefined ? rule.tool : `${rule.tool}(${rule.command})`;
}
