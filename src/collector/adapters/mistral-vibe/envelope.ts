import { sessionName } from "../../../core/text.ts";

/**
 * The little this adapter keeps of a Vibe session's public state.
 *
 * Vibe calls the whole of it `PublicSessionState`, written in camelCase
 * (harness/.../session_protocol.py at 2.26.1). The same state is in two places:
 * whole, as `snapshot` in the generation's `projection-state.json`, and, as it
 * changes, in a `set_envelope` step of a journal record, with its history left
 * out. It holds the first thing the person asked (`session.preview`), errors in
 * full, the requests waiting for an answer and the queue of turns, and none of
 * that is kept. What is kept:
 *
 * - `session.title`, cleaned and cut as every session's name is;
 * - `session.status.type`;
 * - `session.createdAt` and `session.updatedAt`;
 * - `latestTurn.status`, `latestTurn.startedAt` and `latestTurn.completedAt`.
 *
 * Every other key, and any key a newer Vibe adds, is left where it is. So is
 * every value a newer Vibe gives a field this adapter does not read, such as
 * the reasons a turn stopped (`latestTurn.stopReason`).
 */
export interface Envelope {
  /** The session's title, cleaned. Null when it has none yet. */
  title: string | null;
  /** `session.status.type`, as Vibe wrote it, when it is short text. */
  statusType: string | null;
  /** Unix milliseconds, as Vibe writes them. Whether each could be right is decided where the clock is known. */
  createdAt: number | null;
  updatedAt: number | null;
  /** `latestTurn.status`: `in_progress`, `completed`, `failed` or `interrupted`. Null with no turn. */
  turnStatus: string | null;
  turnStartedAt: number | null;
  turnCompletedAt: number | null;
}

/** The only format of public state this adapter knows. */
export const PUBLIC_STATE_FORMAT = "harness.public-session-state/v1";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A short word, such as a status. Anything longer is not one. */
function word(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.length <= 64 ? value : null;
}

/** A whole number of milliseconds. */
function milliseconds(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/**
 * The kept fields of a public state, or null when it is not one: not an
 * object, of another format, or with no `session` object.
 */
export function envelopeOf(state: unknown): Envelope | null {
  if (!isRecord(state)) return null;
  if (state.format !== undefined && state.format !== PUBLIC_STATE_FORMAT) return null;
  const session = state.session;
  if (!isRecord(session)) return null;
  const status = isRecord(session.status) ? session.status : null;
  const turn = isRecord(state.latestTurn) ? state.latestTurn : null;
  return {
    title: typeof session.title === "string" ? (sessionName(session.title) ?? null) : null,
    statusType: word(status?.type),
    createdAt: milliseconds(session.createdAt),
    updatedAt: milliseconds(session.updatedAt),
    turnStatus: word(turn?.status),
    turnStartedAt: milliseconds(turn?.startedAt),
    turnCompletedAt: milliseconds(turn?.completedAt),
  };
}
