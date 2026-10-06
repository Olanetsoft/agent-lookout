import type { ReactNode } from "react";

import { isRemoteSource, type Session, type SourceHealth } from "@core/sessions/session";
import { ProblemAdvice } from "@dashboard/components/dashboard/ConnectionNotices";
import { CapabilitiesCard } from "@dashboard/components/sources/CapabilitiesCard";
import { Callout } from "@dashboard/components/ui/feedback/Callout";
import { FactList, FactRow } from "@dashboard/components/ui/facts/FactRow";
import { FactText } from "@dashboard/components/ui/facts/FactText";
import { Literal } from "@dashboard/components/ui/facts/Literal";
import { Loading } from "@dashboard/components/ui/feedback/Loading";
import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import { Tooltip } from "@dashboard/components/ui/surfaces/Tooltip";
import type { CollectorState } from "@dashboard/lib/api/collectorStore";
import { problemTitle, sourceLine } from "@dashboard/lib/sources/connection";
import { formatAgo, formatClock, formatFullTime } from "@dashboard/lib/format";
import { cn } from "@dashboard/lib/utils";

/**
 * Whether a fact's value is a literal string: a folder, a file or a command.
 * Those are set in the mono. A phrase such as "every 2 seconds" or "not run" is
 * words, and words are never set in the mono.
 */
function isLiteral(value: string): boolean {
  return value.includes("/") || value.startsWith("~") || / --?\w/.test(value);
}

/** Whether a fact's value is a count, such as the files a source read. */
function isCount(value: string): boolean {
  return /^\d+$/.test(value);
}

interface SourcesViewProps {
  state: CollectorState;
  now: number;
}

/**
 * One source, as a card: its state in words, the collector's own sentence about
 * how it is being read, what to do about it when the collector says, and a
 * row for each thing it reads or runs. Those facts
 * come from the collector as labels and values, because it is the only part of
 * the app that knows them. The page shows each as it is given and looks for
 * none of them inside the sentence.
 *
 * Once answers stop, everything here is what was last heard: the state says
 * "last known", and the time of the last check is a clock time that does not
 * move, not an age that keeps growing.
 */
function SourceCard({
  source,
  sessions,
  now,
  stalled,
}: {
  source: SourceHealth;
  sessions: readonly Session[];
  now: number;
  stalled: boolean;
}) {
  const line = sourceLine(source, stalled);
  const found = sessions.filter((session) => session.source === source.id).length;

  return (
    <SectionCard
      data-slot='source'
      data-state={source.state}
      data-stalled={stalled}
      title={source.label}
      aside={
        <span data-part='state' className='text-body font-medium text-ink-secondary'>
          {line.state}
        </span>
      }
    >
      <div className='px-6 pb-3'>
        {source.detail && (
          <p data-part='detail' className='text-body wrap-break-word text-ink-secondary'>
            <FactText>{source.detail}</FactText>
          </p>
        )}
        {/* What to do about it, when the collector knows: the card is where a person looks. */}
        {source.advice && (
          <p
            data-part='advice'
            className={cn("text-body wrap-break-word text-ink-secondary", source.detail && "mt-2")}
          >
            <FactText>{source.advice}</FactText>
          </p>
        )}

        <FactList className='mt-2'>
          {source.watching?.map((fact, index) =>
            isLiteral(fact.value) ? (
              // A folder or a command breaks only between its words and after a
              // slash, so a flag is never split at its hyphens.
              <FactRow key={`${index}-${fact.label}`} label={fact.label} mono>
                <Literal data-part='watching'>{fact.value}</Literal>
              </FactRow>
            ) : (
              // A count, such as the files read, is a figure that keeps its width.
              <FactRow key={`${index}-${fact.label}`} label={fact.label}>
                <span
                  data-part='watching'
                  className={cn("wrap-anywhere", isCount(fact.value) && "tabular-nums")}
                >
                  {fact.value}
                </span>
              </FactRow>
            ),
          )}
          {/* A count and an age are figures, in the sans with figures that keep their width. */}
          <FactRow label='Sessions found'>
            <span className='tabular-nums'>{found}</span>
          </FactRow>
          <FactRow label='Last checked'>
            {stalled ? (
              <span className='tabular-nums'>{formatClock(source.checkedAt)}</span>
            ) : (
              <Tooltip content={formatFullTime(source.checkedAt)} mono align='end'>
                <span className='tabular-nums'>{formatAgo(now - source.checkedAt)}</span>
              </Tooltip>
            )}
          </FactRow>
        </FactList>
      </div>
    </SectionCard>
  );
}

