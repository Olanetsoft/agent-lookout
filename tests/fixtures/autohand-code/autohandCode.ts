// Autohand Code's files, written by hand the way Autohand Code 0.9.11 writes
// them, `JSON.stringify(value, null, 2)` and a line break, with the keys in
// the order its writers put them (`src/session/ActiveAgentRegistry.ts:224-243`,
// `src/session/peers/PeerMessaging.ts:257-265`,
// `src/session/SessionManager.ts:142-153`,
// `src/import/importers/BaseImporter.ts:198-216`,
// `src/session/transfer/transfer-session-store.ts:64-66`). Every value is made
// up: the folders are under /Users/example and the project is demo-project.
//
// The text Agent Lookout must never turn into text is written with words found
// nowhere else, in plain, non-ASCII and escaped forms, so a test can look for
// them in anything the adapter made.

export const HOME = "/Users/example";
export const AUTOHAND_HOME = `${HOME}/.autohand`;
export const HEARTBEATS_DIR = `${AUTOHAND_HOME}/active-agents`;
export const SESSIONS_DIR = `${AUTOHAND_HOME}/sessions`;
export const PROJECT = "/Users/example/code/demo-project";

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The time the tests are run at. */
export const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

/** When the sessions were made, an hour before. */
export const CREATED_AT = NOW - HOUR;

export const PID = 4242;
export const OTHER_PID = 4343;

/** Session IDs as Autohand Code makes them, `<uuid>-<milliseconds>`. */
export const SESSION_ID = "0b5d6c1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e-1762772400000";
export const OTHER_SESSION_ID = "1c6e7d2f-3a4b-4c5d-9e6f-7a8b9c0d1e2f-1762772400001";

/** An instance's ID, as one heartbeat's name holds it with peer communication on. */
export const INSTANCE_ID = "2d7f8e3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a";

/** Words that must never reach anything the adapter makes. */
export const CANARIES = {
  instruction: "Instruction-canary-ÅØ-quartz",
  command: "command-canary-ß-ember",
  written: "src/written-canary-ü-lantern.ts",
  claim: "src/claim-canary-ñ-harbor.ts",
  branch: "branch-canary-é-willow",
  endpoint: "/tmp/endpoint-canary-ä-socket.sock",
  publicKey: "publickey-canary-ö-granite",
  alias: "alias-canary-ç-meadow",
  summary: "summary-canary-ê-orchard",
  autoTitle: "autotitle-canary-ï-thistle",
  automode: "automode-canary-ō-pebble",
  readFile: "src/readfile-canary-ū-cedar.ts",
  account: "account-canary-ś-birch",
  branchSource: "branchsource-canary-ž-fern",
  secret: "secret-canary-ł-config-key",
} as const;

/**
 * The word every canary holds, in every form JSON can write it in: only
 * letters past ASCII are escaped, so it is there whether a file is read as it
 * is or parsed.
 */
export const CANARY_MARK = "canary";

/** A time as Autohand Code writes one. */
export const iso = (ms: number) => new Date(ms).toISOString();

