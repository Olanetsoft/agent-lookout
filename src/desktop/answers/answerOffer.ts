// What the Mac app shows of a permission request Agent Lookout holds, and
// whether it offers Allow: in a notification, and in the menu bar's menu.
//
// The dashboard's rule holds here, and the app only ever makes it tighter:
// Allow is offered only when the collector offers it, never for an edit, a
// plan or a question, and only when the whole of what it would allow is
// shown here as it is written. A notification and a menu hold less than the
// page, in a font where two spaces are hard to tell from one, so:
//
// - A notification offers Allow only for one Bash command with no other
//   input, as its whole text: one line of at most 80 characters, with no tab,
//   no two spaces in a row, no space at either end and no space but the plain
//   one, and only while its title, subtitle and text come to 256 bytes or
//   less, which is all macOS is sure to keep. Apple says nothing of how much
//   of a banner it draws, so the length is a guess kept short.
// - The menu offers Allow only when each line of the command, and each other
//   input as `name: value` on a line of its own, is at most 80 characters,
//   with no tab, no two spaces in a row, no space at either end and no space
//   but the plain one, in 20 lines at most, and only when each would be drawn
//   as written. A menu's labels pass through Chromium on their way to macOS,
//   which takes a single `&` out, takes `(&x)` out whole, and draws `...` as
//   `…` (`fixUpWindowsStyleLabel`). An `&` written `&&` is drawn as one, so
//   each is doubled, and a line that would still not be drawn as written,
//   with `...` or `(&)` in it, offers Deny only.
//
// Deny is always offered, with a line saying why Allow is not, and where to
// see the whole of it. It is pure, so it is tested in plain Node.

import { askHeading } from "../../core/answers/askWords.ts";
import type { Notice } from "../../core/notices/waiting.ts";
import {
  EDIT_TOOLS,
  NOT_YES_OR_NO_TOOLS,
  type AnswerDecision,
  type PermissionAsk,
} from "../../core/sessions/session.ts";
import { MAX_NOTICE_TEXT_LENGTH, oneLine } from "../../core/text.ts";

/** The longest command a notification offers Allow for, in characters. */
export const MAX_NOTICE_COMMAND_CHARS = 80;

/** The most a notification's title, subtitle and text may hold, in UTF-8 bytes, for Allow. */
export const MAX_NOTICE_BYTES = 256;

/** The longest line the menu offers Allow for, in characters. */
export const MAX_MENU_LINE_CHARS = 80;

/** The most lines the menu shows of a request, and offers Allow for. */
export const MAX_MENU_LINES = 20;

/** What the app needs of a held request. */
export type OfferedAsk = Pick<
  PermissionAsk,
  "requestId" | "tool" | "command" | "inputs" | "allow" | "denyOnly" | "subagent"
>;

/** What each button says. */
export const DECISION_LABEL: Record<AnswerDecision, string> = { deny: "Deny", allow: "Allow" };

/**
 * A menu label as macOS draws it from Electron: Chromium's
 * `FixUpWindowsStyleLabel`, which every label and sublabel passes through. A
 * single `&` is dropped and `&&` drawn as one, `(&` with any one character
 * and `)` is dropped whole, and `...` is drawn as an ellipsis. It works on
 * UTF-16 code units, as Chromium does.
 */
export function fixUpWindowsStyleLabel(label: string): string {
  let drawn = "";
  const length = label.length;
  for (let index = 0; index < length; index += 1) {
    const character = label.charAt(index);
    if (
      character === "(" &&
      index + 3 < length &&
      label.charAt(index + 1) === "&" &&
      label.charAt(index + 3) === ")"
    ) {
      index += 3;
    } else if (character === "&") {
      if (index + 1 < length && label.charAt(index + 1) === "&") {
        drawn += character;
        index += 1;
      }
    } else if (
      character === "." &&
      index + 2 < length &&
      label.charAt(index + 1) === "." &&
      label.charAt(index + 2) === "."
    ) {
      drawn += "…";
      index += 2;
    } else {
      drawn += character;
    }
  }
  return drawn;
}

/** Text as a menu label, each `&` doubled so it is drawn. Other changes macOS makes are left. */
export function menuText(text: string): string {
  return text.replaceAll("&", "&&");
}

/** The label that macOS draws as exactly this text, or null when there is none. */
export function menuLabel(text: string): string | null {
  const label = menuText(text);
  return fixUpWindowsStyleLabel(label) === text ? label : null;
}

/** Whether the collector offers Allow, for a tool the app would ever offer it for. */
function offersAllow(ask: OfferedAsk): boolean {
  return ask.allow && !EDIT_TOOLS.includes(ask.tool) && !NOT_YES_OR_NO_TOOLS.includes(ask.tool);
}

/**
 * Why only Deny is offered here, in one short sentence: the collector's
 * reason, or, for one the page offers Allow for, that it is shown whole there.
 */
export function denyOnlyHere(ask: OfferedAsk): string {
  if (offersAllow(ask)) return "To allow it, open Agent Lookout, which shows it whole.";
  switch (ask.denyOnly) {
    case "edit":
      return "Allow is not offered for a change to a file. Answer in the session to allow it.";
    case "not-yes-or-no":
      return "It takes more than yes or no, so only Deny is offered here.";
    case "too-long":
      return "It is too long to show whole, so only Deny is offered.";
    case "hidden-characters":
      return "It holds characters that cannot be shown, so only Deny is offered.";
    case "right-to-left":
      return "It holds right-to-left letters, so only Deny is offered.";
    case "blank-lines":
      return "It has blank lines that could hide what follows, so only Deny is offered.";
    case undefined:
      return "Only Deny is offered for it.";
  }
}

