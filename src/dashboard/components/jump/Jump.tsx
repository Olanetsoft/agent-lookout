import type { Session } from "@core/sessions/session";
import { Button } from "@dashboard/components/ui/controls/Button";
import { Badge } from "@dashboard/components/ui/status/Badge";
import { Tooltip } from "@dashboard/components/ui/surfaces/Tooltip";
import type { JumpPress } from "@dashboard/hooks/data/useJump";
import {
  AUTOMATION_REFUSED_LINE,
  automationAskLine,
  jumpOutcomeWords,
} from "@dashboard/lib/api/jump";
import { jumpWay } from "@dashboard/lib/sessions/status";
import { cn } from "@dashboard/lib/utils";

interface JumpProps {
  session: Session;
  /** The press and what it came to, from `useJump`, held by whatever draws the session. */
  jump: JumpPress;
  /** The lamp's solid button is for a session that needs the person now, in the hero. */
  variant?: "quiet" | "needs-you";
  size?: "sm" | "hero";
  className?: string;
}

/**
 * A session's Jump, or nothing when there is no way to reach it.
 *
 * A session with a link, one in VS Code, gets a link the browser opens. A
 * session the collector found in a tmux pane gets a button that asks the
 * collector to select that pane, and one it found in a tab of Terminal or
 * iTerm2 a button that asks it to bring that tab forward. They look the same
 * and sit in the same place. Each is named for the session and where it goes,
 * and a button says where when pointed at or reached with Tab:
 * "tmux, work:2.1", or "Terminal".
 */
export function Jump({ session, jump, variant, size = "sm", className }: JumpProps) {
  const way = jumpWay(session);
  if (!way) return null;
  const label = `Jump to ${session.name} in ${way.where}`;
  // At the small size every Jump is as wide as the next, so a column of them lines up.
  const look = cn(size === "sm" && "w-16", className);

  if (way.by === "link") {
    return (
      <Button asChild variant={variant} size={size} className={look}>
        <a href={way.href} data-part='jump' aria-label={label}>
          Jump
        </a>
      </Button>
    );
  }
  return (
    <Tooltip content={way.where} align='end'>
      <Button
        variant={variant}
        size={size}
        className={look}
        data-part='jump'
        data-way={way.by}
        aria-label={label}
        onClick={jump.press}
      >
        Jump
      </Button>
    </Tooltip>
  );
}

/**
 * What the last press of a session's Jump came to, beside the session's name,
 * or under it where the line cannot hold both: "Selected in tmux" as a quiet
 * badge, or why not, such as "That pane has closed", as an outlined one. It
 * stays a few seconds. Neither is warm, since neither is a session needing the
 * person.
 *
 * Two things need a sentence, which goes on a line of its own under the name
 * in the secondary ink: while the first press of a Jump to a Terminal or iTerm2
 * tab on this browser is held by macOS's question, that macOS will ask once,
 * and when macOS did not allow it, where to change that.
 *
 * A screen reader is told through a line that is in the page before there is
 * anything to say, so that the change is heard. The badge and the sentence are
 * for the eye only.
 */
export function JumpNote({
  session,
  jump,
  className,
}: {
  session: Session;
  jump: JumpPress;
  className?: string;
}) {
  const { outcome, asking } = jump;
  const way = jumpWay(session);
  if (outcome === null && asking === null && (way === null || way.by === "link")) return null;
  const words =
    outcome === null ? null : jumpOutcomeWords(outcome, way?.by === "terminal" ? way.app : null);
  const line =
    outcome === "not-allowed"
      ? AUTOMATION_REFUSED_LINE
      : outcome === null && asking !== null
        ? automationAskLine(asking)
        : null;
  return (
    <>
      <span role='status' data-part='jump-said' className='sr-only'>
        {words !== null && line !== null ? `${words}. ${line}` : (words ?? line)}
      </span>
      {words !== null && (
        <Badge
          aria-hidden
          data-part='jump-note'
          data-outcome={outcome}
          tone={outcome === "selected" ? "neutral" : "outline"}
          className={className}
        >
          {words}
        </Badge>
      )}
      {line !== null && (
        <span
          aria-hidden
          data-part='jump-line'
          className='basis-full text-caption text-ink-secondary'
        >
          {line}
        </span>
      )}
    </>
  );
}
