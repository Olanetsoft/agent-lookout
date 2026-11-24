// Test fixtures only. Every id, time and word here is invented and generic.
// The files follow the layout the source of Mistral Vibe 2.26.1 and 3.0.4
// writes, with a journal record's `session_api`, the history's entries and
// steps and its pieces in `chunks/` as 3.1.4 writes them, as written up in
// docs/adapters/mistral-vibe.md: a store for each session under
// `unified/<id>/`, with `CURRENT`, one generation's `manifest.json`,
// `projection-state.json` and `runtime-state.json`, a journal segment and the
// pieces of the history, and a lease for each open session under `active/`. Every document is JSON
// as Vibe writes it, with its keys sorted, no spaces and a newline at the end.
// Nothing in them is copied from a real machine or a real session. Product
// code never imports this file.

import { createHash } from "node:crypto";

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
  /** Vibe's id for the turn. Defaults to `turn-1`. */
  id?: string;
  status: "in_progress" | "completed" | "failed" | "interrupted" | string;
  startedAt: number;
  completedAt?: number;
  stopReason?: string | null;
}

/** A reply's usage as Vibe writes it in `session.contextUsage`: its total is the input and the output together. */
export const usage = (input: number, output: number, cached = 0) => ({
  cachedInputTokens: cached,
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
});

export interface StateFields {
  id: string;
  title?: string | null;
  /** `session.status.type`. */
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  turn?: TurnFields | null;
  /** `session.contextUsage`, as `usage` gives it, or anything a test puts there. Defaults to null. */
  contextUsage?: unknown;
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
          id: turn.id ?? "turn-1",
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
  if (status === "running") sessionStatus.activeTurnId = turn?.id ?? "turn-1";
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
      contextUsage: fields.contextUsage === undefined ? null : fields.contextUsage,
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
  /** Callbacks the generation saved, beside the settled one every store here has. */
  callbacks?: SavedCallback[];
  /**
   * The pieces of the history the generation saved, oldest first, as
   * `historyChunk` makes them, which the manifest names and `chunks/` holds.
   * Left out, the manifest names one piece that `chunks/` holds with other bytes.
   */
  historyChunks?: HistoryChunk[];
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

/**
 * A generation's manifest. `historyChunks` are the names of the pieces of the
 * history, oldest first, and null leaves the list out, as for a history kept
 * whole. Left out, it names one piece that the store holds under that name
 * with other bytes.
 */
export function manifest(id: string, sequence = 4, historyChunks: unknown = [digest(7)]): string {
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
    projection_state: {
      path: "projection-state.json",
      sha256: digest(6),
      ...(historyChunks === null ? {} : { chunks: historyChunks }),
    },
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
  fields: {
    cwd?: string | null;
    kind?: string;
    lifecycle?: string;
    sequence?: number;
    callbacks?: SavedCallback[];
  } = {},
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
      ...(fields.callbacks ?? []),
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
    [`${generation}/manifest.json`]: manifest(
      id,
      sequence,
      fields.historyChunks === undefined
        ? [digest(7)]
        : fields.historyChunks.map(({ name }) => name),
    ),
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
      callbacks: fields.callbacks,
    }),
    [`${generation}/checkpoint.json`]: document({ context: { messages: [PRIVATE_WORDS] } }),
    [`${root}/chunks/${digest(7)}.json`]: document([{ id: "entry-1", text: PRIVATE_WORDS }]),
    // A piece of the checkpoint, which shares the folder, holding a reply the adapter must never take.
    [`${root}/chunks/${digest(3)}.json`]: document([
      replyEntry("assistant-checkpoint", PRIVATE_WORDS),
    ]),
    ...Object.fromEntries(
      (fields.historyChunks ?? []).map(({ name, body }) => [`${root}/chunks/${name}.json`, body]),
    ),
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
 * state last, with its history left out. With `sessionApi`, it is a record of
 * Vibe 3.1's, whose `session_api` comes between `delta` and `watermark`.
 */
