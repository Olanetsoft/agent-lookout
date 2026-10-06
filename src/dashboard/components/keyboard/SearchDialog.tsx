import { Search } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import type { Session } from "@core/sessions/session";
import { StatusMark } from "@dashboard/components/ui/status/StatusMark";
import type { CollectorState } from "@dashboard/lib/api/collectorStore";
import { formatShortDuration, shortDurationInWords } from "@dashboard/lib/format";
import { searchSessions } from "@dashboard/lib/sessions/search";
import { rowLook } from "@dashboard/lib/sessions/sessions";
import { jumpWay } from "@dashboard/lib/sessions/status";
import { agentLabel } from "@dashboard/lib/sources/sources";
import { cn } from "@dashboard/lib/utils";

interface SearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: CollectorState;
  /** The present. */
  now: number;
  /** Presses the chosen session's Jump, or opens its details, once the dialog has gone. */
  onChoose: (session: Session) => void;
  /** Opens the sheet of shortcuts, once the dialog has gone. */
  onShortcuts: () => void;
}

/** What follows the dialog's closing: the chosen session, the sheet of shortcuts, or nothing. */
type After = { session: Session } | "shortcuts" | null;

/** How long a session has had its status, in the table's short form and in words. */
function lastedOf(session: Session, asOf: number): { shown: string; said: string } {
  if (session.statusSince === null) return { shown: "–", said: "time not reported" };
  const lasted = Math.max(0, asOf - session.statusSince);
  const ended = session.status === "finished" || session.status === "failed";
  return ended
    ? { shown: `${formatShortDuration(lasted)} ago`, said: `${shortDurationInWords(lasted)} ago` }
    : { shown: formatShortDuration(lasted), said: `for ${shortDurationInWords(lasted)}` };
}

/** The folder with what it has checked out, in words: "storefront on branch checkout-flow". */
function placeInWords(session: Session): string | null {
  if (session.project === null) return null;
  const { branch, commit } = session.git ?? {};
  if (branch !== undefined) return `${session.project} on branch ${branch}`;
  if (commit !== undefined) return `${session.project} at commit ${commit}`;
  return session.project;
}

interface ResultProps {
  session: Session;
  agent: string;
  asOf: number;
  id: string;
  active: boolean;
  onPoint: () => void;
  onPick: () => void;
}

/**
 * One session the search found, as an option of the list: its mark, its name,
 * its status and how long, then its folder, its branch and its agent. The
 * session that needs the person carries the lamp's mark, and nothing else of
 * it is warm. A stale or ended session is quiet, as its row is.
 *
 * A long name wraps rather than being cut, since an option is no place for a
 * tooltip. Its whole name, and where its Jump goes, are in what a screen
 * reader says of it.
 */
function Result({ session, agent, asOf, id, active, onPoint, onPick }: ResultProps) {
  const { mark, word, quiet } = rowLook(session);
  const lasted = lastedOf(session, asOf);
  const way = jumpWay(session);
  const label = [
    session.name,
    `${word} ${lasted.said}`,
    placeInWords(session),
    agent,
    way && `Jump to ${way.where}`,
  ]
    .filter(Boolean)
    .join(", ");
  const { branch, commit } = session.git ?? {};

  return (
    <li
      id={id}
      role='option'
      aria-selected={active}
      aria-label={label}
      data-slot='search-result'
      data-session={session.id}
      data-status={session.status}
      onPointerMove={onPoint}
      onClick={onPick}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-inner px-3.5 py-2.5",
        active && "bg-fill-selected",
      )}
    >
      <StatusMark kind={mark} className='mt-0.75' />
      <div className='min-w-0 flex-1'>
        <p className='flex items-baseline justify-between gap-3'>
          <span
            data-part='name'
            className={cn(
              "min-w-0 text-row wrap-anywhere",
              quiet ? "font-medium text-ink-secondary" : "font-semibold text-ink",
            )}
          >
            {session.name}
          </span>
          <span
            data-part='status'
            className='shrink-0 text-body whitespace-nowrap text-ink-secondary'
          >
            {word}{" "}
            <span
              data-part='duration'
              className={cn("tabular-nums", quiet ? "text-ink-secondary" : "text-ink")}
            >
              {lasted.shown}
            </span>
          </span>
        </p>
        {/* A long folder or branch breaks between words where it can. The agent keeps its dot and stays whole. */}
        <p data-part='place' className='text-body wrap-break-word text-ink-secondary'>
          {session.project !== null && (
            <>
              <span data-part='project'>{session.project}</span>
              {branch !== undefined ? (
                <>
                  {" "}
                  on <span data-part='branch'>{branch}</span>
                </>
              ) : commit !== undefined ? (
                <>
                  {" "}
                  at{" "}
                  <span data-part='commit' className='font-mono text-fact'>
                    {commit}
                  </span>
                </>
              ) : null}{" "}
            </>
          )}
          <span className='whitespace-nowrap'>
            {session.project !== null && (
              <span aria-hidden className='mr-1.5 ml-0.5'>
                ·
              </span>
            )}
            <span data-part='agent'>{agent}</span>
          </span>
        </p>
      </div>
    </li>
  );
}

