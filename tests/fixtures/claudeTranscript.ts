// Test fixtures only. Lines of a Claude Code transcript, in the shapes seen in
// `~/.claude/projects/<folder>/<sessionId>.jsonl` and described in
// `src/collector/adapters/claude-code/transcript/lastAsk.ts` and `lastUsage.ts`.
// Every id, path, command, question, reply and token count is invented.
// Product code never imports this file.

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
  /**
   * The message's `usage`, which every line of an assistant message carries,
   * such as `usage(...)` gives. Left out, the line has none.
   */
  usage?: unknown;
  /** The model the message names. Left out, it names none. */
  model?: string;
}

/** The parts of a reply's token counts, as Claude Code writes them in `message.usage`. */
export interface UsageCounts {
  /** `input_tokens`: the part of the prompt neither read from a cache nor written to one. */
  uncached: number;
  /** `cache_creation_input_tokens`: the part written to a cache. */
  written: number;
  /** `cache_read_input_tokens`: the part read from a cache. */
  read: number;
  /** `output_tokens`, thinking included. */
  output: number;
}

/**
 * A `message.usage` in the shape Claude Code 2.1.2xx writes: the four counts,
 * with the nested objects and the service tier that sit beside them, which
 * Agent Lookout never reads. Every number is invented.
 */
export function usage({ uncached, written, read, output }: UsageCounts): Record<string, unknown> {
  return {
    input_tokens: uncached,
    cache_creation_input_tokens: written,
    cache_read_input_tokens: read,
    cache_creation: { ephemeral_1h_input_tokens: written, ephemeral_5m_input_tokens: 0 },
    output_tokens: output,
    output_tokens_details: { thinking_tokens: Math.floor(output / 3) },
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: "standard",
  };
}

/** The fields of an assistant message that every line of it repeats: its id, its model and its usage. */
function messageFields({
  messageId,
  model,
  usage: counted,
}: Pick<LineOptions, "messageId" | "model" | "usage">) {
  return {
    ...(messageId === null || messageId === undefined ? {} : { id: messageId }),
    ...(model === undefined ? {} : { model }),
    ...(counted === undefined ? {} : { usage: counted }),
  };
}

/** An assistant line holding one tool use. */
export function toolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
  { messageId = `msg_${id}`, sidechain = false, usage: counted, model }: LineOptions = {},
): TranscriptLine {
  return {
    type: "assistant",
    isSidechain: sidechain,
    uuid: `line-${id}`,
    message: {
      ...messageFields({ messageId, model, usage: counted }),
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
  { messageId = "msg_words", sidechain = false, usage: counted, model }: LineOptions = {},
): TranscriptLine {
  return {
    type: "assistant",
    isSidechain: sidechain,
    message: {
      ...messageFields({ messageId, model, usage: counted }),
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

/** The lines of one assistant message said in several blocks: a line of words for each, sharing its id. */
export function saidInParts(
  texts: readonly string[],
  { messageId = "msg_parts", ...rest }: LineOptions = {},
): TranscriptLine[] {
  return texts.map((text) => said(text, { messageId, ...rest }));
}

interface ThoughtOptions extends LineOptions {
  /** Gives a `redacted_thinking` block, which holds its thinking as data, in place of a `thinking` one. */
  redacted?: boolean;
}

/** An assistant line holding what the model thought, which is never what it said. */
export function thought(
  text: string,
  {
    messageId = "msg_words",
    sidechain = false,
    redacted = false,
    usage: counted,
    model,
  }: ThoughtOptions = {},
): TranscriptLine {
  return {
    type: "assistant",
    isSidechain: sidechain,
    message: {
      ...messageFields({ messageId, model, usage: counted }),
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

/** The summary Claude Code writes as a user line when it compacts the conversation. */
export function compactSummary(
  text: string,
  { sidechain = false }: LineOptions = {},
): TranscriptLine {
  return {
    type: "user",
    isSidechain: sidechain,
    isCompactSummary: true,
    message: { role: "user", content: [{ type: "text", text }] },
  };
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
