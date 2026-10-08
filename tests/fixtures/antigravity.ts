// Test fixtures only. Every id, time and word here is invented and generic.
// The lines follow the transcript format agy 1.3.1 documents for its own
// agents, as written up in docs/adapters/antigravity.md: one JSON object a
// line, one step a line, with `step_index`, `source`, `type`, `status`,
// `created_at`, `content`, `thinking`, `tool_calls` and `media`. Nothing in
// them is copied from a real machine or a real conversation. Product code
// never imports this file.

export const HOME = "/Users/example";

/** Where the adapter looks when nothing names another folder. */
export const AGY_HOME = `${HOME}/.gemini/antigravity-cli`;

/** Midday UTC on 1 October 2026. */
export const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A generic conversation id whose last two characters are these. */
export const conversationId = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;

/** A time as agy writes `created_at`: ISO 8601, in UTC. */
export const at = (ms: number) => new Date(ms).toISOString();

/** Where a conversation's transcript is, under an agy folder. */
export function transcriptPath(home: string, id: string): string {
  return `${home}/brain/${id}/.system_generated/logs/transcript.jsonl`;
}

/** Where a conversation's database is, or its write-ahead log, under an agy folder. */
export function databasePath(home: string, id: string, log = false): string {
  return `${home}/conversations/${id}.db${log ? "-wal" : ""}`;
}

/** Words that stand for what a person or the model wrote, which the adapter must never keep. */
export const PRIVATE_WORDS = "rename the helper in demo-project and keep the old name";

export interface StepFields {
  index: number;
  type: string;
  status?: string;
  at: number;
  source?: string;
  /** Tool calls the step asks for, by tool name. */
  tools?: string[];
}

/** One transcript line, with its newline, carrying text in every field the adapter must drop. */
export function step(fields: StepFields): string {
  const line: Record<string, unknown> = {
    step_index: fields.index,
    source: fields.source ?? (fields.type === "USER_INPUT" ? "USER_EXPLICIT" : "MODEL"),
    type: fields.type,
    status: fields.status ?? "DONE",
    created_at: at(fields.at),
    content: `${fields.type.toLowerCase()}: ${PRIVATE_WORDS}`,
  };
  if (fields.type === "PLANNER_RESPONSE") line.thinking = `thinking about ${PRIVATE_WORDS}`;
  if (fields.tools) {
    line.tool_calls = fields.tools.map((name) => ({
      name,
      args: { CommandLine: "npm test", Path: "/Users/example/code/demo/notes.md" },
    }));
  }
  if (fields.type === "USER_INPUT") line.media = [];
  return `${JSON.stringify(line)}\n`;
}

/**
 * A whole turn, from the person's prompt to the model's last reply, that began
 * at `start` and took four seconds: the prompt, a reply asking to run a
 * command, the command, and a reply with no tool call.
 */
export function finishedTurn(firstIndex: number, start: number): string[] {
  return [
    step({ index: firstIndex, type: "USER_INPUT", at: start }),
    step({
      index: firstIndex + 1,
      type: "PLANNER_RESPONSE",
      at: start + SECOND,
      tools: ["run_command"],
    }),
    step({ index: firstIndex + 2, type: "RUN_COMMAND", at: start + 2 * SECOND }),
    step({ index: firstIndex + 3, type: "PLANNER_RESPONSE", at: start + 4 * SECOND }),
  ];
}

/** A turn still going: the prompt, a reply asking to run a command, and the command running. */
export function workingTurn(firstIndex: number, start: number): string[] {
  return [
    step({ index: firstIndex, type: "USER_INPUT", at: start }),
    step({
      index: firstIndex + 1,
      type: "PLANNER_RESPONSE",
      at: start + SECOND,
      tools: ["run_command"],
    }),
    step({ index: firstIndex + 2, type: "RUN_COMMAND", status: "RUNNING", at: start + 2 * SECOND }),
  ];
}

