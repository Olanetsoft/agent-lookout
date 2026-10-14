// Test fixtures only. Every id, name and path here is invented and generic.
// The lines follow the shapes in Gemini CLI's source at v0.64.0
// (packages/core/src/services/chatRecordingService.ts and chatRecordingTypes.ts),
// and at v0.63.0 for the helpers whose names end `AsOf063`, as written up in
// docs/adapters/gemini-cli.md, and nothing in them is copied from a real
// machine. Product code never imports this file.
//
// The folder `home/` beside this file is the same kind of data laid out on
// disk, as Gemini CLI lays out its own folder. `tests/README.md` lists what is
// in it.

export const HOME = "/Users/example";

/** Where the adapter looks when nothing names another folder. */
export const GEMINI_DIR = `${HOME}/.gemini`;

/** The folder that holds every project's sessions. */
export const TMP_DIR = `${GEMINI_DIR}/tmp`;

/** Midday UTC on 1 October 2026, the day the fixture's sessions were written. */
export const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The folder the fixture's sessions were started in, and the project folder Gemini CLI makes for it. */
export const PROJECT = `${HOME}/code/demo-project`;
export const SLUG = "demo-project";

/** A second project, for a session in another folder. */
export const OTHER_PROJECT = `${HOME}/code/demo-api`;
export const OTHER_SLUG = "demo-api";

/**
 * Text placed in every field the adapter must never keep: prompts, replies,
 * thoughts, a tool's arguments and result, `displayContent`, the scratchpad
 * and an imported header's first prompt. A test checks it is nowhere in what
 * the adapter returns.
 */
export const PRIVATE_WORDS = "placeholder-private-words";

/** The id Gemini CLI gives the context message it starts every session with. */
export const ENVIRONMENT_CONTEXT_ID = "d04923d38bb0f6017037e74183378ef4";

/** A generic session id whose last two characters are these. */
export const sessionIdOf = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;

/** A generic message id whose last two characters are these. */
export const messageIdOf = (suffix: string) => `10000000-0000-4000-8000-0000000000${suffix}`;

/** The ids of the sessions in `home/`. */
export const ids = {
  working: sessionIdOf("01"),
  idle: sessionIdOf("02"),
} as const;

/** A time as Gemini CLI writes it: `new Date().toISOString()`. */
export const at = (ms: number) => new Date(ms).toISOString();

/** A main session's file name: the minute it began, in UTC, and the first 8 characters of its id. */
export function chatName(began: number, sessionId: string, clash?: number): string {
  const minute = at(began).slice(0, 16).replace(/:/g, "-");
  return `session-${minute}-${clash === undefined ? "" : `${clash}-`}${sessionId.slice(0, 8)}.jsonl`;
}

/** A session file's path in a project's folder. */
export const chatPath = (name: string, slug = SLUG, tmp = TMP_DIR) =>
  `${tmp}/${slug}/chats/${name}`;

/** A project's `.project_root`. */
export const projectRootPath = (slug = SLUG, tmp = TMP_DIR) => `${tmp}/${slug}/.project_root`;

/** A placeholder for `projectHash`, which Gemini CLI makes a SHA-256 of the project's folder. */
export const PROJECT_HASH = "0".repeat(64);

export interface HeaderFields {
  sessionId?: string;
  startTime?: number;
  lastUpdated?: number;
  kind?: string;
  [field: string]: unknown;
}

/** The first line of a session file. */
export function headerLine(fields: HeaderFields = {}): string {
  const {
    sessionId = ids.working,
    startTime = NOW - 10 * MINUTE,
    lastUpdated,
    kind = "main",
  } = fields;
  return JSON.stringify({
    sessionId,
    projectHash: PROJECT_HASH,
    startTime: at(startTime),
    lastUpdated: at(lastUpdated ?? startTime),
    kind,
    ...Object.fromEntries(
      Object.entries(fields).filter(
        ([key]) => !["sessionId", "startTime", "lastUpdated", "kind"].includes(key),
      ),
    ),
  });
}

/** The context message Gemini CLI starts every session with. */
export function contextLine(time: number): string {
  return JSON.stringify({
    id: ENVIRONMENT_CONTEXT_ID,
    timestamp: at(time),
    type: "user",
    content: [
      { text: `<session_context>\nA placeholder context. ${PRIVATE_WORDS}\n</session_context>` },
    ],
  });
}

/** A message the person typed. */
export function userLine(
  id: string,
  time: number,
  text = `A placeholder prompt. ${PRIVATE_WORDS}`,
) {
  return JSON.stringify({
    id,
    timestamp: at(time),
    type: "user",
    content: [{ text }],
    displayContent: [{ text: `A placeholder shown prompt. ${PRIVATE_WORDS}` }],
  });
}

