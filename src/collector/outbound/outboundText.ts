/** The longest a session's name, a folder's name or an agent's name may run in an email or a post. */
export const MOST_NAME_LENGTH = 80;

/**
 * Line breaks, every other control character, and the marks that reorder the
 * text around them. None has a place in a subject, a line of an email's body
 * or the one line of a post.
 */
const NOT_ON_ONE_LINE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Text from a session, made to stand on one line: what cannot sit on one line
 * becomes a space, runs of spaces become one, and it is cut to `most`
 * characters with an ellipsis. It is cut between code points, so no letter is
 * broken in two.
 */
export function oneLine(text: string, most = MOST_NAME_LENGTH): string {
  const flat = text.replace(NOT_ON_ONE_LINE, " ").replace(/\s+/g, " ").trim();
  const characters = Array.from(flat);
  if (characters.length <= most) return flat;
  return `${characters
    .slice(0, most - 1)
    .join("")
    .trimEnd()}…`;
}
