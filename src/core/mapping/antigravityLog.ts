// What an Antigravity CLI program's own log says: the folder it works in, the
// conversation it has open, and whether it waits for the person's approval of
// a tool. Pure.
//
// Each agy program writes a log of its own, `<agy folder>/log/cli-<start>.log`,
// named for the local time it started (docs/adapters/antigravity.md). Its lines
// are in the glog format: the level's letter, the month and day, the local
// time, a thread, the source file and line, `]` and the message. These
// messages are the only ones used, matched whole, by the message alone, since
// the source line moves between versions. Seen from agy 1.3.1:
//
//   Creating CLI server backend: product=antigravity workspaceDirs=[<folder>] …
//   Created conversation <id>
//   Streaming conversation <id>
//   Surfacing tool confirmation: "RunCommand" at step 2
//   Responding to tool confirmation: convID=<id>, stepIdx=2, approved=true, sandboxOverride=false, persistGrants=[]
//
// the last once the person answers, from another source file than the one
// that asks, and with more after `approved` that is passed over.
//
// Every other line is passed over, and nothing of one is kept.
//
// glog writes a message that holds newlines as it is, and agy's own output goes
// to the log too, so a line can be written to look like one of these. Each
// kind is taken only from the source file agy writes it from, the folder only
// from the first line that names it, and an approval only for the step just
// after the transcript's last (`waitsForApproval`), so such a line can at most
// show a wait that ends with the next step.

/** One line of a glog log: its level, month, day and local time, its source file, then the message. */
const GLOG_LINE =
  /^[IWEF](\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))? +\d+ ([\w.-]+):\d+\] (.*)$/;

/** The source file each kind of line comes from, as agy 1.3.1 logs them. */
const SOURCE = {
  backend: "server.go",
  created: "server.go",
  streaming: "conversation_manager.go",
  asking: "tool_confirmation_manager.go",
  answered: "input_loop.go",
} as const;

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

const OPENED = new RegExp(`^(Created|Streaming) conversation (${UUID})$`);

const BACKEND = /^Creating CLI server backend: (?:.* )?workspaceDirs=\[([^\]\s]+)\](?: |$)/;

/** A tool's name as agy logs it, `RunCommand`. Letters only, and short. */
const ASKING = /^Surfacing tool confirmation: "([A-Za-z]{1,64})" at step (\d{1,9})$/;

const ANSWERED = new RegExp(
  `^Responding to tool confirmation: convID=(${UUID}), stepIdx=(\\d{1,9}), approved=(?:true|false)(?:, .*)?$`,
);

/** An absolute path, on macOS and Linux or on Windows. */
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])/;

/** A control or formatting character, such as an escape or a mark that turns text right to left. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;

/** What one line says, of the few kinds used. */
export type AgyLogLine =
  | { kind: "folder"; folder: string }
  | { kind: "opened"; conversation: string }
  | { kind: "asking"; tool: string; step: number; at: AgyLogTime }
  | { kind: "answered"; conversation: string; step: number };

