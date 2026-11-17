// Test fixtures only. Every id, name, path and word here is invented and
// generic. A session file, a session lease, a worker's record and a worker's
// recovery journal follow the shapes Prime Agent's source writes at v0.10.3
// (`crates/pa-types/src/session.rs`, `crates/pa-daemon/src/lease.rs`,
// `crates/pa-types/src/daemon/worker.rs` and `crates/pa-daemon/src/journal.rs`),
// as written up in docs/adapters/prime-agent.md, and nothing in them is copied
// from a real machine: Prime Agent was not run to make them. Product code
// never imports this file.

import { DAY, HOUR, MINUTE, NOW, SECOND, sessionIdOf } from "@tests/fixtures/pi/pi";

export { DAY, HOUR, MINUTE, NOW, SECOND, sessionIdOf };

export const HOME = "/Users/example";

/** Where the adapter looks when nothing names another folder. */
export const AGENT_DIR = `${HOME}/.prime/agent`;
export const SESSIONS_DIR = `${AGENT_DIR}/sessions`;
export const LEASES_DIR = `${AGENT_DIR}/session-leases`;
export const WORKERS_DIR = `${AGENT_DIR}/daemon-workers`;

/** The folder the fixture's sessions run in. */
export const PROJECT = `${HOME}/code/demo-project`;

/** A session started an hour before the fixture's clock. */
export const STARTED_AT = NOW - HOUR;

export const SESSION_ID = sessionIdOf(1);

/** Words written where a prompt, a reply, a queued message or a tool's output goes. None may leave a file. */
export const PRIVATE_WORDS = "placeholder words that must never leave the file";

/** Written where a lease's token goes. It must never leave the parse of the lease. */
export const LEASE_TOKEN = "placeholder-lease-token-that-must-never-leave";

/** A folder name in a lease's `sessionPath`, which must never leave the parse either. */
export const PRIVATE_FOLDER = "placeholder-folder-that-must-never-leave";

/** Written where a worker's record keeps its token, its key, its prompts and its environment. */
export const WORKER_SECRET = "placeholder-worker-secret-that-must-never-leave";

/** A time as Prime Agent writes one (`now_iso` in `util.rs`): 24 characters, in UTC. */
export const iso = (at: number) => new Date(at).toISOString();

/** A session's file, named as Prime Agent names one: its ID, then `.jsonl`. */
export const sessionFileOf = (id: string, dir = SESSIONS_DIR) => `${dir}/${id}.jsonl`;

export const SESSION_FILE = sessionFileOf(SESSION_ID);

/** One line of a session file or a journal, as `serde_json` writes each, with no spaces. */
export const line = (fields: unknown) => `${JSON.stringify(fields)}\n`;

/** A session's header, with `type` first and the rest in `SessionHeader`'s order, as a worker writes one. */
export function headerFields(id: string, changes: Record<string, unknown> = {}) {
  return {
    type: "session",
    version: 3,
    id,
    timestamp: iso(STARTED_AT),
    cwd: PROJECT,
    rlmDepth: 0,
    ...changes,
  };
}

/** What `/name`, `/new --name`, a rename and `rlm.rename` write. */
export const nameLine = (name: string, at = NOW - 30 * MINUTE) =>
  line({ type: "session_info", id: "a0b1c2d3", parentId: "b1c2d3e4", timestamp: iso(at), name });

/** Lines that hold what was said, with placeholder words where it goes. */
export function conversationLines(at = STARTED_AT): string {
  const base = (type: string, id: string) => ({
    type,
    id,
    parentId: "c2d3e4f5",
    timestamp: iso(at),
  });
  return [
    line({ ...base("model_change", "d3e4f5a6"), provider: "demo-provider", modelId: "demo-model" }),
    line({ ...base("session_state", "e4f5a6b7"), state: { status: "active" } }),
    line({ ...base("message", "f5a6b7c8"), message: { role: "user", content: PRIVATE_WORDS } }),
    line({
      ...base("message", "a6b7c8d9"),
      message: {
        role: "assistant",
        content: [{ type: "text", text: PRIVATE_WORDS }],
        stopReason: "stop",
      },
    }),
    line({ ...base("custom_message", "b7c8d9e0"), customType: "demo", content: PRIVATE_WORDS }),
  ].join("");
}

