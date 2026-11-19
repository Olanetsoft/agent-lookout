import { FINISHED_RETENTION_MS, isWithinRetention } from "../../../core/sessions/retention.ts";
import type { Session } from "../../../core/sessions/session.ts";
import type { RegistryEntry } from "./registry.ts";
import { finishedAtOf, finishedGrokBuildSession, type FinishedGrokBuild } from "./toSession.ts";

/**
 * What the Grok Build adapter remembers between polls of the sessions it has
 * seen: the ones Grok Build listed open, and the ones that have ended, kept
 * for 24 hours, in memory only. Built from Grok Build's source at 1.0.45
 * (commit 2bdd1d6) and not yet checked on a machine running it.
 *
 * - A session Grok Build listed, while its process ran, is seen. One it lists
 *   no more is watched while its process runs, for at most 24 hours from when
 *   it was last listed: /new and leaving for the welcome screen take a session
 *   off the list and leave its turn running
 *   (`xai-grok-pager/src/app/dispatch/session/lifecycle.rs:380`, `:492-493`).
 *   The adapter shows it as working while its turn is under way, needing you
 *   while a question is open or a plan waits, and finished otherwise, and a
 *   new turn shows it as working again.
 * - A session has ended once its process has, or a process with its ID that
 *   did not list it has it, or it has been watched for 24 hours. A session a
 *   crash left listed ends again on every poll, a restart among them.
 * - An ended session is shown as finished from the later of when it was
 *   listed and when its event log was last written, judged against the clock
 *   on every poll, and dropped a day after that. A session listed open again
 *   under its ID leaves the list of ended ones.
 * - At most 200 sessions are remembered as seen, listed and watched together,
 *   and 200 as ended, the newest first. One past either limit is dropped.
 */

/** The most sessions remembered as seen, and as ended. */
export const MAX_REMEMBERED = 200;

export interface SeenGrokBuild {
  entry: RegistryEntry;
  /** The last poll that found it listed, with its process running. */
  listedAt: number;
  /** What the last poll found of its title and its log's time, for when it ends. */
  title: string | null;
  writtenAt: number | null;
}

export interface GrokBuildMemory {
  /**
   * A session this poll found with its process running: listed, or watched.
   * Its title and its log's time are kept for when it ends.
   */
  seen(
    entry: RegistryEntry,
    facts: { listed: boolean; title: string | null; writtenAt: number | null },
    now: number,
  ): void;
  /**
   * The sessions seen before that this poll's list does not name, to watch.
   * One watched for a day ends, and so does the oldest past the limit.
   */
  unlisted(listedIds: ReadonlySet<string>, now: number): SeenGrokBuild[];
  /** A session that has ended, or a crash left listed: shown as finished for a day. */
  ended(record: Omit<FinishedGrokBuild, "noticedAt">, now: number): void;
  /** The ended sessions to show this poll, each judged against the clock now. */
  finished(now: number): Session[];
  /** The IDs of every session remembered as seen or ended. */
  ids(): Set<string>;
  /** How many sessions it remembers, for the tests that check the limits. */
  readonly size: { seen: number; ended: number };
}

export function createGrokBuildMemory(
  retentionMs: number = FINISHED_RETENTION_MS,
  max: number = MAX_REMEMBERED,
): GrokBuildMemory {
  const seen = new Map<string, SeenGrokBuild>();
  const ended = new Map<string, FinishedGrokBuild>();

  function end(record: Omit<FinishedGrokBuild, "noticedAt">, now: number) {
    const id = record.entry.sessionId;
    seen.delete(id);
    const before = ended.get(id);
    // A look that finds neither its log nor its title this time leaves what
    // an earlier one found, so its time does not move back and forth.
    ended.set(id, {
      entry: record.entry,
      processRunsOn: record.processRunsOn,
      title: record.title ?? before?.title ?? null,
      writtenAt: record.writtenAt ?? before?.writtenAt ?? null,
      noticedAt: before?.noticedAt ?? now,
    });
    if (ended.size <= max) return;
    const oldest = [...ended.entries()].sort(
      ([, a], [, b]) => finishedAtOf(a, now) - finishedAtOf(b, now),
    );
    for (const [old] of oldest.slice(0, ended.size - max)) ended.delete(old);
  }

  return {
    seen(entry, facts, now) {
      const id = entry.sessionId;
      const before = seen.get(id);
      seen.set(id, {
        entry,
        listedAt: facts.listed ? now : (before?.listedAt ?? now),
        title: facts.title,
        writtenAt: facts.writtenAt,
      });
      if (facts.listed) ended.delete(id);
    },
    unlisted(listedIds, now) {
      const watched: SeenGrokBuild[] = [];
      for (const [id, item] of seen) {
        if (listedIds.has(id)) continue;
        // Watched for a day at most. A clock set back keeps it watched.
        if (now - item.listedAt >= retentionMs) {
          end({ ...item, processRunsOn: true }, now);
          continue;
        }
        watched.push(item);
      }
      // Together with the listed ones, no more than the most remembered.
      watched.sort((a, b) => b.listedAt - a.listedAt);
      const room = Math.max(0, max - listedIds.size);
      for (const item of watched.slice(room)) end({ ...item, processRunsOn: true }, now);
      return watched.slice(0, room);
    },
    ended: end,
    finished(now) {
      const shown: Session[] = [];
      for (const [id, record] of ended) {
        if (!isWithinRetention(finishedAtOf(record, now), now, retentionMs)) {
          ended.delete(id);
          continue;
        }
        shown.push(finishedGrokBuildSession(record, now));
      }
      return shown;
    },
    ids() {
      return new Set([...seen.keys(), ...ended.keys()]);
    },
    get size() {
      return { seen: seen.size, ended: ended.size };
    },
  };
}
