import type { Session } from "@core/sessions/session";
import { formatShortDuration, shortDurationInWords } from "@dashboard/lib/format";

/** How long a working session's agent may write nothing before its row says so: 5 minutes. */
export const QUIET_AFTER_MS = 5 * 60_000;

/**
 * How long a working session's agent has written nothing to its file, once
 * that is the threshold or longer. Null for every other session: one that is
 * not working, one whose source gives no time of its last write, and one that
 * wrote more recently than that.
 *
 * It is a measurement and changes nothing else: the session stays working,
 * with its own mark and word, and is never taken to need the person. A Codex
 * session waiting for approval shows as working, and so does an agent that has
 * hung: a long quiet stretch is the sign to look.
 */
export function quietFor(
  session: Pick<Session, "status" | "lastWriteAt">,
  now: number,
): number | null {
  if (session.status !== "working" || session.lastWriteAt === undefined) return null;
  const quiet = now - session.lastWriteAt;
  return quiet >= QUIET_AFTER_MS ? quiet : null;
}

/** What a row says of it, in the table's short form: "quiet for 12m". */
export function quietPhrase(ms: number): string {
  return `quiet for ${formatShortDuration(ms)}`;
}

/** The same in words, so what is read out is what is shown: "quiet for 12 minutes". */
export function quietPhraseInWords(ms: number): string {
  return `quiet for ${shortDurationInWords(ms)}`;
}
