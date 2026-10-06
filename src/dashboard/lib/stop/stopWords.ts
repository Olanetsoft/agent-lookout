import type { Session } from "@core/sessions/session";
import type { TextRun } from "@dashboard/lib/sources/facts";

/**
 * What the person is told before a session is stopped: what Stop does, that
 * the conversation is kept and how to open it again, and what is lost of what
 * it is doing now. A command is a run of its own, set in the mono.
 */

/**
 * A run of a sentence: words, or a command in the mono. A `whole` command is
 * never broken across two lines, as `claude --resume` must not be at its
 * dashes; any other may break anywhere, as a long ID must on a phone.
 */
export interface StopRun extends TextRun {
  whole?: boolean;
}

/** The prefix of a Claude Code session's id, before its own. */
const CLAUDE_CODE_PREFIX = "claude-code:";

/** A Claude Code session's own ID, without the source in front, or null for any other session. */
function claudeCodeId(session: Pick<Session, "id" | "source">): string | null {
  if (session.source !== "claude-code" || !session.id.startsWith(CLAUDE_CODE_PREFIX)) return null;
  const id = session.id.slice(CLAUDE_CODE_PREFIX.length);
  return id === "" ? null : id;
}

/** The command that opens a Claude Code session's conversation again: `claude --resume <id>`. */
export function resumeCommand(session: Pick<Session, "id" | "source">): string | null {
  const id = claudeCodeId(session);
  return id === null ? null : `claude --resume ${id}`;
}

/** `claude --resume`, the command that opens a conversation again, as a run that is never broken. */
export const RESUME: StopRun = { text: "claude --resume", fact: true, whole: true };

/** The question the confirmation asks: "Stop checkout-flow?". */
export function stopQuestion(session: Pick<Session, "name">): string {
  return `Stop ${session.name}?`;
}

const words = (text: string): StopRun => ({ text, fact: false });
const command = (text: string): StopRun => ({ text, fact: true });

/**
 * `claude --resume <id>` as runs: the command, which is never broken, and the
 * ID, which may break where a narrow window needs it to.
 */
function resumeRuns(session: Pick<Session, "id" | "source">): StopRun[] | null {
  const id = claudeCodeId(session);
  return id === null ? null : [RESUME, words(" "), command(id)];
}

/**
 * What Stop does to this session, and how its conversation is opened again.
 *
 * - In a terminal: its process ends now, and `claude --resume <id>` opens the
 *   conversation again.
 * - In VS Code: the same, and the session history in VS Code opens it too.
 * - A background job: Claude Code is asked to stop it with `claude stop`.
 */
export function stopDoes(session: Pick<Session, "id" | "source" | "surface" | "stop">): StopRun[] {
  const resume = resumeRuns(session);
  const kept: StopRun[] = resume
    ? [words("The conversation is kept, and "), ...resume, words(" opens it again.")]
    : [words("The conversation is kept.")];
  if (session.stop?.how === "background") {
    return [
      words("Agent Lookout asks Claude Code to stop this background job with "),
      { ...command("claude stop"), whole: true },
      words(". "),
      ...kept,
    ];
  }
  if (session.surface === "vscode" && resume) {
    return [
      words(
        "Its process ends now. The conversation is kept: open it again from the session history in VS Code, or with ",
      ),
      ...resume,
      words("."),
    ];
  }
  return [words("Its process ends now. "), ...kept];
}

/** What is lost of what it is doing now, or null when it is doing nothing. */
export function stopInterrupts(session: Pick<Session, "status">): string | null {
  if (session.status === "working")
    return "It is working now. What it is doing will stop part-way.";
  if (session.status === "needs-you")
    return "It is waiting for you. The question is left unanswered.";
  return null;
}

/** Why a Claude Code session in the desktop app has no Stop, in one line, for its details. */
export const DESKTOP_NO_STOP =
  "Stop it in the desktop app. Agent Lookout does not stop the desktop app's sessions, because that app looks after their processes.";

/** The same, short, for a row of the sessions left running: the details say why. */
export const DESKTOP_STOP_THERE = "Stop it in the desktop app.";
