import type { ReactNode } from "react";

import type { LastMessageReason, LastMessageSetting } from "@core/api";
import { Literal } from "@dashboard/components/ui/facts/Literal";
import { Loading } from "@dashboard/components/ui/feedback/Loading";
import type { LastMessageReading } from "@dashboard/hooks/data/useLastMessage";
import { useOverflows } from "@dashboard/hooks/dom/useOverflows";
import { cn } from "@dashboard/lib/utils";

/** Said in place of what a session on another machine last said, which is never asked for. */
const REMOTE_LINE = "Last messages are not read from another machine.";

/** Said once the asking failed with nothing read before. */
const FAILED_LINE = "Its last message could not be read. The page asks again every two seconds.";

/** Said over a message whose start was left out. */
const CUT_LINE = "The start of a longer message is left out.";

/** One calm line in place of the message. */
function Line({ children }: { children: ReactNode }) {
  return (
    <p data-part='last-message-state' className='py-2.5 text-body text-ink-secondary'>
      {children}
    </p>
  );
}

/** Why there is no message to show, in words. */
function reasonWords(
  reason: LastMessageReason,
  setting: LastMessageSetting | undefined,
  agent: string,
): ReactNode {
  switch (reason) {
    case "off":
      return setting === undefined ? (
        "Last messages are off."
      ) : (
        <>
          Last messages are off:{" "}
          <code data-slot='fact' className='font-mono text-fact'>
            <Literal>{setting}</Literal>
          </code>{" "}
          is off.
        </>
      );
    case "not-read":
      return `Agent Lookout does not read what ${agent} sessions say.`;
    case "not-found":
      return "Its transcript was not found.";
    case "unreadable":
      return "Its transcript could not be read.";
    case "nothing-yet":
      return "It has not said anything yet.";
    case "too-far-back":
      return "Its last message is further back than the end of its transcript that Agent Lookout reads.";
  }
}

/**
 * The text itself, as it was written: a plain text node, so nothing in it is
 * read as markup or becomes a link, with every line break kept and long
 * words broken anywhere. It can be selected to copy. A long message scrolls
 * inside its block, which is then a Tab stop, so it can be scrolled from the
 * keyboard too.
 */
function Message({ text, cut }: { text: string; cut: boolean }) {
  const [ref, overflows] = useOverflows<HTMLDivElement>(text);
  return (
    <div className='pt-2.5'>
      {cut && (
        <p data-part='last-message-cut' className='mb-1.5 text-caption text-ink-muted'>
          {CUT_LINE}
        </p>
      )}
      <div
        ref={ref}
        data-part='last-message-scroll'
        data-overflows={overflows || undefined}
        role={overflows ? "group" : undefined}
        tabIndex={overflows ? 0 : undefined}
        aria-label={overflows ? "Its last message" : undefined}
        className={cn(
          "thin-scroll max-h-60 overflow-y-auto",
          overflows && "focus-visible:-outline-offset-2",
        )}
      >
        <p
          data-part='last-message-text'
          className='text-body whitespace-pre-wrap text-ink wrap-anywhere select-text'
        >
          {text}
        </p>
      </div>
    </div>
  );
}

interface LastMessageProps {
  reading: LastMessageReading;
  /** The session runs on another machine: nothing is asked for it. */
  remote: boolean;
  /** Its agent, in words, for a session whose agent's messages are not read. */
  agent: string;
}

/**
 * What a session last said, in its details: the text of its newest reply, or
 * one line that says why there is none. Nothing in it is warm. Apart from
 * `Loading`'s status while it is first read, nothing in it is announced as it
 * changes: it is there to be read when the person looks.
 */
export function LastMessage({ reading, remote, agent }: LastMessageProps) {
  if (remote) return <Line>{REMOTE_LINE}</Line>;
  if (reading.status === "idle") return null;
  if (reading.status === "loading") {
    return <Loading label='Reading its last message' className='justify-start px-0 py-2.5' />;
  }
  if (reading.status === "failed" || reading.answer === null) return <Line>{FAILED_LINE}</Line>;
  const { answer } = reading;
  if (answer.message !== null)
    return <Message text={answer.message.text} cut={answer.message.cut} />;
  return <Line>{reasonWords(answer.reason, answer.setting, agent)}</Line>;
}
