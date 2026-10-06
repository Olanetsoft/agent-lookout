import type { AskInput, DenyOnlyReason, PermissionAsk } from "../../core/sessions/session.ts";
import { oneLine } from "../../core/text.ts";

/**
 * What the dashboard shows of a permission request, and whether it offers
 * Allow. Pure: the request is read elsewhere (`hookSocket.ts`).
 *
 * The rule is that Allow is offered only when the whole of what it would
 * allow is on the screen. The one-line summary a notice uses, "Run: npm
 * test", is not enough to approve on: a command's second line can do
 * something else entirely.
 *
 * - Bash: the whole command, every line, and every other input it has, such
 *   as `run_in_background`, beside the agent's description of it.
 * - An edit, a new file or a notebook edit (`Edit`, `Write`, `MultiEdit`,
 *   `NotebookEdit`): its path, and Deny only, since the change itself is not
 *   shown.
 * - A plan to approve or a question to answer (`ExitPlanMode`,
 *   `AskUserQuestion`): Deny only, since they are answered with more than yes
 *   or no.
 * - Any other tool: its name and every input, in full.
 *
 * Deny is always offered. These offer Deny only too:
 *
 * - Anything longer than 4,000 characters, or 40 lines, in all, which is cut.
 * - Anything holding a character that cannot be shown as it is, such as a
 *   control character, a mark that reorders text, a character drawn as
 *   nothing, a private-use or unassigned one: each is shown as its code,
 *   `\u{202e}`, and the text is never shown as if it were the text that would
 *   run.
 * - A command holding right-to-left letters, such as Hebrew or Arabic, which
 *   can redraw the punctuation around them in another order than it runs in.
 * - Anything with more than two blank lines in a row, which could push what
 *   follows them out of sight under something harmless.
 */

/** The most characters of what a request asks that are shown, in all. */
export const MAX_SHOWN_CHARS = 4_000;

/** The most lines of what a request asks that Allow is offered for, in all. */
export const MAX_SHOWN_LINES = 40;

/** The most blank lines in a row that Allow is offered for. */
export const MAX_BLANK_RUN = 2;

/** The most inputs listed. A tool with more is cut, and offers Deny only. */
export const MAX_INPUTS = 30;

/** The longest tool name taken. A request with a longer one is not held. */
export const MAX_TOOL_NAME_CHARS = 200;

/** The longest description kept of a command, on one line. */
export const MAX_DESCRIPTION_CHARS = 200;

/** The tools that change a file. The change is not shown, so they offer Deny only. */
export const EDIT_TOOLS: readonly string[] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/** The tools answered with more than yes or no. */
export const NOT_YES_OR_NO_TOOLS: readonly string[] = ["ExitPlanMode", "AskUserQuestion"];

/** The inputs of an edit that are shown: where it would write. */
const EDIT_INPUTS = ["file_path", "notebook_path"];

/**
 * A character that cannot be shown as it is: a control character other than
 * a line break or a tab, a format character such as a zero-width space or a
 * mark that reorders text, a private-use, unassigned or lone surrogate code
 * point, any character drawn as nothing (variation selectors and the Hangul
 * fillers among them), and the line and paragraph separators.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu;

/** A letter of a script written right to left. */
const RIGHT_TO_LEFT =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Mende_Kikakui}\p{Script=Old_Hungarian}\p{Script=Kharoshthi}\p{Script=Phoenician}\p{Script=Imperial_Aramaic}\p{Script=Avestan}\p{Script=Old_South_Arabian}\p{Script=Old_North_Arabian}\p{Script=Nabataean}\p{Script=Palmyrene}\p{Script=Manichaean}\p{Script=Inscriptional_Pahlavi}\p{Script=Inscriptional_Parthian}\p{Script=Psalter_Pahlavi}\p{Script=Sogdian}\p{Script=Old_Sogdian}\p{Script=Elymaic}\p{Script=Lydian}\p{Script=Cypriot}]/u;

/** A run of more blank lines in a row than Allow is offered for. */
const BLANK_RUN = new RegExp(`\\n(?:[ \\t]*\\n){${MAX_BLANK_RUN + 1},}`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text with every character that cannot be shown written as its code, and whether there were any. */
export function visible(text: string): { text: string; hidden: boolean } {
  let hidden = false;
  const shown = text.replace(HIDDEN, (character) => {
    if (character === "\n" || character === "\t") return character;
    hidden = true;
    return `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`;
  });
  return { text: shown, hidden };
}

/** An input's value as text: a string as it is, anything else as indented JSON. */
function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  return JSON.stringify(value, null, 2) ?? String(value);
}

