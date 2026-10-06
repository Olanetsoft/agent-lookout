/**
 * Finds the machine facts inside a sentence, so they can be set in the mono face.
 *
 * The collector describes what it did in one plain sentence, such as "Listed by
 * claude agents --json, with apps and status times from ~/.claude/sessions." The
 * command and the folder in it are machine facts: in the sans face a double
 * hyphen reads as one long dash, and a path wraps like prose. This splits such a
 * sentence into words and facts. It never changes or reorders the text.
 */

export interface TextRun {
  text: string;
  /** True for a command, a path or a variable name. */
  fact: boolean;
}

/**
 * The commands the sources run, and gh, which the collector asks for pull
 * requests. In lowercase and on its own, one of these is the program, not the
 * product: "the claude command", not "Claude Code".
 */
const COMMANDS = ["claude", "gh"];

const FACT = new RegExp(
  [
    // A variable name: AGENT_LOOKOUT_CLAUDE_BIN, or PATH.
    String.raw`\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b`,
    String.raw`\bPATH\b`,
    // A path: ~/.claude/sessions, /opt/homebrew/bin, /api/sessions, ./dist, C:\Users\example.
    String.raw`(?<![\w.:/~])(?:~|\.{1,2})?(?:/[\w.@%+~-]+)+/?`,
    String.raw`\b[A-Za-z]:\\[^\s,;]+`,
    // The command that signs gh in, which takes no flag.
    String.raw`\bgh auth login\b`,
    // A command, with its subcommands when flags follow: claude agents --json.
    String.raw`\b(?:${COMMANDS.join("|")})\b(?![\w-]|\.\w)(?:(?: [a-z][\w-]*)*(?: --?[a-z][\w-]*)+)?`,
    // A flag on its own: --json.
    String.raw`(?<![\w-])--[a-z][\w-]*`,
  ].join("|"),
  "g",
);

/** Punctuation that ends a sentence or a clause, and is not part of a fact before it. */
const TRAILING = /[.,;:!?]+$/;

/** Splits a sentence into runs of words and machine facts, in order. */
export function splitFacts(sentence: string): TextRun[] {
  const runs: TextRun[] = [];
  const push = (text: string, fact: boolean) => {
    if (text === "") return;
    const last = runs[runs.length - 1];
    if (last && last.fact === fact) last.text += text;
    else runs.push({ text, fact });
  };

  let cursor = 0;
  for (const match of sentence.matchAll(FACT)) {
    const start = match.index;
    const fact = match[0].replace(TRAILING, "");
    if (fact === "") continue;
    push(sentence.slice(cursor, start), false);
    push(fact, true);
    cursor = start + fact.length;
  }
  push(sentence.slice(cursor), false);
  return runs;
}
