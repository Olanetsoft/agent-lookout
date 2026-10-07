// Which Antigravity CLI conversations an agy program may have open, from the
// process table and when each conversation was last written. Pure.
//
// agy keeps no lock, pid file or other mark of an open conversation
// (docs/adapters/antigravity.md). What can be known is which agy programs run,
// when each started, and, for one started with `--conversation <id>`, which
// conversation it opened. A program writes to the conversation it has open, so
// a conversation written since a program started may be that program's.

import type { AntigravityLiveness } from "./antigravityMapping.ts";

/** One agy program that runs a session, as the process table gives it. */
export interface AgySessionProcess {
  /** When it started, in epoch milliseconds, to the second. Null when not known. */
  startedAt: number | null;
  /** The conversation it was started with, `--conversation <id>`, in lower case. */
  conversation?: string;
}

/** One conversation, and when agy last wrote any of its files. */
export interface ConversationWrite {
  id: string;
  /** Epoch milliseconds. Null when none of its files could be looked at. */
  writtenAt: number | null;
}

export interface Holding {
  /** The conversations an agy program may have open. */
  held: Set<string>;
  /**
   * False when some program could be holding any conversation at all: one
   * that names none and has written none since it started, as a program does
   * before its first step is saved, or after it resumed an older conversation
   * and has not yet written to it, or one whose start is not known. Then no
   * other conversation can be said to be closed.
   */
  complete: boolean;
}

/**
 * Works out which conversations agy programs may have open.
 *
 * - A program started with `--conversation <id>` may have that one open.
 * - A program may have open any conversation written since it started: the
 *   one it began, one it moved on to with `/new` or `/resume`, or, as far as
 *   the files can tell, one another agy program wrote to and closed meanwhile.
 * - A program that names no conversation and has written none since it
 *   started, or whose start is not known, makes the answer incomplete.
 *
 * It errs towards open: a conversation is closed only when no agy program
 * running could have it open. With one agy program open all day, every
 * conversation it wrote to stays open until it ends.
 */
export function holdConversations(
  processes: readonly AgySessionProcess[],
  conversations: readonly ConversationWrite[],
): Holding {
  const held = new Set<string>();
  let complete = true;
  for (const { startedAt, conversation } of processes) {
    if (conversation !== undefined) held.add(conversation);
    if (startedAt === null) {
      if (conversation === undefined) complete = false;
      continue;
    }
    let wrote = false;
    for (const { id, writtenAt } of conversations) {
      if (writtenAt === null || writtenAt < startedAt) continue;
      held.add(id);
      wrote = true;
    }
    if (!wrote && conversation === undefined) complete = false;
  }
  return { held, complete };
}

/**
 * Whether agy has one conversation open: true when a program may have it open,
 * false when none could, and "unknown" when the process table could not be
 * read (`holding` null) or the holding is not complete.
 */
export function antigravityLiveness(id: string, holding: Holding | null): AntigravityLiveness {
  if (holding === null) return "unknown";
  if (holding.held.has(id)) return true;
  return holding.complete ? false : "unknown";
}
