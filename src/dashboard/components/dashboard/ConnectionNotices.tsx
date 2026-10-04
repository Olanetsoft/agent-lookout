import { Button } from "@dashboard/components/ui/Button";
import { Callout } from "@dashboard/components/ui/Callout";
import { FactList, FactRow } from "@dashboard/components/ui/FactRow";
import { FactText } from "@dashboard/components/ui/FactText";
import { POLL_INTERVAL_MS, type ProblemKind } from "@dashboard/lib/collectorStore";
import { problemTitle } from "@dashboard/lib/connection";
import { formatAgo, formatClock } from "@dashboard/lib/format";

const RETRY_SECONDS = POLL_INTERVAL_MS / 1_000;

interface StaleNoticeProps {
  /** When the last answer arrived. */
  lastOkAt: number;
  now: number;
  onRetry: () => void;
}

/**
 * Shown above data that has stopped refreshing. The data stays on screen, and
 * this says how old it is, so yesterday's picture is never read as the present.
 *
 * The time is a clock time in a sentence, so it is in the sans with figures
 * that keep their width, as the header's checked time is.
 *
 * The notice is an alert, and an alert is read out again whenever its text
 * changes. The time of the last answer is fixed, so it is part of the alert. The
 * age beside it ticks every second, so it is shown but kept out of what is
 * announced: a screen reader says the notice once, not once a second.
 */
export function StaleNotice({ lastOkAt, now, onRetry }: StaleNoticeProps) {
  return (
    <Callout
      tone='error'
      title='Agent Lookout has stopped updating'
      action={
        <Button size='sm' onClick={onRetry}>
          Try now
        </Button>
      }
    >
      <p>
        This is what it last saw, at{" "}
        <span className='tabular-nums'>
          {formatClock(lastOkAt)}
          <span data-part='age' aria-hidden aria-live='off'>
            {" "}
            ({formatAgo(now - lastOkAt)})
          </span>
        </span>
        . Check that it is still running in your terminal. The page keeps trying and catches up on
        its own.
      </p>
    </Callout>
  );
}

const COMMAND = "font-mono text-fact";

/**
 * What to check, for each kind of failure. It agrees with the title above it and
 * does not say again what the title says: the title is what happened, this is
 * what to do about it.
 */
export function ProblemAdvice({ kind }: { kind: ProblemKind | null }) {
  if (kind === "error-status") {
    return (
      <p>
        Its local server is running. Restart Agent Lookout in your terminal, and open the address it
        prints.
      </p>
    );
  }
  if (kind === "not-data") {
    return (
      <p>
        This page is being served without its collector. Start Agent Lookout with{" "}
        <code className={COMMAND}>npm start</code> or <code className={COMMAND}>npm run dev</code>,
        and open the address it prints.
      </p>
    );
  }
  return <p>Check that Agent Lookout is still running in your terminal.</p>;
}

interface UnreachableProps {
  /** What the last request ran into, in plain words. */
  problem: string | null;
  /** The kind of failure that was. It decides what the page says to check. */
  kind: ProblemKind | null;
  onRetry: () => void;
}

/**
 * The page has never had an answer. This replaces the whole dashboard, because
 * an empty hero would look like "nothing needs you" rather than "no connection".
 * It is one card of glass, centred, with the error inside it.
 */
export function Unreachable({ problem, kind, onRetry }: UnreachableProps) {
  return (
    <section
      data-slot='unreachable'
      data-kind={kind ?? "no-answer"}
      aria-label='Connection problem'
      className='glass-card mx-auto mt-10 w-full max-w-155 p-6 max-mid:p-5'
    >
      <Callout
        tone='error'
        title={problemTitle(kind)}
        action={
          <Button size='sm' onClick={onRetry}>
            Try now
          </Button>
        }
      >
        <ProblemAdvice kind={kind} />
      </Callout>
      <FactList className='mt-3'>
        <FactRow label='What happened'>
          <FactText>{problem ?? "The local server did not answer."}</FactText>
        </FactRow>
        <FactRow label='Asked for' mono>
          /api/sessions
        </FactRow>
        <FactRow label='Trying again'>
          <span className='tabular-nums'>every {RETRY_SECONDS}s</span>
        </FactRow>
      </FactList>
    </section>
  );
}
