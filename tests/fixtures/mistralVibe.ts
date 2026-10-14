// Test fixtures only. Every id, time and word here is invented and generic.
// The files follow the layout Mistral Vibe 2.26.1's source writes, as written
// up in docs/adapters/mistral-vibe.md: a store for each session under
// `unified/<id>/`, with `CURRENT`, one generation's `manifest.json`,
// `projection-state.json` and `runtime-state.json`, and a journal segment,
// and a lease for each open session under `active/`. Every document is JSON
// as Vibe writes it, with its keys sorted, no spaces and a newline at the end.
// Nothing in them is copied from a real machine or a real session. Product
// code never imports this file.

export const HOME = "/Users/example";

/** Vibe's own folder, where it is when `VIBE_HOME` is not set. */
export const VIBE_HOME = `${HOME}/.vibe`;

/** The session folder the adapter reads when nothing names another. */
export const SESSION_DIR = `${VIBE_HOME}/logs/session`;

/** A folder a session works in. */
export const CWD = "/Users/example/code/demo";

/** Midday UTC on 1 October 2026. */
export const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A generic session id whose last two characters are these. */
export const sessionId = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;

/** A subagent's id, as Vibe makes one: `child-` and 24 hexadecimal digits. */
export const SUBAGENT_ID = "child-000000000000000000000001";

/** Words that stand for what a person or the model wrote, which the adapter must never keep. */
export const PRIVATE_WORDS = "rename the helper in demo-project and keep the old name";

/** A pid the stand-in says runs. */
export const LIVE_PID = 4242;

/** A pid the stand-in says does not run. */
export const GONE_PID = 4343;

/** JSON as Vibe writes it: keys sorted at every depth and no spaces, with no newline. */
export function canonical(value: unknown): string {
  return JSON.stringify(sorted(value));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
  );
}

/** A whole document as Vibe writes one: canonical JSON and a newline. */
export const document = (value: unknown) => `${canonical(value)}\n`;

/** A generation's name: 16 digits. */
export const generationName = (sequence: number) => String(sequence).padStart(16, "0");

/** The journal segment that follows a generation, by the record it begins with. */
export const segmentName = (firstSequence: number) =>
  `${String(firstSequence).padStart(16, "0")}.jsonl`;

/** An invented SHA-256, as Vibe writes digests. The adapter checks none. */
export const digest = (n: number) => n.toString(16).padStart(64, "0");

/** A time as Vibe writes one in its leases and manifests. */
export const isoTime = (ms: number) => new Date(ms).toISOString();

export interface TurnFields {
  status: "in_progress" | "completed" | "failed" | "interrupted" | string;
  startedAt: number;
  completedAt?: number;
  stopReason?: string | null;
}

export interface StateFields {
  id: string;
  title?: string | null;
  /** `session.status.type`. */
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  turn?: TurnFields | null;
  /** Keys a newer Vibe could add, at the top of the state and in `session`. */
  extra?: Record<string, unknown>;
}

/**
 * A session's public state, in camelCase as Vibe writes it, carrying the
 * first thing the person asked, an error and a queued turn in words the
 * adapter must never keep.
 */
export function publicState(fields: StateFields): Record<string, unknown> {
  const status = fields.status ?? "idle";
  const createdAt = fields.createdAt ?? NOW - HOUR;
  const turn = fields.turn === undefined ? null : fields.turn;
  const latestTurn =
    turn === null
      ? null
      : {
          id: "turn-1",
          sessionId: fields.id,
          status: turn.status,
          queueItemId: null,
          inputEntryId: "entry-1",
          startedAt: turn.startedAt,
          ...(turn.completedAt === undefined ? {} : { completedAt: turn.completedAt }),
          ...(turn.status === "completed" ? { stopReason: turn.stopReason ?? null } : {}),
          ...(turn.status === "failed"
            ? { error: { code: "provider_error", message: PRIVATE_WORDS, details: null } }
            : {}),
          ...(turn.status === "interrupted" ? { reason: PRIVATE_WORDS } : {}),
        };
  const sessionStatus: Record<string, unknown> = { type: status };
  if (status === "running") sessionStatus.activeTurnId = "turn-1";
  if (status === "failed") sessionStatus.message = PRIVATE_WORDS;
  return {
    format: "harness.public-session-state/v1",
    session: {
      id: fields.id,
      rootSessionId: fields.id,
      parentSessionId: null,
      title: fields.title === undefined ? "demo-project refactor" : fields.title,
      titleSource: "auto",
      preview: PRIVATE_WORDS,
      status: sessionStatus,
      createdAt,
      updatedAt: fields.updatedAt ?? createdAt,
      tokenUsage: null,
      contextUsage: null,
      ...fields.extra,
    },
    history: { range: "latest", entries: [], cursor: { before: null, after: null } },
    activeCallbacks: [],
    latestTurn,
    turnQueue: { items: [{ id: "queued-1", text: PRIVATE_WORDS }] },
    ...fields.extra,
  };
}