/** A line of text as Allow needs it: one plain space between words, and none at either end. */
function plainLine(text: string, max: number): boolean {
  return (
    text !== "" &&
    text.trim() === text &&
    !/[^\S ]/.test(text) &&
    !text.includes("  ") &&
    Array.from(text).length <= max
  );
}

const encoder = new TextEncoder();

function bytes(text: string): number {
  return encoder.encode(text).length;
}

/** What a notification shows, and the buttons it has, Deny first. */
export interface NoticeOffer {
  title: string;
  subtitle?: string;
  body: string;
  /** What each button answers, in order. None for a notification of no held request. */
  decisions: AnswerDecision[];
}

/** What the request asks, cut to one line, for a notification that does not offer Allow. */
function preview(ask: OfferedAsk): string {
  if (ask.command !== undefined) return ask.command;
  const first = ask.inputs?.[0];
  return first === undefined ? ask.tool : `${first.name}: ${first.value}`;
}

/** Whether a notification shows the whole of a request as its text, with room for its title. */
function noticeShowsWhole(
  title: string,
  subtitle: string,
  ask: OfferedAsk,
): ask is OfferedAsk & {
  command: string;
} {
  const { command } = ask;
  if (!offersAllow(ask) || ask.tool !== "Bash" || command === undefined) return false;
  if (ask.inputs !== undefined && ask.inputs.length > 0) return false;
  if (!plainLine(command, MAX_NOTICE_COMMAND_CHARS)) return false;
  return bytes(title) + bytes(subtitle) + bytes(command) <= MAX_NOTICE_BYTES;
}

/**
 * The notification for a notice: as it is, with no buttons, when no request
 * is held for it. For a held request, the title is the session's, the
 * subtitle says what it asks, "Asks to run", and the text is the whole
 * command, with Deny and Allow, when it fits as written; otherwise the text
 * says why only Deny is offered and where to see it whole, then the start of
 * what it asks, cut to one line, with Deny alone.
 */
export function noticeOffer(notice: Notice, ask?: OfferedAsk): NoticeOffer {
  const title = oneLine(notice.title);
  if (ask === undefined) {
    return { title, body: oneLine(notice.body, MAX_NOTICE_TEXT_LENGTH), decisions: [] };
  }
  const subtitle = oneLine(askHeading(ask));
  if (noticeShowsWhole(title, subtitle, ask)) {
    return { title, subtitle, body: ask.command, decisions: ["deny", "allow"] };
  }
  const body = oneLine(`${denyOnlyHere(ask)} ${preview(ask)}`, MAX_NOTICE_TEXT_LENGTH);
  return { title, subtitle, body, decisions: ["deny"] };
}

/** What the menu shows of a held request, each a label as Electron is handed it. */
export interface MenuOffer {
  /** The line over it: "Asks to run". */
  heading: string;
  /** What it asks, a line each: whole, while Allow is offered. */
  lines: string[];
  /** Whether Allow is offered. Deny always is. */
  allow: boolean;
  /** Why Allow is not offered here, when it is not. */
  note: string | null;
}

/** The lines of a request: each of the command's, then each other input as `name: value`. */
function rowsOf(ask: OfferedAsk): { rows: string[]; inputsOnOneLine: boolean } {
  const inputs = ask.inputs ?? [];
  return {
    rows: [
      ...(ask.command === undefined ? [] : ask.command.split("\n")),
      ...inputs.map((input) => `${input.name}: ${input.value}`),
    ],
    inputsOnOneLine: inputs.every((input) => !input.value.includes("\n")),
  };
}

/**
 * The menu's part for a held request: the heading, then what it asks, a line
 * each, whole and as written while Allow is offered. Offering Deny only, each
 * line is cut to one of 80 characters, 20 at most, with a count of the rest,
 * and a note says why.
 */
export function menuOffer(ask: OfferedAsk): MenuOffer {
  const heading = askHeading(ask);
  const { rows, inputsOnOneLine } = rowsOf(ask);
  const labels = rows.map((row) => (plainLine(row, MAX_MENU_LINE_CHARS) ? menuLabel(row) : null));
  const headingLabel = menuLabel(heading);
  const whole: string[] = labels.filter((label): label is string => label !== null);
  if (
    offersAllow(ask) &&
    inputsOnOneLine &&
    rows.length <= MAX_MENU_LINES &&
    whole.length === rows.length &&
    headingLabel !== null
  ) {
    return { heading: headingLabel, lines: whole, allow: true, note: null };
  }
  const shown = rows
    .slice(0, MAX_MENU_LINES)
    .map((row) => menuText(oneLine(row, MAX_MENU_LINE_CHARS)));
  const more = rows.length - shown.length;
  return {
    heading: menuText(heading),
    lines: more > 0 ? [...shown, more === 1 ? "And 1 more line" : `And ${more} more lines`] : shown,
    allow: false,
    note: menuText(denyOnlyHere(ask)),
  };
}
