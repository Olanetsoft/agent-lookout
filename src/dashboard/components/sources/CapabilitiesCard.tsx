import {
  CAPABILITIES,
  CAPABILITY_LABEL,
  CAPABILITY_LEVEL_LABEL,
  type Capability,
  type CapabilityCell,
  type SourceCapabilities,
  type SourceHealth,
} from "@core/sessions/session";
import { FactList, FactRow } from "@dashboard/components/ui/facts/FactRow";
import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import { Tooltip } from "@dashboard/components/ui/surfaces/Tooltip";
import { useNarrow } from "@dashboard/hooks/dom/useMediaQuery";

/** One row of the table: a source on this computer, or an agent on another machine. */
interface Row {
  key: string;
  /** The source it belongs to. */
  source: string;
  /** For an agent on another machine: its name there. */
  agent?: string;
  /** "Claude Code", or "Claude Code on devbox". */
  label: string;
  capabilities: SourceCapabilities;
}

/**
 * A row for each source that declared what it can report, and after another
 * machine's, a row for each agent there, named "Claude Code on devbox".
 */
function rowsOf(sources: readonly SourceHealth[]): Row[] {
  const rows: Row[] = [];
  for (const source of sources) {
    if (source.capabilities) {
      rows.push({
        key: source.id,
        source: source.id,
        label: source.label,
        capabilities: source.capabilities,
      });
    }
    for (const agent of source.agents ?? []) {
      rows.push({
        key: `${source.id}\n${agent.label}`,
        source: source.id,
        agent: agent.label,
        label: `${agent.label} on ${source.label}`,
        capabilities: agent.capabilities,
      });
    }
  }
  return rows;
}

/**
 * One cell of the table, as a word. A yes is said quietly. A no or a partly is
 * the news, so it is in ink at 500, with its reason one hover or one Tab away
 * and, for a screen reader, in the cell's own text.
 */
function Cell({ cell }: { cell: CapabilityCell }) {
  if (cell.level === "yes") {
    return (
      <span data-part='capability' data-level='yes' className='text-ink-secondary'>
        {CAPABILITY_LEVEL_LABEL.yes}
      </span>
    );
  }
  return (
    <Tooltip content={cell.reason}>
      <span
        data-part='capability'
        data-level={cell.level}
        tabIndex={0}
        className='rounded-bar font-medium text-ink'
      >
        {CAPABILITY_LEVEL_LABEL[cell.level]}
        <span className='sr-only'>: {cell.reason}</span>
      </span>
    </Tooltip>
  );
}