export interface StoreFields {
  id: string;
  /** The generation `CURRENT` names, by its snapshot sequence. Defaults to 4. */
  sequence?: number;
  state?: StateFields;
  cwd?: string | null;
  kind?: "root" | "fork" | "subagent" | string;
  lifecycle?: "active" | "deleting_tree";
  minor?: number;
  storeFormat?: string;
  /** Journal lines, each with its newline. Defaults to none: an empty segment. */
  journal?: string[];
}

/** The path of a session's store, relative to the session folder. */
export const storePath = (id: string) => `unified/${id}`;

/** The journal segment a store's manifest names, relative to the session folder. */
export const journalPath = (id: string, sequence = 4) =>
  `${storePath(id)}/journal/${segmentName(sequence + 1)}`;

/** `CURRENT`, naming a generation. */
export function current(fields: {
  id: string;
  sequence?: number;
  minor?: number;
  storeFormat?: string;
}): string {
  const sequence = fields.sequence ?? 4;
  return document({
    store_format: fields.storeFormat ?? "mistral.vibe.unified-session-store/v1",
    store_format_minor: fields.minor ?? 8,
    session_id: fields.id,
    generation: generationName(sequence),
    snapshot_sequence: sequence,
    manifest_sha256: digest(1),
  });
}

/** A generation's manifest. */
export function manifest(id: string, sequence = 4): string {
  return document({
    manifest_version: 1,
    session_id: id,
    generation: generationName(sequence),
    created_at: isoTime(NOW - HOUR),
    snapshot_sequence: sequence,
    execution_state: "quiescent",
    checkpoint: {
      path: "checkpoint.json",
      sha256: digest(2),
      chunks: [digest(3)],
      checkpoint_version: 1,
    },
    runtime_state: { path: "runtime-state.json", sha256: digest(4), chunks: [digest(5)] },
    projection_state: { path: "projection-state.json", sha256: digest(6), chunks: [digest(7)] },
    recovery_journal_segment: {
      path: `journal/${segmentName(sequence + 1)}`,
      first_sequence: sequence + 1,
    },
  });
}

/** A generation's public state, with its history moved out to chunks as Vibe 2.26.1 does. */
export function projectionState(id: string, state: StateFields, sequence = 4): string {
  return document({
    projection_state_version: 1,
    session_id: id,
    snapshot_sequence: sequence,
    watermark: 12,
    snapshot: publicState({ ...state, id }),
  });
}

