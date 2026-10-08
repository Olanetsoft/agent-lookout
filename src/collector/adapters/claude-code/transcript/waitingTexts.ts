import path from "node:path";

import type { Session } from "../../../../core/sessions/session.ts";
import { isMissing, nodeIo, type ReadOnlyIo } from "../../../files/readOnlyIo.ts";
import { askedInTail } from "./lastAsk.ts";
import {
  findTranscript,
  readTranscriptTail,
  sessionIdOf,
  type TranscriptStamp,
} from "./transcriptFile.ts";

/** The setting that, set to `off`, stops any transcript being opened. */
export const WAITING_TEXT_ENV = "AGENT_LOOKOUT_WAITING_TEXT";

/** Whether the environment turns the reading of transcripts off. */
export function waitingTextOff(env: NodeJS.ProcessEnv): boolean {
  return env[WAITING_TEXT_ENV]?.trim().toLowerCase() === "off";
}

/**
 * How long a transcript that was looked for and not found is left before it
 * is looked for again, while the same wait goes on. Looking means listing the
 * `projects` folder, which can hold a folder for every project ever opened.
 */
export const LOOK_AGAIN_MS = 10_000;

/** What is remembered of one wait, until it ends. */
interface Kept {
  /** The wait it was read for: the session's status time when it was. */
  statusSince: number | null;
  /** Where its transcript is, or null when it was looked for and not found. */
  file: string | null;
  /** When it was looked for. */
  lookedAt: number;
  /** The file as it was when its end was last read, or null before that. */
  stamp: TranscriptStamp | null;
  /** What that end said the session is asking. */
  text: string | undefined;
}

export interface WaitingTextReader {
  /**
   * Gives each Claude Code session that needs the person what it is asking,
   * when the end of its transcript says, as `waitingText`. Every other session
   * is handed back as it is. It never rejects: a transcript that cannot be
   * found or read gives no text.
   *
   * What it remembers of a session is forgotten as soon as that session is
   * not waiting in the list it is handed, so nothing outlives the wait.
   */
  annotate(sessions: readonly Session[]): Promise<Session[]>;
  /** How many waits it remembers. */
  readonly size: number;
}

export interface WaitingTextReaderOptions {
  /** The Claude Code folder, `~/.claude` or the one `AGENT_LOOKOUT_CLAUDE_HOME` names. */
  claudeHome: string;
  /** Defaults to the file system. Tests pass a stand-in. */
  io?: ReadOnlyIo;
  now?: () => number;
}

/**
 * Reads what each waiting Claude Code session is asking from the last message
 * of its transcript, `<claude home>/projects/<folder>/<sessionId>.jsonl`.
 *
 * Only a session that needs the person is read, and only the end of its
 * transcript. A wait's transcript is found once, and its end is read again
 * only when the file's size, modified time or identity has changed, so a
 * session that waits for an hour is not read every two seconds. What is
 * remembered is the place, the file's stamp and the text, by session, and it
 * is dropped on the first poll the session is not waiting.
 */
export function createWaitingTextReader(options: WaitingTextReaderOptions): WaitingTextReader {
  const io = options.io ?? nodeIo;
  const now = options.now ?? Date.now;
  const projectsDir = path.join(options.claudeHome, "projects");
  const kept = new Map<string, Kept>();

  async function textFor(session: Session, sessionId: string): Promise<string | undefined> {
    const at = now();
    let wait = kept.get(session.id);
    // Another wait, or one whose transcript was not found a while ago, is looked for again.
    if (
      wait === undefined ||
      wait.statusSince !== session.statusSince ||
      (wait.file === null && at - wait.lookedAt >= LOOK_AGAIN_MS)
    ) {
      const file = await findTranscript(projectsDir, sessionId, session.cwd, io);
      wait = { statusSince: session.statusSince, file, lookedAt: at, stamp: null, text: undefined };
      kept.set(session.id, wait);
    }
    if (wait.file === null) return undefined;

    try {
      const read = await readTranscriptTail(wait.file, io, wait.stamp);
      if (!read.unchanged) {
        wait.stamp = read.stamp;
        wait.text = askedInTail(read.tail, read.fromStart, session.cwd);
      }
      return wait.text;
    } catch (error) {
      // Gone from where it was: it is looked for again in a while. Anything
      // else, a link or a pipe among them, is no transcript, and gives no text.
      if (isMissing(error)) wait.file = null;
      wait.lookedAt = at;
      wait.stamp = null;
      wait.text = undefined;
      return undefined;
    }
  }

  return {
    async annotate(sessions) {
      const waiting = new Set<string>();
      const annotated = await Promise.all(
        sessions.map(async (session) => {
          const sessionId = session.status === "needs-you" ? sessionIdOf(session) : null;
          if (sessionId === null) return session;
          waiting.add(session.id);
          let text: string | undefined;
          try {
            text = await textFor(session, sessionId);
          } catch {
            // Nothing above is expected to throw. If it does, the session goes without.
            text = undefined;
          }
          return text === undefined ? session : { ...session, waitingText: text };
        }),
      );
      for (const id of kept.keys()) {
        if (!waiting.has(id)) kept.delete(id);
      }
      return annotated;
    },
    get size() {
      return kept.size;
    },
  };
}
