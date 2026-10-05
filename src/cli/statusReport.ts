// What `agent-lookout status` prints, worked out from one answer of
// `/api/sessions`. Pure: the clock is passed in and nothing is read or written.
//
// The reasons and the format of a wait's length come from the core, as the
// dashboard's do, so a wait reads the same here as there.

import { formatDuration } from "../core/duration.ts";
import type { Session, SourceHealth, WaitingReason } from "../core/sessions/session.ts";
import { sessionTitle, waitingLabel } from "../core/sessions/waiting.ts";

/** The fields of a session the report reads. The rest of the answer is left alone. */
export type ReportedSession = Pick<
  Session,
  | "id"
  | "source"
  | "agent"
  | "name"
  | "project"
  | "status"
  | "waitingReason"
  | "statusSince"
  | "stale"
>;

/** The parts of an answer of `/api/sessions` the report reads. */
export interface ReportedSnapshot {
  sessions: readonly ReportedSession[];
  sources: readonly Pick<SourceHealth, "id" | "label" | "state">[];
}

/** A session that needs the person, as `--json` gives it. */
export interface WaitingSession {
  id: string;
  /** What the dashboard calls it, as the source gave it. Printed as text, it is made safe first. */
  name: string;
  /** The agent's own name, or its source's label: "Claude Code". */
  agent: string;
  reason: WaitingReason;
  /** When the wait began, in epoch milliseconds, or null when the source did not say. */
  waitingSince: number | null;
  /** How long it has waited, or null when the start of the wait is not known. */
  waitedMs: number | null;
}

/**
 * Each session is counted once, as the dashboard counts it: a stale session is
 * counted as stale and not as idle. Finished, failed and unknown sessions are
 * not counted here.
 */
export interface StatusReport {
  /**
   * Whether the numbers are a count. Until an agent has been read, or a session
   * found, nothing was counted, and a zero would claim what was never measured.
   */
  counted: boolean;
  /** Whether an agent is still being looked for, so a count is still to come. */
  searching: boolean;
  needsYou: number;
  working: number;
  idle: number;
  stale: number;
  /**
   * In the order the server sends them, which is the Needs you panel's: longest
   * wait first, and a wait whose start is not known after the others.
   */
  waiting: WaitingSession[];
}

const REASONS: readonly WaitingReason[] = ["permission", "question", "other"];

/** Shown in place of a length of time that is not known, as the dashboard shows it. */
export const NOT_KNOWN = "–";

/** The most columns a session's name takes in a line. A longer one is cut. */
export const MOST_NAME_COLUMNS = 40;

function reasonOf(session: ReportedSession): WaitingReason {
  const reason = session.waitingReason;
  return reason !== undefined && REASONS.includes(reason) ? reason : "other";
}

export function statusReport(snapshot: ReportedSnapshot, now: number): StatusReport {
  const report: StatusReport = {
    counted:
      snapshot.sessions.length > 0 || snapshot.sources.some((source) => source.state === "ok"),
    searching: snapshot.sources.some((source) => source.state === "searching"),
    needsYou: 0,
    working: 0,
    idle: 0,
    stale: 0,
    waiting: [],
  };
  const labels = new Map(snapshot.sources.map((source) => [source.id, source.label]));

  for (const session of snapshot.sessions) {
    switch (session.status) {
      case "needs-you": {
        report.needsYou += 1;
        const since = session.statusSince;
        report.waiting.push({
          id: session.id,
          name: sessionTitle(session),
          agent: session.agent ?? labels.get(session.source) ?? session.source,
          reason: reasonOf(session),
          waitingSince: since,
          waitedMs: since === null ? null : Math.max(0, now - since),
        });
        break;
      }
      case "working":
        report.working += 1;
        break;
      case "idle":
        if (session.stale) report.stale += 1;
        else report.idle += 1;
        break;
    }
  }

  return report;
}

/**
 * Terminal escape sequences: a control sequence (ESC [ or its one-byte form),
 * a string sequence such as a window title (ESC ], ESC P and the like, up to
 * its end), and any other ESC with the character after it.
 */
