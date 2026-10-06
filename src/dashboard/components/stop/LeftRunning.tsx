import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react";

import { MAX_CLEAN_UP_SESSIONS, type CleanUpEntry, type CleanUpOutcome } from "@core/api";
import type { Session } from "@core/sessions/session";
import { STALE_THRESHOLD_MS, staleAfterInWords } from "@core/sessions/staleness";
import { Count } from "@dashboard/components/sessions/SessionsBoard";
import { Runs } from "@dashboard/components/stop/StopSession";
import { Button } from "@dashboard/components/ui/controls/Button";
import { Checkbox } from "@dashboard/components/ui/controls/Checkbox";
import { Badge } from "@dashboard/components/ui/status/Badge";
import { StatusMark } from "@dashboard/components/ui/status/StatusMark";
import { Truncated } from "@dashboard/components/ui/surfaces/Tooltip";
import { formatShortDuration, shortDurationInWords } from "@dashboard/lib/format";
import { surfaceLabel } from "@dashboard/lib/sessions/status";
import { openFromLink, sessionHref } from "@dashboard/lib/shell/sessionDetails";
import { hiddenKey, hideSession, readHidden } from "@dashboard/lib/stop/hiddenSessions";
import {
  cleanUpEntries,
  cleanUpSummary,
  END_DOES,
  END_QUESTION,
  endLabel,
  leftRunning,
  type LeftRunningSession,
} from "@dashboard/lib/stop/leftRunning";
import {
  cleanUpOutcomeWords,
  cleanUpTimeoutMs,
  requestCleanUp,
  type CleanUpAnswer,
} from "@dashboard/lib/stop/stopRequest";
import { DESKTOP_STOP_THERE } from "@dashboard/lib/stop/stopWords";
import { cn } from "@dashboard/lib/utils";

/** Where the group is between presses. */
type Step =
  | { kind: "list" }
  | { kind: "confirming"; shown: LeftRunningSession[]; chosen: Set<string>; busy: boolean }
  | {
      kind: "done";
      rows: { one: LeftRunningSession; outcome: CleanUpOutcome | null }[];
      summary: string;
    };

/**
 * What takes focus once the group is drawn again: a button of its own, the
 * Hide of the row with this session's id, or, when the group has gone, what
 * `onGone` says.
 */
type FocusTarget = "toggle" | "end" | "cancel" | "summary" | { hide: string } | null;

/** The sessions first ticked: every one that can be ended, up to as many as one clean-up takes. */
function firstChosen(shown: readonly LeftRunningSession[]): Set<string> {
  return new Set(
    shown
      .filter((one) => one.endable)
      .slice(0, MAX_CLEAN_UP_SESSIONS)
      .map((one) => one.session.id),
  );
}

/** What a clean-up that was not tried says. */
function notTried(answer: Extract<CleanUpAnswer, { ok: false }>): string {
  if (answer.reason === "too-soon")
    return "Another session is being stopped. Try again in a moment.";
  if (answer.reason === "no-answer") {
    return "Agent Lookout did not answer in time. The list shows which have ended.";
  }
  return "The sessions could not be ended.";
}

interface LeftRunningProps {
  sessions: readonly Session[];
  now: number;
  /** Told once some were ended, so the page reads the sessions again at once. */
  onEnded?: () => void;
  /**
   * Told when what had focus in the group has gone with it, as when the last
   * session in it is hidden, so focus can go to the card's title.
   */
  onGone?: () => void;
  /** What ends them. Defaults to asking the app. */
  end?: (entries: readonly CleanUpEntry[], timeoutMs: number) => Promise<CleanUpAnswer>;
  /**
   * How long a session is idle before it is stale, as the snapshot's time
   * rules say: what the band and a clean-up's words say. Defaults to a day.
   */
  staleAfterMs?: number;
}

/**
 * One session left running: its mark, name, folder, app and how long it has
 * been idle. Once a clean-up has answered for it, the mark of a session ended
 * is Ended's, and a session left running for any other reason no longer says
 * how long it has been idle, which is no longer known to be so.
 */
