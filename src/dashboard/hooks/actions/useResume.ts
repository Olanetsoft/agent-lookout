import { useCallback, useEffect, useRef, useState } from "react";

import { sessionResumeCommand } from "@core/mapping/claudeCodeResume";
import type { Session } from "@core/sessions/session";
import { COPIED_MS, type CopyOutcome } from "@dashboard/lib/shell/clipboard";

export interface ResumeCopy {
  /** The command that resumes the session, or null when it has none to offer. */
  command: string | null;
  /** Whether the button's word reads "Copied", for two seconds after a press copied. */
  copied: boolean;
  /** Whether the last press was refused the clipboard, so the command is shown to select by hand. */
  refused: boolean;
  /** Told what a press came to. */
  onCopied: (outcome: CopyOutcome) => void;
}

/**
 * One session's Resume: the command it copies, whether a press just copied it,
 * and whether the clipboard refused it, held by what draws the session, so the
 * button and the command shown in its place can sit in different parts of the
 * same row, and a button drawn again in another place, as a row's is when the
 * window crosses 760px, still says "Copied" for the rest of its two seconds.
 *
 * A session has a command once it is over, or, with `ended`, once Agent
 * Lookout has seen its process end: see `sessionResumeCommand`. A refusal
 * stands until a press copies, so the command stays on the page for as long
 * as the person needs to select it.
 */
export function useResume(
  session: Pick<Session, "id" | "source" | "status" | "alive" | "cwd">,
  ended?: boolean,
): ResumeCopy {
  const command = sessionResumeCommand(session, ended);
  const [copied, setCopied] = useState(false);
  const [refused, setRefused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onCopied = useCallback((outcome: CopyOutcome) => {
    setRefused(outcome === "refused");
    clearTimeout(timer.current);
    setCopied(outcome === "copied");
    if (outcome === "copied") timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }, []);
  return {
    command,
    copied: copied && command !== null,
    refused: refused && command !== null,
    onCopied,
  };
}
