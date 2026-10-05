import { useLayoutEffect, useRef, useState, type RefObject } from "react";

import type { Session, SourceHealth } from "@core/sessions/session";
import { SessionRow } from "@dashboard/components/sessions/SessionRow";
import { Callout } from "@dashboard/components/ui/feedback/Callout";
import { EmptyState } from "@dashboard/components/ui/feedback/EmptyState";
import { FactText } from "@dashboard/components/ui/facts/FactText";
import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import { useNarrow } from "@dashboard/hooks/dom/useMediaQuery";
import { countState, tableGroups, type SessionGroup } from "@dashboard/lib/sessions/sessions";
import {
  agentLabel,
  overviewSources,
  showsAgents,
  sourceNames,
} from "@dashboard/lib/sources/sources";
import { safeJumpLink } from "@dashboard/lib/sessions/status";
import { cn } from "@dashboard/lib/utils";

interface SessionsCardProps {
  sessions: readonly Session[];
  sources: readonly SourceHealth[];
  now: number;
  className?: string;
}

/**
 * A source that cannot be read. Missing is said calmly; broken is said as an error.
 *
 * What to do about it comes from the collector when it knows. A person who
 * pointed Agent Lookout at the wrong program is told to correct that, not to
 * install something they already have.
 */
function SourceNotice({ source }: { source: SourceHealth }) {
  const missing = source.state === "unavailable";
  return (
    <Callout
      tone={missing ? "info" : "error"}
      title={missing ? `${source.label} was not found` : `${source.label} could not be read`}
    >
      <p>
        <FactText>
          {source.detail ??
            (missing
              ? `Agent Lookout could not find ${source.label} on this computer.`
              : `Agent Lookout found ${source.label} but could not read its sessions.`)}
        </FactText>
      </p>
      <p data-part='advice'>
        {source.advice ? (
          <FactText>{source.advice}</FactText>
        ) : missing ? (
          `Install ${source.label} or start a session. It will show up here on its own.`
        ) : (
          "It keeps trying. If this stays, restart Agent Lookout."
        )}
      </p>
    </Callout>
  );
}

/** The notices for sources that cannot be read, inside the card's inset. */
function SourceNotices({ sources, last }: { sources: readonly SourceHealth[]; last: boolean }) {
  return (
    <div className={cn("flex flex-col gap-2 px-6", last ? "pb-6" : "pb-3")}>
      {sources.map((source) => (
        <SourceNotice key={source.id} source={source} />
      ))}
    </div>
  );
}

/** First run: the collector is still looking. Says where, so it never reads as stuck. */
function Searching({ sources }: { sources: readonly SourceHealth[] }) {
  const looking = sources.filter((source) => source.state === "searching");
  return (
    <EmptyState title='Looking for agents'>
      {looking.map((source) => (
        <p key={source.id}>
          <FactText>
            {source.detail ?? `Looking for ${source.label} sessions on this computer.`}
          </FactText>
        </p>
      ))}
      <p className='mt-2 text-ink-muted'>
        It checks every two seconds. There is nothing you need to do.
      </p>
    </EmptyState>
  );
}

/** A count beside a group's name, in the muted ink, with figures that keep their width. */
function Count({ children }: { children: number }) {
  return (
    <span data-part='count' className='font-medium text-ink-muted tabular-nums'>
      {children}
    </span>
  );
}

/**
 * One group: its name and count in words, then its sessions.
 *
 * The idle group counts its stale sessions apart, as the counts row does:
 * "Idle 2" and "Stale 1" over three rows. When every one of them is stale, it
 * says only that.
 */