/** Text written as Autohand Code writes a file. */
export const written = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Text written with every character past ASCII escaped, as another writer could. */
export const writtenEscaped = (value: unknown) =>
  [...written(value)]
    .map((c) =>
      c.charCodeAt(0) > 0x7f ? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}` : c,
    )
    .join("");

export type Phase = "idle" | "thinking" | "editing" | "running_command" | "waiting_input";

export interface HeartbeatOptions {
  pid?: number;
  sessionId?: string;
  workspaceRoot?: string;
  mode?: string;
  status?: string;
  updatedAt?: number;
  startedAt?: number;
  phase?: string | null;
  /** With peer communication on: the advertisement, which the main writer puts after `activity`. */
  communication?: boolean;
  version?: number;
}

function activity(phase: string) {
  return {
    phase,
    instruction: `${CANARIES.instruction} \n  "pid": 1, \n  "status": "completed"`,
    command: CANARIES.command,
    pathsWritten: [CANARIES.written],
    claims: [CANARIES.claim],
    headRef: { branch: CANARIES.branch, sha: "0123456789abcdef0123456789abcdef01234567" },
  };
}

function communication() {
  return {
    protocol: 1,
    instanceId: INSTANCE_ID,
    endpoint: CANARIES.endpoint,
    publicKey: CANARIES.publicKey,
    capabilities: ["message.send"],
    alias: CANARIES.alias,
    scope: "workspace",
    workspaceId: PROJECT,
  };
}

/** A heartbeat's record as the main writer builds it (`src/session/ActiveAgentRegistry.ts:224-243`). */
export function heartbeatRecord(options: HeartbeatOptions = {}): Record<string, unknown> {
  const phase = options.phase === undefined ? "thinking" : options.phase;
  return {
    version: options.version ?? 1,
    pid: options.pid ?? PID,
    sessionId: options.sessionId ?? SESSION_ID,
    workspaceRoot: options.workspaceRoot ?? PROJECT,
    projectName: "demo-project",
    provider: "openrouter",
    model: "example/model",
    mode: options.mode ?? "interactive",
    status: options.status ?? (phase === "idle" ? "idle" : "working"),
    startedAt: iso(options.startedAt ?? CREATED_AT),
    updatedAt: iso(options.updatedAt ?? NOW),
    messageCount: 4,
    contextPercent: 81,
    tokensUsed: 1200,
    tokensUsageStatus: "actual",
    sessionTokensUsed: 5400,
    ...(phase === null ? {} : { activity: activity(phase) }),
    ...(options.communication ? { communication: communication() } : {}),
  };
}

/** A heartbeat as the main writer writes it. */
export const heartbeat = (options: HeartbeatOptions = {}) => written(heartbeatRecord(options));

/**
 * A heartbeat as the presence writer writes it, once, as peer communication
 * starts (`src/session/peers/PeerMessaging.ts:254-268`): the folder's real
 * path, mode `interactive`, and `communication` before `activity`.
 */
export function presenceHeartbeat(options: HeartbeatOptions = {}): string {
  const time = iso(options.updatedAt ?? NOW);
  const phase = options.phase ?? "thinking";
  return written({
    version: 1,
    pid: options.pid ?? PID,
    sessionId: options.sessionId ?? SESSION_ID,
    workspaceRoot: options.workspaceRoot ?? "/private/Users/example/code/demo-project",
    projectName: "demo-project",
    provider: "peer",
    model: "",
    mode: "interactive",
    status: phase === "idle" ? "idle" : "working",
    startedAt: time,
    updatedAt: time,
    messageCount: 0,
    contextPercent: 0,
    tokensUsed: 0,
    communication: communication(),
    activity: { phase, pathsWritten: [] },
  });
}

/** A heartbeat as Autohand Code 0.9.3 wrote it, with no `communication`. */
export const oldHeartbeat = (options: HeartbeatOptions = {}) =>
  written(heartbeatRecord({ ...options, communication: false }));

export interface MetadataOptions {
  sessionId?: string;
  createdAt?: number;
  lastActiveAt?: number;
  closedAt?: number;
  status?: string;
  projectPath?: string;
  client?: string;
  title?: string;
  titleSource?: "user" | "auto";
  importedAt?: number;
  /** A summary of the session's own: the start of the last message. */
  summary?: string;
  automode?: boolean;
  fork?: boolean;
}

/**
 * A `metadata.json` as `createSession` makes it and a session's life adds to
 * it (`src/session/SessionManager.ts:142-153`), with a title, usage, the files
 * read and, once closed, `closedAt` and `summary` after them.
 */
export function metadataRecord(options: MetadataOptions = {}): Record<string, unknown> {
  const createdAt = options.createdAt ?? CREATED_AT;
  const record: Record<string, unknown> = {
    sessionId: options.sessionId ?? SESSION_ID,
    createdAt: iso(createdAt),
    lastActiveAt: iso(options.lastActiveAt ?? NOW - 30 * SECOND),
    projectPath: options.projectPath ?? PROJECT,
    projectName: "demo-project",
    model: "example/model",
    messageCount: 4,
    status: options.status ?? "active",
    client: options.client ?? "terminal",
  };
  if (options.automode) {
    record.type = "automode";
    record.automodePrompt = CANARIES.automode;
  }
  if (options.titleSource !== undefined) {
    record.title = options.title ?? CANARIES.autoTitle;
    record.titleSource = options.titleSource;
  }
  record.usage = { promptTokens: 900, completionTokens: 300, totalTokens: 1200, turnCount: 2 };
  record.readFileState = {
    schemaVersion: 1,
    entries: [{ path: CANARIES.readFile, revision: 1, complete: true, views: [] }],
  };
  if (options.fork) {
    record.branch = {
      type: "fork",
      sourceSessionId: CANARIES.branchSource,
      createdAt: iso(createdAt),
    };
  }
  if (options.closedAt !== undefined) record.closedAt = iso(options.closedAt);
  record.summary =
    options.summary ?? `${CANARIES.summary} \n  "status": "completed" \n  "titleSource": "user"`;
  if (options.importedAt !== undefined) {
    record.importedFrom = {
      source: "Claude",
      originalId: "example-original",
      accountId: CANARIES.account,
      importedAt: iso(options.importedAt),
    };
  }
  return record;
}

export const metadata = (options: MetadataOptions = {}) => written(metadataRecord(options));

/** A `metadata.json` as the importer writes it, `summary` before `status` (`src/import/importers/BaseImporter.ts:198-214`). */
export function importedMetadata(options: MetadataOptions & { importedAt: number }): string {
  return written({
    sessionId: options.sessionId ?? SESSION_ID,
    createdAt: iso(options.createdAt ?? CREATED_AT),
    lastActiveAt: iso(options.lastActiveAt ?? options.closedAt ?? CREATED_AT),
    ...(options.closedAt === undefined ? {} : { closedAt: iso(options.closedAt) }),
    projectPath: options.projectPath ?? PROJECT,
    projectName: "demo-project",
    model: "example/model",
    messageCount: 6,
    summary: CANARIES.summary,
    status: options.status ?? "completed",
    importedFrom: {
      source: "Claude",
      originalId: "example-original",
      importedAt: iso(options.importedAt),
    },
  });
}

/**
 * A `metadata.json` as a web transfer writes it
 * (`src/session/transfer/transfer-session-store.ts:64-66`), or, with a later
 * `lastActiveAt`, as a resume of it saves it.
 */
export function transferredMetadata(options: {
  importedAt: number;
  sessionId?: string;
  lastActiveAt?: number;
}): string {
  return JSON.stringify(
    {
      sessionId: options.sessionId ?? SESSION_ID,
      projectPath: PROJECT,
      projectName: "demo-project",
      model: "example/model",
      createdAt: iso(CREATED_AT),
      lastActiveAt: iso(options.lastActiveAt ?? options.importedAt),
      messageCount: 3,
      status: "completed",
      summary: CANARIES.summary,
      client: "web",
      importedFrom: {
        source: "Autohand Code Web",
        originalId: "example-transfer",
        accountId: CANARIES.account,
        importedAt: iso(options.importedAt),
      },
    },
    null,
    2,
  );
}

/** A heartbeat's path. */
export const heartbeatPath = (name = `${SESSION_ID}.json`) => `${HEARTBEATS_DIR}/${name}`;

/** A session's folder and its `metadata.json`. */
export const sessionDir = (id = SESSION_ID) => `${SESSIONS_DIR}/${id}`;
export const metadataPath = (id = SESSION_ID) => `${sessionDir(id)}/metadata.json`;