/** When a line was written, as the log has it: local time, with no year. */
export interface AgyLogTime {
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

/** What one line says, or null for a line of any other kind, or one that is not whole. */
export function readAgyLogLine(line: string): AgyLogLine | null {
  const glog = GLOG_LINE.exec(line);
  if (glog === null) return null;
  const source = glog[7];
  const message = glog[8];

  const opened = OPENED.exec(message);
  if (opened !== null) {
    const from = opened[1] === "Created" ? SOURCE.created : SOURCE.streaming;
    return source === from ? { kind: "opened", conversation: opened[2].toLowerCase() } : null;
  }

  if (source === SOURCE.backend) {
    const backend = BACKEND.exec(message);
    return backend !== null && ABSOLUTE.test(backend[1]) && !UNPRINTABLE.test(backend[1])
      ? { kind: "folder", folder: backend[1] }
      : null;
  }
  if (source === SOURCE.answered) {
    const answered = ANSWERED.exec(message);
    return answered === null
      ? null
      : { kind: "answered", conversation: answered[1].toLowerCase(), step: Number(answered[2]) };
  }
  if (source !== SOURCE.asking) return null;

  const asking = ASKING.exec(message);
  if (asking !== null) {
    const fraction = (glog[6] ?? "0").padEnd(3, "0").slice(0, 3);
    return {
      kind: "asking",
      tool: asking[1],
      step: Number(asking[2]),
      at: {
        month: Number(glog[1]),
        day: Number(glog[2]),
        hour: Number(glog[3]),
        minute: Number(glog[4]),
        second: Number(glog[5]),
        millisecond: Number(fraction),
      },
    };
  }

  return null;
}

/** An approval agy asks for and has not yet been answered. */
export interface AgyAsk {
  conversation: string;
  /** The step that waits for it, which the transcript does not hold yet. */
  step: number;
  /** The tool, as agy names it, such as `RunCommand`. */
  tool: string;
  /** When agy began to ask, as the log has it. */
  at: AgyLogTime;
}

/** What one program's log has said, read from its start. */
export interface AgyLogState {
  /**
   * The folder the program works in, from the first line that names it, which
   * agy writes as it starts. Null when that line has not been read, or named
   * several folders or one with a space, which cannot be told apart.
   */
  folder: string | null;
  /** Whether that line has been read, so no later line can name another. */
  folderNamed: boolean;
  /** Every conversation the program has opened, in lower case. */
  opened: Set<string>;
  /** The one it opened last, which it has open now. Null before it opens one. */
  current: string | null;
  /** The approval it waits for now, if any. */
  ask: AgyAsk | null;
}

export function emptyAgyLogState(): AgyLogState {
  return { folder: null, folderNamed: false, opened: new Set(), current: null, ask: null };
}

/**
 * Moves the state on by one line, read in the order agy wrote them.
 *
 * - An approval is asked for in the conversation the program has open.
 * - It is over once agy logs the answer to it, or when the program opens
 *   another conversation, which takes the prompt off the screen.
 * - The program asks for one approval at a time: a later one replaces it.
 */
export function addAgyLogLine(state: AgyLogState, line: AgyLogLine): void {
  switch (line.kind) {
    case "folder":
      if (!state.folderNamed) state.folder = line.folder;
      state.folderNamed = true;
      return;
    case "opened":
      state.opened.add(line.conversation);
      if (state.current !== line.conversation) state.ask = null;
      state.current = line.conversation;
      return;
    case "asking":
      state.ask =
        state.current === null
          ? null
          : { conversation: state.current, step: line.step, tool: line.tool, at: line.at };
      return;
    case "answered":
      if (state.ask?.conversation === line.conversation && state.ask.step === line.step) {
        state.ask = null;
      }
      return;
  }
}

/**
 * How far past the transcript's last step a step that waits for approval may
 * be. Seen in agy 1.3.1: the very next one.
 */
export const ASK_STEPS_AHEAD = 2;

/**
 * Whether a conversation waits for the person's approval: its program's log
 * says it asked and has had no answer, and the step that waits is just past
 * the transcript's last. agy was not seen to write that step while it waits,
 * so a step there means the wait is over, however it ended, and one asked for
 * far past the transcript's end is not taken for agy's.
 *
 * `lastIndex` is the `step_index` of the transcript's last step, null when it
 * holds none that could be read.
 */
export function waitsForApproval(
  ask: AgyAsk | null,
  conversation: string,
  lastIndex: number | null,
): boolean {
  if (ask === null || ask.conversation !== conversation || lastIndex === null) return false;
  return ask.step > lastIndex && ask.step <= lastIndex + ASK_STEPS_AHEAD;
}

/**
 * Epoch milliseconds of a log line's local time, in the year of `near`, or
 * the year before or after when that puts it closer, so a line written on 31
 * December and read on 1 January is placed right. Null for a date that does
 * not exist.
 */
export function agyLogTimeAt(time: AgyLogTime, near: number): number | null {
  const year = new Date(near).getFullYear();
  let best: number | null = null;
  for (const y of [year - 1, year, year + 1]) {
    const at = new Date(
      y,
      time.month - 1,
      time.day,
      time.hour,
      time.minute,
      time.second,
      time.millisecond,
    );
    if (at.getMonth() !== time.month - 1 || at.getDate() !== time.day) continue;
    const ms = at.getTime();
    if (best === null || Math.abs(ms - near) < Math.abs(best - near)) best = ms;
  }
  return best;
}