function GroupBody({
  group,
  now,
  jumpColumn,
  columns,
  narrow,
  agentOf,
  folderColumn,
  appColumn,
}: {
  group: SessionGroup;
  now: number;
  jumpColumn: boolean;
  columns: number;
  narrow: boolean;
  /** The tool each session belongs to, when the table names it. */
  agentOf?: (session: Session) => string;
  /** Whether the table has a Folder column, or it has given way so the names keep their room. */
  folderColumn: boolean;
  /** Whether the table has an App column, or it has given way so the names keep their room. */
  appColumn: boolean;
}) {
  const named = group.id !== "idle" || group.count > 0;
  return (
    <tbody data-slot='session-group' data-group={group.id}>
      <tr data-slot='group-row'>
        <th
          scope='rowgroup'
          colSpan={columns}
          className='h-group px-6 pt-2.5 pb-1.5 text-left align-bottom text-caption font-semibold text-ink-secondary'
        >
          <span className='flex items-baseline gap-3.5'>
            {named && (
              <span className='inline-flex items-baseline gap-1.5'>
                {group.label}
                <Count>{group.count}</Count>
              </span>
            )}
            {group.id === "idle" && group.stale > 0 && (
              <span data-part='stale' className='inline-flex items-baseline gap-1.5'>
                Stale
                <Count>{group.stale}</Count>
              </span>
            )}
          </span>
        </th>
      </tr>
      {group.sessions.map((session) => (
        <SessionRow
          key={session.id}
          session={session}
          now={now}
          jumpColumn={jumpColumn}
          narrow={narrow}
          agent={agentOf?.(session)}
          folderColumn={folderColumn}
          appColumn={appColumn}
        />
      ))}
    </tbody>
  );
}

/**
 * The widths of the columns beside Session, in rem, as the classes of the
 * table's columns set them. Each holds what goes in it and little more: Agent
 * w-25 holds "Claude Code", App w-28 "Unknown app", Status w-40 the longest
 * phrase, "Finished 23h 59m ago", and Jump w-24 the 64px button. Folder w-28
 * holds a folder name of about 12 letters and cuts a longer one, whose whole
 * path is in its tooltip. A change to one of those classes changes this.
 */
const COLUMN_REM = { agent: 6.25, folder: 7, app: 7, status: 10, jump: 6 } as const;
/** The least the Session column keeps: its mark and a name of about 18 letters. */
const SESSION_REM = 12.5;

interface Columns {
  folder: boolean;
  app: boolean;
}

/**
 * Which of the Folder and App columns the card has room for. The name comes
 * first: every column beside it gives way before the Session column falls
 * under its 200px, a name of about 18 letters. The App column goes first, then
 * the Folder column, as both do in a narrow window; the Agent column and the
 * status keep their place, since a row is not read without them.
 *
 * Beside the Events card on a laptop screen, or alone in a window just wider
 * than a phone, the card is often too narrow for all of them.
 *
 * Measured from the card, whose width does not depend on which way is chosen,
 * and before the page is painted, so the table never draws one way and then
 * the other.
 */
