/**
 * The lines of the end of a Claude Code transcript, taken apart with the same
 * care by every reader of it: what the session is asking (`lastAsk.ts`) and
 * what it last said (`lastSaid.ts`). Pure: the bytes are read elsewhere
 * (`transcriptFile.ts`).
 *
 * The transcript is undocumented, and `lastAsk.ts` has the notes on its
 * format. A line that does not parse is skipped, and a field of the wrong kind
 * is no field.
 */

/** Whether a value is a JSON object: not null, and not a list. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value when it is text with anything on it, and null otherwise. */
export function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The blocks of a line's message, or none. */
export function blocksOf(line: Record<string, unknown>): Record<string, unknown>[] {
  const message = line.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

/**
 * The lines of a tail of the transcript, parsed. The first line is cut short
 * unless the tail is the whole file, so it is dropped then. A line that does
 * not parse as a JSON object is skipped.
 */
export function linesOf(tail: string, fromStart: boolean): Record<string, unknown>[] {
  const pieces = tail.split("\n");
  if (!fromStart) pieces.shift();
  const lines: Record<string, unknown>[] = [];
  for (const piece of pieces) {
    if (piece.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(piece);
      if (isRecord(value)) lines.push(value);
    } catch {
      // Not a line Agent Lookout can read. The next one may be.
    }
  }
  return lines;
}
