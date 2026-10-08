import type { Session, SourceHealth } from "@core/sessions/session";
import { FactRow } from "@dashboard/components/ui/facts/FactRow";
import {
  noTokensReason,
  NOT_RECORDED,
  tokenCountsCaption,
  tokenCountsLine,
  tokenCountsSaid,
} from "@dashboard/lib/tokens/tokenWords";

/**
 * The token counts of a session's newest reply, as a fact of its details:
 * "182,431 in, 9,120 out", with tabular figures, and under them "Newest
 * reply", with how much of the input came from a cache when the agent
 * recorded it. The counts are its agent's own, as the collector read them.
 *
 * A session with none has a dash, read as "Not recorded", and under it why:
 * the reason its agent gives in Sources when it cannot report them, or that
 * none have been recorded yet.
 *
 * Nothing about it is warm, it is no meter, and it says nothing when the
 * counts change: they change with every reply.
 */
export function TokensFact({
  session,
  sources,
}: {
  session: Session;
  sources: readonly SourceHealth[];
}) {
  const { tokens } = session;
  return (
    <FactRow label='Tokens'>
      {tokens ? (
        <span data-part='tokens' className='tabular-nums'>
          <span aria-hidden>{tokenCountsLine(tokens)}</span>
          <span className='sr-only'>{tokenCountsSaid(tokens)}</span>
        </span>
      ) : (
        <span data-part='tokens'>
          <span aria-hidden>–</span>
          <span className='sr-only'>{NOT_RECORDED}</span>
        </span>
      )}
      <span
        data-part='tokens-note'
        className='block text-caption font-normal text-pretty text-ink-secondary tabular-nums'
      >
        {tokens ? tokenCountsCaption(tokens) : noTokensReason(session, sources)}
      </span>
    </FactRow>
  );
}
