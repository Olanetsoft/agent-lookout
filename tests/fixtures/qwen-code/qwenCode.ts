// Test fixtures only. Every id, name, path and token here is invented and
// generic. The records and lines follow the shapes in Qwen Code's source at
// v0.25.1 (`session-registry.ts` and `chatRecordingService.ts`), as written up
// in docs/adapters/qwen-code.md, and nothing in them is copied from a real
// machine: Qwen Code was not run to make them. Product code never imports
// this file.
//
// The folder `home/` beside this file is the same kind of data laid out on
// disk, as Qwen Code lays out its own folder. `tests/README.md` lists what is in it.

export const HOME = "/Users/example";

/** Where the adapter looks when nothing names another folder. */
export const QWEN_DIR = `${HOME}/.qwen`;

/** Midday UTC on 1 October 2026, the day the fixture's sessions were written. */
export const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A generic session id whose last digits are these. */
export const sessionIdOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** The folder the fixture's sessions run in, and the folder Qwen Code names for it. */
export const PROJECT = `${HOME}/code/demo-project`;
export const PROJECT_FOLDER = "-Users-example-code-demo-project";

/** Words written where a prompt, a reply, a thought or a tool's input or output goes. None may leave the file. */
export const PRIVATE_WORDS = "placeholder words that must never leave the chat file";

/** A token written where a record's `ipcToken` goes. It may never leave the record. */
export const PRIVATE_TOKEN = "d0d0".repeat(16);

/** What every file the adapter must never open holds. */
export const PLACEHOLDER = "Placeholder. Agent Lookout never opens this file.";

/** The sessions of `home/`, by what each shows. */
export const fixture = {
  /** pid 41001, a terminal session in a turn, its reply calling a tool. */
  working: { pid: 41001, sessionId: sessionIdOf(1) },
  /** pid 41002 as `41002-0a1b2c3d.json`, an editor's session: left out. */
  headless: { pid: 41002, sessionId: sessionIdOf(2) },
  /** pid 41004, a terminal session whose turn is over, with a title. */
  idle: { pid: 41004, sessionId: sessionIdOf(4) },
  /** pid 41005, a terminal session whose process ended without letting it go. */
  crashed: { pid: 41005, sessionId: sessionIdOf(5) },
  /** pid 41006, a terminal session in another folder that has not been given a prompt. */
  fresh: { pid: 41006, sessionId: sessionIdOf(6) },
} as const;

/** The processes of `home/` that run, for the `isAlive` a test hands the adapter. */
export const RUNNING_PIDS: ReadonlySet<number> = new Set([41001, 41002, 41004, 41006]);

/** When each record in `home/` says its process registered its session. */
export const registeredAt = {
  working: NOW - 30 * MINUTE,
  headless: NOW - 20 * MINUTE,
  idle: NOW - 2 * HOUR,
  crashed: NOW - 3 * HOUR,
  fresh: NOW - 5 * MINUTE,
} as const;

/** A time as Qwen Code writes it: `YYYY-MM-DDTHH:MM:SS.mmmZ`, in UTC. */
export const at = (ms: number) => new Date(ms).toISOString();

export interface RecordFields {
  pid: number;
  sessionId: string;
  cwd?: string;
  startedAt?: number;
  /** Left out of the record when undefined, as one written before the field was. */
  kind?: string;
  procStart?: string | null;
  pidNs?: number | null;
  schemaVersion?: number;
  /** Anything else to put in the record, or to take a field out with `undefined`. */
  extra?: Record<string, unknown>;
}

/**
 * One record of the list of running sessions, as Qwen Code writes it, with
 * the socket and the token that may never leave it.
 */
export function registryRecord(fields: RecordFields): string {
  const record: Record<string, unknown> = {
    schemaVersion: fields.schemaVersion ?? 1,
    pid: fields.pid,
    procStart: fields.procStart ?? null,
    pidNs: fields.pidNs ?? null,
    sessionId: fields.sessionId,
    cwd: fields.cwd ?? PROJECT,
    name: "demo-project-a1",
    startedAt: fields.startedAt ?? NOW - 30 * MINUTE,
    qwenVersion: "0.25.1",
    ...(fields.kind === undefined ? {} : { kind: fields.kind }),
    ipcPath: `/tmp/qwen-socks/${fields.pid}.sock`,
    ipcToken: PRIVATE_TOKEN,
    ...fields.extra,
  };
  return JSON.stringify(record, null, 2);
}