/** A row for each agent and a column for each thing it can report. */
function Table({ rows }: { rows: readonly Row[] }) {
  const head = "pr-2 pb-2 align-bottom text-caption font-medium text-ink-secondary";
  return (
    <table data-part='table' className='mt-3 w-full table-fixed border-collapse text-left'>
      <colgroup>
        <col className='w-28' />
        {CAPABILITIES.map((capability) => (
          <col key={capability} />
        ))}
      </colgroup>
      <thead>
        <tr className='border-b border-hairline'>
          <th scope='col' className={head}>
            Agent
          </th>
          {CAPABILITIES.map((capability) => (
            <th key={capability} scope='col' className={head}>
              {CAPABILITY_LABEL[capability]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.key}
            data-source={row.source}
            data-agent={row.agent}
            className='border-b border-hairline last:border-b-0'
          >
            <th scope='row' className='py-2.5 pr-2 text-body font-semibold text-ink'>
              {row.label}
            </th>
            {CAPABILITIES.map((capability) => (
              <td key={capability} className='py-2.5 pr-2 text-body'>
                <Cell cell={row.capabilities[capability]} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Whether two cells say the same: the same word, and the same reason for it. */
function sameCell(a: CapabilityCell, b: CapabilityCell): boolean {
  if (a.level === "yes" || b.level === "yes") return a.level === b.level;
  return a.level === b.level && a.reason === b.reason;
}

/** What acts on this computer only, and so is No for every agent on another machine. */
const ACTS_HERE: readonly Capability[] = ["jump", "stop", "answer"];

/**
 * The row on this computer that an agent on another machine reports as, all
 * but Jump, Stop and Answer, which act on this computer only: "Claude Code"
 * for Claude Code on devbox, when each of its other cells says the same. Null
 * when there is none, or one says otherwise.
 */
function sameAsHere(row: Row, rows: readonly Row[]): Row | null {
  if (row.agent === undefined) return null;
  const here = rows.find((other) => other.agent === undefined && other.label === row.agent);
  if (!here) return null;
  const same = CAPABILITIES.every(
    (capability) =>
      ACTS_HERE.includes(capability) ||
      sameCell(here.capabilities[capability], row.capabilities[capability]),
  );
  return same ? here : null;
}

/**
 * The same, for a phone: a block for each agent with a fact row for each thing
 * it can report. A touch screen has no hover, so each reason is a line of its
 * own under its row.
 *
 * An agent on another machine that reports what the same agent here does, all
 * but Jump, Stop and Answer, is one line, so a phone is not made to read the
 * same nine rows again: "As Claude Code on this computer, but Jump: No, Stop:
 * No and Answer: No, which act on this computer only."
 */
function Blocks({ rows }: { rows: readonly Row[] }) {
  return (
    <div data-part='blocks' className='mt-3 flex flex-col gap-4'>
      {rows.map((row) => {
        const here = sameAsHere(row, rows);
        if (here) {
          return (
            <div key={row.key} data-source={row.source} data-agent={row.agent}>
              <h3 className='text-row font-semibold text-ink'>{row.label}</h3>
              <p data-part='same-as' className='mt-1 text-body text-ink-secondary'>
                As {here.label} on this computer, but{" "}
                <span className='font-medium text-ink'>
                  Jump: {CAPABILITY_LEVEL_LABEL[row.capabilities.jump.level]}
                </span>
                ,{" "}
                <span className='font-medium text-ink'>
                  Stop: {CAPABILITY_LEVEL_LABEL[row.capabilities.stop.level]}
                </span>{" "}
                and{" "}
                <span className='font-medium text-ink'>
                  Answer: {CAPABILITY_LEVEL_LABEL[row.capabilities.answer.level]}
                </span>
                , which act on this computer only.
              </p>
            </div>
          );
        }
        return (
          <div key={row.key} data-source={row.source} data-agent={row.agent}>
            <h3 className='text-row font-semibold text-ink'>{row.label}</h3>
            <FactList className='mt-1'>
              {CAPABILITIES.map((capability) => {
                const cell = row.capabilities[capability];
                return (
                  <FactRow
                    key={capability}
                    label={CAPABILITY_LABEL[capability]}
                    note={cell.level === "yes" ? undefined : cell.reason}
                  >
                    <span
                      data-part='capability'
                      data-level={cell.level}
                      className={
                        cell.level === "yes" ? "font-normal text-ink-secondary" : undefined
                      }
                    >
                      {CAPABILITY_LEVEL_LABEL[cell.level]}
                    </span>
                  </FactRow>
                );
              })}
            </FactList>
          </div>
        );
      })}
    </div>
  );
}

/**
 * What each agent can report at all, so a signal that never shows is not read
 * as good news: working and idle, needs you, finished, failed, names, Jump and
 * quiet for, each yes, no or partly. Every word and every reason is what the
 * agent's adapter declared, carried on its source's health. The page knows
 * none of them itself, and draws no row for a source that declared nothing.
 * Another machine has a row for each agent there, as that machine's Agent
 * Lookout declared it, with no Jump, no Stop and no Answer: "Claude Code on
 * devbox".
 *
 * It is a table while there is room for one, and a block for each agent on a
 * phone. Nothing in it is coloured: yes and no are words.
 */
export function CapabilitiesCard({ sources }: { sources: readonly SourceHealth[] }) {
  const narrow = useNarrow();
  const rows = rowsOf(sources);
  if (rows.length === 0) return null;

  return (
    <SectionCard data-slot='capabilities' title='What each agent can report'>
      <div className='px-6 pb-3'>
        <p data-part='lead' className='text-body text-ink-secondary'>
          A signal marked No never appears for that agent, so not seeing it is not good news.
          {!narrow && " Point at No or Partly, or move to it with Tab, to read why."}
        </p>
        {narrow ? <Blocks rows={rows} /> : <Table rows={rows} />}
      </div>
    </SectionCard>
  );
}
