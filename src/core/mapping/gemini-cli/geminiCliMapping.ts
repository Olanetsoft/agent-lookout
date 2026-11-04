// How Gemini CLI's session files map onto the session model. Pure, so the
// collector today and a browser or desktop host later share one mapping.
//
// Gemini CLI writes each session to a file of JSON lines, and replays it
// itself by a few rules: a message line with an id it has seen replaces the
// earlier one in place, `$rewindTo` drops a message and every one after it,
// `$patch` changes, removes or reorders messages, and `$set` changes the
// session's details, or with `messages` replaces the whole list. This module
// replays the small records the collector keeps of each line by the same rules,
// and reads a status, and the newest reply's token counts, from what is left.
// Gemini CLI writes nothing while a tool waits for approval or runs, and no
// mark when a session ends, so a session is working, idle, failed or unknown
// here, never "needs-you" or "finished". See docs/adapters/gemini-cli.md for
// where each value comes from.
//
// Built from Gemini CLI's source at v0.64.0
// (packages/core/src/services/chatRecordingService.ts), and not yet checked
// against a machine running it.

import type { SessionStatus, TokenCounts } from "../../sessions/session.ts";

/**
 * The id Gemini CLI gives the message it starts every session with, which
 * describes the machine and the folder: `deriveStableId(['environment-context'])`.
 * The person did not write it, so it is not a prompt.
 */
export const ENVIRONMENT_CONTEXT_ID = "d04923d38bb0f6017037e74183378ef4";

/** The message types Gemini CLI 0.64.0 writes. */
export const GEMINI_CLI_MESSAGE_TYPES = ["user", "gemini", "info", "warning", "error"] as const;

export type GeminiCliMessageType = (typeof GEMINI_CLI_MESSAGE_TYPES)[number];

/** The most messages kept for one file. The oldest go first, as Gemini CLI's own reader can drop them. */
export const MAX_KEPT_MESSAGES = 10_000;

/**
 * What a message's content says, without any of its text: the collector works
 * these out from a line it has parsed, and keeps nothing else of the content.
 */
export interface GeminiCliContent {
  /** The content is exactly "": a reply that was only calls for tools. */
  empty: boolean;
  /** A part asks for a tool (`functionCall`). */
  functionCall: boolean;
  /** A part answers a tool (`functionResponse`): a tool's result, sent back to the model. */
  functionResponse: boolean;
  /**
   * The content is a list of parts and every one is a thought: Gemini CLI's own
   * note that a tool sent back a file, written just before it asks the model.
   */
  thoughtOnly: boolean;
  /**
   * Its text begins as a message Gemini CLI writes itself as if the person had
   * typed it, which starts no request: the session's context, a hook's context,
   * a shell command's output, a change of folders or leaving Plan Mode.
   */
  note: boolean;
  /**
   * Its text begins as the `error` message of a failed request does. Read only
   * of an `error` message: any other is something else the CLI showed.
   */
  failedRequest: boolean;
}

/** What a reply's tool calls say. Gemini CLI writes them only once every call in the batch has ended. */
export interface GeminiCliToolCalls {
  /** Every call ended as cancelled. */
  allCancelled: boolean;
  /** The newest time a call ended, in epoch milliseconds, when one could be read. */
  lastAt: number | null;
}

/** One message as it is kept: its id, type and time, and the shape of its content. */
export interface GeminiCliMessage {
  id: string;
  /** One of the five types, or `other` for a type Gemini CLI 0.64.0 does not write or a line that could not be read. */
  type: GeminiCliMessageType | "other";
  /** When the message was made, in epoch milliseconds. Null when it is not a time. */
  at: number | null;
  /**
   * Null when the line was too long to parse, and only its first bytes were
   * read, or when it is a line of a kind not known. An `error` that long has
   * the shape of the start of its text, when those bytes hold it.
   */
  content: GeminiCliContent | null;
  /** A reply's tool calls. Null when it has none. */
  toolCalls: GeminiCliToolCalls | null;
  /**
   * A reply's token counts, from its `tokens`: null when they could not be
   * right, or when the line was too long to read them. Left out for a message
   * that is not a reply, and for a reply that has none.
   */
  tokens?: TokenCounts | null;
}

/** A change a `$patch` makes to one message. Only the content's shape is kept. */
export interface GeminiCliUpdate {
  id: string;
  /** The new content's shape, when the patch replaces the content. */
  content?: GeminiCliContent;
}