/** A tool's result, sent back to the model as a user message. */
export function toolResultLine(id: string, time: number, callId = "call-0001"): string {
  return JSON.stringify({
    id,
    timestamp: at(time),
    type: "user",
    content: [
      {
        functionResponse: {
          id: callId,
          name: "run_shell_command",
          response: { output: `A placeholder output. ${PRIVATE_WORDS}` },
        },
      },
    ],
  });
}

/** A tool call as Gemini CLI records it once it has ended. */
export function toolCall(status: string, time: number, callId = "call-0001") {
  return {
    id: callId,
    name: "run_shell_command",
    args: { command: `echo ${PRIVATE_WORDS}` },
    result: [
      {
        functionResponse: {
          id: callId,
          name: "run_shell_command",
          response: { output: PRIVATE_WORDS },
        },
      },
    ],
    status,
    timestamp: at(time),
    displayName: "Shell",
    description: `A placeholder description. ${PRIVATE_WORDS}`,
    resultDisplay: `A placeholder display. ${PRIVATE_WORDS}`,
    renderOutputAsMarkdown: false,
  };
}

export interface GeminiFields {
  /** The visible text, or "" for a reply that was only calls for tools, or a list of parts. */
  content?: unknown;
  toolCalls?: ReturnType<typeof toolCall>[];
}

/** A reply of the model. */
export function geminiLine(id: string, time: number, fields: GeminiFields = {}): string {
  const { content = `A placeholder reply. ${PRIVATE_WORDS}`, toolCalls } = fields;
  return JSON.stringify({
    id,
    timestamp: at(time),
    type: "gemini",
    content,
    thoughts: [
      { subject: "Placeholder", description: PRIVATE_WORDS, timestamp: at(time - SECOND) },
    ],
    tokens: { input: 100, output: 20, cached: 0, thoughts: 5, tool: 0, total: 125 },
    model: "gemini-placeholder",
    ...(toolCalls ? { toolCalls } : {}),
  });
}

/** An `info`, `warning` or `error` message, as the CLI records the notices it shows. */
export function noticeLine(type: "info" | "warning" | "error", id: string, time: number): string {
  return JSON.stringify({
    id,
    timestamp: at(time),
    type,
    content: `A placeholder notice. ${PRIVATE_WORDS}`,
  });
}

/** A `$set` of the session's details. */
export function setLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ $set: fields });
}

/** The `$set` Gemini CLI writes after almost every message. */
export const updatedLine = (time: number) => setLine({ lastUpdated: at(time) });

/** The title a later start in the same folder saves, with the scratchpad saved beside it. */
export function titleLine(summary: string): string {
  return setLine({
    summary,
    memoryScratchpad: { version: 1, workflowSummary: PRIVATE_WORDS, touchedPaths: [PROJECT] },
  });
}

export const rewindLine = (id: string) => JSON.stringify({ $rewindTo: id });

export const patchLine = (patch: Record<string, unknown>) => JSON.stringify({ $patch: patch });

/**
 * A reply's tool results as Gemini CLI writes them again when it takes a
 * session up again or rewinds it: a user message of id `<reply's id>_response`.
 */
export const historyCopyLine = (replyId: string, time: number) =>
  toolResultLine(`${replyId}_response`, time);

/** A `$set` of every message, as Gemini CLI 0.44 to 0.63 wrote one to match the list to its history. */
export function setMessagesLine(lines: readonly string[], time: number): string {
  return setLine({
    messages: lines.map((line) => JSON.parse(line) as unknown),
    lastUpdated: at(time),
  });
}

/** The context, the prompt and the reply of `sessionAsOf063`. */
export function messagesAsOf063(began: number): string[] {
  return [
    contextLine(began + 100),
    userLine(messageIdOf("71"), began + MINUTE),
    geminiLine(messageIdOf("72"), began + 2 * MINUTE),
  ];
}

/**
 * The lines of a session as Gemini CLI 0.44 to 0.63 wrote one: the header, a
 * `$set` of the messages with the context alone, then a prompt and a reply,
 * each with a `$set` of the time. It is idle since the reply.
 */
export function sessionAsOf063(sessionId: string, began: number): string[] {
  const [context = "", prompt = "", reply = ""] = messagesAsOf063(began);
  return [
    headerLine({ sessionId, startTime: began }),
    setMessagesLine([context], began + 100),
    prompt,
    updatedLine(began + MINUTE),
    reply,
    updatedLine(began + 2 * MINUTE),
  ];
}

