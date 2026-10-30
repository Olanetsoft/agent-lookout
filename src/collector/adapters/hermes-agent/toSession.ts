import { mapHermesAgentStatus } from "../../../core/mapping/hermes-agent/hermesAgentMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import { isWithinRetention } from "../../../core/sessions/retention.ts";
import type { Session, SourceId, Surface } from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { HermesRow, LeaseRow } from "./sessionRows.ts";

export const SOURCE_ID: SourceId = "hermes-agent";

/** The `end_reason` of a row Hermes Agent closed to go on in a new one, after it compressed a conversation. */
export const COMPRESSION_END = "compression";

/** The start of the ids of a profile's sessions: `hermes-agent:coder/`. */
export function profilePrefix(profile: string): string {
  return `${SOURCE_ID}:${profile}/`;
}

/** The times Hermes Agent wrote anything of a row: when it began and ended, its activity and its newest message. */
function rowTimes(row: HermesRow): number[] {
  return [row.startedAt, row.endedAt, row.lastActivityAt, row.lastMessageAt].filter(
    (value): value is number => typeof value === "number",
  );
}

/** The newest time anything of a row was written, as it was written. -Infinity when none is known. */
function newestOf(row: HermesRow): number {
  const times = rowTimes(row);
  return times.length === 0 ? -Infinity : Math.max(...times);
}

/**
 * The rows of each conversation, by its root's id, as `sqlite3` gave them.
 * A conversation's rows are those Hermes Agent began when it compressed it.
 */
export function chainsOf(rows: readonly HermesRow[]): Map<string, HermesRow[]> {
  const chains = new Map<string, HermesRow[]>();
  for (const row of rows) {
    const chain = chains.get(row.rootId);
    if (chain) chain.push(row);
    else chains.set(row.rootId, [row]);
  }
  return chains;
}

/**
 * The row a conversation is at now, its tip: one that did not end with a
 * compression, an open one before an ended one, then the one written most
 * recently, as Hermes Agent's own `_CHAIN_STEP_SQL` orders them. When every
 * row ended with a compression, the one written most recently.
 */
export function tipOf(chain: readonly HermesRow[]): HermesRow {
  const going = chain.filter((row) => row.endReason !== COMPRESSION_END);
  const candidates = going.length > 0 ? going : chain;
  return [...candidates].sort((a, b) => {
    const open = Number(b.endedAt === null) - Number(a.endedAt === null);
    if (open !== 0) return open;
    const newer = newestOf(b) - newestOf(a);
    if (newer !== 0 && !Number.isNaN(newer)) return newer;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  })[0] as HermesRow;
}

/**
 * The app a conversation runs in, from its root's source: the terminal for
 * `cli` and `tui`, and for a `local` row made by either; the desktop app for
 * `desktop`, and for a `local` row made by it. Hermes Agent keeps a session of
 * its gateway as `local`, with the surface that made it in `created_source`
 * (`gateway/session_policy.py`). Anything else is not known: a chat app, an
 * editor through ACP, the API server or a scheduled run.
 */
export function surfaceOf(source: unknown, createdSource: unknown): Surface {
  const surface = source === "local" ? createdSource : source;
  if (surface === "cli" || surface === "tui") return "terminal";
  if (surface === "desktop") return "desktop";
  return "unknown";
}

/**
 * Whether a conversation is listed: something of it was written in the last
 * 24 hours. Kept by the newest time as it was written, so a time ahead of a
 * clock set back keeps a conversation, as a clock that steps backwards never
 * hides one.
 */
export function isListed(chain: readonly HermesRow[], now: number): boolean {
  const newest = Math.max(...chain.map(newestOf));
  return Number.isFinite(newest) && isWithinRetention(newest, now);
}

export interface HermesAgentSessionInput {
  /** The profile whose database the conversation is in: `default`, or a named one. */
  profile: string;
  /** The rows of one conversation, with one root. */
  chain: readonly HermesRow[];
  /**
   * Whether the process holding a lease exists: true or false when it could
   * be checked, null when the lease's expiry is trusted alone.
   */
  holderAlive: (lease: LeaseRow) => boolean | null;
  now: number;
}

/**
 * One Hermes Agent conversation in the shared model, or null when nothing of
 * it was written in the last 24 hours.
 *
 * - The id is `hermes-agent:<profile>/<root id>`, so a conversation keeps it
 *   as Hermes Agent compresses it into new rows.
 * - The status comes from the tip and the root's turn lease
 *   (`mapHermesAgentStatus`), judged again on every poll.
 * - The name is the tip's title, else the root's, else the folder's name,
 *   else the id. The folder is the tip's, else the root's.
 * - The app is the terminal or the desktop app when the root's source says.
 * - There is no last write: Hermes Agent keeps every session of a profile in
 *   one file, so no file's modified time says when one was last written.
 * - There is no pid, Jump, Stop, link or token count.
 */
export function hermesAgentSession(input: HermesAgentSessionInput): Session | null {
  const { profile, chain, now } = input;
  if (chain.length === 0 || !isListed(chain, now)) return null;
  const tip = tipOf(chain);
  const root = tip.root;
  const lease = tip.lease;
  const times = chain.flatMap(rowTimes).filter((value) => plausibleTime(value, now) !== null);
  const activityAt = times.length === 0 ? null : Math.max(...times);

  const mapped = mapHermesAgentStatus({
    endedAt: tip.endedAt,
    endReason: tip.endReason,
    newest: tip.newest,
    openQuestions: tip.openQuestions,
    openCalls: tip.openCalls,
    callsAt: tip.callsAt,
    approvalLabel: tip.approvalLabel,
    questionLabel: tip.questionLabel,
    // Hermes Agent saves the label and `last_activity_at` together.
    labelAt: tip.lastActivityAt,
    lease: lease === null ? null : { at: lease.at, until: lease.until },
    holderAlive: lease === null ? null : input.holderAlive(lease),
    activityAt,
    now,
  });

  const id = `${profilePrefix(profile)}${tip.rootId}`;
  const cwd = tip.folder ?? root.folder;
  const project = projectOf(cwd);
  const session: Session = {
    id,
    source: SOURCE_ID,
    surface: surfaceOf(root.source, root.createdSource),
    // A title made only of spaces is no name. It is cleaned and cut as every other agent's is.
    name: sessionName(tip.title ?? "") || sessionName(root.title ?? "") || project || id,
    cwd,
    project,
    status: mapped.status,
    startedAt: plausibleTime(root.startedAt, now),
    statusSince: mapped.since,
    links: {},
    stale: isStale({ status: mapped.status, statusSince: mapped.since }, now),
  };
  if (mapped.waitingReason !== undefined) session.waitingReason = mapped.waitingReason;
  return session;
}
