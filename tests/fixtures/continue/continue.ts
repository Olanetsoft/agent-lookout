// Test fixtures only. Every id, name, path and word here is invented and
// generic. Each file follows the shape Continue's source writes at v1.5.45
// (`core/util/history.ts`), as written up in docs/adapters/continue.md, and
// nothing in it is copied from a real machine: Continue was not run to make it.
// Product code never imports this file.

export const HOME = "/Users/example";

/** Where the adapter looks when nothing names another folder. */
export const CONTINUE_HOME = `${HOME}/.continue`;
export const SESSIONS_DIR = `${CONTINUE_HOME}/sessions`;
export const INDEX = `${SESSIONS_DIR}/sessions.json`;

/** Midday UTC on 1 October 2026. */
export const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The folder the fixture's sessions run in. */
export const PROJECT = `${HOME}/code/demo-project`;

/** That folder as an editor writes it, in the URI of its workspace folder. */
export const PROJECT_URI = `file://${PROJECT}`;

export const CREATED_AT = NOW - HOUR;

/** A generic session id, in the UUID shape Continue gives one. */
export const sessionIdOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const SESSION_ID = sessionIdOf(1);

/** Written where a title goes, which an editor can take word for word from a prompt. None may leave the file. */
export const PRIVATE_TITLE = "placeholder title that must never leave the list";

/** Words written where a prompt or a reply goes. None may leave the file. */
export const PRIVATE_WORDS = "placeholder words that must never leave the session file";

/** Written where a tool's arguments go. */
export const PRIVATE_ARGUMENTS = "placeholder arguments that must never leave the session file";

/** A session's own file. */
export const sessionPath = (id: string) => `${SESSIONS_DIR}/${id}.json`;

/** One session in the index, as an object a test can change. Keys are in the order Continue writes them. */
export function entryOf(id: string, changes: Record<string, unknown> = {}) {
  return {
    sessionId: id,
    title: PRIVATE_TITLE,
    dateCreated: String(CREATED_AT),
    workspaceDirectory: PROJECT,
    messageCount: 3,
    ...changes,
  };
}

/** The index, written as `HistoryManager.save` writes it. */
export const indexText = (entries: readonly unknown[]) => JSON.stringify(entries, undefined, 2);

/**
 * A session's own file as `HistoryManager.save` writes it: a turn that stops on a
 * tool call that has not run, which is how `cn` leaves one that waits for approval
 * and how a crash leaves one. The adapter never opens it.
 */
export function sessionText(id: string, status = "generated") {
  return JSON.stringify(
    {
      sessionId: id,
      title: PRIVATE_TITLE,
      workspaceDirectory: PROJECT,
      history: [
        {
          message: { role: "user", content: PRIVATE_WORDS },
          contextItems: [],
          editorState: PRIVATE_WORDS,
        },
        {
          message: {
            role: "assistant",
            content: PRIVATE_WORDS,
            toolCalls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "Bash", arguments: PRIVATE_ARGUMENTS },
              },
            ],
          },
          contextItems: [],
          toolCallStates: [
            {
              toolCallId: "call_1",
              toolCall: {
                id: "call_1",
                type: "function",
                function: { name: "Bash", arguments: PRIVATE_ARGUMENTS },
              },
              status,
              parsedArgs: { command: PRIVATE_ARGUMENTS },
            },
          ],
        },
      ],
      usage: { totalCost: 0.1, promptTokens: 200, completionTokens: 40 },
    },
    undefined,
    2,
  );
}