function useColumns(
  table: RefObject<HTMLTableElement | null>,
  measured: boolean,
  agentColumn: boolean,
  jumpColumn: boolean,
): Columns {
  const [columns, setColumns] = useState<Columns>({ folder: true, app: true });

  useLayoutEffect(() => {
    const card = table.current?.parentElement;
    if (!measured || !card) return;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const always =
        SESSION_REM +
        COLUMN_REM.status +
        (agentColumn ? COLUMN_REM.agent : 0) +
        (jumpColumn ? COLUMN_REM.jump : 0);
      const width = card.clientWidth / rem;
      const folder = width >= always + COLUMN_REM.folder;
      const app = folder && width >= always + COLUMN_REM.folder + COLUMN_REM.app;
      setColumns((current) =>
        current.folder === folder && current.app === app ? current : { folder, app },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, [table, measured, agentColumn, jumpColumn]);

  return measured ? columns : { folder: true, app: true };
}

/**
 * The main card: every session that does not need the person, as a table
 * grouped by what each is doing. The ones that need the person are the hero's,
 * at the top of the Overview, and the count in the card's head is still every
 * session. While no source has been read, and no session found, there is no
 * count to give, so the head gives none. When there are no sessions it says
 * why, in one of three distinct ways: still looking, nothing running, or the
 * source cannot be read.
 *
 * Rows have no rules: a group is its name in words, and a row lights as one
 * rounded shape inside the card under the pointer. Column heads are for
 * assistive technology only.
 *
 * When the card is too narrow for every column, the App column gives way, then
 * the Folder column, so a name of about 18 letters is never cut. Narrow, both
 * are left out, and the status and its time move under the name, so the name
 * keeps its room down to the width of a phone.
 *
 * A tool that is not on this computer is left out here, as if it were not
 * watched: no notice for it, and no name for it in the empty state. The Sources
 * view says it was not found. Only when no tool is found is that the story here.
 *
 * Once more than one tool is found, each row names its tool in plain words: in
 * an Agent column after the name on every window wider than 760px, and narrow,
 * at the start of the second line.
 */
export function SessionsCard({ sessions, sources, now, className }: SessionsCardProps) {
  const table = useRef<HTMLTableElement>(null);
  const shown = overviewSources(sources);
  const broken = shown.filter(
    (source) => source.state === "unavailable" || source.state === "error",
  );
  const searching = shown.some((source) => source.state === "searching");
  const groups = tableGroups(sessions);
  const listed = groups.flatMap((group) => group.sessions);
  const jumpColumn = listed.some((session) => safeJumpLink(session) !== null);
  const agents = showsAgents(sources);
  const narrow = useNarrow();
  const agentColumn = agents && !narrow;
  // Narrow, the rows still draw the Folder and App cells, hidden, so the first
  // paint is right before the window's width is known to the script.
  const { folder: folderColumn, app: appColumn } = useColumns(
    table,
    listed.length > 0 && !narrow,
    agentColumn,
    jumpColumn,
  );
  // A group row spans the columns there are. A span wider than that would add
  // empty columns of its own and squeeze the ones with something in them.
  // Wide, those are Session and Status, with Agent, Folder and App when shown.
  const columns =
    (narrow ? 1 : 2 + (agentColumn ? 1 : 0) + (folderColumn ? 1 : 0) + (appColumn ? 1 : 0)) +
    (jumpColumn ? 1 : 0);
  // A count that nobody could make is not a zero: while no source has been
  // read, the head says no number at all, as the counts in the hero do.
  const { counted } = countState(sessions, sources);

  let body;
  if (listed.length > 0) {
    body = (
      <>
        {broken.length > 0 && <SourceNotices sources={broken} last={false} />}
        <table
          ref={table}
          data-slot='session-list'
          className='mb-2.5 w-full table-fixed border-separate border-spacing-0'
        >
          {/* The widths, set on the columns, since the heads are not drawn. */}
          <colgroup>
            <col />
            {agentColumn && <col className='w-25' />}
            {folderColumn && !narrow && <col className='w-28' />}
            {appColumn && !narrow && <col className='w-28' />}
            {!narrow && <col className='w-40' />}
            {jumpColumn && <col className='w-24' />}
          </colgroup>
          <thead className='sr-only'>
            <tr>
              <th scope='col'>Session</th>
              {agentColumn && <th scope='col'>Agent</th>}
              {folderColumn && !narrow && <th scope='col'>Folder</th>}
              {appColumn && !narrow && <th scope='col'>App</th>}
              {!narrow && <th scope='col'>Status and time</th>}
              {jumpColumn && <th scope='col'>Jump</th>}
            </tr>
          </thead>
          {groups.map((group) => (
            <GroupBody
              key={group.id}
              group={group}
              now={now}
              jumpColumn={jumpColumn}
              columns={columns}
              narrow={narrow}
              agentOf={agents ? (session) => agentLabel(session, sources) : undefined}
              folderColumn={folderColumn}
              appColumn={appColumn}
            />
          ))}
        </table>
      </>
    );
  } else if (sessions.length > 0) {
    // Every session is waiting on the person, so every one is in the hero.
    body = (
      <>
        {broken.length > 0 && <SourceNotices sources={broken} last={false} />}
        <p data-part='all-waiting' className='px-6 pb-6 text-body text-ink-secondary'>
          Every session needs you. They are at the top of the page, longest wait first.
        </p>
      </>
    );
  } else if (searching) {
    body = <Searching sources={shown} />;
  } else if (broken.length > 0 && broken.length === shown.length) {
    body = <SourceNotices sources={broken} last />;
  } else {
    // Named are only the tools being read. One that cannot be read says so above.
    const watched = shown.filter((source) => source.state === "ok");
    body = (
      <>
        {broken.length > 0 && <SourceNotices sources={broken} last={false} />}
        <EmptyState title='No agents are running'>
          <p>
            Agent Lookout is watching {sourceNames(watched)} on this computer. A session shows up
            here within a few seconds of starting.
          </p>
        </EmptyState>
      </>
    );
  }

  return (
    <SectionCard
      title='Sessions'
      count={counted ? sessions.length : undefined}
      aside={
        jumpColumn ? (
          <span data-part='hint' className='max-mid:hidden'>
            Jump opens the session where it runs
          </span>
        ) : undefined
      }
      className={className}
    >
      {body}
    </SectionCard>
  );
}
