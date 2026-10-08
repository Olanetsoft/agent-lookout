// Test fixtures only. Lines of a Claude Code transcript, in the shapes seen in
// `~/.claude/projects/<folder>/<sessionId>.jsonl` and described in
// `src/collector/adapters/claude-code/transcript/lastAsk.ts`. Every id, path,
// command, question and reply is invented. Product code never imports this file.

/** One line of a transcript, as an object. */
export type TranscriptLine = Record<string, unknown>;

let serial = 0;

/** A fresh id for a tool use, in the shape Claude Code gives one. */
export function toolUseId(): string {
  serial += 1;
  return `toolu_${String(serial).padStart(20, "0")}`;
}

interface LineOptions {
  /** The assistant message the block belongs to. Lines of one message share it. Null leaves it out. */
  messageId?: string | null;
  /** Marks a subagent's line. */
  sidechain?: boolean;
}

/** An assistant line holding one tool use. */
export function toolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
  { messageId = `msg_${id}`, sidechain = false }: LineOptions = {},
): TranscriptLine {
  return {
    type: "assistant",
    isSidechain: sidechain,
    uuid: `line-${id}`,
    message: {
      ...(messageId === null ? {} : { id: messageId }),
      role: "assistant",
      type: "message",
      content: [{ type: "tool_use", id, name, input }],
    },
  };
}

/** A user line holding the result of a tool use. */
export function toolResult(id: string, { sidechain = false }: LineOptions = {}): TranscriptLine {
  return {
    type: "user",
    isSidechain: sidechain,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: "done" }],
    },
  };
}

/** An assistant line of words. */
export function said(
  text: string,
  { messageId = "msg_words", sidechain = false }: LineOptions = {},
): TranscriptLine {
  return {
    type: "assistant",
    isSidechain: sidechain,
    message: {
      ...(messageId === null ? {} : { id: messageId }),
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

/** The lines of one assistant message said in several blocks: a line of words for each, sharing its id. */
export function saidInParts(
  texts: readonly string[],
  { messageId = "msg_parts", sidechain = false }: LineOptions = {},
): TranscriptLine[] {
  return texts.map((text) => said(text, { messageId, sidechain }));
}

interface ThoughtOptions extends LineOptions {
  /** Gives a `redacted_thinking` block, which holds its thinking as data, in place of a `thinking` one. */
  redacted?: boolean;
}

/** An assistant line holding what the model thought, which is never what it said. */
export function thought(
  text: string,
  { messageId = "msg_words", sidechain = false, redacted = false }: ThoughtOptions = {},
): TranscriptLine {
  return {
    type: "assistant",
    isSidechain: sidechain,
    message: {
      ...(messageId === null ? {} : { id: messageId }),
      role: "assistant",
      content: [
        redacted
          ? { type: "redacted_thinking", data: text }
          : { type: "thinking", thinking: text, signature: "c2lnbmF0dXJl" },
      ],
    },
  };
}

/** What the person typed. */
export function prompt(text: string): TranscriptLine {
  return { type: "user", isSidechain: false, message: { role: "user", content: text } };
}

/** Lines Claude Code writes that hold no message, which are read past. */
export const otherLines: TranscriptLine[] = [
  { type: "attachment", isSidechain: false, attachment: { type: "hook_success" } },
  { type: "system", isSidechain: false, content: "A note of Claude Code's own" },
  { type: "last-prompt", lastPrompt: "a prompt" },
];

/** Lines as a transcript holds them: one JSON object a line, each ending in a line break. */
export function transcript(lines: readonly TranscriptLine[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

/** A session waiting for permission to run a command, after one that was answered. */
export function waitingToRun(command: string): string {
  const earlier = toolUseId();
  const pending = toolUseId();
  return transcript([
    prompt("Run the tests"),
    toolUse(earlier, "Read", { file_path: "/Users/example/code/demo/package.json" }),
    toolResult(earlier),
    ...otherLines,
    said("I will run them now."),
    toolUse(pending, "Bash", { command, description: "Run the tests" }),
  ]);
}
