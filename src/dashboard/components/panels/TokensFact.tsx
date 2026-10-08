import type { Session, SourceHealth, TokenCounts } from "@core/sessions/session";
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
 * recorded it. The counts are its agent's own, as the collector read them:
 * the session's own, or for a Claude Code session, whose counts are in no
 * session list, those the answer for what it last said gave, `read`.
 *
 * A session with none has a dash, read as "Not recorded", and under it why:
 * the reason its agent gives in Sources when it cannot report them, why that
 * answer gave none, `notRead`, such as that they are not read yet while it is
 * still to come, or that none have been recorded yet.
 *
 * Nothing about it is warm, it is no meter, and it says nothing when the
 * counts change: they change with every reply.
 */
export function TokensFact({
  session,
  sources,
  read,
  notRead,
}: {
  session: Session;
  sources: readonly SourceHealth[];
  /** The counts the last answer for what the session last said gave, when they come from there. */
  read?: TokenCounts;
  /** Why that answer gave none, when it is not that none are recorded, such as "Not read yet". */
  notRead?: string;
}) {
  const tokens = session.tokens ?? read;
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
        {tokens ? tokenCountsCaption(tokens) : noTokensReason(session, sources, notRead)}
      </span>
    </FactRow>
  );
}