function Row({
  one,
  checkbox,
  outcome,
  action,
  staleAfterMs = STALE_THRESHOLD_MS,
}: {
  staleAfterMs?: number;
  one: LeftRunningSession;
  checkbox?: { checked: boolean; onChange: (checked: boolean) => void; disabled: boolean };
  outcome?: CleanUpOutcome | null;
  action?: ReactNode;
}) {
  const { session } = one;
  const app = surfaceLabel(session.surface);
  const place = [session.project, app].filter((part) => part !== null);
  const idleKnown = outcome === undefined || outcome === null || outcome === "ended";
  return (
    <li
      data-slot='left-running-row'
      data-session={session.id}
      data-endable={one.endable || undefined}
      className='flex items-start gap-3 py-1.5'
    >
      {checkbox ? (
        <Checkbox
          checked={checkbox.checked}
          onCheckedChange={checkbox.onChange}
          disabled={checkbox.disabled}
          aria-label={`End ${session.name}`}
          className='mt-0.5'
        />
      ) : (
        <StatusMark kind={outcome === "ended" ? "ended" : "stale"} className='mt-0.5' />
      )}
      <div className='flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1.5'>
        <div className='min-w-0 grow basis-40'>
          <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-px'>
            <Truncated
              data-part='name'
              href={sessionHref(session.id)}
              onClick={(event) => openFromLink(event, session.id)}
              aria-label={`${session.name}, details`}
              aria-haspopup='dialog'
              className='max-w-full text-row font-medium text-ink-secondary'
            >
              {session.name}
            </Truncated>
            {outcome && (
              <Badge
                data-part='outcome'
                data-outcome={outcome}
                tone={outcome === "ended" ? "neutral" : "outline"}
              >
                {cleanUpOutcomeWords(outcome, staleAfterMs)}
              </Badge>
            )}
          </div>
          <p data-part='place' className='text-caption leading-tight text-ink-secondary'>
            {place.join(" · ")}
            {place.length > 0 && idleKnown && " · "}
            {idleKnown && (
              <span className='tabular-nums'>
                <span aria-hidden>idle {formatShortDuration(one.idleMs)}</span>
                <span className='sr-only'>idle {shortDurationInWords(one.idleMs)}</span>
              </span>
            )}
          </p>
          {!one.endable && (
            <p data-part='desktop' className='mt-0.5 text-caption leading-tight text-ink-secondary'>
              {DESKTOP_STOP_THERE}
            </p>
          )}
        </div>
        {action}
      </div>
    </li>
  );
}

/**
 * The sessions left running, in the Sessions card: Claude Code sessions idle
 * for a day or more, or as long as the idle rule says, whose process still runs, as one does after its VS Code
 * tab is closed. Drawn only while there is one, and at first as one band, the
 * count and "idle a day or more", with a quiet Review…, so it never outweighs
 * the list it sits over. Review… opens it: the longest idle first, each with
 * its folder, its app and how long it has been idle, and Close folds it again.
 *
 * Each can be hidden until it changes, which is kept in this browser and
 * touches nothing else: the first change of its status shows it again. It
 * stays in the list, under Idle, as it was. Focus goes to the next row's Hide,
 * or the one before, and once none is left, to what `onGone` says.
 *
 * End all… asks first, here: every one that can be ended is listed with a
 * tick, all ticked up to 20, which one clean-up takes, and any can be
 * unticked. With more than 20, the rest wait unticked, and no more can be
 * ticked than 20. The button says how many, "End 3 sessions", and focus goes
 * to Cancel. Each is sent with the moment its idle began as shown here, so one
 * that has done anything since is left running. Once answered, a line says
 * what came of it, and each row says what became of it, until Done. A session
 * in the desktop app is listed with the line that says to stop it there, and
 * no tick.
 *
 * Nothing in it is warm: being left running is not a session needing the
 * person.
 */