/** What is kept of one line of a session file. */
export type GeminiCliRecord =
  | {
      /** The first line, or a line of the same shape: the session's details. */
      kind: "header";
      startedAt: number | null;
      updatedAt: number | null;
      summary?: string;
    }
  | { kind: "message"; message: GeminiCliMessage }
  | { kind: "rewind"; id: string }
  | {
      kind: "patch";
      updates: GeminiCliUpdate[];
      removeIds: string[];
      /** The ids to move to the end, in this order. Null when the patch reorders nothing. */
      orderIds: string[] | null;
    }
  | {
      kind: "set";
      /** A new `lastUpdated`, when the line sets one: null when it is not a time. */
      updatedAt?: number | null;
      /** A new title. */
      summary?: string;
      /** The line sets `sessionId`: a Gemini CLI program has taken the session up again. */
      reattach: boolean;
      /** The whole list, when the line replaces it. */
      messages?: GeminiCliMessage[];
    };

/** The last thing a replay saw that says how the session stands. */
export type GeminiCliEvent = "message" | "rollback" | "reattach";

/** A session file replayed so far. Made by `emptyGeminiCliReplay`, moved on by `applyGeminiCliRecord`. */
export interface GeminiCliReplay {
  /** The messages in Gemini CLI's order, by id. */
  messages: Map<string, GeminiCliMessage>;
  /** Whether the replay began at the file's first line, so nothing before it was missed. */
  fromStart: boolean;
  /**
   * Whether the list holds every message the file still has: the replay began
   * at the file's first line, or a `$set` replaced the list since, and none was
   * dropped for the cap. When it does not, a `$patch` can move a message it
   * never saw in among those it holds.
   */
  holdsAll: boolean;
  /**
   * The ids of messages held that a message the replay never saw may stand
   * after, as a `$patch` moved it there. A reply among them is never taken for
   * the newest with counts, since that one may be newer.
   */
  shadowed: Set<string>;
  /** Null until a record that says how the session stands. */
  lastEvent: GeminiCliEvent | null;
  /**
   * After a rollback or a re-attach, the `lastUpdated` of the first `$set`
   * that gave one: when the session has been idle since. Null until then.
   */
  settledAt: number | null;
  /** Whether a rollback or a re-attach is waiting for its `$set`. */
  settling: boolean;
  /** `startTime` from the header. */
  startedAt: number | null;
  /** The last `lastUpdated` written, by the header or a `$set`. */
  updatedAt: number | null;
  /** The time of the last message line written, in the order they were written. */
  messageAt: number | null;
  /** The newest time a tool call ended, of the last reply written with tool calls. */
  toolAt: number | null;
  /** The last title written. */
  summary?: string;
}

export function emptyGeminiCliReplay(fromStart: boolean): GeminiCliReplay {
  return {
    messages: new Map(),
    fromStart,
    holdsAll: fromStart,
    shadowed: new Set(),
    lastEvent: null,
    settledAt: null,
    settling: false,
    startedAt: null,
    updatedAt: null,
    messageAt: null,
    toolAt: null,
  };
}

/** A message that is not part of the conversation, which says nothing of how the session stands. */
function isAside(message: GeminiCliMessage): boolean {
  if (message.type === "info" || message.type === "warning") return true;
  if (message.type !== "user") return false;
  return message.id === ENVIRONMENT_CONTEXT_ID || message.content?.note === true;
}

/** A user message the person wrote, or one that started a request: not a tool's result and not a note. */
function isPrompt(message: GeminiCliMessage): boolean {
  return (
    message.type === "user" &&
    message.content !== null &&
    !message.content.functionResponse &&
    !isAside(message)
  );
}

/** The last messages that say how the session stands, newest first, in Gemini CLI's order. */
function statusMessages(messages: ReadonlyMap<string, GeminiCliMessage>): GeminiCliMessage[] {
  const kept: GeminiCliMessage[] = [];
  for (const message of messages.values()) {
    if (!isAside(message)) kept.push(message);
  }
  return kept.reverse();
}

function newestStatus(messages: ReadonlyMap<string, GeminiCliMessage>): GeminiCliMessage | null {
  let newest: GeminiCliMessage | null = null;
  for (const message of messages.values()) {
    if (!isAside(message)) newest = message;
  }
  return newest;
}

function newestStatusId(messages: ReadonlyMap<string, GeminiCliMessage>): string | null {
  return newestStatus(messages)?.id ?? null;
}

/**
 * A line of a kind not known, kept in the list in its place: one read whole
 * that is not taken for any of Gemini CLI's lines, or one too long to parse
 * whose first bytes do not say what it is, such as a long `$patch`. What it did
 * to the list is not known: it may have taken back a reply, or added one.
 */
function isUnknownLine(message: GeminiCliMessage): boolean {
  return message.type === "other" && message.content === null;
}

