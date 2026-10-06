import type { Session } from "@core/sessions/session";
import { Button } from "@dashboard/components/ui/controls/Button";
import type { StopPress } from "@dashboard/hooks/actions/useStop";
import { stopOutcomeWords } from "@dashboard/lib/stop/stopRequest";
import {
  stopDoes,
  stopInterrupts,
  stopQuestion,
  type StopRun,
} from "@dashboard/lib/stop/stopWords";
import { cn } from "@dashboard/lib/utils";

/**
 * A sentence with its commands in the mono, as `FactText` sets them. A whole
 * command stays on one line; any other may break anywhere, so a long ID never
 * runs past a phone's width.
 */
export function Runs({ runs }: { runs: readonly StopRun[] }) {
  return (
    <>
      {runs.map((run, index) =>
        run.fact ? (
          <code
            key={index}
            data-slot='fact'
            className={cn("font-mono text-fact", run.whole ? "whitespace-nowrap" : "wrap-anywhere")}
          >
            {run.text}
          </code>
        ) : (
          run.text
        ),
      )}
    </>
  );
}

/**
 * A session's Stop, in its details beside its Jump, or nothing when the
 * collector cannot stop it. It is the quiet button, never warm, whatever the
 * session is doing, and it only asks: what it does is said in the
 * confirmation it opens.
 */
export function StopButton({ session, stop }: { session: Session; stop: StopPress }) {
  if (!session.stop) return null;
  const busy = stop.step.kind === "confirming" && stop.step.busy;
  return (
    <Button
      id={stop.ids.stop}
      size='sm'
      data-part='stop'
      aria-label={`Stop ${session.name}`}
      aria-expanded={stop.step.kind === "confirming"}
      aria-disabled={busy || undefined}
      onClick={stop.step.kind === "confirming" ? undefined : stop.ask}
    >
      Stop
    </Button>
  );
}

/**
 * What Stop asks, and what it came to, at the top of a session's details.
 *
 * The confirmation names the session and says what Stop does: its process
 * ends now, and the conversation is kept, with the command that opens it
 * again. For a session that is working or waiting, it says what is lost. It
 * has two quiet buttons, Stop session and Cancel, and focus goes to Cancel,
 * so Enter does not stop it. Once answered, one line says what happened, and
 * focus goes to it.
 */
export function StopNote({
  session,
  stop,
  className,
}: {
  session: Session;
  stop: StopPress;
  className?: string;
}) {
  const { step } = stop;
  if (step.kind === "idle") return null;
  if (step.kind === "answered") {
    return (
      <p
        id={stop.ids.outcome}
        tabIndex={-1}
        role='status'
        data-part='stop-outcome'
        data-outcome={step.outcome}
        className={cn("text-body text-ink outline-none", className)}
      >
        {stopOutcomeWords(step.outcome, session.stop?.how ?? "signal")}
      </p>
    );
  }

  const interrupts = stopInterrupts(session);
  return (
    <section
      data-part='stop-confirm'
      aria-label={stopQuestion(session)}
      className={cn("flex flex-col gap-1", className)}
    >
      {/* Said again to a screen reader when the press is under way. */}
      <p data-part='question' aria-live='polite' className='text-body font-medium text-ink'>
        {step.busy ? `Stopping ${session.name}…` : stopQuestion(session)}
      </p>
      <p data-part='does' className='text-body text-ink-secondary'>
        <Runs runs={stopDoes(session)} />
      </p>
      {interrupts && (
        <p data-part='interrupts' className='text-body text-ink-secondary'>
          {interrupts}
        </p>
      )}
      <div className='mt-2 flex flex-wrap items-center gap-3'>
        <Button
          size='sm'
          data-part='confirm-stop'
          onClick={stop.confirm}
          aria-disabled={step.busy || undefined}
        >
          Stop session
        </Button>
        <Button
          id={stop.ids.cancel}
          size='sm'
          data-part='cancel-stop'
          onClick={stop.cancel}
          aria-disabled={step.busy || undefined}
        >
          Cancel
        </Button>
      </div>
    </section>
  );
}
