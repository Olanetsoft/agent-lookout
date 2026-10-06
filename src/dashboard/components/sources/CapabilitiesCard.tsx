import {
  CAPABILITIES,
  CAPABILITY_LABEL,
  CAPABILITY_LEVEL_LABEL,
  type CapabilityCell,
  type SourceCapabilities,
  type SourceHealth,
} from "@core/sessions/session";
import { FactList, FactRow } from "@dashboard/components/ui/facts/FactRow";
import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import { Tooltip } from "@dashboard/components/ui/surfaces/Tooltip";
import { useNarrow } from "@dashboard/hooks/dom/useMediaQuery";

type Declared = SourceHealth & { capabilities: SourceCapabilities };

function isDeclared(source: SourceHealth): source is Declared {
  return source.capabilities !== undefined;
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
function Table({ sources }: { sources: readonly Declared[] }) {
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
        {sources.map((source) => (
          <tr
            key={source.id}
            data-source={source.id}
            className='border-b border-hairline last:border-b-0'
          >
            <th scope='row' className='py-2.5 pr-2 text-body font-semibold text-ink'>
              {source.label}
            </th>
            {CAPABILITIES.map((capability) => (
              <td key={capability} className='py-2.5 pr-2 text-body'>
                <Cell cell={source.capabilities[capability]} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The same, for a phone: a block for each agent with a fact row for each thing
 * it can report. A touch screen has no hover, so each reason is a line of its
 * own under its row.
 */
function Blocks({ sources }: { sources: readonly Declared[] }) {
  return (
    <div data-part='blocks' className='mt-3 flex flex-col gap-4'>
      {sources.map((source) => (
        <div key={source.id} data-source={source.id}>
          <h3 className='text-row font-semibold text-ink'>{source.label}</h3>
          <FactList className='mt-1'>
            {CAPABILITIES.map((capability) => {
              const cell = source.capabilities[capability];
              return (
                <FactRow
                  key={capability}
                  label={CAPABILITY_LABEL[capability]}
                  note={cell.level === "yes" ? undefined : cell.reason}
                >
                  <span
                    data-part='capability'
                    data-level={cell.level}
                    className={cell.level === "yes" ? "font-normal text-ink-secondary" : undefined}
                  >
                    {CAPABILITY_LEVEL_LABEL[cell.level]}
                  </span>
                </FactRow>
              );
            })}
          </FactList>
        </div>
      ))}
    </div>
  );
}

/**
 * What each agent can report at all, so a signal that never shows is not read
 * as good news: working and idle, needs you, finished, failed, names, Jump and
 * quiet for, each yes, no or partly. Every word and every reason is what the
 * agent's adapter declared, carried on its source's health. The page knows
 * none of them itself, and draws no row for a source that declared nothing.
 *
 * It is a table while there is room for one, and a block for each agent on a
 * phone. Nothing in it is coloured: yes and no are words.
 */
export function CapabilitiesCard({ sources }: { sources: readonly SourceHealth[] }) {
  const narrow = useNarrow();
  const declared = sources.filter(isDeclared);
  if (declared.length === 0) return null;

  return (
    <SectionCard data-slot='capabilities' title='What each agent can report'>
      <div className='px-6 pb-3'>
        <p data-part='lead' className='text-body text-ink-secondary'>
          A signal marked No never appears for that agent, so not seeing it is not good news.
          {!narrow && " Point at No or Partly, or move to it with Tab, to read why."}
        </p>
        {narrow ? <Blocks sources={declared} /> : <Table sources={declared} />}
      </div>
    </SectionCard>
  );
}
