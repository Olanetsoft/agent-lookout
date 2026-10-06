import {
  ACTION_HEADER,
  CLEAR_HISTORY_ACTION,
  type ClearHistoryFailure,
  type HistoryKept,
  type HistorySince,
} from "@core/api";
import { apiRequest } from "@dashboard/lib/api/apiHost";
import { clockAt } from "@dashboard/lib/format";

/**
 * The History card in Settings: where the history is kept, how much it holds
 * and since when, in its own words, and the request that clears it.
 */

/** A press is not left waiting on a server that has stopped answering. */
export const CLEAR_TIMEOUT_MS = 10_000;

/** What pressing Clear history came to. */
export type ClearOutcome =
  | { ok: true; at: number }
  | {
      ok: false;
      /** Why, as the app said, or `no-answer` when it did not answer with data. */
      reason: ClearHistoryFailure | "no-answer";
      /** The app's own sentence, when it gave one. */
      error: string | null;
    };

const FAILURES: readonly ClearHistoryFailure[] = ["memory-only", "not-writing", "failed"];

/** The longest sentence of the app's that is shown. Its own are far shorter. */
const MAX_ERROR_LENGTH = 300;

/**
 * Asks the app to clear the history: to delete the files it is kept in and to
 * empty the Events log and the history in memory. The request names nothing:
 * the files are the ones in the app's own folder. It never rejects.
 */
export async function requestClearHistory(
  timeoutMs: number = CLEAR_TIMEOUT_MS,
): Promise<ClearOutcome> {
  try {
    const response = await apiRequest("/api/history/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json", [ACTION_HEADER]: CLEAR_HISTORY_ACTION },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data: unknown = await response.json();
    const answer =
      typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    if (response.ok && answer.ok === true && typeof answer.clearedAt === "number") {
      return { ok: true, at: answer.clearedAt };
    }
    const error =
      typeof answer.error === "string" && answer.error.length <= MAX_ERROR_LENGTH
        ? answer.error
        : null;
    return {
      ok: false,
      reason: FAILURES.find((failure) => failure === answer.reason) ?? "failed",
      error,
    };
  } catch {
    return { ok: false, reason: "no-answer", error: null };
  }
}

const KB = 1024;
const MB = 1024 * 1024;

/** A size as the card says it: "312 KB", "1.4 MB", "20 MB". */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / KB))} KB`;
  const megabytes = (bytes / MB).toFixed(1).replace(/\.0$/, "");
  return `${megabytes} MB`;
}

/** A number of whole days: "8 days". */
export function formatDays(ms: number): string {
  const days = Math.round(ms / (24 * 60 * 60 * 1000));
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** What the History card says, before any button is pressed. */
export interface KeptHistoryWords {
  /** The first line: where it is kept. */
  state: string;
  /** The folder, the size and where the history begins, while it is kept on disk. */
  facts: { folder: string; holds: string; since: string } | null;
  /** While this copy is not writing the files: a title and the app's sentence. */
  note: { title: string; detail: string } | null;
  /** What it means, under the rest. */
  explanation: string[];
}

/**
 * The card's words from the app's answer. `since` is where the history held
 * begins, from the same answer.
 */
export function keptHistoryWords(
  kept: HistoryKept,
  since: HistorySince,
  now: number,
): KeptHistoryWords {
  const age = formatDays(kept.maxAgeMs);
  const cap = formatBytes(kept.maxBytes);
  if (kept.where === "memory" || kept.folder === null) {
    return {
      state: "History is kept in memory only.",
      facts: null,
      note: null,
      explanation: [
        "The Events log and the charts start empty each time Agent Lookout starts, because AGENT_LOOKOUT_HISTORY is set to off.",
        `Without it, they are kept on this computer for ${age}, so they are still there after a restart.`,
      ],
    };
  }
  return {
    // While this copy does not write the files, what it sees from now on is
    // kept in memory, whatever the files hold.
    state:
      kept.problem === null
        ? `History is kept on this computer for ${age}.`
        : "History is kept in memory for now.",
    facts: {
      folder: kept.folder,
      holds: kept.bytes === null ? "–" : `${formatBytes(kept.bytes)} of ${cap}`,
      since: clockAt(since.at, now),
    },
    note:
      kept.problem === null
        ? null
        : { title: "This copy is not writing history", detail: kept.problem },
    explanation: [
      kept.problem === null
        ? "The Events log and the counts behind the charts are written to this folder every few seconds, so they are still there when Agent Lookout starts again. It holds no prompt and nothing a waiting session is asking."
        : "The copy that writes the history writes the Events log and the counts behind the charts to this folder every few seconds, so they are still there when Agent Lookout starts again. It holds no prompt and nothing a waiting session is asking.",
      `A day's history is deleted ${age} after the day ends, and the oldest goes first once the files would hold more than ${cap}.`,
    ],
  };
}

/** What the card says after a press of Clear history that did not clear it. */
export function clearFailureWords(outcome: Extract<ClearOutcome, { ok: false }>): string {
  if (outcome.reason === "no-answer") {
    return "Agent Lookout did not answer. Try again in a moment.";
  }
  return outcome.error ?? "Agent Lookout could not clear it. Try again in a moment.";
}