/** The id of the reply that calls a tool in `toolRoundAsOf063`. */
export const BATCH_ID_063 = messageIdOf("82");

/** The context, the prompt, the reply with its tool call ended, and the tool's result, of `toolRoundAsOf063`. */
export function toolRoundMessagesAsOf063(began: number): string[] {
  return [
    contextLine(began + 100),
    userLine(messageIdOf("81"), began + MINUTE),
    geminiLine(BATCH_ID_063, began + 2 * MINUTE, {
      content: "",
      toolCalls: [toolCall("success", began + 2 * MINUTE + 5 * SECOND)],
    }),
    toolResultLine(messageIdOf("83"), began + 3 * MINUTE),
  ];
}

/**
 * The lines of a session as Gemini CLI 0.44 to 0.63 wrote one whose run
 * stopped while the model answered a tool's result: the header, a `$set` of
 * the messages with the context alone, then the prompt, the reply with its
 * tool call and the result, each with a `$set` of the time. It is working
 * since the prompt.
 */
export function toolRoundAsOf063(sessionId: string, began: number): string[] {
  const [context = "", ...round] = toolRoundMessagesAsOf063(began);
  return [
    headerLine({ sessionId, startTime: began }),
    setMessagesLine([context], began + 100),
    ...round.flatMap((line, index) => [line, updatedLine(began + (index + 1) * MINUTE)]),
  ];
}

/**
 * A message line as Gemini CLI 0.44 to 0.63 rebuilt it for the model and
 * wrote it back in a `$set` of messages. A `gemini` message's content becomes
 * a list of parts, with its thoughts first and a call for each of its tools
 * last (`convertSessionToClientHistory`, then `updateMessagesFromHistory`).
 * A `user` message's content is a list already, and stays as it was.
 */
export function rebuiltAsOf063(line: string): string {
  const message = JSON.parse(line) as {
    type: string;
    content: string;
    thoughts?: { subject: string; description: string }[];
    toolCalls?: { id: string; name: string; args: unknown }[];
  };
  if (message.type !== "gemini") return line;
  const thoughts = (message.thoughts ?? []).map((thought) => ({
    text: `**${thought.subject}** ${thought.description}`,
    thought: true,
  }));
  const calls = (message.toolCalls ?? []).map(({ id, name, args }) => ({
    functionCall: { id, name, args },
  }));
  return JSON.stringify({
    ...message,
    content: [...thoughts, { text: message.content }, ...calls],
  });
}

/**
 * The `$set` of messages Gemini CLI 0.44 to 0.63 writes at `time` as it takes
 * up `toolRoundAsOf063` again, right after a `$set` of `sessionId`. The tool's
 * result is gone, because its text is "", and the reply's tool results come
 * after the reply as a new message of id `<reply's id>_response`, made then.
 * `later` are the messages written after the round, such as its reply.
 */
export function resumedToolRoundAsOf063(
  began: number,
  time: number,
  later: readonly string[] = [],
): string {
  const [context = "", prompt = "", batch = ""] = toolRoundMessagesAsOf063(began);
  return setMessagesLine(
    [
      context,
      prompt,
      rebuiltAsOf063(batch),
      historyCopyLine(BATCH_ID_063, time),
      ...later.map(rebuiltAsOf063),
    ],
    time,
  );
}

/** A session file of these lines, each ended as Gemini CLI ends them. */
export const chatFile = (lines: readonly string[]) => lines.map((line) => `${line}\n`).join("");

/**
 * A whole session that is working: it began 10 minutes before `NOW`, and its
 * newest message is the person's prompt, a minute before.
 */
export function workingSession(sessionId: string = ids.working, began = NOW - 10 * MINUTE) {
  return chatFile([
    headerLine({ sessionId, startTime: began }),
    contextLine(began + 100),
    updatedLine(began + 100),
    userLine(messageIdOf("01"), NOW - MINUTE),
    updatedLine(NOW - MINUTE),
  ]);
}

/** A whole session that is idle after a reply, with the title `summary` when given. */
export function idleSession(
  sessionId: string = ids.idle,
  began = NOW - 30 * MINUTE,
  summary?: string,
) {
  return chatFile([
    headerLine({ sessionId, startTime: began }),
    contextLine(began + 100),
    updatedLine(began + 100),
    userLine(messageIdOf("11"), began + MINUTE),
    updatedLine(began + MINUTE),
    geminiLine(messageIdOf("12"), began + 2 * MINUTE),
    updatedLine(began + 2 * MINUTE),
    ...(summary === undefined ? [] : [titleLine(summary)]),
  ]);
}
