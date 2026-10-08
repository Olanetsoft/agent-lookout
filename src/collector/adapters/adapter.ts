import type { LastMessageResponse } from "../../core/api.ts";
import type {
  Session,
  SourceCapabilities,
  SourceHealth,
  SourceId,
} from "../../core/sessions/session.ts";

/** What one poll of one agent tool found. */
export interface AdapterResult {
  health: SourceHealth;
  sessions: Session[];
  /**
   * Names the way this result was read, for an adapter that has more than one.
   * Two ways of reading do not see exactly the same sessions, so the poller
   * only compares polls that share a basis.
   *
   * The Claude Code adapter has three:
   * - `registry+feed`: the session registry, checked against the last answer of
   *   `claude agents --json --all`, plus the background jobs only that answer
   *   knows. The usual one.
   * - `registry`: the session registry alone, while there is no answer from the
   *   command.
   * - `feed`: the command's answer, while the registry cannot be relied on.
   *
   * The Codex adapter has two:
   * - `files`: Codex's session files, its folder of open-session locks and its
   *   file of session names. The usual one.
   * - `files-without-locks`: the same while the folder of locks is missing or
   *   cannot be listed, when no session can be shown as finished.
   *
   * The status-file adapter has one, `files`: the folder of status files.
   */
  basis?: string;
}

/**
 * One agent tool, seen through a common interface.
 *
 * The contract every adapter keeps:
 * - `poll()` never throws and never rejects. A failure becomes `health.state`
 *   with a plain-language `health.detail`, and `sessions` is empty.
 * - It is read-only on the tool it watches.
 * - Session ids are stable from one poll to the next.
 */
export interface Adapter {
  readonly id: SourceId;
  /** Plain label, for example "Claude Code". */
  readonly label: string;
  /**
   * Where this adapter looks, in plain language. Shown while the first poll is
   * still running, so the dashboard can say what it is searching.
   */
  readonly lookingIn?: string;
  /**
   * What the tool can report at all, and why not where it cannot, taken from
   * what this adapter reads. Fixed: it does not change from one poll to the
   * next. The poller passes it on with every health of this source.
   */
  readonly capabilities?: SourceCapabilities;
  poll(): Promise<AdapterResult>;
  /**
   * What a session this adapter listed on its last poll last said, read when
   * the route asks, by the session's id in the session model. Null when the
   * adapter did not list that id, and `busy` while it reads no more for a
   * moment. It never rejects. Left out by an adapter that does not read what
   * its sessions say, whose sessions are then answered `not-read`.
   */
  lastMessage?(sessionId: string): Promise<LastMessageResponse | "busy" | null>;
}
