import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { answerOutcomeWords, askHeading, denyOnlyWords } from "@core/answers/askWords";
import type { PermissionAsk, Session } from "@core/sessions/session";
import { FactText } from "@dashboard/components/ui/facts/FactText";
import { Button } from "@dashboard/components/ui/controls/Button";
import { useAnswer, type AnswerPress } from "@dashboard/hooks/actions/useAnswer";
import type { requestAnswer } from "@dashboard/lib/answer/answerRequest";
import {
  noAskLine,
  PERMISSION_PROMPTS_LINK,
  type NoAskFacts,
  type NoAskLine,
} from "@dashboard/lib/answer/noAsk";
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

/** The underline the page's links in a sentence have. */
const LINK =
  "rounded-bar underline decoration-rule-strong underline-offset-2 transition-colors duration-120 hover:text-ink";

/**
 * Why there is no Deny or Allow, in the block's place: one plain line, quiet
 * and never warm. It is a standing fact, read where it stands, so it is no
 * live region. Where Settings, under Permission prompts, has what it points
 * to, the install commands or the problem sentence too long for the hero, it
 * links to Settings. When it is taken away with focus in it, `onLeave` is
 * told.
 */
function NoAsk({
  line,
  lineRef,
  onLeave,
  className,
}: {
  line: NoAskLine;
  lineRef?: (element: HTMLElement | null) => void;
  onLeave?: () => void;
  className?: string;
}) {
  const own = useRef<HTMLParagraphElement | null>(null);
  const leave = useRef(onLeave);
  useEffect(() => {
    leave.current = onLeave;
  }, [onLeave]);
  useLayoutEffect(
    () => () => {
      // Run as the line is taken away, while what had focus is still on the page.
      if (own.current?.contains(document.activeElement)) leave.current?.();
    },
    [],
  );
  const ref = useCallback(
    (element: HTMLParagraphElement | null) => {
      own.current = element;
      lineRef?.(element);
    },
    [lineRef],
  );
  return (
    <p
      ref={ref}
      tabIndex={-1}
      data-part='no-ask'
      data-reason={line.reason}
      className={cn("min-w-0 text-body text-ink-secondary outline-none", className)}
    >
      <FactText>{line.text}</FactText>
      {line.settings !== null && (
        <>
          {" "}
          <a href='#settings' className={LINK}>
            {PERMISSION_PROMPTS_LINK}
          </a>{" "}
          {line.settings}
        </>
      )}
    </p>
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
 *
 * Given `noAsk`, a Claude Code session on this computer waiting for permission
 * with no request held has one line in the block's place saying why, from
 * `noAskLine` in `lib/answer/noAsk.ts`, `brief` in the hero, linking to
 * Settings where Settings, under Permission prompts, has what the line points
 * to: the commands that install the plugin, or a problem sentence too long for
 * the hero. It is not drawn while a press is under way, or once what one came
 * to is said, which says why already. When the line is taken away with focus
 * in it, focus goes to what is drawn in its place, a request or another line.
 * With nothing there, it goes to `focusOnLeave`, unless the page has put it
 * somewhere by then, as the Overview gives it to the row's Jump when the row
 * is still drawn and has one.
 */
export function AnswerAsk({
  session,
  onAnswered,
  request,
  settleMs,
  focusOnLeave,
  noAsk,
  brief = false,
  className,
}: {
  session: Session;
  onAnswered?: () => void;
  request?: typeof requestAnswer;
  settleMs?: number;
  /** The id of what takes focus when the block leaves the page with focus in it. */
  focusOnLeave?: string;
  /** What the page holds that says why there is no Deny or Allow. Left out, nothing says why. */
  noAsk?: NoAskFacts | null;
  /** Whether the line is the hero's, which leaves a long sentence to Settings. */
  brief?: boolean;
  className?: string;
}) {
  const answer = useAnswer(session, { onAnswered, request, settleMs });
  const block = useRef<HTMLElement | null>(null);
  const setBlock = useCallback((element: HTMLElement | null) => {
    block.current = element;
  }, []);
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
  // Set as the line is taken away with focus in it, for the effect below.
  const lineHadFocus = useRef(false);
  const lineLeft = useCallback(() => {
    lineHadFocus.current = true;
  }, []);
  // In the same change that took the line away, and before the effects of
  // what holds the block, such as the Overview's, which would give focus to
  // the row's Jump: focus goes to what is drawn in the line's place. With
  // nothing there, it goes to `focusOnLeave` once the page has done, unless
  // something has taken it by then.
  useLayoutEffect(() => {
    if (!lineHadFocus.current) return;
    lineHadFocus.current = false;
    const lost = () => {
      const now = document.activeElement;
      return now === null || now === document.body || !now.isConnected;
    };
    const drawn = block.current;
    if (drawn?.isConnected) {
      if (lost()) drawn.focus();
      return;
    }
    const target = leaveTo.current;
    if (target === undefined) return;
    setTimeout(() => {
      if (lost()) document.getElementById(target)?.focus();
    }, 0);
  });
  const line = noAsk == null ? null : noAskLine(session, noAsk, { brief });
  return (
    <AnswerBlock
      session={session}
      answer={answer}
      line={line}
      onLineLeft={lineLeft}
      className={className}
      blockRef={setBlock}
    />
  );
}

/** The block itself, for one press's state, or in its place, while no press is under way, the line that says why there is none. */
export function AnswerBlock({
  session,
  answer,
  line = null,
  onLineLeft,
  className,
  blockRef,
}: {
  session: Pick<Session, "name" | "ask">;
  answer: AnswerPress;
  line?: NoAskLine | null;
  onLineLeft?: () => void;
  className?: string;
  blockRef?: (element: HTMLElement | null) => void;
}) {
  const { ask } = session;
  const { step } = answer;
  const answered = step.kind === "answered" ? step : null;
  // The request shown is offered unless it is the one already answered.
  const offered = ask !== undefined && ask.requestId !== answered?.requestId ? ask : null;
  if (offered === null && answered === null) {
    if (line === null || step.kind !== "idle") return null;
    return (
      <NoAsk
        // A line for another reason, or with or without its link, is a line of its own.
        key={`${line.reason}:${line.settings !== null}`}
        line={line}
        lineRef={blockRef}
        onLeave={onLineLeft}
        className={className}
      />
    );
  }
  const busy = step.kind === "busy";
  const inactive = busy || answer.settling;
  return (
    <section
      ref={blockRef}
      // Focus can be given to it, as when it takes the place of a line that had focus.
      tabIndex={-1}
      data-slot='answer'
      aria-label={`Permission request of ${session.name}`}
      className={cn("flex min-w-0 flex-col outline-none", className)}
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
