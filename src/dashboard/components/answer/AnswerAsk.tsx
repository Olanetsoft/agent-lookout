import { useEffect, useLayoutEffect, useRef, type Ref } from "react";

import type { PermissionAsk, Session } from "@core/sessions/session";
import { Button } from "@dashboard/components/ui/controls/Button";
import { useAnswer, type AnswerPress } from "@dashboard/hooks/actions/useAnswer";
import {
  answerOutcomeWords,
  askHeading,
  denyOnlyWords,
  type requestAnswer,
} from "@dashboard/lib/answer/answerRequest";
import { cn } from "@dashboard/lib/utils";

/**
 * A literal block of what the request would run or use, in the mono, kept as
 * it is: every line, wrapping anywhere so nothing runs past a phone's width,
 * with the mono's own spacing, so a space between two words is never read as
 * none. While Allow is offered it is drawn whole, at its full height, so no
 * line of what would be allowed is out of sight. Offering Deny only, a long
 * one scrolls inside itself, and can be scrolled from the keyboard.
 */
function Literal({
  text,
  label,
  part,
  whole,
}: {
  text: string;
  label: string;
  part: string;
  whole: boolean;
}) {
  return (
    <pre
      data-part={part}
      data-whole={whole || undefined}
      tabIndex={0}
      aria-label={label}
      className={cn(
        "rounded-row bg-fill-zebra px-3 py-2 font-mono text-fact whitespace-pre-wrap text-ink inset-ring inset-ring-hairline wrap-anywhere select-text [letter-spacing:0]! [word-spacing:normal]!",
        !whole && "thin-scroll max-h-60 overflow-y-auto",
      )}
    >
      {text}
    </pre>
  );
}

/**
 * What the request asks: the whole command and the inputs that go with it,
 * then the agent's description of it, or the tool and each of its inputs.
 */
function Asked({ ask, again }: { ask: PermissionAsk; again: boolean }) {
  return (
    <>
      <p data-part='ask-heading' className='text-body font-medium text-ink'>
        {askHeading(ask, again)}
      </p>
      {ask.command !== undefined && (
        <div className='mt-1.5'>
          <Literal text={ask.command} label='The whole command' part='command' whole={ask.allow} />
        </div>
      )}
      {ask.inputs !== undefined && ask.inputs.length > 0 && (
        <dl data-part='inputs' className='mt-1.5 flex flex-col gap-1.5'>
          {ask.inputs.map((input, index) => (
            <div key={index} className='min-w-0'>
              <dt className='font-mono text-caption text-ink-secondary wrap-anywhere'>
                {input.name}
              </dt>
              <dd className='mt-0.5'>
                <Literal text={input.value} label={input.name} part='input' whole={ask.allow} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {ask.description !== undefined && (
        <p data-part='description' className='mt-1.5 text-body text-ink-secondary'>
          {ask.description}
        </p>
      )}
      {!ask.allow && ask.denyOnly !== undefined && (
        <p data-part='deny-only' className='mt-1.5 text-body text-ink-secondary'>
          {denyOnlyWords(ask.denyOnly)}
        </p>
      )}
    </>
  );
}

/**
 * A held permission request of a session's, with Deny and Allow: in the hero
 * under the session's reason, and at the top of its details.
 *
 * It shows the whole of what Allow would allow, and Allow is there only when
 * the collector says all of it is shown. Deny always is, first, so it is in
 * the same place whether Allow is offered or not, and Allow is never where
 * Deny was a moment before. Both are the quiet button, side by side, neither
 * has focus first, and neither takes a press for a second after a request is
 * drawn: an answer is a deliberate press on what is shown, never a key held
 * from somewhere else or a click meant for what was there before. Nothing in
 * it is warm. What a press came to is one line, a status that takes focus. It
 * stays said once the request has gone, and above a newer request of the
 * session's. When the block leaves the page with focus in it, as a hero row
 * does once its session stops waiting, focus goes to `focusOnLeave`.
 */
export function AnswerAsk({
  session,
  onAnswered,
  request,
  settleMs,
  focusOnLeave,
  className,
}: {
  session: Session;
  onAnswered?: () => void;
  request?: typeof requestAnswer;
  settleMs?: number;
  /** The id of what takes focus when the block leaves the page with focus in it. */
  focusOnLeave?: string;
  className?: string;
}) {
  const answer = useAnswer(session, { onAnswered, request, settleMs });
  const block = useRef<HTMLElement | null>(null);
  const leaveTo = useRef(focusOnLeave);
  useEffect(() => {
    leaveTo.current = focusOnLeave;
  }, [focusOnLeave]);
  useLayoutEffect(
    () => () => {
      // Run as the block is taken away, while what had focus is still on the page.
      const had = block.current?.contains(document.activeElement) ?? false;
      const target = leaveTo.current;
      if (!had || target === undefined) return;
      setTimeout(() => {
        const now = document.activeElement;
        if (now === null || now === document.body || !now.isConnected) {
          document.getElementById(target)?.focus();
        }
      }, 0);
    },
    [],
  );
  return <AnswerBlock session={session} answer={answer} className={className} blockRef={block} />;
}

/** The block itself, for one press's state. */
export function AnswerBlock({
  session,
  answer,
  className,
  blockRef,
}: {
  session: Pick<Session, "name" | "ask">;
  answer: AnswerPress;
  className?: string;
  blockRef?: Ref<HTMLElement>;
}) {
  const { ask } = session;
  const { step } = answer;
  const answered = step.kind === "answered" ? step : null;
  // The request shown is offered unless it is the one already answered.
  const offered = ask !== undefined && ask.requestId !== answered?.requestId ? ask : null;
  if (offered === null && answered === null) return null;
  const busy = step.kind === "busy";
  const inactive = busy || answer.settling;
  return (
    <section
      ref={blockRef}
      data-slot='answer'
      aria-label={`Permission request of ${session.name}`}
      className={cn("flex min-w-0 flex-col", className)}
    >
      {answered !== null && (
        <p
          id={answer.outcomeId}
          tabIndex={-1}
          role='status'
          data-part='answer-outcome'
          data-outcome={answered.outcome}
          className={cn("text-body text-ink outline-none", offered !== null && "mb-2.5")}
        >
          {answerOutcomeWords(answered.outcome)}
        </p>
      )}
      {offered !== null && (
        <>
          <Asked ask={offered} again={answered !== null} />
          <div className='mt-2.5 flex flex-wrap items-center gap-3'>
            <Button
              size='sm'
              data-part='deny'
              aria-label={`Deny, for ${session.name}`}
              aria-disabled={inactive || undefined}
              onClick={() => answer.press("deny")}
            >
              Deny
            </Button>
            {offered.allow && (
              <Button
                size='sm'
                data-part='allow'
                aria-label={`Allow, for ${session.name}`}
                aria-disabled={inactive || undefined}
                onClick={() => answer.press("allow")}
              >
                Allow
              </Button>
            )}
          </div>
          <p data-part='answering' aria-live='polite' className='sr-only'>
            {busy ? (step.decision === "allow" ? "Allowing…" : "Denying…") : ""}
          </p>
        </>
      )}
    </section>
  );
}
