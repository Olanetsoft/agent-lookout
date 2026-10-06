import type { Session } from "@core/sessions/session";
import { Badge } from "@dashboard/components/ui/status/Badge";
import { cn } from "@dashboard/lib/utils";

/**
 * The other machine a session runs on, as a word after its name: a neutral
 * badge, "devbox", read as "on devbox". It is a fact about the row, as the
 * agent's name is, and never warm. A session on this machine has none.
 *
 * A machine's name is at most 24 letters, digits and dashes, so the badge is
 * never cut, and nor is the session's name for it: where the line cannot hold
 * both, the badge goes under the name, as what Jump came to does.
 */
export function Machine({
  session,
  className,
}: {
  session: Pick<Session, "machine">;
  className?: string;
}) {
  if (session.machine === undefined) return null;
  return (
    <Badge data-part='machine' className={className}>
      <span className='sr-only'>on </span>
      {session.machine}
    </Badge>
  );
}

/**
 * The other machine as words after a session's name, " on devbox", where a
 * badge has no room and nothing can go under the name: inside the name's own
 * cut text in a column of fixed width, such as the timeline's names and the
 * bars of waits, where it is the end of the text and so the first part cut,
 * and in a sentence, such as an event's. Never warm. Nothing for a session on
 * this machine.
 */
export function OnMachine({ machine, className }: { machine: string | null; className?: string }) {
  if (machine === null) return null;
  return (
    <span data-part='machine' className={cn("font-normal", className)}>
      {" "}
      on {machine}
    </span>
  );
}