export function LeftRunning({
  sessions,
  now,
  onEnded,
  onGone,
  end = requestCleanUp,
  staleAfterMs = STALE_THRESHOLD_MS,
}: LeftRunningProps) {
  const note = `idle ${staleAfterInWords(staleAfterMs)} or more`;
  const [hidden, setHidden] = useState<Set<string>>(readHidden);
  const [step, setStep] = useState<Step>({ kind: "list" });
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const frame = useRef<HTMLElement>(null);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const endButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const summary = useRef<HTMLParagraphElement>(null);
  const focusNext = useRef<FocusTarget>(null);
  const drawn = useRef(true);
  const listId = useId();

  useEffect(() => {
    drawn.current = true;
    return () => {
      drawn.current = false;
    };
  }, []);

  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === null) return;
    let to: HTMLElement | null | undefined;
    if (target === "cancel") to = cancelButton.current;
    else if (target === "summary") to = summary.current;
    else if (target === "toggle") to = toggleButton.current;
    else if (target === "end") to = endButton.current ?? toggleButton.current;
    else {
      const rows = frame.current?.querySelectorAll<HTMLElement>('[data-slot="left-running-row"]');
      const row = [...(rows ?? [])].find((one) => one.dataset.session === target.hide);
      to = row?.querySelector<HTMLElement>('[data-part="hide"]');
    }
    if (to) to.focus();
    // The group itself has gone, and what had focus with it.
    else if (!frame.current) onGone?.();
  }, [step, hidden, open, onGone]);

  const found = leftRunning(sessions, now).filter((one) => !hidden.has(hiddenKey(one.session)));
  // Once none is left, it is folded again, for the next one that is.
  if (open && step.kind === "list" && found.length === 0) setOpen(false);

  const ask = () => {
    setProblem(null);
    focusNext.current = "cancel";
    setStep({ kind: "confirming", shown: found, chosen: firstChosen(found), busy: false });
  };
  const cancel = () => {
    focusNext.current = "end";
    setStep({ kind: "list" });
  };
  const hide = (one: LeftRunningSession) => {
    const at = found.indexOf(one);
    const rest = found.filter((other) => other !== one);
    const next = rest[at] ?? rest[at - 1];
    focusNext.current = next ? { hide: next.session.id } : "end";
    setHidden(hideSession(one.session));
  };
  const toggle = () => {
    focusNext.current = "toggle";
    setOpen(!open);
  };

  if (step.kind === "list" && found.length === 0) return null;

  if (step.kind === "done") {
    const stillRunning = step.rows.filter(({ outcome }) => outcome !== "ended").length;
    return (
      <Frame ref={frame} count={stillRunning} note={note} open>
        <p
          ref={summary}
          tabIndex={-1}
          role='status'
          data-part='summary'
          className='mt-1 text-body text-ink outline-none'
        >
          {step.summary}
        </p>
        <ul className='mt-1.5'>
          {step.rows.map(({ one, outcome }) => (
            <Row key={one.session.id} one={one} outcome={outcome} staleAfterMs={staleAfterMs} />
          ))}
        </ul>
        <div className='mt-2'>
          <Button
            size='sm'
            data-part='done'
            onClick={() => {
              focusNext.current = "end";
              setStep({ kind: "list" });
            }}
          >
            Done
          </Button>
        </div>
      </Frame>
    );
  }

  if (step.kind === "confirming") {
    const { shown, chosen, busy } = step;
    const entries = cleanUpEntries(shown.filter((one) => chosen.has(one.session.id)));
    const full = chosen.size >= MAX_CLEAN_UP_SESSIONS;
    const many = shown.filter((one) => one.endable).length > MAX_CLEAN_UP_SESSIONS;
    const background = shown.filter(
      (one) => chosen.has(one.session.id) && one.session.stop?.how === "background",
    ).length;
    const confirm = () => {
      if (busy || entries.length === 0) return;
      setStep({ ...step, busy: true });
      void end(entries, cleanUpTimeoutMs(background)).then((answer) => {
        if (!drawn.current) return;
        if (!answer.ok) {
          setProblem(notTried(answer));
          focusNext.current = "cancel";
          setStep({ ...step, busy: false });
          return;
        }
        const outcomes = entries.map(
          (entry) => answer.results.get(entry.sessionId) ?? ("failed" as const),
        );
        focusNext.current = "summary";
        setStep({
          kind: "done",
          rows: shown.map((one) => ({
            one,
            outcome: chosen.has(one.session.id)
              ? (answer.results.get(one.session.id) ?? null)
              : null,
          })),
          summary: cleanUpSummary(outcomes, staleAfterMs),
        });
        if (outcomes.includes("ended")) onEnded?.();
      });
    };
    return (
      <Frame ref={frame} count={shown.length} note={note} open>
        <section data-part='end-confirm' aria-label={END_QUESTION}>
          <p
            data-part='question'
            aria-live='polite'
            className='mt-1 text-body font-medium text-ink'
          >
            {busy
              ? `Ending ${entries.length === 1 ? "1 session" : `${entries.length} sessions`}…`
              : END_QUESTION}
          </p>
          <p data-part='does' className='mt-1 text-body text-ink-secondary'>
            <Runs runs={END_DOES} />
          </p>
          {many && (
            <p data-part='limit' className='mt-1 text-body text-ink-secondary'>
              Up to {MAX_CLEAN_UP_SESSIONS} at a time.
            </p>
          )}
          <ul className='mt-1.5'>
            {shown.map((one) => (
              <Row
                key={one.session.id}
                one={one}
                checkbox={
                  one.endable
                    ? {
                        checked: chosen.has(one.session.id),
                        // No more than one clean-up takes can be ticked.
                        disabled: busy || (full && !chosen.has(one.session.id)),
                        onChange: (checked) => {
                          const next = new Set(chosen);
                          if (!checked) next.delete(one.session.id);
                          else if (next.size < MAX_CLEAN_UP_SESSIONS) next.add(one.session.id);
                          setStep({ ...step, chosen: next });
                        },
                      }
                    : undefined
                }
              />
            ))}
          </ul>
          {problem && (
            <p data-part='problem' role='status' className='mt-1.5 text-body text-ink'>
              {problem}
            </p>
          )}
          <div className='mt-2 flex flex-wrap items-center gap-3'>
            <Button
              size='sm'
              data-part='confirm-end'
              onClick={confirm}
              aria-disabled={busy || entries.length === 0 || undefined}
            >
              {endLabel(entries.length)}
            </Button>
            <Button
              ref={cancelButton}
              size='sm'
              data-part='cancel-end'
              onClick={busy ? undefined : cancel}
              aria-disabled={busy || undefined}
            >
              Cancel
            </Button>
          </div>
        </section>
      </Frame>
    );
  }

  const endable = found.some((one) => one.endable);
  return (
    <Frame
      ref={frame}
      count={found.length}
      note={note}
      open={open}
      action={
        <>
          {open && endable && (
            <Button ref={endButton} size='sm' data-part='end-all' onClick={ask}>
              End all…
            </Button>
          )}
          <Button
            ref={toggleButton}
            size='sm'
            data-part='review'
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            onClick={toggle}
          >
            {open ? "Close" : "Review…"}
          </Button>
        </>
      }
    >
      {open && (
        <ul id={listId} className='mt-1.5'>
          {found.map((one) => (
            <Row
              key={one.session.id}
              one={one}
              action={
                <Button
                  size='sm'
                  data-part='hide'
                  aria-label={`Hide ${one.session.name} until it changes`}
                  onClick={() => hide(one)}
                >
                  Hide until it changes
                </Button>
              }
            />
          ))}
        </ul>
      )}
    </Frame>
  );
}