/** A whole session file: its header, then the lines given, or a conversation. */
export const sessionText = (id: string, rest: string = conversationLines()) =>
  line(headerFields(id)) + rest;

/** A worker's ID, as Prime Agent makes one: 12 lowercase hex digits. */
export const workerIdOf = (n: number) => `a1b2c3d4${String(n).padStart(4, "0")}`;

export const WORKER_ID = workerIdOf(1);

/** The folder of one daemon's workers: 12 hex digits of the hash of its socket's path. */
export const HASH = "0f1e2d3c4b5a";
export const OTHER_HASH = "a5b4c3d2e1f0";

export const workersFolderOf = (hash = HASH) => `${WORKERS_DIR}/${hash}`;

/** A worker's journal. */
export const journalOf = (worker = WORKER_ID, hash = HASH) =>
  `${workersFolderOf(hash)}/${worker}.recovery.jsonl`;

/** A worker's record, which the adapter must never open. */
export const workerRecordOf = (worker = WORKER_ID, hash = HASH) =>
  `${workersFolderOf(hash)}/${worker}.json`;

/** A lease's folder: 64 hex digits, as the SHA-256 of a session file's path, and `.lock`. */
export const leaseNameOf = (n: number) => `${String(n).padStart(4, "0")}${"ab".repeat(30)}.lock`;

export const leaseOf = (n: number, dir = LEASES_DIR) => `${dir}/${leaseNameOf(n)}`;

export const ownerOf = (n: number, dir = LEASES_DIR) => `${leaseOf(n, dir)}/owner.json`;

/** The process the fixture's lease names. */
export const PID = 4242;