export function delta(
  sequence: number,
  state?: StateFields,
  entries: unknown[] = [{ id: `entry-${sequence}`, type: "message", text: PRIVATE_WORDS }],
  sessionApi?: unknown,
): string {
  const steps: unknown[] = entries.map((entry) => ({ op: "append_entry", entry }));
  if (state) steps.push({ op: "set_envelope", state: publicState(state) });
  const payload =
    sessionApi === undefined
      ? { delta: steps, watermark: sequence }
      : { delta: steps, session_api: sessionApi, watermark: sequence };
  return record("projection_delta", sequence, payload);
}

/**
 * The Session API facts a record of Vibe 3.1's carries, as a journal keeps
 * them: the history's positions in `sparse_history`, how a turn ended, and a
 * tool call's id with the arguments the model wrote, as JSON.
 */
export function sessionApiFacts(
  toolArguments: unknown = { command: PRIVATE_WORDS },
): Record<string, unknown> {
  return {
    history_positions: {},
    metadata_version: 1,
    next_history_index: 0,
    sparse_history: { next_index: 3, positions: { "entry-1": 0, "entry-2": 1, "entry-3": 2 } },
    tool_calls: { "entry-2": { arguments: toolArguments, toolCallId: "call-1" } },
    turn_outcomes: {
      "turn-0": {
        completedAt: NOW - HOUR,
        startedAt: NOW - 2 * HOUR,
        termination: { type: "completed" },
      },
    },
  };
}

/** A record of another kind, carrying words the adapter must never keep. */
export function otherRecord(type: string, sequence: number): string {
  return record(type, sequence, { action_id: `action-${sequence}`, request: PRIVATE_WORDS });
}

export interface CallbackFields {
  id: string;
  /** Defaults to `approval`. */
  kind?: string;
  createdAt: number;
}

/**
 * What Vibe keeps of a callback, as `_approval_callback` and
 * `_user_input_callback` build one: what a tool was asked to run, why, and the
 * question, in words the adapter must never keep.
 */
export function callbackRouting(fields: CallbackFields): Record<string, unknown> {
  const { id, createdAt } = fields;
  const kind = fields.kind ?? "approval";
  return {
    type: "callback",
    id,
    sessionId: sessionId("a1"),
    turnId: "turn-1",
    createdAt,
    updatedAt: createdAt,
    generationStatus: "in_progress",
    relatedEntryId: "effect-action-1",
    inputEntryId: "entry-1",
    callbackId: id,
    title: kind === "approval" ? "Approve bash" : "User input required",
    detail:
      kind === "approval"
        ? {
            kind,
            effect: {
              kind: "tool",
              toolName: "bash",
              input: { command: PRIVATE_WORDS },
              display: { summary: "bash", message: PRIVATE_WORDS, statusText: PRIVATE_WORDS },
            },
            requiredPermissions: [],
            choices: [
              "approve",
              "approve_for_session",
              "approve_permanently",
              "deny",
              "cancel_turn",
            ],
            relatedEntryId: "effect-action-1",
            reason: PRIVATE_WORDS,
          }
        : { kind, request: { questions: [PRIVATE_WORDS] }, relatedEntryId: "call-1" },
    state: { status: "open" },
  };
}

/** A `callback_registered` record: Vibe asks for an approval or an answer. */
export function callbackRegistered(sequence: number, fields: CallbackFields): string {
  return record("callback_registered", sequence, {
    callback_id: fields.id,
    kind: fields.kind ?? "approval",
    routing: callbackRouting(fields),
  });
}

/**
 * A `callback_resolved` record. An answer, and an approval or a denial, are
 * `resolved`, with the person's words in the result. A callback closed by a
 * stopped turn, or an error sent back, is `failed`.
 */
export function callbackResolved(
  sequence: number,
  id: string,
  state: "resolved" | "failed" = "resolved",
  result: unknown = { callback_id: id, output: { result: PRIVATE_WORDS } },
): string {
  return record("callback_resolved", sequence, { callback_id: id, result, state });
}

/** A callback as a generation's `runtime-state.json` keeps it. */
export type SavedCallback = Record<string, unknown>;