/** A turn that ended on an error agy reports itself, such as the model being unavailable. */
export function failedTurn(firstIndex: number, start: number): string[] {
  return [
    step({ index: firstIndex, type: "USER_INPUT", at: start }),
    step({
      index: firstIndex + 1,
      type: "ERROR_MESSAGE",
      status: "DONE",
      source: "SYSTEM",
      at: start + SECOND,
    }),
  ];
}

/** What `ps -o lstart=` prints in UTC for a moment, as the table has it. */
export function lstart(ms: number): string {
  const date = new Date(ms);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const two = (value: number) => String(value).padStart(2, "0");
  return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, " ")} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} ${date.getUTCFullYear()}`;
}

const two = (value: number) => String(value).padStart(2, "0");

/**
 * One line of an agy program's own log, in the glog format agy 1.3.1 writes:
 * the level, the month and day, the local time, a thread, the source line and
 * the message.
 */
export function logLine(
  ms: number,
  message: string,
  source = "server.go:100",
  level = "I",
): string {
  const date = new Date(ms);
  const micro = String(date.getMilliseconds() * 1000).padStart(6, "0");
  return `${level}${two(date.getMonth() + 1)}${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${micro}     787 ${source}] ${message}\n`;
}

/** The name agy gives the log of a program that started at this moment, in local time. */
export function logName(ms: number): string {
  const date = new Date(ms);
  return `cli-${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}_${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}.log`;
}

/** Where a program's log is, under an agy folder. */
export function logPath(home: string, name: string): string {
  return `${home}/log/${name}`;
}

/** Where a conversation's title is, under an agy folder. */
export function annotationPath(home: string, id: string): string {
  return `${home}/annotations/${id}.pbtxt`;
}

/** A folder an agy program works in. */
export const WORKSPACE = "/Users/example/code/demo-project";

/**
 * The log of a program that started at `start`, began a conversation, and
 * asks for approval of a command at `step`, with lines of other kinds around
 * them carrying words the adapter must never keep.
 */
export function askingLog(start: number, id: string, step: number, folder = WORKSPACE): string[] {
  return [
    logLine(start + 1 * SECOND, `Starting CLI ${PRIVATE_WORDS}`, "main.go:12"),
    logLine(
      start + 1 * SECOND,
      `Creating CLI server backend: product=antigravity workspaceDirs=[${folder}] appDataDir=${HOME}/.gemini/antigravity-cli`,
      "server.go:323",
    ),
    logLine(start + 2 * SECOND, `Error report: ${PRIVATE_WORDS}`, "errorreport.go:224", "E"),
    logLine(start + 20 * SECOND, "Starting new conversation (agent=false)"),
    logLine(start + 20 * SECOND, `Created conversation ${id}`, "server.go:1263"),
    streamingLine(start + 20 * SECOND, id),
    logLine(
      start + 20 * SECOND,
      `Sending user message to conversation ${id} (items=1, media=0)`,
      "server.go:1840",
    ),
    askingLine(start + 25 * SECOND, step),
  ];
}

/** The line agy logs when a program opens a conversation, by starting it or switching to it. */
export function streamingLine(ms: number, id: string): string {
  return logLine(ms, `Streaming conversation ${id}`, "conversation_manager.go:967");
}

/** The line agy logs when it asks for approval of a tool at `step`. */
export function askingLine(ms: number, step: number, tool = "RunCommand"): string {
  return logLine(
    ms,
    `Surfacing tool confirmation: "${tool}" at step ${step}`,
    "tool_confirmation_manager.go:226",
  );
}

/** The line agy logs once the person answers the approval asked at `step`, as agy 1.3.1 was seen to write it. */
export function answeredLine(ms: number, id: string, step: number, approved = true): string {
  return logLine(
    ms,
    `Responding to tool confirmation: convID=${id}, stepIdx=${step}, approved=${approved}, sandboxOverride=false, persistGrants=[]`,
    "input_loop.go:706",
  );
}
