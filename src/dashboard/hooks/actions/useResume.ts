import { useCallback, useState } from "react";

import { sessionResumeCommand } from "@core/mapping/claudeCodeResume";
import type { Session } from "@core/sessions/session";
import type { CopyOutcome } from "@dashboard/lib/shell/clipboard";

export interface ResumeCopy {
  /** The command that resumes the session, or null when it has none to offer. */
  command: string | null;
  /** Whether the last press was refused the clipboard, so the command is shown to select by hand. */
  refused: boolean;
  /** Told what a press came to. */
  onCopied: (outcome: CopyOutcome) => void;
}

/**
 * One session's Resume: the command it copies, and whether the clipboard
 * refused it, held by what draws the session, so the button and the command
 * shown in its place can sit in different parts of the same row.
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
  const [refused, setRefused] = useState(false);
  const onCopied = useCallback((outcome: CopyOutcome) => setRefused(outcome === "refused"), []);
  return { command, refused: refused && command !== null, onCopied };
}