/** A card with one message in it, for when there is no source to show. */
function MessageCard({ children }: { children: ReactNode }) {
  return (
    <SectionCard title='Sources'>
      <div className='px-6 pb-6'>{children}</div>
    </SectionCard>
  );
}

/** What About sources says of other machines, once one is named. */
const MACHINES =
  "Another machine is one named in AGENT_LOOKOUT_REMOTES, with Agent Lookout running there. It is read over SSH, with your own ssh, and asked for its sessions and nothing else. Its sessions carry its name, and Jump, Stop, Allow and Deny act on this computer only.";

/**
 * Where the sessions come from: each source's health, and what it reads and
 * runs, in plain language, and under them what each agent can report at all.
 * Another machine has a card of its own, which says whether it is connected
 * and, when it is not, why. It sits in the main area in place of the Overview.
 */
export function SourcesView({ state, now }: SourcesViewProps) {
  const { snapshot, phase } = state;
  const stalled = phase === "stalled";
  const machines = snapshot?.sources.some((source) => isRemoteSource(source.id)) ?? false;

  let sources;
  if (snapshot) {
    sources =
      snapshot.sources.length > 0 ? (
        snapshot.sources.map((source) => (
          <SourceCard
            key={source.id}
            source={source}
            sessions={snapshot.sessions}
            now={now}
            stalled={stalled}
          />
        ))
      ) : (
        <MessageCard>
          <Callout title='No sources are set up'>
            <p>Agent Lookout is running but is not watching any agent tool.</p>
          </Callout>
        </MessageCard>
      );
  } else if (phase === "unreachable") {
    // The title says what happened and the advice what to do. The request's own
    // detail is on the Overview, under "What happened".
    sources = (
      <MessageCard>
        <Callout tone='error' title={problemTitle(state.problemKind)}>
          <ProblemAdvice kind={state.problemKind} />
        </Callout>
      </MessageCard>
    );
  } else {
    sources = (
      <SectionCard title='Sources'>
        <Loading label='Waiting for the first answer' />
      </SectionCard>
    );
  }

  return (
    <div
      data-slot='sources-view'
      className='grid grid-cols-3 items-start gap-4 max-wide:flex max-wide:flex-col'
    >
      <div className='col-span-2 flex min-w-0 flex-col gap-4 max-wide:w-full'>
        {stalled && state.lastOkAt !== null && (
          <Callout tone='error' title='Agent Lookout has stopped updating'>
            <p>
              What follows is from{" "}
              <span className='tabular-nums'>{formatClock(state.lastOkAt)}</span>. Check that it is
              still running in your terminal.
            </p>
          </Callout>
        )}
        {sources}
        {/* What each agent can report is fixed, so it stays true once updates stop. */}
        {snapshot && <CapabilitiesCard sources={snapshot.sources} />}
      </div>

      <SectionCard title='About sources' className='col-span-1 max-wide:w-full'>
        <div className='flex flex-col gap-2 px-6 pb-6 text-body text-ink-secondary'>
          <p>
            A source is an agent tool Agent Lookout finds sessions in. It reads its files and never
            writes to them. Agent Lookout stops a Claude Code session only when you press Stop and
            confirm.
          </p>
          <p>
            Status files are how any other agent appears: it writes a small file for each of its
            sessions in a folder that Agent Lookout reads.
          </p>
          <p>
            Unless you set up email or a webhook, Agent Lookout itself sends nothing anywhere. A
            command listed under a source is that tool&apos;s own program, and may reach the
            tool&apos;s own servers, as it does whenever it runs.
          </p>
          {machines && (
            <p data-part='machines'>
              <FactText>{MACHINES}</FactText>
            </p>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