/** A generation's runtime state, carrying a request and an import in words the adapter must never keep. */
export function runtimeState(
  id: string,
  fields: { cwd?: string | null; kind?: string; lifecycle?: string; sequence?: number } = {},
): string {
  const kind = fields.kind ?? "root";
  return document({
    runtime_state_version: 3,
    storage_lifetime: "persistent",
    session_id: id,
    snapshot_sequence: fields.sequence ?? 4,
    session_metadata: {
      cwd: fields.cwd === undefined ? CWD : fields.cwd,
      active_model: "demo-model",
      agent_name: "default",
      root_session_id: id,
      parent_session_id: kind === "root" ? null : sessionId("ff"),
      hook_bindings: [],
    },
    identity: {
      kind,
      session_id: id,
      root_session_id: kind === "root" ? id : sessionId("ff"),
      parent_session_id: kind === "root" ? null : sessionId("ff"),
      depth: kind === "subagent" ? 1 : 0,
    },
    lifecycle:
      fields.lifecycle === "deleting_tree"
        ? { type: "deleting_tree", ordered_child_session_ids: [], deleted_child_session_ids: [] }
        : { type: "active" },
    command_receipts: [],
    actions: [{ action_id: "action-1", state: "succeeded", request: { input: PRIVATE_WORDS } }],
    callbacks: [
      {
        callback_id: "callback-1",
        kind: "approval",
        state: "resolved",
        routing: { detail: { effect: { input: { command: PRIVATE_WORDS } } } },
      },
    ],
    provider_operations: [],
    processes: [],
    submitted_process_notifications: [],
    plugin_lock: {},
    children: [],
    import_provenance: { source: { backend: "legacy", session_id: PRIVATE_WORDS } },
  });
}

/**
 * Every file of one session's store, by its path relative to the session
 * folder: what the adapter reads, and beside it files holding the whole
 * conversation that it must never open.
 */
export function storeFiles(fields: StoreFields): Record<string, string> {
  const { id } = fields;
  const sequence = fields.sequence ?? 4;
  const root = storePath(id);
  const generation = `${root}/generations/${generationName(sequence)}`;
  return {
    [`${root}/CURRENT`]: current({
      id,
      sequence,
      minor: fields.minor,
      storeFormat: fields.storeFormat,
    }),
    [`${generation}/manifest.json`]: manifest(id, sequence),
    [`${generation}/projection-state.json`]: projectionState(
      id,
      fields.state ?? { id, status: "idle" },
      sequence,
    ),
    [`${generation}/runtime-state.json`]: runtimeState(id, {
      cwd: fields.cwd,
      kind: fields.kind,
      lifecycle: fields.lifecycle,
      sequence,
    }),
    [`${generation}/checkpoint.json`]: document({ context: { messages: [PRIVATE_WORDS] } }),
    [`${root}/chunks/${digest(7)}.json`]: document([{ id: "entry-1", text: PRIVATE_WORDS }]),
    [`${root}/meta.json`]: document({ title: PRIVATE_WORDS, username: PRIVATE_WORDS }),
    [journalPath(id, sequence)]: (fields.journal ?? []).join(""),
  };
}

/** One journal record's line, with its newline: the payload first and the type last, as Vibe lays it out. */
export function record(type: string, sequence: number, payload: unknown): string {
  const header = canonical({
    previous_record_sha256: sequence > 1 ? digest(100 + sequence - 1) : null,
    record_sha256: digest(100 + sequence),
    recovery_journal_record_version: 1,
    sequence,
    type,
  });
  return `{"payload":${canonical(payload)},${header.slice(1)}\n`;
}

/**
 * A `projection_delta` record: steps that add history entries, holding words
 * the adapter must never keep, and, when `state` is given, the new public
 * state last, with its history left out.
 */
export function delta(
  sequence: number,
  state?: StateFields,
  entries: unknown[] = [{ id: `entry-${sequence}`, type: "message", text: PRIVATE_WORDS }],
): string {
  const steps: unknown[] = entries.map((entry) => ({ op: "append_entry", entry }));
  if (state) steps.push({ op: "set_envelope", state: publicState(state) });
  return record("projection_delta", sequence, { delta: steps, watermark: sequence });
}

/** A record of another kind, carrying words the adapter must never keep. */
export function otherRecord(type: string, sequence: number): string {
  return record(type, sequence, { action_id: `action-${sequence}`, request: PRIVATE_WORDS });
}

/** A lease's `<id>.lock.json`, as Vibe writes it. */
export function leaseFile(id: string, pid: unknown = LIVE_PID, acquiredAt = NOW - HOUR): string {
  return document({
    acquired_at: isoTime(acquiredAt),
    lease_version: 1,
    process_id: pid,
    session_id: id,
  });
}