/**
 * A reply's tool results as Gemini CLI writes them again, as a user message of
 * id `<reply's id>_response`, when it rebuilds the history of a session it
 * takes up again or rewinds (`convertSessionToClientHistory`). It is an old
 * turn written again, not new work.
 */
function isHistoryCopy(message: GeminiCliMessage): boolean {
  return message.type === "user" && message.id.endsWith("_response");
}

/**
 * Whether a message just written says how the session stands now. An aside
 * never does. Nor does a copy of old tool results written while a rollback or
 * a re-attach waits for its `$set`, as Gemini CLI writes when it takes up a
 * session's history: then the session is idle since that `$set`.
 */
function saysHowItStands(replay: GeminiCliReplay, message: GeminiCliMessage): boolean {
  return !isAside(message) && !(replay.settling && isHistoryCopy(message));
}

/** Drops the oldest messages until no more than the cap are kept. */
function cap(replay: GeminiCliReplay): void {
  const { messages } = replay;
  while (messages.size > MAX_KEPT_MESSAGES) {
    const oldest = messages.keys().next().value;
    if (oldest === undefined) return;
    messages.delete(oldest);
    replay.shadowed.delete(oldest);
    replay.holdsAll = false;
  }
}

function rollback(replay: GeminiCliReplay): void {
  replay.lastEvent = "rollback";
  replay.settling = true;
  replay.settledAt = null;
}

/** Adds a message, or replaces the one with its id where it stands. */
function put(replay: GeminiCliReplay, message: GeminiCliMessage): void {
  replay.messages.set(message.id, message);
  cap(replay);
}

/**
 * A `$set` of `messages`, which Gemini CLI 0.44 to 0.63 wrote to match the
 * list to its history: as a session starts or is taken up again, and as a
 * prompt is stopped or a request fails. Like a `$patch`, it is a rollback when
 * it drops the newest message that says how the session stands. It says the
 * session stands by a message only when its newest such message is new, which
 * is known only when every line from the start was read: a replay begun inside
 * the file never saw the messages before it. Otherwise what came before
 * stands, a re-attach among them.
 */
function replaceAll(replay: GeminiCliReplay, messages: readonly GeminiCliMessage[]): void {
  const before = newestStatusId(replay.messages);
  const held = new Set(replay.messages.keys());
  replay.messages.clear();
  replay.shadowed.clear();
  replay.holdsAll = true;
  for (const message of messages) put(replay, message);
  const after = newestStatus(replay.messages);
  if (after !== null && replay.fromStart && !held.has(after.id) && saysHowItStands(replay, after)) {
    replay.lastEvent = "message";
  } else if (before !== null && !replay.messages.has(before)) {
    rollback(replay);
  }
}

/**
 * Moves the messages `orderIds` names to the end, in that order, each to the
 * place its id is first named, as Gemini CLI's reader does. When the list does
 * not hold every message, an id it does not hold may be a message the replay
 * never saw, which moves there too: every message held that would then be
 * before it is shadowed.
 */
function reorder(replay: GeminiCliReplay, orderIds: readonly string[]): void {
  const named = new Set<string>();
  const moved: GeminiCliMessage[] = [];
  /** The messages moved since the last one the replay never saw. */
  let since: string[] = [];
  let unseen = false;
  for (const id of orderIds) {
    if (named.has(id)) continue;
    named.add(id);
    const message = replay.messages.get(id);
    if (message) {
      moved.push(message);
      since.push(id);
    } else if (!replay.holdsAll) {
      unseen = true;
      for (const before of since) replay.shadowed.add(before);
      since = [];
    }
  }
  if (unseen) {
    // Those not named stay first, before every message moved.
    for (const id of replay.messages.keys()) {
      if (!named.has(id)) replay.shadowed.add(id);
    }
  }
  for (const message of moved) replay.messages.delete(message.id);
  for (const message of moved) replay.messages.set(message.id, message);
}

