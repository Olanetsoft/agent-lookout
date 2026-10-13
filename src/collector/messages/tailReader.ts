import type { LastMessageResponse } from "../../core/api.ts";
import { isMissing, nodeIo, type ReadOnlyIo } from "../files/readOnlyIo.ts";
import { readTranscriptTail, type TranscriptStamp } from "../files/transcriptTail.ts";

/**
 * How long an answer is given again from memory, without the transcript being
 * looked at. A page asks every two seconds while a session's details are open,
 * and two pages open at once ask no more than one.
 */
export const ANSWER_AGAIN_MS = 1_000;

/** The most transcripts read in any one second, for every session together. */
export const READS_PER_SECOND = 4;

/** The most sessions whose last message is kept at once. The one asked for least recently goes first. */
export const MAX_KEPT = 8;

/** How long a session's last message is kept after it was last asked for. */
export const KEEP_MS = 15_000;

/**
 * What the reader answers: the session's last message or why there is none,
 * or `busy` while more transcripts are asked for than are read in a second.
 */
export type LastMessageAnswer = LastMessageResponse | "busy";

/** What is kept of one session, from the first time it is asked for until it is dropped. */
interface Kept {
  /** What names its transcript, from the poll it was first asked for under, or null when nothing does. */
  key: string | null;
  /** Where its transcript is, or null before it was looked for and when it was not found. */
  file: string | null;
  /** When it was last looked for, or null before that. */
  lookedAt: number | null;
  /** The file as it was when its end was last read, and the answer made from it, or null before that. */
  last: { stamp: TranscriptStamp; answer: LastMessageResponse } | null;
  /** The last answer, or null before the first. */
  answer: LastMessageResponse | null;
  /** When the transcript was last looked at for that answer. */
  checkedAt: number;
  /** When the session was last asked for. */
  askedAt: number;
  /** While its transcript is being looked at: the answer to come, which every ask meanwhile shares. */
  checking: Promise<LastMessageResponse> | null;
}

/**
 * The limits readers share: the reads of the last second, and the sessions
 * each reader keeps. The collector gives one to every agent's reader, so that
 * together they read at most four transcripts a second and keep at most eight
 * sessions.
 */
export interface TailLimits {
  /** Whether a transcript may be read now, counted as one of the second's reads when it may. */
  mayRead(at: number): boolean;
  /** Counts what a reader keeps, by session, with what the other readers keep. */
  share(kept: Map<string, { askedAt: number }>): void;
  /** Makes room for one more session, dropping the one asked for least recently by any reader. */
  makeRoom(): void;
}

export function createTailLimits(): TailLimits {
  /** When each read of the last second began. */
  let reads: number[] = [];
  const shelves = new Set<Map<string, { askedAt: number }>>();
  const keptCount = () => [...shelves].reduce((count, kept) => count + kept.size, 0);
  return {
    mayRead(at) {
      reads = reads.filter((started) => at - started < 1_000 && started <= at);
      if (reads.length >= READS_PER_SECOND) return false;
      reads.push(at);
      return true;
    },
    share(kept) {
      shelves.add(kept);
    },
    makeRoom() {
      while (keptCount() >= MAX_KEPT) {
        let leastRecent:
          { kept: Map<string, { askedAt: number }>; id: string; askedAt: number } | undefined;
        for (const kept of shelves) {
          for (const [id, entry] of kept) {
            if (leastRecent === undefined || entry.askedAt < leastRecent.askedAt) {
              leastRecent = { kept, id, askedAt: entry.askedAt };
            }
          }
        }
        if (leastRecent === undefined) return;
        leastRecent.kept.delete(leastRecent.id);
      }
    },
  };
}

