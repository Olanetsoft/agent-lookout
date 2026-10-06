import type { SessionsSnapshot, SourceHealth, Surface } from "@core/sessions/session";
import type { CollectorPhase, ProblemKind } from "@dashboard/lib/api/collectorStore";
import { formatAgo, formatClock, sentenceStart } from "@dashboard/lib/format";
import { sourceNames } from "@dashboard/lib/sources/sources";
import { SOURCE_STATE_LABEL } from "@dashboard/lib/sessions/status";

/** How one source reads in the Sources view: its name and its state in words. */
export interface SourceLine {
  key: string;
  name: string;
  state: string;
}

/** What a source was doing when the page last heard from it. */
const LAST_KNOWN_LABEL: Record<SourceHealth["state"], string> = {
  ok: "Last known: watching",
  searching: "Last known: searching",
  unavailable: "Last known: not found",
  "not-set-up": "Last known: not set up",
  error: "Last known: not working",
};

/** A state the page does not know is read as a problem, never as healthy. */
function knownState(state: SourceHealth["state"]): SourceHealth["state"] {
  return Object.hasOwn(SOURCE_STATE_LABEL, state) ? state : "error";
}

/**
 * How one source reads in the Sources view. While answers arrive it is the
 * source's own state. Once they stop, the state is only what was last heard, and
 * the words say so, so a source never reads as healthy under a notice that
 * updates have stopped.
 */
export function sourceLine(
  source: Pick<SourceHealth, "id" | "label" | "state">,
  stalled: boolean,
): SourceLine {
  const state = knownState(source.state);
  return {
    key: source.id,
    name: source.label,
    state: stalled ? LAST_KNOWN_LABEL[state] : SOURCE_STATE_LABEL[state],
  };
}

/** Which sentence the header's status line is. */
export type StatusKey =
  | "watching"
  | "none-running"
  | "searching"
  | "not-found"
  | "not-working"
  | "no-sources"
  | "connecting"
  | "not-connected"
  | "not-updating";

export interface StatusSentence {
  key: StatusKey;
  /** What is being watched, or why nothing is, as one plain sentence. */
  text: string;
  /** The same, cut to a few words for a narrow window: "8 sessions", "Not updating". */
  short: string;
  /**
   * The machine fact beside it, set in mono: "checked 2s ago" while answers
   * arrive, or the fixed clock time of the last answer once they stop. A
   * `ticking` fact changes every second, so it is shown but never announced.
   */
  fact: { text: string; ticking: boolean } | null;
}

/**
 * How each app reads inside a sentence, in the order a sentence names them. A
 * terminal session can run in any terminal, so it is "a terminal", not the app
 * of that name.
 */
const SURFACE_IN_SENTENCE: readonly [Surface, string][] = [
  ["vscode", "VS Code"],
  ["desktop", "the desktop app"],
  ["terminal", "a terminal"],
  ["cloud", "the cloud"],
  ["browser", "a browser"],
  ["unknown", "another app"],
];