let lineNumber = 0;

export interface LineFields {
  sessionId?: string;
  cwd?: string;
}

/**
 * The fields every line begins with, in the order Qwen Code writes them
 * (`createBaseRecord`): an id, its parent's, the session, the time and the
 * type, then the folder, the version and the branch.
 */
function baseOf(type: string, time: number, fields: LineFields = {}): Record<string, unknown> {
  lineNumber += 1;
  return {
    uuid: `00000000-0000-4000-9000-${String(lineNumber).padStart(12, "0")}`,
    parentUuid: null,
    sessionId: fields.sessionId ?? fixture.working.sessionId,
    timestamp: at(time),
    type,
    provenance:
      type === "user"
        ? "real_user"
        : type === "assistant"
          ? "assistant_output"
          : type === "tool_result"
            ? "tool_result"
            : "system",
    cwd: fields.cwd ?? PROJECT,
    version: "0.25.1",
    gitBranch: "main",
  };
}

/** One line of a chat file, ending in its newline. */
const lineOf = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;

/** A prompt the person typed, with what they typed in it. */
export function promptLine(time: number, fields: LineFields = {}): string {
  return lineOf({
    ...baseOf("user", time, fields),
    executionContext: { modelId: "demo-model", approvalMode: "default" },
    message: { role: "user", parts: [{ text: PRIVATE_WORDS }] },
    systemPayload: { displayText: PRIVATE_WORDS },
  });
}

/** A `user` line of this subtype: `cron`, `notification`, `mid_turn_user_message` and so on. */
export function userLine(
  time: number,
  subtype: string,
  options: { deliveredTurn?: boolean } & LineFields = {},
): string {
  return lineOf({
    ...baseOf("user", time, options),
    subtype,
    ...(options.deliveredTurn ? { deliveredTurn: true } : {}),
    message: { role: "user", parts: [{ text: PRIVATE_WORDS }] },
    systemPayload: { displayText: PRIVATE_WORDS },
  });
}

export interface AssistantFields extends LineFields {
  /** How many tools the reply calls. */
  calls?: number;
  /** A reply with no `message`, as Qwen Code writes when a response had none. */
  noMessage?: boolean;
  subtype?: string;
  /** What the reply says, in place of the words that must never leave the file. Its thought and calls stay. */
  says?: string;
  /** The reply's parts, in place of its thought, its text and its calls. */
  parts?: unknown[];
  /** Marks the line as one a subagent wrote into the file. */
  sidechain?: boolean;
}

/** A whole reply, with its thought, its text, the tools it calls and its token counts. */
export function assistantLine(time: number, fields: AssistantFields = {}): string {
  const calls = Array.from({ length: fields.calls ?? 0 }, (_, index) => ({
    functionCall: {
      id: `call-${index + 1}`,
      name: "run_shell_command",
      args: { command: PRIVATE_WORDS },
    },
  }));
  return lineOf({
    ...baseOf("assistant", time, fields),
    ...(fields.subtype === undefined ? {} : { subtype: fields.subtype }),
    ...(fields.sidechain ? { isSidechain: true } : {}),
    model: "demo-model",
    ...(fields.noMessage
      ? {}
      : {
          message: {
            role: "model",
            parts: fields.parts ?? [
              { text: PRIVATE_WORDS, thought: true },
              { text: fields.says ?? PRIVATE_WORDS },
              ...calls,
            ],
          },
        }),
    usageMetadata: {
      promptTokenCount: 1200,
      candidatesTokenCount: 80,
      thoughtsTokenCount: 20,
      totalTokenCount: 1300,
      cachedContentTokenCount: 600,
    },
    contextWindowSize: 128000,
  });
}

/** A tool's result, with its output and what was shown of it. */
export function toolResultLine(
  time: number,
  status: "success" | "error" | "cancelled" = "success",
  fields: LineFields = {},
): string {
  return lineOf({
    ...baseOf("tool_result", time, fields),
    message: {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "call-1",
            name: "run_shell_command",
            response: { output: PRIVATE_WORDS },
          },
        },
      ],
    },
    toolCallResult: { callId: "call-1", status, resultDisplay: PRIVATE_WORDS },
  });
}

/** A `system` line of this subtype with this payload. */
export function systemLine(
  time: number,
  subtype: string,
  payload: unknown = {},
  fields: LineFields = {},
): string {
  return lineOf({ ...baseOf("system", time, fields), subtype, systemPayload: payload });
}

