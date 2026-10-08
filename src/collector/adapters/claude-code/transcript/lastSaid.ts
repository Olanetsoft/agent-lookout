import { blocksOf, isRecord, linesOf, nonEmpty } from "./transcriptLines.ts";

/**
 * What a Claude Code session last said, worked out from the end of its
 * transcript. Pure: the bytes are read elsewhere (`transcriptFile.ts`), and
 * the text is made fit to show elsewhere (`messageText` in
 * `src/core/text.ts`).
 *
 * The transcript is undocumented, and `lastAsk.ts` has the notes on its
 * format. What is said is the `text` blocks of the session's own assistant
 * lines, and nothing else:
 *
 * - The newest assistant line with a `text` block that has anything in it
 *   names the message. The lines before it that share its `message.id` are
 *   part of it too, back to an assistant line of another message or a user
 *   line, and their `text` blocks are joined in the order they were written,
 *   with a blank line between. A line with no `message.id` is a message on
 *   its own.
 * - A subagent's line (`isSidechain: true`) is not the session's own: it is
 *   read past and never taken. Nor is a line marked `isMeta`.
 * - Thinking, tool uses, tool results, prompts, and Claude Code's own lines
 *   (`system`, `attachment`, `last-prompt` and a compacted summary) are never
 *   taken.
 * - A prompt the person typed after the reply does not hide the reply.
 * - When only the end of the transcript is read and the message runs back to
 *   its first line read, its start may be further back, so `startCut` says so.
 *
 * A line that does not parse is skipped, and a field of the wrong kind is no
 * field. When no line says anything, nothing is guessed, and nothing from an
 * earlier read is carried over.
 */

/**
 * Why there is no text: the whole transcript was read and the session has not
 * said anything yet, or only its end was read and it said nothing there.
 */
export type NothingSaid = "nothing-yet" | "too-far-back";

/**
 * What the session last said, or why there is nothing. `startCut` is there,
 * and true, when the start of the message may lie before the end that was read.
 */
export type LastSaid = { text: string; startCut?: true } | { text: null; reason: NothingSaid };

/** What goes between the parts of one message: a blank line. */
const PART_BREAK = "\n\n";

/** The `text` blocks with anything in them of a line of the session's own assistant reply. */
function textsOf(line: Record<string, unknown>): string[] {
  if (line.type !== "assistant" || line.isSidechain === true || line.isMeta === true) return [];
  const texts: string[] = [];
  for (const block of blocksOf(line)) {
    const text = block.type === "text" ? nonEmpty(block.text) : null;
    if (text !== null) texts.push(text);
  }
  return texts;
}

/** The `message.id` of a line, or null when it gives none. */
function messageIdOf(line: Record<string, unknown>): string | null {
  return isRecord(line.message) ? nonEmpty(line.message.id) : null;
}

/**
 * What the session last said, from the end of its transcript, as the text its
 * blocks hold, not yet made fit to show.
 *
 * `fromStart` says whether the tail is the whole file. When it is not, its
 * first line is a part of a longer one and is not read, and a tail with no
 * reply in it says the reply is further back, not that there is none.
 */
export function lastSaidInTail(tail: string, fromStart: boolean): LastSaid {
  const lines = linesOf(tail, fromStart);
  const newest = lines.findLastIndex((line) => textsOf(line).length > 0);
  if (newest === -1) return { text: null, reason: fromStart ? "nothing-yet" : "too-far-back" };

  const parts = [textsOf(lines[newest])];
  const messageId = messageIdOf(lines[newest]);
  if (messageId === null) return { text: parts[0].join(PART_BREAK) };
  let index = newest - 1;
  for (; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.isSidechain === true) continue;
    if (line.type === "user") break;
    if (line.type !== "assistant") continue;
    if (messageIdOf(line) !== messageId) break;
    parts.unshift(textsOf(line));
  }
  const text = parts.flat().join(PART_BREAK);
  // Nothing before the message stopped it, and the line dropped from the start
  // of the tail may be a part of it.
  return index < 0 && !fromStart ? { text, startCut: true } : { text };
}
