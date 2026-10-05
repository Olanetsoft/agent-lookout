/**
 * Finding a session by what the page shows of it: its name, its folder's name,
 * its branch, or the commit in the branch's place, and its agent.
 *
 * The matching is plain and forgiving. Case and accents are set aside, the
 * words can come in any order, and each must appear somewhere in those four,
 * as part of a word or a whole one. Nothing is scored: the order is the page's
 * own, so a session is where the person expects to find it.
 */

import type { Session } from "@core/sessions/session";
import { groupSessions } from "@dashboard/lib/sessions/sessions";

/** Text as it is compared: in lower case, with its accents set aside, so "Café" is found by "cafe". */
function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The words of a search, folded. Any run of spaces parts two words, and none is empty. */
export function searchWords(query: string): string[] {
  return fold(query).split(/\s+/u).filter(Boolean);
}

/**
 * Everything a search looks in for one session. The parts are joined by a
 * space, which no word holds, so a word is never found across two of them.
 */
function searchedText(session: Session, agent: string): string {
  return fold(
    [session.name, session.project, session.git?.branch, session.git?.commit, agent]
      .filter((part): part is string => typeof part === "string")
      .join(" "),
  );
}

/**
 * The sessions a search finds, in the page's order: those that need the person
 * first, longest wait first, as the Needs you panel lists them, then the rest
 * as the Sessions list orders them. An empty search finds every session.
 *
 * `agentOf` names each session's agent as the page does.
 */
export function searchSessions(
  sessions: readonly Session[],
  query: string,
  agentOf: (session: Session) => string,
): Session[] {
  const ordered = groupSessions(sessions).flatMap((group) => group.sessions);
  const words = searchWords(query);
  if (words.length === 0) return ordered;
  return ordered.filter((session) => {
    const text = searchedText(session, agentOf(session));
    return words.every((word) => text.includes(word));
  });
}