export interface TailReader<Target> {
  /**
   * What a session last said, by its id in the session model, read from the
   * end of its transcript. Null for an id the last `keep` did not list, and
   * `not-found` for a listed one with no target, such as a background job
   * known only by its job id. Neither touches a file. It never rejects.
   */
  read(id: string): Promise<LastMessageAnswer | null>;
  /**
   * Told the sessions of each poll, by id, with what finds each one's
   * transcript, or null for one whose transcript cannot be named: the ids that
   * may be read from now on. What is kept of a session that is not among them,
   * that was not asked for in the last 15 seconds, or whose target now names
   * another transcript, is dropped.
   */
  keep(targets: ReadonlyMap<string, Target | null>): void;
  /** Drops everything: what is kept, and the sessions that may be read. */
  forget(): void;
  /** How many sessions it keeps a last message for. */
  readonly size: number;
}

export interface TailReaderOptions<Target> {
  /**
   * Where a listed session's transcript is, from what its adapter read for it
   * on its own, never from a request. Null when it is not found.
   */
  find(target: Target): Promise<string | null>;
  /**
   * The answer the end of a transcript gives, made fit to show. `fromStart`
   * says whether the tail is the whole file. Nothing of the tail is kept.
   */
  answerFrom(tail: string, fromStart: boolean): LastMessageResponse;
  /**
   * What names a target's transcript. When a poll gives a session a target
   * with another key, what was kept of it is dropped and its transcript is
   * found afresh. Left out, a session's transcript stays where it was found
   * while it is kept.
   */
  keyOf?(target: Target): string;
  /**
   * How long a transcript that was not found, or has gone, is left before it
   * is looked for again. Defaults to no wait beyond the second an answer is
   * given again.
   */
  lookAgainMs?: number;
  /** Shared with the other agents' readers. Left out, the reader keeps limits of its own. */
  limits?: TailLimits;
  /** Defaults to the file system. Tests pass a stand-in. */
  io?: ReadOnlyIo;
  now?: () => number;
  /**
   * Runs `run` once, `ms` from now, without keeping the process alive for it,
   * so what is kept is dropped on time even while no poll comes. Tests pass
   * their own.
   */
  later?: (run: () => void, ms: number) => void;
}

const NOT_FOUND: LastMessageResponse = { message: null, reason: "not-found" };
const UNREADABLE: LastMessageResponse = { message: null, reason: "unreadable" };

function runLater(run: () => void, ms: number): void {
  setTimeout(run, ms).unref();
}

/**
 * Reads what a session last said from the end of its transcript when it is
 * asked for, and only then: no poll opens a transcript for this. The rules
 * are the same for every agent that has one; only where its transcript is
 * and what its lines mean are the agent's own, `find` and `answerFrom`.
 *
 * - Only a session the last `keep` listed is read. The path comes from what
 *   the adapter read for it, through `find`, never from a request. A listed
 *   session with no target is answered `not-found` without a file being
 *   touched.
 * - The end of the file is read with `readTranscriptTail`, at most 256 KB, by
 *   position, and not again while the file is unchanged.
 * - An answer is given again from memory for a second. Asks for one session
 *   while its transcript is being read share that read.
 * - At most four transcripts are read in a second, for every session
 *   together, of every reader that shares `limits`. Above that the answer is
 *   `busy`, and no file is touched.
 * - What is kept is the place of the file, its stamp and the last answer, for
 *   eight sessions at most, of every reader that shares `limits`, and only for
 *   15 seconds after each was last asked for, or until a poll does not list
 *   the session.
 */
