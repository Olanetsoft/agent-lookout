import type { AnsweringStatus, Session } from "@core/sessions/session";
import { needsYou } from "@core/waits/answeredWaits";
import type { SeenAsks } from "@dashboard/lib/answer/seenAsks";
import type { CollectorState } from "@dashboard/lib/api/collectorStore";
import { durationInWords } from "@dashboard/lib/format";

/**
 * Why a Claude Code session on this computer that waits for permission has
 * no Deny or Allow, which is when Agent Lookout holds no request of its. It is
 * told from what the page already holds, and nothing else: the snapshot's
 * `answering`, the wait's `statusSince`, `startedAt` of `/api/history`, and
 * the requests the page has seen (`seenAsks.ts`). The collector says nothing
 * of a request it let go, so the page says only what that much makes certain.
 *
 * The line is drawn where Deny and Allow would be, beside the Jump: in the
 * hero and at the top of the details. The list leaves waiting sessions to the
 * hero, and the board's cards and the search have no Deny or Allow. The Mac
 * app's menu bar offers them in a submenu while a request is held, but it has
 * no Jump, and a session with none held opens its details, where the line is.
 *
 * off           AGENT_LOOKOUT_ANSWER is off
 * unavailable   Agent Lookout could not listen for the plugin, or does not, as on Windows
 * ran-out       a request was seen in this wait, and the time it could be held is over
 * before-start  the wait began before this run of Agent Lookout did
 * missed        a Claude Code session waited for permission and its request did not
 *               reach Agent Lookout, and no request has reached it since
 * held-out      the wait is longer than a request is held
 * not-held      no request of its is held, and nothing says why
 */
export const NO_ASK_REASONS = [
  "off",
  "unavailable",
  "ran-out",
  "before-start",
  "missed",
  "held-out",
  "not-held",
] as const;

export type NoAskReason = (typeof NO_ASK_REASONS)[number];

/**
 * How long a wait goes before the line speaks of its request. The collector
 * takes a wait to have missed its request after 5 seconds (`MISSED_AFTER_MS`
 * in `src/collector/answers/heldAsks.ts`), at a poll every 2 seconds, and the
 * page reads every 2 seconds. Before this, a request may still be on its way,
 * a rule may be answering it, and the snapshot may not yet say what it will.
 */
export const NO_ASK_AFTER_MS = 10_000;

/** What the page holds that says why. */
export interface NoAskFacts {
  /** The snapshot's `answering`. */
  answering: AnsweringStatus;
  /** When this run of the collector began, from `/api/history`, or null before that is read. */
  startedAt: number | null;
  /** When the snapshot was made, on the collector's clock, which `until` and `statusSince` are on too. */
  at: number;
  /** The requests the page has seen in the waits under way. */
  seen: SeenAsks;
}

/**
 * The facts from what the store holds, or null when there is no snapshot, or
 * it does not say whether answering is on, as from a collector that cannot
 * answer: then no line is drawn.
 */
export function noAskFacts(
  state: Pick<CollectorState, "snapshot" | "history" | "seenAsks">,
): NoAskFacts | null {
  const answering = state.snapshot?.answering;
  if (state.snapshot === null || answering === undefined) return null;
  return {
    answering,
    startedAt: state.history?.startedAt ?? null,
    at: state.snapshot.generatedAt,
    seen: state.seenAsks,
  };
}

/** The parts of a session the reason is told from. */
export type NoAskSession = Pick<
  Session,
  | "id"
  | "source"
  | "machine"
  | "status"
  | "answered"
  | "waitingReason"
  | "ask"
  | "askNotRead"
  | "alive"
  | "statusSince"
>;

