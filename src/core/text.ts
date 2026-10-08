// The one rule for text that another program wrote, such as a session's name,
// a branch or a tmux session's name, before Agent Lookout shows it or sends it
// anywhere. Pure, so the collector, the `agent-lookout` command and the tests
// all use the same.

/**
 * The marks that make text run the other way: the Arabic letter mark, the
 * left-to-right and right-to-left marks, the embeddings and overrides, and the
 * isolates. None belongs in a name, and they can make one read as another, so
 * every rule here takes them out. Written as the inside of a character class.
 */
export const REORDERING_MARKS = "\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069";

/** Control characters and the marks that reorder text. */
const UNWANTED = new RegExp(`[\\p{Cc}${REORDERING_MARKS}]`, "gu");

/**
 * Line breaks, every other control character, line and paragraph separators,
 * and the marks that reorder the text around them. None has a place on one
 * line: a subject, a line of an email, a post or a notification.
 */
const NOT_ON_ONE_LINE = new RegExp(
  `[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029${REORDERING_MARKS}]`,
  "g",
);

/** The longest session name kept, in characters. A longer one is cut. */
export const MAX_NAME_LENGTH = 200;

/** The longest a name may run on one line, in an email, a post, a notification or a tmux place. */
export const MAX_LINE_LENGTH = 80;

/** The longest text kept of what a waiting session is asking, in characters. */
export const MAX_WAITING_TEXT_LENGTH = 200;

/**
 * The longest the text of a notification may run: the reason, and what the
 * session is asking after it, which a notification has room for on two lines.
 */
export const MAX_NOTICE_TEXT_LENGTH = 240;

/** The most kept of what a session last said, in characters: its end. */
export const MAX_MESSAGE_LENGTH = 2000;

/**
 * How far into what is kept of a long message a line break may be and still
 * be where it starts, in characters. Past that, it starts where it was cut.
 */
const MESSAGE_START_REACH = 200;

/** Control characters other than a line break, which `messageText` makes a space. */
const CONTROL_BUT_LINE_BREAK = /[^\P{Cc}\n]/gu;

/** The marks that reorder text, which `messageText` takes out. */
const REORDERING = new RegExp(`[${REORDERING_MARKS}]`, "gu");

/** The text with the unwanted characters made spaces, trimmed. Empty is none. */
export function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(UNWANTED, " ").trim();
  return text === "" ? undefined : text;
}

/** Clean text cut to `max` characters, never inside a character made of two code units. */
export function cut(value: unknown, max: number): string | undefined {
  const text = clean(value);
  if (text === undefined) return undefined;
  const characters = Array.from(text);
  return characters.length > max ? characters.slice(0, max).join("").trimEnd() : text;
}

/** Any text made fit to be a session's name: cleaned, and cut to 200 characters. Empty is none. */
export function sessionName(value: string): string | undefined {
  return cut(value, MAX_NAME_LENGTH);
}

/**
 * Any text made fit to say what a waiting session is asking: made to stand on
 * one line, which the page may still wrap onto two, and cut to 200 characters
 * with an ellipsis. Empty is none.
 */
export function waitingText(value: unknown): string | undefined {
  const text = clean(value);
  if (text === undefined) return undefined;
  return oneLine(text, MAX_WAITING_TEXT_LENGTH) || undefined;
}

/**
 * Text made to stand on one line: what cannot sit on one line becomes a space,
 * runs of spaces become one, and it is cut to `max` characters with an
 * ellipsis. It is cut between code points, so no letter is broken in two.
 */
export function oneLine(text: string, max = MAX_LINE_LENGTH): string {
  const flat = text.replace(NOT_ON_ONE_LINE, " ").replace(/\s+/g, " ").trim();
  const characters = Array.from(flat);
  if (characters.length <= max) return flat;
  return `${characters
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

/**
 * Any text made fit to show as what a session last said, kept on as many
 * lines as it was written on.
 *
 * - `\r\n`, `\r` and the line and paragraph separators become `\n`, a tab
 *   two spaces, and any other control character a space. The marks that
 *   reorder text are taken out.
 * - Spaces at the end of a line are trimmed, three or more line breaks in a
 *   row become two, and the whole is trimmed.
 * - Over 2,000 characters, the last 2,000 are kept and `cut` is true. When a
 *   line break falls within the first 200 of those, it starts after it, and
 *   what is kept is trimmed at its start too. It is cut between code points,
 *   so no letter is broken in two.
 *
 * Empty, or not text, is none.
 */
export function messageText(value: unknown): { text: string; cut: boolean } | undefined {
  if (typeof value !== "string") return undefined;
  const lines = value
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(/\t/g, "  ")
    .replace(CONTROL_BUT_LINE_BREAK, " ")
    .replace(REORDERING, "")
    .split("\n");
  // Each line is trimmed on its own, not by a pattern anchored at line ends,
  // which takes time that grows with the square of a long run of spaces.
  const text = lines
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text === "") return undefined;
  const characters = Array.from(text);
  if (characters.length <= MAX_MESSAGE_LENGTH) return { text, cut: false };
  const kept = characters.slice(-MAX_MESSAGE_LENGTH);
  const lineBreak = kept.indexOf("\n");
  const start = lineBreak !== -1 && lineBreak < MESSAGE_START_REACH ? lineBreak + 1 : 0;
  return { text: kept.slice(start).join("").trimStart(), cut: true };
}