export function createTailReader<Target>(options: TailReaderOptions<Target>): TailReader<Target> {
  const io = options.io ?? nodeIo;
  const now = options.now ?? Date.now;
  const later = options.later ?? runLater;
  const lookAgainMs = options.lookAgainMs ?? 0;
  const keyOf = (target: Target) => (options.keyOf ? options.keyOf(target) : null);
  /** Null for a listed session whose transcript cannot be named. */
  const listed = new Map<string, Target | null>();
  const kept = new Map<string, Kept>();
  const limits = options.limits ?? createTailLimits();
  limits.share(kept);
  /** Whether a drop of what has been kept too long is set to run. */
  let dropSet = false;

  function dropOld(at: number): void {
    for (const [id, entry] of kept) {
      if (at - entry.askedAt >= KEEP_MS) kept.delete(id);
    }
  }

  /** Sets the next drop for when the entry asked for least recently has been kept 15 seconds. */
  function dropOnTime(at: number): void {
    if (dropSet || kept.size === 0) return;
    const oldest = Math.min(...[...kept.values()].map((entry) => entry.askedAt));
    dropSet = true;
    later(
      () => {
        dropSet = false;
        const then = now();
        dropOld(then);
        dropOnTime(then);
      },
      Math.max(0, oldest + KEEP_MS - at),
    );
  }

  async function check(entry: Kept, target: Target, at: number): Promise<LastMessageResponse> {
    try {
      if (entry.file === null) {
        entry.lookedAt = at;
        entry.file = await options.find(target);
        if (entry.file === null) return NOT_FOUND;
      }
      const read = await readTranscriptTail(entry.file, io, entry.last?.stamp ?? null);
      // As it was when its end was last read, which is the only stamp ever
      // passed: the answer made then stands.
      if (read.unchanged) return entry.last?.answer ?? UNREADABLE;
      // The end of the file is not kept once the answer is made from it.
      const answer = options.answerFrom(read.tail, read.fromStart);
      entry.last = { stamp: read.stamp, answer };
      return answer;
    } catch (error) {
      // Gone from where it was: it is looked for again in a while. Anything
      // else, a link or a pipe among them, is a transcript that cannot be read.
      entry.last = null;
      if (isMissing(error)) {
        entry.file = null;
        entry.lookedAt = at;
        return NOT_FOUND;
      }
      return UNREADABLE;
    }
  }

  return {
    read(id) {
      const target = listed.get(id);
      if (target === undefined) return Promise.resolve(null);
      // Listed, but with no transcript that can be named: nothing to look for.
      if (target === null) return Promise.resolve(NOT_FOUND);
      const at = now();
      dropOld(at);
      const entry = kept.get(id);
      if (entry !== undefined) {
        entry.askedAt = at;
        dropOnTime(at);
        if (entry.checking !== null) return entry.checking;
        if (entry.answer !== null && at - entry.checkedAt < ANSWER_AGAIN_MS) {
          return Promise.resolve(entry.answer);
        }
        // Not found a moment ago: it is not looked for again yet, and no file is touched.
        if (
          entry.answer !== null &&
          entry.file === null &&
          entry.lookedAt !== null &&
          at - entry.lookedAt < lookAgainMs
        ) {
          return Promise.resolve(entry.answer);
        }
      }
      if (!limits.mayRead(at)) return Promise.resolve("busy");

      let fresh = entry;
      if (fresh === undefined) {
        limits.makeRoom();
        fresh = {
          key: keyOf(target),
          file: null,
          lookedAt: null,
          last: null,
          answer: null,
          checkedAt: at,
          askedAt: at,
          checking: null,
        };
        kept.set(id, fresh);
        dropOnTime(at);
      }
      const reading = fresh;
      const checking = check(reading, target, at).then((answer) => {
        reading.answer = answer;
        reading.checkedAt = at;
        reading.checking = null;
        return answer;
      });
      reading.checking = checking;
      return checking;
    },
    keep(targets) {
      listed.clear();
      for (const [id, target] of targets) listed.set(id, target);
      for (const [id, entry] of kept) {
        const target = listed.get(id);
        // Not listed, or its transcript is now named by something else: it starts afresh.
        if (target === undefined || target === null || keyOf(target) !== entry.key) {
          kept.delete(id);
        }
      }
      dropOld(now());
    },
    forget() {
      // The reads of the last second still count: they were made.
      listed.clear();
      kept.clear();
    },
    get size() {
      return kept.size;
    },
  };
}