/** "A", "A and B", "A, B and C". */
function listOf(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * "VS Code, the desktop app and a terminal": the apps the sessions run in. An
 * app that is not known is named only beside one that is, "a terminal and
 * another app". Alone it says nothing, so no app is named.
 */
export function appsIn(sessions: readonly { surface: Surface }[]): string {
  const present = new Set(sessions.map((session) => session.surface));
  if (present.size === 1 && present.has("unknown")) return "";
  return listOf(SURFACE_IN_SENTENCE.filter(([surface]) => present.has(surface)).map(([, w]) => w));
}

function sourcesIn(sources: readonly SourceHealth[], state: SourceHealth["state"]): SourceHealth[] {
  return sources.filter((source) => knownState(source.state) === state);
}

/**
 * The status line in the header: what is being watched and when it was last
 * checked, in one plain sentence. Every phase of the connection and every state
 * of a source has its own sentence, so the line never says less than it knows.
 *
 * Once answers stop, the sentence says so, and names no source at all: a source
 * that was healthy at the last answer is not known to be healthy now.
 *
 * A tool that is not on this computer is named only when no tool is found, so
 * someone who uses one tool reads the same line as if only that one were watched.
 * A source that is not set up, such as a folder of status files nobody has
 * made, is never named: it is not being watched.
 *
 * Each sentence also has a short form, for a window too narrow for the whole
 * line. It keeps the count and the fact beside it, and drops the names.
 */
export function statusSentence(
  phase: CollectorPhase,
  snapshot: Pick<SessionsSnapshot, "sources" | "sessions"> | null,
  now: number,
  lastOkAt: number | null = null,
): StatusSentence {
  if (phase === "connecting") {
    return {
      key: "connecting",
      text: "Connecting to the local server",
      short: "Connecting",
      fact: null,
    };
  }
  if (phase === "unreachable") {
    return {
      key: "not-connected",
      text: "Not connected to the local server",
      short: "Not connected",
      fact: null,
    };
  }
  if (phase === "stalled") {
    return {
      key: "not-updating",
      text: "Not updating",
      short: "Not updating",
      fact: lastOkAt === null ? null : { text: `since ${formatClock(lastOkAt)}`, ticking: false },
    };
  }

  const sources = (snapshot?.sources ?? []).filter((source) => source.state !== "not-set-up");
  const sessions = snapshot?.sessions ?? [];
  if (sources.length === 0) {
    return {
      key: "no-sources",
      text: "Not watching any agent tool",
      short: "Not watching",
      fact: null,
    };
  }

  const checkedAt = Math.max(...sources.map((source) => source.checkedAt));
  const fact = { text: `checked ${formatAgo(now - checkedAt)}`, ticking: true };

  if (sessions.length > 0) {
    const count = `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`;
    // With one tool the sentence names the apps the sessions run in. With more,
    // it names the tools instead, since which tools are watched matters more
    // than where, and the line has room for only one list.
    const watched = sourcesIn(sources, "ok");
    const apps = appsIn(sessions);
    const where = watched.length > 1 ? ` from ${sourceNames(watched)}` : apps ? ` in ${apps}` : "";
    return {
      key: "watching",
      text: `Watching ${count}${where}`,
      short: count,
      fact,
    };
  }

  const searching = sourcesIn(sources, "searching");
  if (searching.length > 0) {
    return {
      key: "searching",
      text: `Looking for ${sourceNames(searching)} sessions`,
      short: "Looking for sessions",
      fact,
    };
  }
  const ok = sourcesIn(sources, "ok");
  if (ok.length > 0) {
    return {
      key: "none-running",
      text: `Watching ${sourceNames(ok)}, no sessions running`,
      short: "No sessions",
      fact,
    };
  }
  // The short forms use the words the Sources view puts beside each source.
  const broken = sourcesIn(sources, "error");
  if (broken.length > 0) {
    return {
      key: "not-working",
      text: `${sentenceStart(sourceNames(broken))} could not be read`,
      short: broken.length === 1 ? "Source not working" : "Sources not working",
      fact,
    };
  }
  const missing = sourcesIn(sources, "unavailable");
  return {
    key: "not-found",
    text: `${sentenceStart(sourceNames(missing))} ${missing.length === 1 ? "was" : "were"} not found`,
    short: missing.length === 1 ? "Source not found" : "Sources not found",
    fact,
  };
}

/**
 * The title of the notice when the page has never had an answer. Each kind of
 * failure has its own, so the title never contradicts the detail under it:
 * nothing answered, the server answered with an error, or something answered
 * that is not Agent Lookout's data.
 */
export function problemTitle(kind: ProblemKind | null): string {
  switch (kind) {
    case "error-status":
      return "Agent Lookout answered with an error";
    case "not-data":
      return "The answer was not session data";
    default:
      return "Agent Lookout is not answering";
  }
}
