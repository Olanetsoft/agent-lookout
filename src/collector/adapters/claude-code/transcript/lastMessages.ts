import path from "node:path";

import type { LastMessageResponse } from "../../../../core/api.ts";
import type { Session } from "../../../../core/sessions/session.ts";
import { messageText } from "../../../../core/text.ts";
import { isMissing, nodeIo, type ReadOnlyIo } from "../../../files/readOnlyIo.ts";
import { lastSaidInTail } from "./lastSaid.ts";
import { lastUsageInTail } from "./lastUsage.ts";
import {
  findTranscript,
  readTranscriptTail,
  sessionIdOf,
  type TranscriptStamp,
} from "./transcriptFile.ts";
import { LOOK_AGAIN_MS } from "./waitingTexts.ts";

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

/** A session the adapter listed on its last poll, and what its transcript is found by. */
interface Listed {
  sessionId: string;
  cwd: string | null;
}

export interface LastMessageReader {
  /**
   * What a session last said, by its id in the session model, read from the
   * end of its transcript. Null for an id the adapter did not list on its last
   * poll, and `not-found` for a listed one whose id names no transcript, such
   * as a background job known only by its job id. Neither touches a file. It
   * never rejects.
   */
  read(id: string): Promise<LastMessageAnswer | null>;
  /**
   * Told the sessions of each poll: the ids that may be read from now on.
   * What is kept of a session that is not among them, or that was not asked
   * for in the last 15 seconds, is dropped.
   */
  keep(sessions: readonly Session[]): void;
  /** Drops everything: what is kept, and the sessions that may be read. */
  forget(): void;
  /** How many sessions it keeps a last message for. */
  readonly size: number;
}

export interface LastMessageReaderOptions {
  /** The Claude Code folder, `~/.claude` or the one `AGENT_LOOKOUT_CLAUDE_HOME` names. */
  claudeHome: string;
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
 * The answer the end of a transcript gives, made fit to show, with the token
 * counts of the newest reply when they could be right. Both come from the
 * same bytes, and nothing of the tail is kept.
 */
function answerFrom(tail: string, fromStart: boolean): LastMessageResponse {
  const tokens = lastUsageInTail(tail, fromStart);
  const counted = tokens === null ? {} : { tokens };
  const said = lastSaidInTail(tail, fromStart);
  if (said.text === null) return { message: null, reason: said.reason, ...counted };
  const shown = messageText(said.text);
  // What it said is made only of what cannot be shown: there is nothing to show.
  if (shown === undefined) {
    return { message: null, reason: fromStart ? "nothing-yet" : "too-far-back", ...counted };
  }
  return { message: { text: shown.text, cut: shown.cut || said.startCut === true }, ...counted };
}

/**
 * Reads what a Claude Code session last said, from the end of its transcript,
 * `<claude home>/projects/<folder>/<sessionId>.jsonl`, when the route asks for
 * it, and only then: no poll opens a transcript for this. The token counts of
 * its newest reply come with it, from the same bytes, and no file is opened or
 * read for them that would not be for the text.
 *
 * - Only a session the adapter listed on its last poll is read. The path is
 *   made from what the adapter read for it, its id once it is checked to be
 *   one and its folder, through `findTranscript`, never from a request. A
 *   listed session whose id is not one, such as a background job known only
 *   by its job id, is answered `not-found` without a file being touched.
 * - The end of the file is read as the waiting text's is, at most 256 KB, by
 *   position, and not again while the file is unchanged. A transcript not
 *   found is looked for again only after 10 seconds.
 * - An answer is given again from memory for a second. Asks for one session
 *   while its transcript is being read share that read.
 * - At most four transcripts are read in a second, for every session
 *   together. Above that the answer is `busy`, and no file is touched.
 * - What is kept is the place of the file, its stamp and the last answer,
 *   counts and all, for eight sessions at most, and only for 15 seconds after
 *   each was last asked for, or until a poll does not list the session.
 */
export function createLastMessageReader(options: LastMessageReaderOptions): LastMessageReader {
  const io = options.io ?? nodeIo;
  const now = options.now ?? Date.now;
  const later = options.later ?? runLater;
  const projectsDir = path.join(options.claudeHome, "projects");
  /** Null for a listed session whose id names no transcript, such as a background job known only by its job id. */
  const listed = new Map<string, Listed | null>();
  const kept = new Map<string, Kept>();
  /** When each read of the last second began. */
  let reads: number[] = [];
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

  /** Whether a transcript may be read now, counted as one of the second's reads when it may. */
  function mayRead(at: number): boolean {
    reads = reads.filter((started) => at - started < 1_000 && started <= at);
    if (reads.length >= READS_PER_SECOND) return false;
    reads.push(at);
    return true;
  }

  /** Makes room for one more entry, dropping the one asked for least recently. */
  function makeRoom(): void {
    while (kept.size >= MAX_KEPT) {
      let leastRecent: [string, Kept] | undefined;
      for (const pair of kept) {
        if (leastRecent === undefined || pair[1].askedAt < leastRecent[1].askedAt) {
          leastRecent = pair;
        }
      }
      if (leastRecent === undefined) return;
      kept.delete(leastRecent[0]);
    }
  }

  async function check(entry: Kept, target: Listed, at: number): Promise<LastMessageResponse> {
    try {
      if (entry.file === null) {
        entry.lookedAt = at;
        entry.file = await findTranscript(projectsDir, target.sessionId, target.cwd, io);
        if (entry.file === null) return NOT_FOUND;
      }
      const read = await readTranscriptTail(entry.file, io, entry.last?.stamp ?? null);
      // As it was when its end was last read, which is the only stamp ever
      // passed: the answer made then stands.
      if (read.unchanged) return entry.last?.answer ?? UNREADABLE;
      // The end of the file is not kept once the answer is made from it.
      const answer = answerFrom(read.tail, read.fromStart);
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
          at - entry.lookedAt < LOOK_AGAIN_MS
        ) {
          return Promise.resolve(entry.answer);
        }
      }
      if (!mayRead(at)) return Promise.resolve("busy");

      let fresh = entry;
      if (fresh === undefined) {
        makeRoom();
        fresh = {
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
    keep(sessions) {
      listed.clear();
      for (const session of sessions) {
        const sessionId = sessionIdOf(session);
        listed.set(session.id, sessionId === null ? null : { sessionId, cwd: session.cwd });
      }
      for (const id of kept.keys()) {
        if (!listed.has(id)) kept.delete(id);
      }
      dropOld(now());
    },
    forget() {
      listed.clear();
      kept.clear();
      reads = [];
    },
    get size() {
      return kept.size;
    },
  };
}