/** A `request_lifecycle` event: a request to the model that started, or ended. */
export function lifecycleLine(
  time: number,
  phase: "started" | "ended",
  options: { outcome?: string; subagentId?: string; executionId?: string } & LineFields = {},
): string {
  return systemLine(
    time,
    "ui_telemetry",
    {
      uiEvent: {
        v: 1,
        kind: "request",
        executionId: options.executionId ?? "exec-1",
        sessionId: options.sessionId ?? fixture.working.sessionId,
        promptId: "prompt-1",
        model: "demo-model",
        startedAt: time,
        ...(options.subagentId ? { subagentId: options.subagentId } : {}),
        phase,
        ...(phase === "ended"
          ? { endedAt: time, durationMs: 0, outcome: options.outcome ?? "success" }
          : {}),
        "event.name": "request_lifecycle",
      },
    },
    options,
  );
}

/** Another event Qwen Code records: the answer to a request, with its counts. */
export function apiResponseLine(time: number, fields: LineFields = {}): string {
  return systemLine(
    time,
    "ui_telemetry",
    {
      uiEvent: {
        "event.name": "qwen-code.api_response",
        response_text: PRIVATE_WORDS,
        input_token_count: 1200,
      },
    },
    fields,
  );
}

/** A title, given by Qwen Code or with /rename. */
export function titleLine(time: number, title: string, fields: LineFields = {}): string {
  return systemLine(time, "custom_title", { customTitle: title, titleSource: "auto" }, fields);
}

/** A compression of the conversation, padded to about this many bytes with its compressed history. */
export function compressionLine(time: number, sizeBytes: number, fields: LineFields = {}): string {
  return systemLine(
    time,
    "chat_compression",
    {
      info: { originalTokenCount: 9000, newTokenCount: 900 },
      compressedHistory: [
        { role: "user", parts: [{ text: PRIVATE_WORDS.padEnd(sizeBytes, ".") }] },
      ],
    },
    fields,
  );
}

/** A file history snapshot, which holds the files' own text. */
export function snapshotLine(time: number, fields: LineFields = {}): string {
  return systemLine(
    time,
    "file_history_snapshot",
    { files: { "demo.txt": PRIVATE_WORDS } },
    fields,
  );
}

/** The lines of one chat file, as one text. */
export const chatFile = (...lines: string[]) => lines.join("");

/** A chat file's path under a runtime folder. */
export const chatPath = (runtime: string, sessionId: string, folder = PROJECT_FOLDER) =>
  `${runtime}/projects/${folder}/chats/${sessionId}.jsonl`;

/** A record's path under a Qwen Code folder. */
export const recordPath = (home: string, name: string) => `${home}/sessions/${name}`;

/**
 * Every file in `home/` the adapter must never open or list, by its path in
 * the folder: credentials, settings, other files beside the chat files and the
 * runtime's own folders. The tests that copy `home/` add `.env` themselves,
 * since git keeps no file of that name.
 */
export const NEVER_OPENED = [
  "sessions/41003.json.0123456789ab.tmp",
  "sessions/notes.json",
  `projects/${PROJECT_FOLDER}/chats/${sessionIdOf(1)}.runtime.json`,
  `projects/${PROJECT_FOLDER}/chats/${sessionIdOf(1)}.ledger.jsonl`,
  `projects/${PROJECT_FOLDER}/chats/archive/${sessionIdOf(3)}.jsonl`,
  `projects/${PROJECT_FOLDER}/memory/MEMORY.md`,
  `projects/${PROJECT_FOLDER}/subagents/${sessionIdOf(1)}/agent-x.jsonl`,
  "oauth_creds.json",
  "oauth_creds.lock",
  "settings.json",
  "installation_id",
  "google_accounts.json",
  "mcp-oauth-tokens.json",
  "mcp-oauth-tokens-v2.json",
  "extension-secrets-v1.json",
  "trustedFolders.json",
  "memory.md",
  "ide/12345.lock",
  "file-history/x",
  "daemon/supervisor.json",
  "jobs/x/launch.json",
  "jobs/x/worker.json",
  "channels/qqbot-credentials.json",
  "channels/weixin/account.json",
  "agent-hosts/0000000000000000000000000000000000000000000000000000000000000000.json",
  "tmp/x/logs.json",
  "tmp/x/shell_history",
  "tmp/session-writer-locks/x.lock",
  "debug/x.txt",
  "todos/x.json",
  "usage/token-usage-2026-10.jsonl",
] as const;
