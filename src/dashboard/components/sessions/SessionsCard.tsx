import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { sessionResumeCommand } from "@core/mapping/claudeCodeResume";
import { isRemoteSource, type Session, type SourceHealth } from "@core/sessions/session";
import { SessionRow } from "@dashboard/components/sessions/SessionRow";
import { Count, SessionsBoard } from "@dashboard/components/sessions/SessionsBoard";
import { LeftRunning } from "@dashboard/components/stop/LeftRunning";
import { SegmentedControl } from "@dashboard/components/ui/controls/SegmentedControl";
import { Callout } from "@dashboard/components/ui/feedback/Callout";
import { EmptyState } from "@dashboard/components/ui/feedback/EmptyState";
import { FactText } from "@dashboard/components/ui/facts/FactText";
import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import { Truncated } from "@dashboard/components/ui/surfaces/Tooltip";
import { useNarrow } from "@dashboard/hooks/dom/useMediaQuery";
import { useSessionsLayout } from "@dashboard/hooks/shell/useSessionsLayout";
import { repositoryGroups } from "@dashboard/lib/sessions/repositories";
import { countState, tableGroups, type SessionGroup } from "@dashboard/lib/sessions/sessions";
import {
  agentLabel,
  overviewSources,
  showsAgents,
  sourceNames,
  unseenMachines,
  unseenSentence,
} from "@dashboard/lib/sources/sources";
import { jumpWay } from "@dashboard/lib/sessions/status";
import type { SessionsLayout } from "@dashboard/lib/shell/sessionsLayout";
import { cn } from "@dashboard/lib/utils";

/**
 * The three ways the card can lay out its sessions, as the switch in its head
 * offers them: the list by status, the list by repository, and the board.
 * Each word is short enough for the three to sit side by side on a phone.
 */
const LAYOUTS = [
  { value: "list", label: "List" },
  { value: "repositories", label: "Repos" },
  { value: "board", label: "Board" },
] as const satisfies readonly { value: SessionsLayout; label: string }[];

interface SessionsCardProps {
  sessions: readonly Session[];
  sources: readonly SourceHealth[];
  now: number;
  /** Told once sessions left running have been ended, so the page reads the sessions again. */
  onEnded?: () => void;
  /** How long a session is idle before it is stale, as the snapshot's time rules say. */
  staleAfterMs?: number;
  className?: string;
}

/**
 * A source that cannot be read. Missing is said calmly; broken is said as an error.
 * Another machine that cannot be read is not connected, said calmly, since the
 * collector says it is unavailable, and it is named only when nothing on this
 * computer is found either.
 *
 * What to do about it comes from the collector when it knows. A person who
 * pointed Agent Lookout at the wrong program is told to correct that, not to
 * install something they already have.
 */
