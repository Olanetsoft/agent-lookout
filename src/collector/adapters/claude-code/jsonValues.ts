/**
 * Takes JSON arrays and objects out of a command's stdout.
 *
 * `claude agents --json` prints one array, but it is not always alone on stdout:
 * shell wrappers and hooks from other tools print before or after it. So this
 * reads the complete JSON values in the text, in order, and the caller decides
 * which of them is the one it asked for.
 */

/**
 * How many bracketed runs to try to parse before giving up on noisy output. A
 * run that is not JSON costs a few microseconds, so this allows for a wrapper
 * that logs thousands of `[debug]` lines and still bounds the work.
 */
const MAX_CANDIDATES = 10_000;

/**
 * Terminal colour and cursor codes. Their `[` would be mistaken for the start of
 * an array. Inside real JSON the escape character is always written as `\u001b`,
 * so removing the raw form cannot damage a value.
 */
// eslint-disable-next-line no-control-regex
const TERMINAL_CODES = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/**
 * Returns the index just past the bracket that closes the value opening at
 * `start`, or -1 when the text ends first. Brackets inside strings do not count.
 */
function endOfValue(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/**
 * Yields every top-level bracketed run that parses as JSON, in the order they
 * appear.
 *
 * A run that closes but is not JSON, such as `[info]` in a log line, is stepped
 * over whole. A run that never closes ends the search: the output was cut off,
 * and whatever sits inside it is a fragment of a larger value, not the value.
 * Yielding a fragment would turn a truncated list into a shorter list.
 */
export function* jsonValuesIn(text: string): Generator<unknown, void, undefined> {
  const clean = text.replace(TERMINAL_CODES, "");
  let index = 0;
  let candidates = 0;

  while (index < clean.length && candidates < MAX_CANDIDATES) {
    const char = clean[index];
    if (char !== "[" && char !== "{") {
      index += 1;
      continue;
    }
    candidates += 1;

    const end = endOfValue(clean, index);
    if (end === -1) return;
    let value: unknown;
    let parsed = false;
    try {
      value = JSON.parse(clean.slice(index, end)) as unknown;
      parsed = true;
    } catch {
      // Not JSON. Step over it.
    }
    index = end;
    if (parsed) yield value;
  }
}
