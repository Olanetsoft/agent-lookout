import type { Session, SourceHealth, SourceId } from "../../core/session.ts";

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
   * The Codex adapter has one, `files`: Codex's session files, its folder of
   * open-session locks and its file of session names.
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
  poll(): Promise<AdapterResult>;
}