interface SearchBodyProps {
  state: CollectorState;
  now: number;
  onChoose: (session: Session) => void;
  onShortcuts: () => void;
}

/**
 * The field and what it finds. It is drawn only while the dialog is open, so
 * each opening starts with an empty field and the first session lit.
 *
 * The field is a combobox and the sessions are the options of its list. Focus
 * stays in the field; Up and Down move the lit option, from the last back
 * round to the first and from the first to the last, and the field says which
 * one it is through `aria-activedescendant`. The lit option is followed by
 * session, not by place, so a poll that moves the sessions about keeps the
 * same one lit. A pointer moving over an option lights it, and a click
 * chooses it.
 */
function SearchBody({ state, now, onChoose, onShortcuts }: SearchBodyProps) {
  const [query, setQuery] = useState("");
  const [litId, setLitId] = useState<string | null>(null);
  const listId = useId();
  const sessions = state.snapshot?.sessions ?? [];
  const sources = state.snapshot?.sources ?? [];
  // Once answers stop, time is counted up to the last one, as on the Overview.
  const asOf = state.phase === "stalled" && state.lastOkAt !== null ? state.lastOkAt : now;
  const agentOf = (session: Session) => agentLabel(session, sources);
  const results = searchSessions(sessions, query, agentOf);
  const found = results.findIndex((session) => session.id === litId);
  const lit = results.length === 0 ? -1 : Math.max(0, found);
  const litSession = results[lit];
  // An option's id is its session's, so the field's attribute changes when another session is lit.
  const optionId = (session: Session) => `${listId}-${encodeURIComponent(session.id)}`;
  const litOption = litSession ? optionId(litSession) : undefined;
  const litWay = litSession ? jumpWay(litSession) : null;

  // The lit option stays in sight as the keys move it down a long list.
  useEffect(() => {
    if (litOption) document.getElementById(litOption)?.scrollIntoView({ block: "nearest" });
  }, [litOption]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        results[(lit + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length];
      if (next) setLitId(next.id);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (litSession) onChoose(litSession);
    }
  };

  const empty = !state.snapshot
    ? "Agent Lookout has not read any sessions yet."
    : sessions.length === 0
      ? "No agents are running."
      : results.length === 0
        ? `No session matches “${query.trim()}”.`
        : null;
  const count =
    results.length === 0
      ? (empty ?? "")
      : `${results.length} ${results.length === 1 ? "session" : "sessions"}`;

  return (
    <>
      <Dialog.Title className='sr-only'>Find a session</Dialog.Title>
      <div className='relative'>
        <Search
          aria-hidden
          strokeWidth={1.75}
          className='pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-muted'
        />
        <input
          type='text'
          role='combobox'
          aria-label='Find a session'
          aria-expanded
          aria-controls={listId}
          aria-autocomplete='list'
          aria-activedescendant={litOption}
          data-part='field'
          placeholder='Name, folder, branch or agent'
          autoComplete='off'
          autoCorrect='off'
          autoCapitalize='off'
          spellCheck={false}
          enterKeyHint='go'
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLitId(null);
          }}
          onKeyDown={onKeyDown}
          className='h-11 w-full rounded-inner bg-transparent pr-3.5 pl-10 text-row text-ink placeholder:text-ink-muted'
        />
      </div>

      <ul
        id={listId}
        role='listbox'
        aria-label='Sessions'
        data-part='results'
        // Not a stop of Tab, though it scrolls. A click in it leaves focus in the field, so the keys
        // go on working.
        tabIndex={-1}
        onPointerDown={(event) => event.preventDefault()}
        className='thin-scroll mt-2 max-h-[min(26rem,55vh)] overflow-y-auto border-t border-hairline pt-2'
      >
        {results.map((session, index) => (
          <Result
            key={session.id}
            session={session}
            agent={agentOf(session)}
            asOf={asOf}
            id={optionId(session)}
            active={index === lit}
            onPoint={() => {
              if (session.id !== litSession?.id) setLitId(session.id);
            }}
            onPick={() => onChoose(session)}
          />
        ))}
      </ul>
      {empty && (
        <p data-part='empty' className='px-3.5 pt-4 pb-6 text-center text-body text-ink-secondary'>
          {empty}
        </p>
      )}

      <div className='mt-2 flex items-baseline justify-between gap-4 border-t border-hairline px-3.5 pt-2.5 pb-1 text-caption text-ink-muted'>
        <p data-part='enter' className='min-w-0'>
          {litSession && (
            <>
              <kbd className='font-mono'>Enter</kbd>{" "}
              {litWay ? `jumps to it in ${litWay.where}` : "opens its details"}
            </>
          )}
        </p>
        <button
          type='button'
          aria-haspopup='dialog'
          data-part='shortcuts'
          onClick={onShortcuts}
          className='-mx-1.5 -my-0.5 shrink-0 cursor-pointer rounded-row px-1.5 py-0.5 whitespace-nowrap transition-colors duration-120 hover:bg-fill-hover hover:text-ink-secondary'
        >
          <kbd className='font-mono'>?</kbd> for shortcuts
        </button>
      </div>
      <p role='status' data-part='count' className='sr-only'>
        {count}
      </p>
    </>
  );
}