/**
 * Moves a replay on by one record, by Gemini CLI's own rules
 * (`chatRecordingService.ts`, `createJsonlRecordAccumulator`):
 *
 * | Record | The list | Says how the session stands? |
 * | --- | --- | --- |
 * | header | none: its start time, `lastUpdated` and title are kept | no |
 * | message: a note, `info` or `warning` | added, or replaces its id in place | no |
 * | message: a copy of old tool results, `<id>_response`, while a rollback or a re-attach waits for its `$set` | added, or replaces its id in place | no |
 * | message: a prompt, a tool's result, `gemini`, `error` or another type | added, or replaces its id in place | yes: message |
 * | `$rewindTo` | that id and every message after it dropped; all of them for an id not in the list | rollback, when the newest message that says how the session stands is dropped |
 * | `$patch` | its own change, then `updates`, then `removeIds`, then `orderIds` (moved to the end, in that order) | rollback, when the newest message that says how the session stands is removed |
 * | `$set` with `messages` | replaced | message, when the newest that says how the session stands is new and every line from the start was read; rollback, when the old newest is dropped; otherwise no |
 * | `$set` with `sessionId` | none | yes: re-attach |
 * | any other `$set` | none: `lastUpdated` and the title are kept | no |
 *
 * The first `$set` with a `lastUpdated` after a rollback or a re-attach says
 * when the session has been idle since. Taking a session up again, or
 * rewinding it, Gemini CLI writes the copies, then a `$patch`, then that `$set`.
 *
 * In a replay that does not hold every message, an id in a `$patch`'s
 * `orderIds` that it does not hold may be a message it never saw: the messages
 * held that would be before it are shadowed, and none of their replies is
 * taken for the newest with counts (`newestGeminiCliTokens`). It changes no
 * status.
 */
export function applyGeminiCliRecord(replay: GeminiCliReplay, record: GeminiCliRecord): void {
  switch (record.kind) {
    case "header": {
      replay.startedAt ??= record.startedAt;
      if (record.updatedAt !== null) replay.updatedAt = record.updatedAt;
      if (record.summary !== undefined) replay.summary = record.summary;
      return;
    }
    case "message": {
      const { message } = record;
      put(replay, message);
      if (message.at !== null) replay.messageAt = message.at;
      const toolAt = message.toolCalls?.lastAt ?? null;
      if (toolAt !== null) replay.toolAt = toolAt;
      if (saysHowItStands(replay, message)) replay.lastEvent = "message";
      return;
    }
    case "rewind": {
      const newest = newestStatusId(replay.messages);
      if (replay.messages.has(record.id)) {
        let found = false;
        for (const id of [...replay.messages.keys()]) {
          if (id === record.id) found = true;
          if (found) {
            replay.messages.delete(id);
            replay.shadowed.delete(id);
          }
        }
      } else {
        replay.messages.clear();
        replay.shadowed.clear();
      }
      if (newest !== null && !replay.messages.has(newest)) rollback(replay);
      return;
    }
    case "patch": {
      const newest = newestStatusId(replay.messages);
      for (const update of record.updates) {
        const message = replay.messages.get(update.id);
        if (message && update.content !== undefined) {
          replay.messages.set(update.id, { ...message, content: update.content });
        }
      }
      for (const id of record.removeIds) {
        replay.messages.delete(id);
        replay.shadowed.delete(id);
      }
      if (record.orderIds !== null) reorder(replay, record.orderIds);
      if (newest !== null && !replay.messages.has(newest)) rollback(replay);
      return;
    }
    case "set": {
      if (record.messages !== undefined) replaceAll(replay, record.messages);
      if (record.reattach) {
        replay.lastEvent = "reattach";
        replay.settling = true;
        replay.settledAt = null;
      }
      if (record.updatedAt !== undefined && record.updatedAt !== null) {
        replay.updatedAt = record.updatedAt;
        if (replay.settling && !record.reattach) {
          replay.settledAt = record.updatedAt;
          replay.settling = false;
        }
      }
      if (record.summary !== undefined) replay.summary = record.summary;
      return;
    }
  }
}

/** Replays records from nothing, in the order they were written. */
export function replayGeminiCliRecords(
  records: readonly GeminiCliRecord[],
  fromStart = true,
): GeminiCliReplay {
  const replay = emptyGeminiCliReplay(fromStart);
  for (const record of records) applyGeminiCliRecord(replay, record);
  return replay;
}

/** A session's status, and since when, in epoch milliseconds, when that is known. */
export interface GeminiCliStatus {
  status: SessionStatus;
  since: number | null;
  /**
   * Only when the status is unknown because the newest message is a batch of
   * tool calls that ended, not every one cancelled. Gemini CLI writes the
   * tools' results a few moments after the batch, so the collector, which knows
   * the time, shows such a session as working for a while after `endedAt`.
   */
  batch?: {
    /** The newest time a call in the batch ended. Null when none could be read. */
    endedAt: number | null;
    /** The newest prompt's time, as a tool's result would give it. */
    workingSince: number | null;
  };
}

/**
 * The token counts of the newest reply left in the list that has any, as
 * Gemini CLI's own `hydrate` takes a session's last counts from its file
 * (`packages/core/src/telemetry/uiTelemetry.ts`): a reply with none, as Gemini
 * CLI writes one whose stream sent no usage, is passed over for the one before
 * it. A reply a `$rewindTo` or a `$patch` took back is gone from the list, so
 * it is never the one. Null when no reply left has counts, when the newest
 * that has them could not be right or was too long to read, when a message
 * the replay never saw may stand after it, and when a line of a kind not known
 * comes after it: that line may have taken it back.
 */
