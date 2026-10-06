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
