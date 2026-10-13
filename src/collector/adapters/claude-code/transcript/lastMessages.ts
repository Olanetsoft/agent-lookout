import path from "node:path";

import type { LastMessageResponse } from "../../../../core/api.ts";
import type { Session } from "../../../../core/sessions/session.ts";
import { messageText } from "../../../../core/text.ts";
import { nodeIo, type ReadOnlyIo } from "../../../files/readOnlyIo.ts";
import {
  createTailReader,
  type LastMessageAnswer,
  type TailLimits,
} from "../../../messages/tailReader.ts";
import { lastSaidInTail } from "./lastSaid.ts";
import { lastUsageInTail } from "./lastUsage.ts";
import { findTranscript, sessionIdOf } from "./transcriptFile.ts";
import { LOOK_AGAIN_MS } from "./waitingTexts.ts";

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
  /** Shared with the other agents' readers. Left out, the reader has its own. */
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
 * The limits are those of every reader of last messages, `createTailReader`
 * in `src/collector/messages/tailReader.ts`: the last 256 KB, not again while
 * the file is unchanged, an answer given again for a second, four
 * transcripts a second and eight sessions kept, with the other agents'
 * readers, each for 15 seconds after it was last asked for. What is Claude
 * Code's own:
 *
 * - The path is made from what the adapter read for the session, its id once
 *   it is checked to be one and its folder, through `findTranscript`, never
 *   from a request. A listed session whose id is not one, such as a background
 *   job known only by its job id, is answered `not-found` without a file being
 *   touched.
 * - A transcript not found is looked for again only after 10 seconds, since
 *   looking can list every folder in `projects`.
 * - What is kept of an answer holds its counts too.
 */
export function createLastMessageReader(options: LastMessageReaderOptions): LastMessageReader {
  const io = options.io ?? nodeIo;
  const projectsDir = path.join(options.claudeHome, "projects");
  const reader = createTailReader<Listed>({
    find: (target) => findTranscript(projectsDir, target.sessionId, target.cwd, io),
    answerFrom,
    lookAgainMs: LOOK_AGAIN_MS,
    limits: options.limits,
    io,
    now: options.now,
    later: options.later,
  });

  return {
    read: (id) => reader.read(id),
    keep(sessions) {
      const targets = new Map<string, Listed | null>();
      for (const session of sessions) {
        const sessionId = sessionIdOf(session);
        targets.set(session.id, sessionId === null ? null : { sessionId, cwd: session.cwd });
      }
      reader.keep(targets);
    },
    forget: () => reader.forget(),
    get size() {
      return reader.size;
    },
  };
}
