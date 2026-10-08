import type { CapabilityCell, Session, SourceHealth, TokenCounts } from "@core/sessions/session";

/**
 * A session's token counts in words, as its details say them: "182,431 in,
 * 9,120 out", and under them "Newest reply · 141,002 of the input from a
 * cache". Every number is the agent's own, written whole with its thousands
 * grouped, never cut to "182k". Nothing here is money or a share of a limit.
 */

const GROUPED = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0, useGrouping: true });

/** "182,431": a count of tokens, whole, with its thousands grouped. */
export function tokenCount(count: number): string {
  return GROUPED.format(count);
}

/** The value of the Tokens fact: "182,431 in, 9,120 out". */
export function tokenCountsLine(tokens: TokenCounts): string {
  return `${tokenCount(tokens.input)} in, ${tokenCount(tokens.output)} out`;
}

/** The same, as a screen reader says it: "182,431 tokens in, 9,120 tokens out". */
export function tokenCountsSaid(tokens: TokenCounts): string {
  return `${tokenCount(tokens.input)} tokens in, ${tokenCount(tokens.output)} tokens out`;
}

/** What every count is of. The fact says it every time, so no one reads it as a session's total. */
export const NEWEST_REPLY = "Newest reply";

/**
 * The line under the counts: "Newest reply", and when the agent recorded how
 * much of the input came from a cache, "Newest reply · 141,002 of the input
 * from a cache", or "none of the input".
 */
export function tokenCountsCaption(tokens: TokenCounts): string {
  if (tokens.cached === undefined) return NEWEST_REPLY;
  const cached = tokens.cached === 0 ? "none" : tokenCount(tokens.cached);
  return `${NEWEST_REPLY} · ${cached} of the input from a cache`;
}

/** What the dash stands for, to a screen reader. */
export const NOT_RECORDED = "Not recorded";

/** Said under the dash when nothing more is known: the agent can record counts, and has not yet. */
export const NONE_YET = "None recorded yet";

/**
 * What the session's agent says of Tokens: its source's cell, or for a
 * session on another machine the cell of the agent there, as that machine
 * sent it. Null when no source says.
 */
function tokensCell(
  session: Pick<Session, "source" | "agent">,
  sources: readonly Pick<SourceHealth, "id" | "capabilities" | "agents">[],
): CapabilityCell | null {
  const source = sources.find((candidate) => candidate.id === session.source);
  if (!source) return null;
  if (source.capabilities) return source.capabilities.tokens;
  const agent = source.agents?.find((candidate) => candidate.label === session.agent);
  return agent?.capabilities.tokens ?? null;
}

/**
 * Why a session has no counts, under the dash: the reason its agent gives when
 * it cannot report them, such as "A status file has no field for token
 * counts."; for a session on another machine whose agent can, "devbox sent
 * none"; otherwise "None recorded yet", as for a Codex session before its first
 * reply.
 */
export function noTokensReason(
  session: Pick<Session, "source" | "agent" | "machine">,
  sources: readonly Pick<SourceHealth, "id" | "capabilities" | "agents">[],
): string {
  const cell = tokensCell(session, sources);
  if (cell?.level === "no") return cell.reason;
  if (session.machine !== undefined) return `${session.machine} sent none`;
  return NONE_YET;
}
