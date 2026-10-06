// The command that opens a Claude Code session's conversation again, for the
// person to copy and run in a terminal. Agent Lookout only builds the text: it
// never runs it.
//
// `claude --resume <session ID>` continues a conversation by its ID (Claude
// Code's own `claude --help`, 2.1.292). Claude Code keeps each conversation
// under the folder the session ran in, so the command goes to that folder
// first and works from any folder: `cd '<folder>' && claude --resume <ID>`.
// `&&` keeps `claude` from starting anywhere else when the folder has gone.

import { isOver } from "../sessions/retention.ts";
import type { Session } from "../sessions/session.ts";

/** A session ID as Claude Code gives one: a UUID in its usual form, 8-4-4-4-12 hexadecimal digits. */
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What a folder may not hold for a command to be built for it: any control
 * character, a newline, a carriage return, NUL and the escape that starts a
 * terminal's own sequences among them, the two separators Unicode counts as
 * line breaks, the marks that change the order text is drawn in, which
 * would make the command on the screen read otherwise than the one copied,
 * and a backslash. Inside single quotes fish reads `\'` and `\\` as escapes,
 * so a backslash in the folder could end the quotes there and run the rest
 * of its name. With none, fish reads the quoting as sh, bash and zsh do.
 */
const UNSAFE_IN_COMMAND = /[\p{Cc}\\\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

/** The prefix of a Claude Code session's id, before Claude Code's own ID. */
const CLAUDE_CODE_PREFIX = "claude-code:";

/**
 * Text as one word of a POSIX shell (sh, bash, zsh): in single quotes, inside
 * which nothing is special, with each `'` in it written as `'\''`, which ends
 * the quotes, adds a quote of its own and starts them again. Fish reads it
 * the same way only when the text holds no backslash.
 */
export function shellQuoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * `cd '<folder>' && claude --resume <ID>`, or null when no command can be
 * given for certain: the ID is not a UUID in its usual form, or the folder is
 * not known, is not an absolute path, or holds a character listed above. The
 * folder is written exactly as given, so a home folder is its whole path, as
 * the collector reports it, never `~`, which would not be read inside quotes.
 */
export function resumeCommand(sessionId: string, folder: string | null | undefined): string | null {
  if (!SESSION_UUID.test(sessionId)) return null;
  if (typeof folder !== "string" || !folder.startsWith("/")) return null;
  if (UNSAFE_IN_COMMAND.test(folder)) return null;
  return `cd ${shellQuoted(folder)} && claude --resume ${sessionId}`;
}

/** Claude Code's own ID for one of its sessions, from the session's id, or null for any other session. */
export function claudeCodeSessionId(session: Pick<Session, "id" | "source">): string | null {
  if (session.source !== "claude-code" || !session.id.startsWith(CLAUDE_CODE_PREFIX)) return null;
  return session.id.slice(CLAUDE_CODE_PREFIX.length);
}

/**
 * The command that resumes a Claude Code session, when it can be resumed now:
 * once it is over, finished or failed with no process left behind it, which
 * only a background job is ever reported to be, or, with `ended`, once Agent
 * Lookout has seen its process end, as when the person stopped it. A session
 * whose process still runs is never offered one: resuming it would start a
 * second copy of the same conversation. Codex sessions, sessions from
 * status files and sessions on another machine have none: the command would
 * run on this computer, where that conversation is not kept.
 */
export function sessionResumeCommand(
  session: Pick<Session, "id" | "source" | "status" | "alive" | "cwd" | "machine">,
  ended: boolean = isOver(session),
): string | null {
  if (session.machine !== undefined) return null;
  const id = claudeCodeSessionId(session);
  if (id === null || !ended) return null;
  return resumeCommand(id, session.cwd);
}