const ESCAPE_SEQUENCE =
  // eslint-disable-next-line no-control-regex
  /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?|(?:\u001b[\]PX^_]|[\u0090\u0098\u009d-\u009f])[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?|\u001b[ -/]*[0-~]?/g;

/**
 * Every other control character, line and paragraph separators, and the marks
 * that reorder the text around them.
 */
const NOT_ON_ONE_LINE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u061c\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Marks that join the character before them and take no column: accents, joiners, variation selectors. */
const NO_COLUMN = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

/** Characters a terminal draws two columns wide: emoji, and the wide letters of East Asian scripts. */
const TWO_COLUMNS =
  /^[\p{Emoji_Presentation}\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]$/u;

function columnsOf(character: string): number {
  if (NO_COLUMN.test(character)) return 0;
  return TWO_COLUMNS.test(character) ? 2 : 1;
}

/** How many columns a terminal gives a line of text, near enough to line up a table. */
export function columns(text: string): number {
  let total = 0;
  for (const character of text) total += columnsOf(character);
  return total;
}

/**
 * Text from a session, made safe to print: escape sequences are taken out, every
 * other control character becomes a space, runs of spaces become one, and it is
 * cut to `most` columns with an ellipsis. Nothing in a name can then move the
 * cursor, change colours, set a window title or break the line.
 */
export function terminalText(text: string, most = MOST_NAME_COLUMNS): string {
  const flat = text
    .replace(ESCAPE_SEQUENCE, "")
    .replace(NOT_ON_ONE_LINE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (columns(flat) <= most) return flat;
  let cut = "";
  let width = 0;
  for (const character of flat) {
    const next = columnsOf(character);
    if (width + next > most - 1) break;
    cut += character;
    width += next;
  }
  return `${cut.trimEnd()}…`;
}

function padded(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - columns(text)));
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The first line: "2 need you · 3 working · 2 idle", with stale only when there are any. */
export function countsLine(report: StatusReport): string {
  if (!report.counted) {
    return report.searching
      ? "Agent Lookout is still looking for agents on this computer"
      : "No agent tool could be read, so nothing could be counted";
  }
  const parts = [
    report.needsYou === 0 ? "Nothing needs you" : plural(report.needsYou, "needs you", "need you"),
    `${report.working} working`,
    `${report.idle} idle`,
  ];
  if (report.stale > 0) parts.push(`${report.stale} stale`);
  return parts.join(" · ");
}

/**
 * What a person reads: the counts, then a line for each session that needs
 * them with its name, the reason and how long it has waited, in columns.
 *
 * tmux shows the last line a status-line command prints, and reads `#` in it
 * as the start of its own formatting, such as `#[fg=red]` or `#{pane_title}`.
 * With `forTmux`, each `#` in a name is doubled, which tmux shows as one.
 */
export function statusText(report: StatusReport, forTmux = false): string {
  const rows = report.waiting.map((session) => {
    // A name made only of escape sequences leaves nothing, so the id stands in.
    const name = terminalText(session.name) || terminalText(session.id);
    return {
      name: forTmux ? name.replaceAll("#", "##") : name,
      reason: waitingLabel({ waitingReason: session.reason }),
      waited: session.waitedMs === null ? NOT_KNOWN : formatDuration(session.waitedMs),
    };
  });
  const nameWidth = Math.max(0, ...rows.map((row) => columns(row.name)));
  const reasonWidth = Math.max(0, ...rows.map((row) => columns(row.reason)));
  const lines = rows.map(
    (row) => `${padded(row.name, nameWidth)}  ${padded(row.reason, reasonWidth)}  ${row.waited}`,
  );
  return `${[countsLine(report), ...lines].join("\n")}\n`;
}

/** What `--count` prints: the number that need you, or a dash when nothing was counted. */
export function statusCount(report: StatusReport): string {
  return `${report.counted ? report.needsYou : NOT_KNOWN}\n`;
}

/**
 * Characters that JSON leaves as they are and a terminal may act on: DEL, the
 * one-byte control characters, line and paragraph separators and the marks
 * that reorder text. JSON already escapes the rest.
 */
const ESCAPED_IN_JSON = /[\u007f-\u009f\u061c\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * What `--json` prints. Names are given exactly as the source gave them, with
 * any character a terminal could act on written as a `\u` escape, so the JSON
 * reads back the same and printing it changes nothing on screen.
 */
export function statusJson(report: StatusReport): string {
  const { counted, needsYou, working, idle, stale, waiting } = report;
  const json = JSON.stringify({ counted, needsYou, working, idle, stale, waiting }, null, 2);
  return `${json.replace(
    ESCAPED_IN_JSON,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )}\n`;
}