/**
 * The group's own surface inside the Sessions card, with its head: "Left
 * running 3" and "idle a day or more", or as long as the idle rule says, and
 * its buttons at the right. Folded, it is that one line.
 */
function Frame({
  ref,
  count,
  note,
  open,
  action,
  children,
}: {
  ref: Ref<HTMLElement>;
  count: number;
  /** "idle a day or more". */
  note: string;
  open: boolean;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section
      ref={ref}
      data-slot='left-running'
      data-open={open || undefined}
      aria-labelledby='left-running-head'
      className={cn(
        "mx-2.5 mb-3 rounded-inner bg-fill-zebra px-3.5 pt-2 inset-ring inset-ring-hairline",
        open ? "pb-3" : "pb-2",
      )}
    >
      <div className='flex min-h-button flex-wrap items-center justify-between gap-x-3 gap-y-2'>
        <div className='flex min-w-0 grow basis-32 flex-wrap items-baseline gap-x-2 gap-y-px'>
          <h3
            id='left-running-head'
            className='inline-flex items-baseline gap-1.5 text-caption font-semibold text-ink-secondary'
          >
            Left running
            <Count>{count}</Count>
          </h3>
          <span data-part='note' className='text-caption text-ink-secondary'>
            {note}
          </span>
        </div>
        {action && <div className='flex items-center gap-3'>{action}</div>}
      </div>
      {children}
    </section>
  );
}