/** What a request is shown as, without Agent Lookout's own id and the end of its hold. */
export type ShownAsk = Omit<PermissionAsk, "requestId" | "until">;

/** Keeps a running count of what is shown, cutting what goes past the limit. */
function budget() {
  let left = MAX_SHOWN_CHARS;
  let lines = 0;
  let cut = false;
  let hidden = false;
  let blankRun = false;
  return {
    /** Takes a text to show. A name, drawn on a line of its own beside its value, adds no lines. */
    take(text: string, kind: "value" | "name" = "value"): string {
      const seen = visible(text);
      if (seen.hidden) hidden = true;
      if (BLANK_RUN.test(`\n${seen.text}\n`)) blankRun = true;
      if (kind === "value") lines += seen.text.split("\n").length;
      if (lines > MAX_SHOWN_LINES) cut = true;
      const characters = Array.from(seen.text);
      if (characters.length <= left) {
        left -= characters.length;
        return seen.text;
      }
      cut = true;
      const kept = characters.slice(0, Math.max(0, left)).join("");
      left = 0;
      return `${kept}…`;
    },
    markCut() {
      cut = true;
    },
    get cut() {
      return cut;
    },
    get hidden() {
      return hidden;
    },
    get blankRun() {
      return blankRun;
    },
  };
}

/** Each input as a name and its value, in the order given, cut to the limit. */
function inputsOf(
  input: Record<string, unknown>,
  keys: readonly string[],
  shown: ReturnType<typeof budget>,
): AskInput[] {
  const listed = keys.slice(0, MAX_INPUTS);
  if (keys.length > MAX_INPUTS) shown.markCut();
  return listed.map((key) => ({
    name: shown.take(key, "name"),
    value: shown.take(valueText(input[key])),
  }));
}

/**
 * What to show of a request, and whether Allow is offered, or null when the
 * request cannot be read: no tool name, or one too long, or an input that is
 * not an object.
 */
export function shownAsk(
  toolName: unknown,
  toolInput: unknown,
  agentId?: unknown,
): ShownAsk | null {
  if (typeof toolName !== "string") return null;
  const tool = toolName.trim();
  if (tool === "" || Array.from(tool).length > MAX_TOOL_NAME_CHARS) return null;
  if (visible(tool).hidden || /\s/.test(tool)) return null;
  const input = toolInput === undefined ? {} : toolInput;
  if (!isRecord(input)) return null;

  const shown = budget();
  const subagent = typeof agentId === "string" && agentId !== "" ? { subagent: true as const } : {};
  let denyOnly: DenyOnlyReason | undefined;
  let rightToLeft = false;
  let ask: ShownAsk;

  if (EDIT_TOOLS.includes(tool)) {
    const keys = EDIT_INPUTS.filter((key) => input[key] !== undefined);
    ask = { tool, inputs: inputsOf(input, keys, shown), allow: false };
    denyOnly = "edit";
  } else if (tool === "Bash" && typeof input.command === "string" && input.command.trim() !== "") {
    const command = shown.take(input.command);
    rightToLeft = RIGHT_TO_LEFT.test(input.command);
    const description =
      typeof input.description === "string"
        ? oneLine(input.description, MAX_DESCRIPTION_CHARS) || undefined
        : undefined;
    const rest = Object.keys(input).filter((key) => key !== "command" && key !== "description");
    const inputs = inputsOf(input, rest, shown);
    ask = {
      tool,
      command,
      ...(description !== undefined && { description }),
      ...(inputs.length > 0 && { inputs }),
      allow: false,
    };
  } else {
    ask = { tool, inputs: inputsOf(input, Object.keys(input), shown), allow: false };
    if (NOT_YES_OR_NO_TOOLS.includes(tool)) denyOnly = "not-yes-or-no";
  }

  denyOnly ??= shown.hidden
    ? "hidden-characters"
    : rightToLeft
      ? "right-to-left"
      : shown.blankRun
        ? "blank-lines"
        : shown.cut
          ? "too-long"
          : undefined;
  return denyOnly === undefined
    ? { ...ask, allow: true, ...subagent }
    : { ...ask, allow: false, denyOnly, ...subagent };
}
