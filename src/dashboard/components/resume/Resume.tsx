import type { Session } from "@core/sessions/session";
import { CopyButton } from "@dashboard/components/ui/controls/CopyButton";
import { Literal } from "@dashboard/components/ui/facts/Literal";
import type { ResumeCopy } from "@dashboard/hooks/actions/useResume";
import { cn } from "@dashboard/lib/utils";

/** What a screen reader is told when the clipboard refused the command. */
const REFUSED_SAID = "The command was not copied. It is shown on the page, to select and copy.";

/**
 * The command as a literal string a person can select whole: in the mono,
 * broken only between its words and after a slash, with every space kept as
 * it is, so a folder with two spaces in a row is selected as it is. A click
 * selects all of it, and it is a Tab stop, so a click on it in a row selects
 * it rather than opening the session's details.
 */
function Command({ command, className }: { command: string; className?: string }) {
  return (
    <code
      data-part='resume-command'
      tabIndex={0}
      className={cn("font-mono text-fact whitespace-pre-wrap text-ink select-all", className)}
    >
      <Literal>{command}</Literal>
    </code>
  );
}

/**
 * A finished Claude Code session's Resume, or nothing when it has no command
 * to offer. It is the quiet button, in the place a Jump has, and it runs
 * nothing: it copies the command that goes to the session's folder and
 * resumes its conversation, `cd '<folder>' && claude --resume <ID>`, which is
 * one hover or one Tab away in its tooltip. For two seconds after, its word
 * reads "Copied".
 */
export function ResumeButton({
  session,
  resume,
  tooltip = true,
  className,
}: {
  session: Pick<Session, "name">;
  resume: ResumeCopy;
  /** Whether the command is in its tooltip. Left out where it is on the page already. */
  tooltip?: boolean;
  className?: string;
}) {
  if (resume.command === null) return null;
  return (
    <CopyButton
      text={resume.command}
      size='sm'
      data-part='resume'
      aria-label={`Copy the command that resumes ${session.name}`}
      copiedSaid={`Copied the command that resumes ${session.name}. Paste it in a terminal.`}
      refusedSaid={REFUSED_SAID}
      onCopied={resume.onCopied}
      tooltip={tooltip ? resume.command : undefined}
      tooltipMono
      // As wide as a Jump, so a column of them lines up, with less room at its sides for the longer word.
      className={cn("w-16 px-2", className)}
    >
      Resume
    </CopyButton>
  );
}

/**
 * In a row or on a card, once the clipboard has refused the command: a line
 * of its own under the name that says so, with the command to select by
 * hand. It stays until a press copies.
 */
export function ResumeNote({ resume, className }: { resume: ResumeCopy; className?: string }) {
  if (!resume.refused || resume.command === null) return null;
  return (
    <span
      data-part='resume-line'
      className={cn("basis-full text-caption text-ink-secondary", className)}
    >
      Not copied. Select the command to copy it:{" "}
      <Command command={resume.command} className='rounded-bar' />
    </span>
  );
}

/**
 * In a session's details: what Resume copies, the command itself as a
 * literal block, so the person sees what they copy, and once the clipboard
 * has refused it, a line saying so under it.
 */
export function ResumeBlock({ resume, className }: { resume: ResumeCopy; className?: string }) {
  if (resume.command === null) return null;
  return (
    <section data-part='resume-block' aria-label='Resume' className={cn("grid gap-1.5", className)}>
      <p className='text-body text-ink-secondary'>
        Resume copies this command, which goes to the session&apos;s folder and opens its
        conversation again. Paste it in a terminal.
      </p>
      <Command
        command={resume.command}
        className='block w-fit max-w-full rounded-row bg-fill-zebra px-3 py-1.5 inset-ring inset-ring-hairline'
      />
      {resume.refused && (
        <p data-part='resume-refused' className='text-body text-ink-secondary'>
          Not copied. Select the command and copy it.
        </p>
      )}
    </section>
  );
}
