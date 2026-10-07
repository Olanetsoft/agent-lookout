// Which Antigravity CLI conversations an agy program may have open, from the
// process table and when each conversation's transcript was last written. Pure.
//
// The adapter does not read the lock agy keeps of an open conversation
// (docs/adapters/antigravity.md). What it knows is which agy programs run,
// when each started, and which conversation each names: the one its log says
// it opened last, else the one it was started with, `--conversation <id>`. A
// program writes to the conversation it has open, so a conversation written
// since a program started may be that program's.

import type { AntigravityLiveness } from "./antigravityMapping.ts";

/** One agy program that runs a session, as the process table gives it. */
export interface AgySessionProcess {
  /** When it started, in epoch milliseconds, to the second. Null when not known. */
  startedAt: number | null;
  /** The conversation it was started with, `--conversation <id>`, in lower case. */
  conversation?: string;
}

/** One conversation, and when agy last wrote its transcript. */
export interface ConversationWrite {
  id: string;
  /** Epoch milliseconds. Null when the transcript could not be looked at. */
  writtenAt: number | null;
}

export interface Holding {
  /** The conversations an agy program may have open. */
  held: Set<string>;
  /**
   * False when some program could be holding any conversation at all: one
   * whose start is not known, or one that names none and has written none
   * since it started, as a program does before its first step is saved, or
   * when the first thing it did was resume an older conversation. Then no
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
 * - A program whose start is not known, or that names no conversation and
 *   has written none since it started, makes the answer incomplete.
 * - A conversation written after the process table was read, at `listedAt`,
 *   may be open in a program started since, which the table does not show.
 *
 * It errs towards open: a conversation is closed only when no agy program
 * running could have it open. With one agy program open all day, every
 * conversation it wrote to stays open until it ends. It cannot tell when a
 * program that has written to one conversation resumes an older one: that
 * one is held only once the program writes to it.
 */
export function holdConversations(
  processes: readonly AgySessionProcess[],
  conversations: readonly ConversationWrite[],
  listedAt: number | null = null,
): Holding {
  const held = new Set<string>();
  let complete = true;
  for (const { startedAt, conversation } of processes) {
    if (conversation !== undefined) held.add(conversation);
    if (startedAt === null) {
      // It may have moved on from the one it names, with `/new` or `/resume`.
      complete = false;
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
  if (listedAt !== null) {
    for (const { id, writtenAt } of conversations) {
      if (writtenAt !== null && writtenAt > listedAt) held.add(id);
    }
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