/** A process start as `ps -o lstart=` prints one in the C locale and UTC, and as `strftime("%c")` makes one. */
export function lstartOf(at: number): string {
  const date = new Date(at);
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
  const two = (n: number) => String(n).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, " ");
  const time = `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`;
  return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${day} ${time} ${date.getUTCFullYear()}`;
}

/** When the fixture's process started: a little before its lease was taken. */
export const PROCESS_STARTED_AT = STARTED_AT - 5 * SECOND;

/** The start Prime Agent writes on macOS for that process. */
export const PS_START_ID = `ps:${lstartOf(PROCESS_STARTED_AT)}`;

/** A process's start on Linux, in clock ticks since the boot. */
export const START_TICKS = "123456";

/** The start Prime Agent writes on Linux. */
export const PROC_START_ID = `proc:${START_TICKS}`;

/** A `/proc/<pid>/stat` line, as Linux writes one, whose field 22 is `ticks`. */
export function statLine(pid: number, ticks: string, program = "prime-agent"): string {
  const after = [
    "S",
    "1",
    pid,
    pid,
    "0",
    "-1",
    "4194560",
    "100",
    "0",
    "0",
    "0",
    "5",
    "3",
    "0",
    "0",
  ];
  const rest = ["20", "0", "4", "0", ticks, "123456789", "2048"];
  return `${pid} (${program}) ${[...after, ...rest].join(" ")}\n`;
}

export interface OwnerFields {
  pid?: unknown;
  processStartId?: unknown;
  activeSessionId?: unknown;
  sessionPath?: unknown;
  createdAt?: unknown;
  version?: unknown;
  token?: unknown;
}

/**
 * A lease's `owner.json`, as `serde_json::to_string_pretty` writes it, with
 * placeholders in its token and in the folders of its session's path.
 */
export function ownerText(id: string, fields: OwnerFields = {}): string {
  const owner: Record<string, unknown> = {
    version: 1,
    token: LEASE_TOKEN,
    pid: PID,
    processStartId: PS_START_ID,
    activeSessionId: WORKER_ID,
    sessionPath: `/private/${PRIVATE_FOLDER}/.prime/agent/sessions/${id}.jsonl`,
    createdAt: iso(STARTED_AT),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) delete owner[key];
    else owner[key] = value;
  }
  return `${JSON.stringify(owner, null, 2)}\n`;
}

/** A worker's record, with placeholders wherever Prime Agent keeps a secret or a prompt. */
export function workerRecordText(worker = WORKER_ID): string {
  return `${JSON.stringify(
    {
      version: 2,
      workerId: worker,
      pid: PID,
      socketPath: `/tmp/prime-agent-501/worker-${HASH}-${worker}.sock`,
      recoveryJournalPath: journalOf(worker),
      supervisorSocketPath: "/tmp/prime-agent-501/daemon.sock",
      authenticationToken: WORKER_SECRET,
      rootActiveSessionId: worker,
      sessionFile: `/private/${PRIVATE_FOLDER}/other.jsonl`,
      createdAt: iso(STARTED_AT),
      updatedAt: iso(STARTED_AT),
      lifecycle: "ready",
      createCommand: {
        cwd: PROJECT,
        apiKey: WORKER_SECRET,
        systemPrompt: WORKER_SECRET,
        env: { DEMO: WORKER_SECRET },
        runtimeMetadata: { prompt: WORKER_SECRET },
      },
      consecutiveFailures: 0,
    },
    null,
    2,
  )}\n`;
}

export interface RecordFields {
  activeSessionId?: string;
  sessionId?: string;
  /** The session's file, or null for a line with none. */
  sessionFile?: string | null;
  busy: boolean;
  operation: string;
  at: number;
}

/** A record line of a journal, keys in `WorkerRecoveryRecord`'s order. */
export function recordLine(fields: RecordFields): string {
  const sessionFile =
    fields.sessionFile === undefined
      ? `/private/${PRIVATE_FOLDER}/${SESSION_ID}.jsonl`
      : fields.sessionFile;
  return line({
    activeSessionId: fields.activeSessionId ?? WORKER_ID,
    sessionId: fields.sessionId ?? SESSION_ID,
    ...(sessionFile === null ? {} : { sessionFile }),
    busy: fields.busy,
    operation: fields.operation,
    recordedAt: iso(fields.at),
  });
}

/** A queued message, as a version 2 lane holds one, with placeholder words in its text and preview. */
export const queuedItem = (words = PRIVATE_WORDS) => ({
  message: words,
  priority: "human",
  preview: words,
  queue_visible: true,
  policy: "queued",
  forced_batch: false,
});

export interface QueueFields {
  activeSessionId?: string;
  suspended: boolean;
  at: number;
  steering?: unknown[];
  followUp?: unknown[];
}

/** A queue line of a journal, version 2, keys in `WorkerQueueSnapshotRecord`'s order. */
export function queueLine(fields: QueueFields): string {
  return line({
    version: 2,
    type: "queue_snapshot",
    active_session_id: fields.activeSessionId ?? WORKER_ID,
    steering: fields.steering ?? [queuedItem()],
    follow_up: fields.followUp ?? [],
    suspended: fields.suspended,
    recorded_at: iso(fields.at),
  });
}

/** A queue line of the first format, whose lanes are bare text. */
export function oldQueueLine(fields: QueueFields): string {
  return line({
    version: 1,
    type: "queue_snapshot",
    active_session_id: fields.activeSessionId ?? WORKER_ID,
    steering: [PRIVATE_WORDS],
    follow_up: [],
    suspended: fields.suspended,
    recorded_at: iso(fields.at),
  });
}

/** One checkpoint, as Prime Agent writes it: the queue line, then the record line. */
export const checkpoint = (record: RecordFields, suspended = false) =>
  queueLine({ activeSessionId: record.activeSessionId, suspended, at: record.at }) +
  recordLine(record);

/** The file a daemon keeps beside its workers' records. */
export const supervisorConfigText = () =>
  `${JSON.stringify({ version: 1, socketPath: "/tmp/prime-agent-501/daemon.sock" }, null, 2)}\n`;