/** A callback a generation saved as still pending. */
export function savedCallback(fields: CallbackFields): SavedCallback {
  return {
    callback_id: fields.id,
    kind: fields.kind ?? "approval",
    result: null,
    routing: callbackRouting(fields),
    state: "pending",
  };
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

/** A text block of a history entry. */
export const textBlock = (text: string) => ({ type: "text", text });

/** An image block of a reply, as the public history shows one. */
export const imageBlock = () => ({
  type: "image",
  attachment: {
    source: { kind: "inline", data: "aW1hZ2U=" },
    alias: "image",
    mimeType: "image/png",
  },
});

/** A resource block of a reply, holding words the adapter must never take. */
export const resourceBlock = () => ({
  type: "resource",
  resource: { kind: "text", uri: "file:///Users/example/code/demo/notes.md", text: PRIVATE_WORDS },
});

export interface ReplyFields {
  /** `completed`, as Vibe saves every reply, unless a test says otherwise. */
  generationStatus?: string;
  /** `{ type: "committed" }` unless a test says otherwise. Null leaves it out. */
  outcome?: unknown;
  turnId?: string;
}

/**
 * A reply in the public history, as Vibe 3.1.4 builds one (`_message_entry`):
 * its text as one text block, or the blocks given.
 */
export function replyEntry(
  id: string,
  content: string | unknown[],
  fields: ReplyFields = {},
): Record<string, unknown> {
  const outcome = fields.outcome === undefined ? { type: "committed" } : fields.outcome;
  return {
    type: "message",
    id,
    sessionId: sessionId("a1"),
    turnId: fields.turnId ?? "turn-1",
    createdAt: NOW - 2 * MINUTE,
    updatedAt: NOW - 2 * MINUTE,
    generationStatus: fields.generationStatus ?? "completed",
    relatedEntryId: null,
    inputEntryId: "user-1",
    role: "assistant",
    content: typeof content === "string" ? [textBlock(content)] : content,
    source: "harness",
    ...(outcome === null ? {} : { outcome }),
  };
}

/** A prompt in the public history, in words the adapter must never take. */
export function userEntry(id: string, text = PRIVATE_WORDS): Record<string, unknown> {
  return {
    type: "message",
    id,
    sessionId: sessionId("a1"),
    turnId: "turn-1",
    createdAt: NOW - 5 * MINUTE,
    updatedAt: NOW - 5 * MINUTE,
    generationStatus: "completed",
    relatedEntryId: null,
    inputEntryId: null,
    role: "user",
    content: [textBlock(text)],
    source: "turn_start",
  };
}

/** The model's thinking, an entry of its own, in words the adapter must never take. */
export function reasoningEntry(id: string): Record<string, unknown> {
  return {
    type: "reasoning",
    id,
    sessionId: sessionId("a1"),
    turnId: "turn-1",
    createdAt: NOW - 3 * MINUTE,
    updatedAt: NOW - 3 * MINUTE,
    generationStatus: "completed",
    relatedEntryId: null,
    inputEntryId: "user-1",
    text: PRIVATE_WORDS,
    summary: [PRIVATE_WORDS],
  };
}

/** A tool's call and its output, in words the adapter must never take. */
export function effectEntry(id: string): Record<string, unknown> {
  return {
    type: "effect",
    id,
    sessionId: sessionId("a1"),
    turnId: "turn-1",
    createdAt: NOW - 3 * MINUTE,
    updatedAt: NOW - 3 * MINUTE,
    generationStatus: "completed",
    relatedEntryId: null,
    inputEntryId: "user-1",
    detail: {
      kind: "tool",
      toolName: "bash",
      input: { command: PRIVATE_WORDS },
      display: { summary: "bash", message: PRIVATE_WORDS },
    },
    state: { status: "succeeded", outputText: PRIVATE_WORDS },
  };
}

/** A question Vibe asked and its answer, settled into the history. */
export function callbackEntry(id: string): Record<string, unknown> {
  return {
    ...callbackRouting({ id, kind: "user_input", createdAt: NOW - 3 * MINUTE }),
    generationStatus: "completed",
    state: { status: "resolved", result: { answers: [PRIVATE_WORDS] } },
  };
}

/** The mark a rewind leaves in the history. */
export function checkpointEntry(id: string): Record<string, unknown> {
  return {
    type: "checkpoint",
    id,
    sessionId: sessionId("a1"),
    turnId: null,
    createdAt: NOW - MINUTE,
    updatedAt: NOW - MINUTE,
    generationStatus: "completed",
    relatedEntryId: null,
    inputEntryId: null,
    kind: "rewind",
    message: "Conversation rewound",
    details: { entryId: "user-1", restoreFiles: false, inplace: true },
  };
}

/**
 * The mark Vibe 3.1.4 adds to the history as it takes up a turn a stopped Vibe
 * left, as `_resumed_entry` builds it: the `count`th such mark of the session.
 */
export function resumedEntry(at: number, turnId = "turn-1", count = 1): Record<string, unknown> {
  return {
    type: "checkpoint",
    id: `checkpoint-resumed-${count}`,
    sessionId: sessionId("a1"),
    turnId,
    createdAt: at,
    updatedAt: at,
    generationStatus: "completed",
    relatedEntryId: null,
    inputEntryId: null,
    kind: "resumed",
    message: "Resumed after a restart",
    details: {},
  };
}

/**
 * The record Vibe 3.1.4 journals for that mark (`_mark_resumed_turn`): the
 * entry added, then the state, whose `session.updatedAt` is the mark's time,
 * then `session_api` as 3.1.4 writes it with the Session API on, its default:
 * the entry's place in the history (`history_position_ids` in
 * _session_api_entries.py at 3.1.4).
 */
export function resumedRecord(
  sequence: number,
  state: StateFields,
  at: number,
  turnId = state.turn?.id ?? "turn-1",
  count = 1,
): string {
  return historyDelta(sequence, [appendStep(resumedEntry(at, turnId, count))], {
    state: { ...state, updatedAt: at },
    sessionApi: {
      history_positions: { [`checkpoint-resumed-${count}`]: 3 + count },
      next_history_index: 4 + count,
    },
  });
}

/** A notice a hook left in the history, in words the adapter must never take. */
export function noticeEntry(id: string): Record<string, unknown> {
  return {
    type: "notice",
    id,
    sessionId: sessionId("a1"),
    turnId: "turn-1",
    createdAt: NOW - MINUTE,
    updatedAt: NOW - MINUTE,
    generationStatus: "completed",
    relatedEntryId: null,
    inputEntryId: null,
    level: "info",
    detail: { kind: "hook", scope: "turn", content: PRIVATE_WORDS },
  };
}

/** The steps of a `projection_delta`, as Vibe 3.1.4 writes them (`compute_projection_delta`). */
export const appendStep = (entry: unknown) => ({ op: "append_entry", entry });
export const replaceStep = (id: string, entry: unknown) => ({ op: "replace_entry", id, entry });
export const removeStep = (id: string) => ({ op: "remove_entry", id });
export const setEntriesStep = (entries: unknown[]) => ({ op: "set_history_entries", entries });

/**
 * A `projection_delta` record made of the steps given and, with `state`, the
 * new public state last. With `sessionApi`, it is a record of Vibe 3.1's,
 * whose `session_api` comes between `delta` and `watermark`.
 */
export function historyDelta(
  sequence: number,
  steps: unknown[],
  options: { state?: StateFields; sessionApi?: unknown } = {},
): string {
  const delta = options.state
    ? [...steps, { op: "set_envelope", state: publicState(options.state) }]
    : steps;
  const payload =
    options.sessionApi === undefined
      ? { delta, watermark: sequence }
      : { delta, session_api: options.sessionApi, watermark: sequence };
  return record("projection_delta", sequence, payload);
}

/** A `session_relocated` record: the session moved to another folder, with the steps that mark it. */
export function relocatedRecord(sequence: number, steps: unknown[]): string {
  return record("session_relocated", sequence, {
    delta: steps,
    metadata: { cwd: CWD, active_model: "demo-model", agent_name: "default" },
    plugin_lock: {},
    watermark: sequence,
  });
}

/** A piece of the history as Vibe writes one: its name and what is in `chunks/<name>.json`. */
export interface HistoryChunk {
  name: string;
  body: string;
}

/**
 * A piece of the history holding these entries, as Vibe writes one: a JSON
 * array and a newline, named for the SHA-256 of the array.
 */
export function historyChunk(entries: unknown[]): HistoryChunk {
  const array = canonical(entries);
  return { name: createHash("sha256").update(array).digest("hex"), body: `${array}\n` };
}