function SourceNotice({ source }: { source: SourceHealth }) {
  const missing = source.state === "unavailable";
  const title = isRemoteSource(source.id)
    ? `${source.label} is not connected`
    : missing
      ? `${source.label} was not found`
      : `${source.label} could not be read`;
  return (
    <Callout tone={missing ? "info" : "error"} title={title}>
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

/**
 * What is being watched, for the empty state: "Agent Lookout is watching
 * Claude Code on this computer.", with "and the sessions on devbox" when
 * another machine is read too, and, for a machine that is not, which one and
 * that its sessions are not known: "devbox is not connected, so its sessions
 * are not known."
 */
function watchingWhere(watched: readonly SourceHealth[], sources: readonly SourceHealth[]): string {
  const here = watched.filter((source) => !isRemoteSource(source.id));
  const machines = watched.filter((source) => isRemoteSource(source.id));
  const parts: string[] = [];
  if (here.length > 0 || machines.length === 0) parts.push(`${sourceNames(here)} on this computer`);
  if (machines.length > 0) parts.push(`the sessions on ${sourceNames(machines)}`);
  const unseen = unseenSentence(unseenMachines(sources));
  return [`Agent Lookout is watching ${parts.join(" and ")}.`, unseen].filter(Boolean).join(" ");
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

/** What a group's rows are drawn with, the same in every group of the table. */
interface RowsProps {
  now: number;
  /** Whether the table has a column for Jump, and for Resume. */
  actionColumn: boolean;
  columns: number;
  narrow: boolean;
  /** The tool each session belongs to, when the table names it. */
  agentOf?: (session: Session) => string;
  /** Whether the table has a Folder column, or it has given way so the names keep their room. */
  folderColumn: boolean;
  /** Whether the table has an App column, or it has given way so the names keep their room. */
  appColumn: boolean;
}

/**
 * One group of the table: a head of words over its sessions. Every group is
 * drawn by this, whatever it groups by, so the rows line up across them all.
 */
function GroupBody({
  head,
  sessions,
  now,
  actionColumn,
  columns,
  narrow,
  agentOf,
  folderColumn,
  appColumn,
  ...data
}: RowsProps & {
  head: ReactNode;
  sessions: readonly Session[];
  "data-group": string;
  "data-repository"?: string;
}) {
  return (
    <tbody data-slot='session-group' {...data}>
      <tr data-slot='group-row'>
        <th
          scope='rowgroup'
          colSpan={columns}
          className='h-group px-6 pt-2.5 pb-1.5 text-left align-bottom text-caption font-semibold text-ink-secondary'
        >
          {head}
        </th>
      </tr>
      {sessions.map((session) => (
        <SessionRow
          key={session.id}
          session={session}
          now={now}
          actionColumn={actionColumn}
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
 * The head of a status group: its name and count in words.
 *
 * The idle group counts its stale sessions apart, as the counts row does:
 * "Idle 2" and "Stale 1" over three rows. When every one of them is stale, it
 * says only that.
 */
function StatusHead({ group }: { group: SessionGroup }) {
  const named = group.id !== "idle" || group.count > 0;
  return (
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
  );
}

/**
 * The table's groups. By status: Working, Idle, then the endings, then
 * unknown. By repository: one group for each repository, in order of name,
 * headed by its name and how many sessions it has, "storefront 3", with the
 * sessions in no repository last, under "No repository". Inside each, the
 * sessions keep the order of the status groups. A repository's head is cut
 * when its name is too long for the card, and stays a hover or a Tab away.
 */
function Groups({
  sessions,
  byRepository,
  ...rows
}: RowsProps & { sessions: readonly Session[]; byRepository: boolean }) {
  if (!byRepository) {
    return tableGroups(sessions).map((group) => (
      <GroupBody
        key={group.id}
        data-group={group.id}
        head={<StatusHead group={group} />}
        sessions={group.sessions}
        {...rows}
      />
    ));
  }
  const listed = tableGroups(sessions).flatMap((group) => group.sessions);
  return repositoryGroups(listed).map((group) => (
    <GroupBody
      key={group.id ?? ""}
      data-group={group.id === null ? "no-repository" : "repository"}
      data-repository={group.id ?? undefined}
      head={
        <span className='flex min-w-0 items-baseline gap-1.5'>
          <Truncated data-part='repository' className='min-w-0'>
            {group.label}
          </Truncated>
          <Count>{group.sessions.length}</Count>
        </span>
      }
      sessions={group.sessions}
      {...rows}
    />
  ));
}

/**
 * The widths of the columns beside Session, in rem, as the classes of the
 * table's columns set them. Each holds what goes in it and little more: Agent
 * w-25 holds "Claude Code", App w-28 "Desktop app", Status w-40 the longest
 * phrase, "Finished 23h 59m ago", and the actions w-24 the 64px button, Jump
 * or Resume. Folder is at least 7rem, a folder name of about 12 letters, and
 * cuts a longer one, whose whole path is in its tooltip. A change to one of
 * those classes changes this.
 */
const COLUMN_REM = { agent: 6.25, folder: 7, app: 7, status: 10, actions: 6 } as const;
/** The least the Session column keeps: its mark and a name of about 18 letters. */
const SESSION_REM = 12.5;
/** The most the Folder column takes, a folder or a branch of about 22 letters. */
const MAX_FOLDER_REM = 12;

interface Columns {
  folder: boolean;
  app: boolean;
  /** The Folder column's width, in rem. */
  folderRem: number;
}

const ALL_COLUMNS: Columns = { folder: true, app: true, folderRem: COLUMN_REM.folder };

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
 * The Folder column, which holds the folder with its branch under it, takes
 * half the room left over once every column has its least, up to 12rem, and
 * the Session column the other half, so neither is cut while the other sits
 * empty. Folder and App still give way at the same widths.
 *
 * Measured from the card, whose width does not depend on which way is chosen,
 * and before the page is painted, so the table never draws one way and then
 * the other.
 */
function useColumns(
  table: RefObject<HTMLTableElement | null>,
  measured: boolean,
  agentColumn: boolean,
  actionColumn: boolean,
): Columns {
  const [columns, setColumns] = useState<Columns>(ALL_COLUMNS);

  useLayoutEffect(() => {
    const card = table.current?.parentElement;
    if (!measured || !card) return;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const always =
        SESSION_REM +
        COLUMN_REM.status +
        (agentColumn ? COLUMN_REM.agent : 0) +
        (actionColumn ? COLUMN_REM.actions : 0);
      const width = card.clientWidth / rem;
      const folder = width >= always + COLUMN_REM.folder;
      const app = folder && width >= always + COLUMN_REM.folder + COLUMN_REM.app;
      const spare = width - (always + COLUMN_REM.folder + (app ? COLUMN_REM.app : 0));
      // In quarters of a rem, so a pixel more or less does not draw the table again.
      const folderRem =
        Math.round(Math.min(MAX_FOLDER_REM, COLUMN_REM.folder + Math.max(0, spare) / 2) * 4) / 4;
      setColumns((current) =>
        current.folder === folder && current.app === app && current.folderRem === folderRem
          ? current
          : { folder, app, folderRem },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, [table, measured, agentColumn, actionColumn]);

  return measured ? columns : ALL_COLUMNS;
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
 *
 * A switch in the head groups the same rows by repository instead, the
 * worktrees of one repository together, or lays the sessions out as a board,
 * with a column for each status, the sessions that need the person included.
 * Grouped by repository, the sessions that need the person are still the
 * hero's. The choice is kept in this browser. With no session there is nothing
 * to lay out, and the switch is not offered.
 *
 * Over the list or the board, once there is one, a band says how many
 * sessions are left running: idle a day or more with the process still
 * running. Review… opens it to list them. Each can be hidden until it
 * changes, and End all… ends them after a confirmation that lists each one.
 * They stay in the list under Idle as well.
 */
export function SessionsCard({
  sessions,
  sources,
  now,
  onEnded,
  staleAfterMs,
  className,
}: SessionsCardProps) {
  const table = useRef<HTMLTableElement>(null);
  // Where focus goes when the last of the sessions left running is hidden.
  const title = useRef<HTMLHeadingElement>(null);
  const shown = overviewSources(sources);
  const broken = shown.filter(
    (source) => source.state === "unavailable" || source.state === "error",
  );
  const searching = shown.some((source) => source.state === "searching");
  const listed = tableGroups(sessions).flatMap((group) => group.sessions);
  const [layout, setLayout] = useSessionsLayout();
  // With no session there is nothing to lay out, so both ways say the same,
  // and the switch is not offered.
  const board = layout === "board" && sessions.length > 0;
  const jumpColumn = listed.some((session) => jumpWay(session) !== null);
  // A Claude Code session that is over has Resume where a Jump would be.
  const resumeColumn = listed.some((session) => sessionResumeCommand(session) !== null);
  const actionColumn = jumpColumn || resumeColumn;
  // What Jump does depends on where a session runs, and the head says only
  // what the Jumps on the card do: the table's, or the board's, which has
  // the sessions that need the person too. Bringing a terminal's tab forward
  // is opening the session where it runs, as a link is.
  const ways = (board ? sessions : listed).map(jumpWay).filter((way) => way !== null);
  const jumpHint = !ways.some((way) => way.by === "tmux")
    ? "Jump opens the session where it runs"
    : ways.some((way) => way.by !== "tmux")
      ? "Jump opens the session, or selects its pane in tmux"
      : "Jump selects the session's pane in tmux";
  const agents = showsAgents(sources, sessions);
  const agentOf = agents ? (session: Session) => agentLabel(session, sources) : undefined;
  const narrow = useNarrow();
  const agentColumn = agents && !narrow;
  // Narrow, the rows still draw the Folder and App cells, hidden, so the first
  // paint is right before the window's width is known to the script.
  const {
    folder: folderColumn,
    app: appColumn,
    folderRem,
  } = useColumns(table, listed.length > 0 && !narrow && !board, agentColumn, actionColumn);
  // A group row spans the columns there are. A span wider than that would add
  // empty columns of its own and squeeze the ones with something in them.
  // Wide, those are Session and Status, with Agent, Folder and App when shown.
  const columns =
    (narrow ? 1 : 2 + (agentColumn ? 1 : 0) + (folderColumn ? 1 : 0) + (appColumn ? 1 : 0)) +
    (actionColumn ? 1 : 0);
  // A count that nobody could make is not a zero: while no source has been
  // read, the head says no number at all, as the counts in the hero do.
  const { counted } = countState(sessions, sources);

  let body;
  if (board) {
    body = (
      <>
        {broken.length > 0 && <SourceNotices sources={broken} last={false} />}
        <SessionsBoard sessions={sessions} now={now} agentOf={agentOf} />
      </>
    );
  } else if (listed.length > 0) {
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
            {folderColumn && !narrow && <col style={{ width: `${folderRem}rem` }} />}
            {appColumn && !narrow && <col className='w-28' />}
            {!narrow && <col className='w-40' />}
            {actionColumn && <col className='w-24' />}
          </colgroup>
          <thead className='sr-only'>
            <tr>
              <th scope='col'>Session</th>
              {agentColumn && <th scope='col'>Agent</th>}
              {folderColumn && !narrow && <th scope='col'>Folder</th>}
              {appColumn && !narrow && <th scope='col'>App</th>}
              {!narrow && <th scope='col'>Status and time</th>}
              {actionColumn && (
                <th scope='col'>
                  {jumpColumn && resumeColumn ? "Jump or resume" : jumpColumn ? "Jump" : "Resume"}
                </th>
              )}
            </tr>
          </thead>
          <Groups
            sessions={sessions}
            byRepository={layout === "repositories"}
            now={now}
            actionColumn={actionColumn}
            columns={columns}
            narrow={narrow}
            agentOf={agentOf}
            folderColumn={folderColumn}
            appColumn={appColumn}
          />
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
            {watchingWhere(watched, sources)} A session shows up here within a few seconds of
            starting.
          </p>
        </EmptyState>
      </>
    );
  }

  // The hint goes where the card is too narrow to hold it beside the switch,
  // the longest hint and a count of hundreds included, as it is just wider
  // than a phone, so the head stays one line and the switch never meets the
  // title. The card's own width decides, so a scrollbar's width counts.
  const hint = ways.length > 0 && (
    <span data-part='hint' className='max-mid:hidden @max-[42rem]:hidden'>
      {jumpHint}
    </span>
  );
  // The switch is as tall as a control, more than the title's line. In the
  // head, its margins give that back, so the head is as tall as the heads
  // beside it and its title sits level with theirs. Narrow, a head that wraps
  // would put it under the title, where those margins pull it up against the
  // title, so there it is the card's first line instead, under the head.
  const layoutSwitch = sessions.length > 0 && (
    <SegmentedControl
      label='Show sessions as'
      value={layout}
      onValueChange={setLayout}
      options={LAYOUTS}
      className={narrow ? undefined : "-my-2.5"}
    />
  );

  return (
    <SectionCard
      title='Sessions'
      titleRef={title}
      count={counted ? sessions.length : undefined}
      aside={
        layoutSwitch && !narrow ? (
          <div className='flex items-center gap-4'>
            {hint}
            {layoutSwitch}
          </div>
        ) : (
          hint || undefined
        )
      }
      className={cn("@container", className)}
    >
      {layoutSwitch && narrow && (
        <div data-part='layout' className='flex px-6 pb-1'>
          {layoutSwitch}
        </div>
      )}
      <LeftRunning
        sessions={sessions}
        now={now}
        onEnded={onEnded}
        onGone={() => title.current?.focus()}
        staleAfterMs={staleAfterMs}
      />
      {body}
    </SectionCard>
  );
}