/**
 * The search over every session, opened by "/", Cmd+K or Ctrl+K, or the
 * header's button. It is the system's dialog: floating glass with blur over a
 * flat scrim, built on Radix Dialog as the history dialog is, so it holds
 * focus, closes on Escape and on a click outside, and gives focus back to what
 * had it.
 *
 * Choosing a session closes it first, and what the choice does follows once it
 * has gone, from the page: a Jump is pressed on the session's own row, and a
 * session with none has its details opened. So what a Jump came to is said by
 * the row, as when its button is pressed, and the dialog never says it. "?" with
 * nothing typed, or the button that says so, closes it and opens the sheet of
 * shortcuts in its place.
 *
 * It is held near the top of the window rather than in the middle, so the
 * field stays where it is as the list under it grows and shrinks.
 */
export function SearchDialog({
  open,
  onOpenChange,
  state,
  now,
  onChoose,
  onShortcuts,
}: SearchDialogProps) {
  const opener = useRef<HTMLElement | null>(null);
  const after = useRef<After>(null);
  const closeFor = (next: After) => {
    after.current = next;
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <div
          aria-hidden
          data-slot='scrim'
          data-state={open ? "open" : "closed"}
          className='fixed inset-0 z-40 bg-scrim data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in'
        />
        <Dialog.Overlay className='fixed inset-0 z-50 overflow-y-auto px-4 pt-[12vh] pb-24 data-[state=closed]:animate-fade-out'>
          <Dialog.Content
            data-slot='search-dialog'
            aria-describedby={undefined}
            className={cn(
              "glass-float glass-blur mx-auto w-[min(600px,100%)] p-2.5",
              "data-[state=closed]:animate-drop data-[state=open]:animate-rise-fast",
            )}
            onOpenAutoFocus={() => {
              // Focus has not moved into the dialog yet, so this is still the opener.
              opener.current =
                document.activeElement instanceof HTMLElement ? document.activeElement : null;
              after.current = null;
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const next = after.current;
              const back = opener.current;
              after.current = null;
              opener.current = null;
              if (next !== null && next !== "shortcuts") {
                onChoose(next.session);
                return;
              }
              back?.focus();
              if (next === "shortcuts") onShortcuts();
            }}
            onKeyDown={(event) => {
              // "?" asks for the shortcuts, unless it is being typed into a search.
              const typed = event.target instanceof HTMLInputElement && event.target.value !== "";
              if (event.key !== "?" || typed) return;
              event.preventDefault();
              closeFor("shortcuts");
            }}
          >
            <SearchBody
              state={state}
              now={now}
              onChoose={(session) => closeFor({ session })}
              onShortcuts={() => closeFor("shortcuts")}
            />
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