export function newestGeminiCliTokens(replay: GeminiCliReplay): TokenCounts | null {
  const messages = [...replay.messages.values()];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (isUnknownLine(message)) return null;
    if (message.type !== "gemini" || message.tokens === undefined) continue;
    return replay.shadowed.has(message.id) ? null : message.tokens;
  }
  return null;
}

/** Working since the newest prompt, when nothing written after it is of a kind that hides when the turn began. */
function workingSince(newestFirst: readonly GeminiCliMessage[]): number | null {
  for (const message of newestFirst) {
    if (isPrompt(message)) return message.at;
    // A user line too long to read could be a prompt or a tool's result.
    if (message.type === "user" && message.content === null) return null;
  }
  return null;
}

/**
 * Maps a replayed session file to a status, from the last record that says how
 * the session stands and the newest message that does:
 *
 * | Last record, or newest message | Status | Since |
 * | --- | --- | --- |
 * | a rollback (a prompt taken back, a tool declined) or a re-attach | idle | the `$set` after it |
 * | no such message, every line from the start read: a new session | idle | its start |
 * | no such message, and the start of the file not read | unknown | |
 * | a prompt | working | the prompt |
 * | a tool's result | working | the newest prompt |
 * | a tool's result after a batch whose every call was cancelled (Esc) | idle | the result |
 * | `gemini`: content "", or a call for a tool, and no tool calls recorded: a tool waits or runs | working | the newest prompt |
 * | `gemini`: only thoughts, Gemini CLI's note before it asks about a file a tool sent back | working | the newest prompt |
 * | `gemini` with text and no tool calls | idle | the reply |
 * | `gemini` with tool calls: the batch ended, and nothing says what came next | unknown, with `batch` unless every call was cancelled | |
 * | `error` that begins as a failed request's does | failed | the error |
 * | any other `error` | idle | the error |
 * | a type Gemini CLI 0.64.0 does not write, a line that could not be read, or a `gemini` line too long to read | unknown | |
 *
 * A reply with text that also calls for a tool is written just as a final
 * answer is, and its call only once it has ended, so a session whose tool
 * waits for approval or runs after such a reply shows as idle. A batch of
 * tool calls ends most often a moment before its result is sent, but a tool
 * that stops the agent, or one the CLI ran itself, leaves the batch last with
 * nothing after it, so the batch alone is unknown rather than a guess. Its
 * `batch` lets the collector show it as working while it is new
 * (`src/collector/adapters/gemini-cli/toSession.ts`).
 *
 * Gemini CLI records every error it shows as an `error` message, so only the
 * start of its text says that a request failed (`failedRequest`). A newer
 * prompt, or a take-back of the error, moves the session on as any message's.
 *
 * It never returns "needs-you" or "finished".
 */
export function mapGeminiCliStatus(replay: GeminiCliReplay): GeminiCliStatus {
  if (replay.lastEvent === "rollback" || replay.lastEvent === "reattach") {
    return { status: "idle", since: replay.settledAt };
  }
  const newestFirst = statusMessages(replay.messages);
  const newest = newestFirst[0];
  if (newest === undefined) {
    return replay.fromStart
      ? { status: "idle", since: replay.startedAt }
      : { status: "unknown", since: null };
  }
  const unknown: GeminiCliStatus = { status: "unknown", since: null };
  const { content } = newest;
  switch (newest.type) {
    case "user": {
      if (content === null) return { status: "working", since: null };
      if (!content.functionResponse) return { status: "working", since: newest.at };
      const before = newestFirst[1];
      if (before?.type === "gemini" && before.toolCalls?.allCancelled === true) {
        return { status: "idle", since: newest.at };
      }
      return { status: "working", since: workingSince(newestFirst) };
    }
    case "gemini": {
      if (content === null) return unknown;
      if (newest.toolCalls !== null) {
        if (newest.toolCalls.allCancelled) return unknown;
        const batch = { endedAt: newest.toolCalls.lastAt, workingSince: workingSince(newestFirst) };
        return { ...unknown, batch };
      }
      if (content.empty || content.functionCall || content.thoughtOnly) {
        return { status: "working", since: workingSince(newestFirst) };
      }
      return { status: "idle", since: newest.at };
    }
    case "error":
      return { status: content?.failedRequest === true ? "failed" : "idle", since: newest.at };
    default:
      return unknown;
  }
}