/** Why the session has no Deny or Allow, or null when it has them, needs no line, or nothing can be said yet. */
export function noAskReason(session: NoAskSession, facts: NoAskFacts): NoAskReason | null {
  if (session.source !== "claude-code" || session.machine !== undefined) return null;
  if (!needsYou(session) || session.waitingReason !== "permission") return null;
  // A held request has its buttons, and one the page could not read is held all the same.
  // A session whose process has ended says so in its badge.
  if (session.ask !== undefined || session.askNotRead === true || session.alive === false) {
    return null;
  }
  const { answering, startedAt, at } = facts;
  if (answering.state === "off") return "off";
  if (answering.state === "unavailable") return "unavailable";

  // A request seen in this wait may have been answered a moment ago, somewhere
  // else, and the next poll will say so. Only once its hold has run out is it
  // certain that it is not held.
  const seen = facts.seen.get(session.id);
  if (seen !== undefined) return seen.until !== null && at >= seen.until ? "ran-out" : null;

  const since = session.statusSince;
  if (since === null) return null;
  const waited = at - since;
  if (waited < NO_ASK_AFTER_MS) return null;
  // Past the hold, that is all that is certain. Before it, a wait from before
  // this run began had no Agent Lookout to send its request to. History kept
  // on disk is read back before the run's start time is set, and the socket
  // may listen a moment before that, so a request that came in that moment
  // and was let go before the page saw it is said to be from before the start.
  const pastHold = waited >= answering.holdMs;
  if (!pastHold && startedAt !== null && since < startedAt) return "before-start";
  // The collector's word for every session at once, not for this one: missed
  // from the start of the latest wait it took to have missed its request,
  // until a request of any session reaches it after that. So a wait can go
  // from missed to not-held or held-out as another session's request arrives,
  // as the card in Settings then leaves out its install commands.
  if (answering.plugin === "missed") return "missed";
  if (pastHold) return "held-out";
  return "not-held";
}

/** The words of the line that link to Settings. */
export const PERMISSION_PROMPTS_LINK = "Settings, Permission prompts";

/** The line for `missed`, before and after its link: the card it links to has the install commands. */
const MISSED_TEXT = "Its request is not held here, and the plugin may not be installed for it.";
const MISSED_SETTINGS = "has the commands that install it.";

/**
 * The longest problem sentence the hero gives whole, in characters: as long
 * as the line's own longest words, the ones for `missed` with their link. A
 * longer one is given whole in the details, and the hero links to Settings,
 * whose card gives it too.
 */
export const HERO_PROBLEM_MAX = `${MISSED_TEXT} ${PERMISSION_PROMPTS_LINK} ${MISSED_SETTINGS}`
  .length;

/**
 * What the line says: a sentence, then, where Settings, under Permission
 * prompts, has what it points to, the install commands or a problem sentence
 * too long for the hero, the link to Settings and what follows it.
 */
export interface NoAskLine {
  reason: NoAskReason;
  /** The sentence, or the words before the link. */
  text: string;
  /** What follows the link to Settings, or null for a line with no link. */
  settings: string | null;
}

/**
 * The line for a session, or null when it has none. `brief` is for the
 * hero: a problem sentence longer than `HERO_PROBLEM_MAX` is left to Settings.
 */
export function noAskLine(
  session: NoAskSession,
  facts: NoAskFacts,
  { brief = false }: { brief?: boolean } = {},
): NoAskLine | null {
  const reason = noAskReason(session, facts);
  if (reason === null) return null;
  const hold = durationInWords(facts.answering.holdMs);
  const line = (text: string, settings: string | null = null): NoAskLine => ({
    reason,
    text,
    settings,
  });
  switch (reason) {
    case "off":
      return line("AGENT_LOOKOUT_ANSWER is off, so answer it in the session.");
    case "unavailable": {
      const { problem } = facts.answering;
      if (problem === undefined) {
        return line(
          "Permission prompts cannot be answered from here, so answer it in the session.",
        );
      }
      if (!brief || problem.length <= HERO_PROBLEM_MAX) return line(problem);
      return line("Permission prompts cannot be answered from here.", "says why.");
    }
    case "ran-out":
      return line(`The hold of ${hold} on its request has run out, so answer it in the session.`);
    case "before-start":
      return line(
        "It was already waiting when Agent Lookout started, and its request is not held here, so answer it in the session.",
      );
    case "missed":
      return line(MISSED_TEXT, MISSED_SETTINGS);
    case "held-out":
      return line(
        `It has waited longer than the ${hold} a request is held, so answer it in the session.`,
      );
    case "not-held":
      return line("Its request is not held here, so answer it in the session.");
  }
}
