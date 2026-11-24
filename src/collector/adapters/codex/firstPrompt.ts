import { walkLine, type Token, type WantedKey } from "../muse-code/jsonWalker.ts";

/**
 * Whether a Codex session's name is its first prompt, whole or cut with `…`,
 * compared as bytes.
 *
 * From 0.170.0, when Codex's terminal app gets no title from its model, it
 * saves one made from the session's first prompt: the prompt trimmed, its first
 * 2,000 characters, the text and code that pulldown-cmark finds in them, pushed
 * with nothing between them but a space for each line break, rule and end of a
 * block, its whitespace collapsed, kept whole up to 60 characters, or cut to
 * 59, its end trimmed and `…` added, so that 58 or 59 characters come before
 * the `…` (codex-rs/tui/src/app/thread_title.rs:349-375 at rust-v0.171.0). Such
 * a name is passed over, and the session takes its folder's name.
 *
 * The prompt is the text of the first `event_msg` line that holds one: the
 * `message` of a `user_message`, which a legacy session writes, or the `text`
 * items of an `item_completed` whose `item` is a `UserMessage`, which a
 * paginated one writes (codex-rs/rollout/src/policy.rs:142-156,232-284), with a
 * space between items, as Codex joins them. Never the `response_item` copy
 * written before it. Of a prompt sent with an editor's context, only what
 * follows the last `## My request for Codex:` counts, trimmed, as for Codex's
 * title (codex-rs/tui/src/user_prompt.rs:44-53). A prompt of whitespace alone,
 * such as one of images alone, is passed for the next one, as Codex passes one
 * whose text trims to nothing (thread_title.rs:392-404).
 *
 * The prompt is trimmed and cut to its first 2,000 characters, counted by
 * their UTF-8 lead bytes, as Codex cuts it before it reads the Markdown. Each
 * line of it that opens or closes a fenced code block is left out, paired as CommonMark pairs them: an
 * opening fence is up to three spaces and then three or more backticks, with no
 * backtick in the rest of its line, or three or more tildes, and the closing
 * one is the same mark, at least as many of it, with only spaces or tabs after
 * them. A block that is never closed runs to the prompt's end. Codex keeps a
 * block's text but not its fences or its language, and the lines between are
 * kept. A line such as ```` ```npm test``` ```` is a code span, and kept. The
 * prompt's backslash escapes of ASCII punctuation are undone, as Codex undoes
 * them outside code.
 *
 * HTML's open and closing tags, comments, processing instructions, declarations
 * and CDATA sections, as CommonMark's grammar for raw HTML has them, are then
 * left out of the prompt and of the name, as Codex takes them out of all but
 * code, and again while that leaves out more, at most 16 times, since leaving
 * out one can make another: Codex saves `Arc<Mutex<T>>` as `Arc<Mutex>`. One in
 * code, which Codex keeps, is left out of both.
 *
 * The prompt and the name are then seen the same way, in the first of three
 * views in which the prompt is not empty. Each leaves out whitespace, Unicode's
 * `White_Space`, which Rust's `trim` and `split_whitespace` use. The first
 * keeps, of ASCII, only letters, and keeps the bytes of every character past
 * ASCII. The second keeps ASCII digits too, and the third every byte but
 * whitespace. So in a prompt with a letter or a character past ASCII, ASCII
 * punctuation, which holds every Markdown mark, and digits count for nothing: a
 * numbered list's number, which Markdown drops, or a number Codex joins onto a
 * word, as in "Handle `404`s", which it saves as "Handle 404s", makes no
 * difference. Codex runs pulldown-cmark with no options (`Parser::new`,
 * thread_title.rs:354), so it makes no curly quotes or dashes, and every view
 * keeps those. The name's end is trimmed. The name is passed over when it is
 * not empty in the view and is all of the prompt in it, or, when it ends with
 * `…`, the prompt's start once the `…` is taken off, byte for byte, case and
 * all. The prompt is also seen without the marker that can open each of its
 * lines as a list item's, after up to three spaces and before whitespace or the
 * line's end: up to nine digits and `.` or `)`, or `-`, `+` or `*`. Seen so, it
 * takes the first view in which it is then not empty, and the name is passed
 * over when it matches the prompt seen either way.
 *
 * Three such comparisons are made: of the two with their HTML left out; of the
 * name, whole and not as a cut, with its HTML kept, against the prompt with its
 * HTML left out, since joining code spans can make a tag Codex never saw, as in
 * "Fix `i<n` and `j>0` checks", saved as "Fix i<n and j>0 checks"; and, when
 * leaving HTML out leaves nothing of the prompt in any view, or nothing of the
 * name in the prompt's view, of the two with their HTML kept, as for "`<div>`",
 * saved as "<div>". One more compares the prompt with its escapes kept and the
 * name, whole or cut, each with its open and closing tags left out once, since
 * leaving them out again can join a `<` in text and a `>` after a tag in code
 * into one Codex never saw, as in "Fix it when i<n and `Vec<T>` len > 0",
 * saved as "Fix it when i<n and Vec<T> len > 0".
 *
 * A name that, trimmed, ends with `…` after 58 or 59 characters, as many as
 * Codex's cut leaves, counted by their UTF-8 lead bytes, is passed over when
 * what the first view keeps of it before the `…` is not empty and comes in
 * order, character by character, within what the first view keeps of the
 * prompt's 2,000 characters, as written or with their entities decoded, as
 * below. Almost all that Markdown changes takes text out, so the letters of a
 * title Codex cut come in order in its prompt whatever was taken out before
 * the cut. An entity, which Codex decodes, adds characters instead.
 *
 * Last, the same three comparisons are made with more copies of the prompt,
 * each with its fence lines left out: one with its escapes kept, as Codex keeps
 * them in code, and the rest with its escapes undone and changed as Codex
 * changes it, but only outside code, a code span, closed by the next run of as
 * many backticks, or a fenced block's text, which Codex keeps as written. One
 * has its entities decoded into the bytes of their characters: `&#` and up to
 * seven digits, `&#x` and up to six hex digits, or the name of one of HTML's
 * five, a space, a few quotes, dashes and marks or a Latin-1 letter, then `;`.
 * One leaves HTML blocks out as CommonMark starts and ends them: at a line's
 * start, after up to three spaces, `<script`, `<pre`, `<style` or `<textarea`
 * through the line that holds its closing tag, `<!--` through `-->`, `<?`
 * through `?>`, `<!` and a letter through `>`, `<![CDATA[` through `]]>`, `<` or
 * `</` and a block tag's name, and a line of one whole open or closing tag that
 * does not break into a paragraph, through the next blank line; and after a
 * block quote's or a list item's marker the rest of that line alone. One leaves
 * out links' and images' destinations and titles, `](` to `)`, the labels of
 * references to a definition the prompt holds, and the lines of its
 * definitions. One leaves out a fence that could open a block, and its
 * language, after any spaces and block quote or list item markers. One does all
 * of these. And one leaves out such a fence and its language in the text of a
 * fenced block whose fence is indented too, as in a list item, since Codex
 * closes that block where the item ends and can read a later line as a new
 * fence. Links and all of these are each left out once more, but only after a
 * `]` that pairs with a `[` before it, since Codex keeps what follows one that
 * does not.
 *
 * A false match shows the folder's name in place of a name you gave that is
 * your prompt; a missed one shows your prompt. So the rule leans to passing
 * over: a name that differs from the prompt only in what the view or a copy
 * leaves out is passed over too, such as the prompt without HTML that Codex
 * keeps as text, in code or written as entities, and so is a name of 58 or 59
 * characters and `…` whose letters come in order in the prompt. It is not
 * Codex's Markdown reader, and reads blocks a line at a time, so a name Codex
 * made can still be kept, for example:
 *
 * - When it is not cut with `…` and Codex takes out text the view keeps from
 *   blocks nested in a way that reading does not follow, as an HTML block
 *   after a block quote's or a list item's marker that runs past its line.
 * - When that reading ends or joins a paragraph or a code block where Codex
 *   does not, as at a setext heading's `===` before a definition or a lone
 *   tag, a `>` line after a `<`, or a list item's fence followed by a line
 *   that is not indented, so that the text Codex keeps differs from what is
 *   compared here, cut with `…` or not.
 * - When it holds a letter or a character past ASCII that Codex decoded from an
 *   entity not decoded here, such as `&hearts;`, or, in a prompt of marks
 *   alone, when Codex takes out its marks, as a code span's backticks or a
 *   block quote's `>`.
 * - When it is cut before anything of the prompt the view keeps, since it is
 *   empty in the view once its `…` is taken off.
 *
 * Only the lines given are looked at. When the prompt's line is not whole in
 * them, there is no verdict. The prompt's escapes and entities are undone into
 * bytes in memory, for the comparison alone, and dropped with it. Nothing of
 * the prompt is turned into text, kept or logged.
 */

const TAB = 0x09;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;
const EXCLAMATION_MARK = 0x21;
const DOUBLE_QUOTE = 0x22;
const NUMBER_SIGN = 0x23;
const AMPERSAND = 0x26;
const SINGLE_QUOTE = 0x27;
const OPENING_PARENTHESIS = 0x28;
const CLOSING_PARENTHESIS = 0x29;
const ASTERISK = 0x2a;
const PLUS = 0x2b;
const HYPHEN = 0x2d;
const FULL_STOP = 0x2e;
const SLASH = 0x2f;
const COLON = 0x3a;
const SEMICOLON = 0x3b;
const LESS_THAN = 0x3c;
const EQUALS = 0x3d;
const GREATER_THAN = 0x3e;
const QUESTION_MARK = 0x3f;
const OPENING_BRACKET = 0x5b;
const BACKSLASH = 0x5c;
const CLOSING_BRACKET = 0x5d;
const UNDERSCORE = 0x5f;
const BACKTICK = 0x60;
const LETTER_U = 0x75;
const LETTER_X = 0x78;
const TILDE = 0x7e;

/** Codex writes a line's `timestamp` first, then a paginated session's `ordinal`, then its `type` and `payload`. */
const LINE_START = Buffer.from('{"timestamp":"');

/** The bytes before a prompt event's own `type`. */
const EVENT = Buffer.from(',"type":"event_msg","payload":{"type":"');

/** How far into a line `EVENT` can begin: past the time, which Codex writes in 24 bytes, and an ordinal. */
const EVENT_WITHIN = 128;

/** The two events that hold a prompt, as their `type` and its closing quote. */
const PROMPT_EVENTS = [Buffer.from('user_message"'), Buffer.from('item_completed"')];

const EVENT_MSG = Buffer.from("event_msg");
const USER_MESSAGE = Buffer.from("user_message");
const ITEM_COMPLETED = Buffer.from("item_completed");
const USER_MESSAGE_ITEM = Buffer.from("UserMessage");
const TEXT = Buffer.from("text");

/** What follows an editor's context in a prompt the terminal app sends with it. */
const REQUEST_BEGIN = Buffer.from("## My request for Codex:");

const ELLIPSIS = Buffer.from("…");

/** What each short escape stands for. */
const SHORT_ESCAPES = new Map<number, number>(
  (
    [
      ['"', 0x22],
      ["\\", 0x5c],
      ["/", 0x2f],
      ["b", 0x08],
      ["f", 0x0c],
      ["n", 0x0a],
      ["r", 0x0d],
      ["t", 0x09],
    ] as const
  ).map(([letter, byte]) => [letter.charCodeAt(0), byte]),
);

const TYPE = 0;
const PAYLOAD_TYPE = 1;
const MESSAGE = 2;
const ITEM_TYPE = 3;
const PART_TYPE = 4;
const PART_TEXT = 5;
const PART_END = 6;

const wanted = (name: string, more: Omit<WantedKey, "key">): WantedKey => ({
  key: Buffer.from(name),
  ...more,
});

const WANTED: readonly WantedKey[] = [
  wanted("type", { leaf: TYPE }),
  wanted("payload", {
    children: [
      wanted("type", { leaf: PAYLOAD_TYPE }),
      wanted("message", { leaf: MESSAGE }),
      wanted("item", {
        children: [
          wanted("type", { leaf: ITEM_TYPE }),
          wanted("content", {
            elements: {
              keys: [wanted("type", { leaf: PART_TYPE }), wanted("text", { leaf: PART_TEXT })],
              leaf: PART_END,
            },
          }),
        ],
      }),
    ],
  }),
];

type StringToken = Extract<Token, { type: "string" }>;

function bytesAt(bytes: Buffer, at: number, word: Buffer): boolean {
  return (
    at >= 0 &&
    at + word.byteLength <= bytes.byteLength &&
    bytes.compare(word, 0, word.byteLength, at, at + word.byteLength) === 0
  );
}

/** Whether a string the walk gave is this word, with no escape in it. */
function isWord(line: Buffer, token: StringToken | null, word: Buffer): boolean {
  return (
    token !== null &&
    !token.escaped &&
    token.end - token.start === word.byteLength &&
    bytesAt(line, token.start, word)
  );
}

/** Whether a line begins as a `user_message` or an `item_completed` event does. Only such a line is walked. */
function mayHoldPrompt(line: Buffer): boolean {
  if (!bytesAt(line, 0, LINE_START)) return false;
  const at = line.subarray(0, EVENT_WITHIN + EVENT.byteLength).indexOf(EVENT);
  return at !== -1 && PROMPT_EVENTS.some((type) => bytesAt(line, at + EVENT.byteLength, type));
}

/** Where a prompt line's text is, in the order Codex joins it, or null when the line is not one. */
function promptStrings(line: Buffer): StringToken[] | null {
  if (!mayHoldPrompt(line)) return null;
  const strings: (StringToken | null)[] = [null, null, null, null];
  const parts: StringToken[] = [];
  let partType: StringToken | null = null;
  let partText: StringToken | null = null;
  const walked = walkLine(line, true, WANTED, (leaf, token) => {
    const string = token.type === "string" ? token : null;
    if (leaf === PART_TYPE) partType = string;
    else if (leaf === PART_TEXT) partText = string;
    else if (leaf === PART_END) {
      if (partText !== null && isWord(line, partType, TEXT)) parts.push(partText);
      partType = null;
      partText = null;
    } else strings[leaf] = string;
    return false;
  });
  if (walked !== "end" || !isWord(line, strings[TYPE] ?? null, EVENT_MSG)) return null;
  const payloadType = strings[PAYLOAD_TYPE] ?? null;
  const message = strings[MESSAGE] ?? null;
  if (isWord(line, payloadType, USER_MESSAGE)) return message === null ? null : [message];
  if (isWord(line, payloadType, ITEM_COMPLETED)) {
    return isWord(line, strings[ITEM_TYPE] ?? null, USER_MESSAGE_ITEM) ? parts : null;
  }
  return null;
}

function hexValue(byte: number): number {
  if (byte <= 0x39) return byte - 0x30;
  return (byte | 0x20) - 0x61 + 10;
}

/** The four hex digits at `at`, which the walk has checked, as a number. */
function hexAt(bytes: Buffer, at: number): number {
  let value = 0;
  for (let index = at; index < at + 4; index += 1) {
    value = value * 16 + hexValue(bytes[index] as number);
  }
  return value;
}

/** Writes a code point as UTF-8 at `at`, and gives how many bytes it took. */
function putUtf8(out: Buffer, at: number, code: number): number {
  if (code < 0x80) {
    out[at] = code;
    return 1;
  }
  if (code < 0x800) {
    out[at] = 0xc0 | (code >> 6);
    out[at + 1] = 0x80 | (code & 0x3f);
    return 2;
  }
  if (code < 0x10000) {
    out[at] = 0xe0 | (code >> 12);
    out[at + 1] = 0x80 | ((code >> 6) & 0x3f);
    out[at + 2] = 0x80 | (code & 0x3f);
    return 3;
  }
  out[at] = 0xf0 | (code >> 18);
  out[at + 1] = 0x80 | ((code >> 12) & 0x3f);
  out[at + 2] = 0x80 | ((code >> 6) & 0x3f);
  out[at + 3] = 0x80 | (code & 0x3f);
  return 4;
}

/**
 * A string's bytes, between its quotes, with its escapes undone, as UTF-8. A
 * `\u` escape of half a surrogate pair alone stands for U+FFFD. What is
 * undone is never longer than its escape, so the copy is never longer than
 * the string.
 */
function unescaped(line: Buffer, token: StringToken): Buffer {
  if (!token.escaped) return line.subarray(token.start, token.end);
  const out = Buffer.alloc(token.end - token.start);
  let length = 0;
  let at = token.start;
  while (at < token.end) {
    const byte = line[at] as number;
    if (byte !== BACKSLASH) {
      out[length] = byte;
      length += 1;
      at += 1;
      continue;
    }
    const next = line[at + 1] as number;
    if (next !== LETTER_U) {
      out[length] = SHORT_ESCAPES.get(next) as number;
      length += 1;
      at += 2;
      continue;
    }
    let code = hexAt(line, at + 2);
    at += 6;
    if (code >= 0xd800 && code <= 0xdbff && line[at] === BACKSLASH && line[at + 1] === LETTER_U) {
      const low = hexAt(line, at + 2);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        at += 6;
      }
    }
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    length += putUtf8(out, length, code);
  }
  return out.subarray(0, length);
}

/**
 * How many bytes the whitespace at `at` takes, or 0. Whitespace is Unicode's
 * `White_Space`, which Rust's `trim` and `split_whitespace` use, in UTF-8.
 */
function spaceAt(bytes: Buffer, at: number): number {
  const byte = bytes[at] as number;
  if (byte === SPACE || (byte >= 0x09 && byte <= 0x0d)) return 1;
  const second = bytes[at + 1];
  const third = bytes[at + 2];
  if (byte === 0xc2) return second === 0x85 || second === 0xa0 ? 2 : 0;
  if (byte === 0xe1) return second === 0x9a && third === 0x80 ? 3 : 0;
  if (byte === 0xe3) return second === 0x80 && third === 0x80 ? 3 : 0;
  if (byte !== 0xe2) return 0;
  if (second === 0x81) return third === 0x9f ? 3 : 0;
  if (second !== 0x80) return 0;
  return third <= 0x8a || third === 0xa8 || third === 0xa9 || third === 0xaf ? 3 : 0;
}

const isDigit = (byte: number) => byte >= 0x30 && byte <= 0x39;

/** Whether an ASCII byte is a letter: `| 0x20` makes a capital small. */
const isLetter = (byte: number) => (byte | 0x20) >= 0x61 && (byte | 0x20) <= 0x7a;

/** The views a prompt and a name are seen in, from the one that keeps least. */
const LETTERS = 0;
const LETTERS_AND_DIGITS = 1;
const ALL_BUT_WHITESPACE = 2;
const VIEWS = [LETTERS, LETTERS_AND_DIGITS, ALL_BUT_WHITESPACE] as const;
type View = (typeof VIEWS)[number];

/**
 * Whether a view keeps a byte that is not whitespace. Every view keeps ASCII
 * letters and the bytes of a character past ASCII.
 */
function keeps(view: View, byte: number): boolean {
  if (byte >= 0x80 || isLetter(byte)) return true;
  if (isDigit(byte)) return view !== LETTERS;
  return view === ALL_BUT_WHITESPACE;
}

/**
 * Bytes as a view sees them: whitespace, which is stepped over whole, and
 * whatever else the view does not keep, left out.
 */
function seenIn(view: View, bytes: Buffer): Buffer {
  const out = Buffer.alloc(bytes.byteLength);
  let length = 0;
  let at = 0;
  while (at < bytes.byteLength) {
    const space = spaceAt(bytes, at);
    if (space > 0) {
      at += space;
      continue;
    }
    const byte = bytes[at] as number;
    if (keeps(view, byte)) {
      out[length] = byte;
      length += 1;
    }
    at += 1;
  }
  return out.subarray(0, length);
}

/** Where bytes start once their leading whitespace is left off. */
function startOfText(bytes: Buffer): number {
  let at = 0;
  for (let width = spaceAt(bytes, at); width > 0; width = spaceAt(bytes, at)) at += width;
  return at;
}

/** Where bytes end once their trailing whitespace is left off. */
function endOfText(bytes: Buffer): number {
  let end = 0;
  let at = 0;
  while (at < bytes.byteLength) {
    const width = spaceAt(bytes, at);
    at += Math.max(width, 1);
    if (width === 0) end = at;
  }
  return end;
}

/** Bytes with the whitespace at their start and end left off, as Rust's `trim` leaves it. */
function trimmed(bytes: Buffer): Buffer {
  const start = startOfText(bytes);
  return bytes.subarray(start, Math.max(start, endOfText(bytes)));
}

/**
 * A prompt line's text: each part undone, cut to the request after an
 * editor's context and trimmed, as Codex trims it, and joined by a space.
 */
function promptOf(line: Buffer, strings: readonly StringToken[]): Buffer {
  const parts: Buffer[] = [];
  for (const [index, token] of strings.entries()) {
    let part = unescaped(line, token);
    const request = part.lastIndexOf(REQUEST_BEGIN);
    if (request !== -1) part = trimmed(part.subarray(request + REQUEST_BEGIN.byteLength));
    if (index > 0) parts.push(Buffer.from([SPACE]));
    parts.push(part);
  }
  return Buffer.concat(parts);
}

/** The byte at `at`, or -1 past the end. */
function byteAt(bytes: Buffer, at: number): number {
  return at < bytes.byteLength ? (bytes[at] as number) : -1;
}

const isLineEnding = (byte: number) => byte === NEWLINE || byte === CARRIAGE_RETURN;

/** Where the line that starts at `at` ends, before its line ending. */
function lineEnd(bytes: Buffer, at: number): number {
  let end = at;
  while (end < bytes.byteLength && !isLineEnding(bytes[end] as number)) end += 1;
  return end;
}

/** Where the line ending at `at`, `\n`, `\r\n` or `\r`, ends, or `at` at the end. */
function pastLineEnding(bytes: Buffer, at: number): number {
  if (at >= bytes.byteLength) return at;
  return bytes[at] === CARRIAGE_RETURN && byteAt(bytes, at + 1) === NEWLINE ? at + 2 : at + 1;
}

/**
 * Bytes with runs left out. `runAt` is asked at each byte, and told whether a
 * line starts there, and gives where a run that starts there ends, or `at`
 * when none does.
 */
function without(
  bytes: Buffer,
  runAt: (bytes: Buffer, at: number, lineStart: boolean) => number,
): Buffer {
  const out = Buffer.alloc(bytes.byteLength);
  let length = 0;
  let at = 0;
  let lineStart = true;
  while (at < bytes.byteLength) {
    const end = runAt(bytes, at, lineStart);
    if (end > at) {
      at = end;
      lineStart = false;
      continue;
    }
    const byte = bytes[at] as number;
    out[length] = byte;
    length += 1;
    at += 1;
    lineStart = isLineEnding(byte);
  }
  return out.subarray(0, length);
}

/** Where the up to three spaces a Markdown line can start with end. */
function pastIndent(bytes: Buffer, at: number): number {
  let end = at;
  while (end < at + 3 && byteAt(bytes, end) === SPACE) end += 1;
  return end;
}

/** A run of three or more backticks or tildes that can open or close a fenced code block. */
interface Fence {
  mark: number;
  length: number;
  /** Where the run ends. */
  end: number;
}

/** The fence that the line from `at` to `end` starts with, after up to three spaces, or null. */
function fenceOf(bytes: Buffer, at: number, end: number): Fence | null {
  const start = pastIndent(bytes, at);
  const mark = byteAt(bytes, start);
  if (mark !== BACKTICK && mark !== TILDE) return null;
  let after = start;
  while (after < end && bytes[after] === mark) after += 1;
  return after - start >= 3 ? { mark, length: after - start, end: after } : null;
}

/** Whether a line opens a fenced code block: a fence of tildes, or of backticks with none in the rest of the line. */
function opens(bytes: Buffer, fence: Fence, end: number): boolean {
  return fence.mark === TILDE || bytes.subarray(fence.end, end).indexOf(BACKTICK) === -1;
}

/** Whether a line closes the block `open` opened: the same mark, at least as many, then only spaces or tabs. */
function closes(bytes: Buffer, fence: Fence, end: number, open: Fence): boolean {
  if (fence.mark !== open.mark || fence.length < open.length) return false;
  for (let at = fence.end; at < end; at += 1) {
    if (bytes[at] !== SPACE && bytes[at] !== TAB) return false;
  }
  return true;
}

/** Whether an ASCII byte is punctuation, which CommonMark lets a backslash escape. */
const isPunctuation = (byte: number) =>
  (byte >= 0x21 && byte <= 0x2f) ||
  (byte >= 0x3a && byte <= 0x40) ||
  (byte >= 0x5b && byte <= 0x60) ||
  (byte >= 0x7b && byte <= 0x7e);

/** Bytes with each backslash that escapes ASCII punctuation left out, and what it escapes kept. */
function withoutEscapes(bytes: Buffer): Buffer {
  const out = Buffer.alloc(bytes.byteLength);
  let length = 0;
  for (let at = 0; at < bytes.byteLength; at += 1) {
    if (bytes[at] === BACKSLASH && isPunctuation(byteAt(bytes, at + 1))) at += 1;
    out[length] = bytes[at] as number;
    length += 1;
  }
  return out.subarray(0, length);
}

/**
 * Where the marker that can open a list item ends, when a line starts at `at`
 * with one: after up to three spaces, up to nine digits and `.` or `)`, or
 * `-`, `+` or `*`, then whitespace or the end.
 */
function listMarkerAt(bytes: Buffer, at: number, lineStart: boolean): number {
  if (!lineStart) return at;
  const marker = pastIndent(bytes, at);
  let end = marker;
  while (end < marker + 9 && isDigit(byteAt(bytes, end))) end += 1;
  const mark = byteAt(bytes, end);
  const ends =
    end > marker
      ? mark === FULL_STOP || mark === CLOSING_PARENTHESIS
      : mark === HYPHEN || mark === PLUS || mark === ASTERISK;
  if (!ends) return at;
  end += 1;
  return end === bytes.byteLength || spaceAt(bytes, end) > 0 ? end : at;
}

/** Where `needle` is first found from `from` on, or -1. */
type Find = (needle: Buffer, from: number) => number;

/**
 * A `Find` in `bytes` that remembers, for each needle, from where it was
 * found nowhere, so that no stretch is searched twice in vain: many openings
 * with no close cost one search, not one each.
 */
function finder(bytes: Buffer): Find {
  const noneFrom = new Map<Buffer, number>();
  return (needle, from) => {
    const limit = noneFrom.get(needle) ?? bytes.byteLength;
    if (from >= limit) return -1;
    const searched = bytes.subarray(0, Math.min(bytes.byteLength, limit + needle.byteLength - 1));
    const found = searched.indexOf(needle, from);
    if (found === -1) noneFrom.set(needle, from);
    return found;
  };
}

const DOUBLE_QUOTED = Buffer.from([DOUBLE_QUOTE]);
const SINGLE_QUOTED = Buffer.from([SINGLE_QUOTE]);
const COMMENT_START = Buffer.from("!--");
const COMMENT_END = Buffer.from("-->");
const PROCESSING_END = Buffer.from("?>");
const CDATA_START = Buffer.from("![CDATA[");
const CDATA_END = Buffer.from("]]>");
const DECLARATION_END = Buffer.from(">");

/** Where the spaces, tabs and up to one line ending that CommonMark lets a tag hold at `at` end. */
function tagSpaceEnd(bytes: Buffer, at: number): number {
  let end = at;
  let lineEnded = false;
  for (;;) {
    const byte = byteAt(bytes, end);
    if (byte === SPACE || byte === TAB) end += 1;
    else if (lineEnded || !isLineEnding(byte)) return end;
    else {
      end += byte === CARRIAGE_RETURN && byteAt(bytes, end + 1) === NEWLINE ? 2 : 1;
      lineEnded = true;
    }
  }
}

const isTagNameByte = (byte: number) => isLetter(byte) || isDigit(byte) || byte === HYPHEN;
const isAttributeStart = (byte: number) => isLetter(byte) || byte === UNDERSCORE || byte === COLON;
const isAttributeByte = (byte: number) =>
  isAttributeStart(byte) || isDigit(byte) || byte === FULL_STOP || byte === HYPHEN;

/** Bytes an unquoted attribute value cannot hold. */
const NOT_UNQUOTED = new Set([
  SPACE,
  TAB,
  NEWLINE,
  CARRIAGE_RETURN,
  DOUBLE_QUOTE,
  SINGLE_QUOTE,
  EQUALS,
  LESS_THAN,
  GREATER_THAN,
  BACKTICK,
]);

/** Where a name that starts at `at` ends, or `at` when none does. */
function nameEnd(
  bytes: Buffer,
  at: number,
  first: (byte: number) => boolean,
  rest: (byte: number) => boolean,
): number {
  if (!first(byteAt(bytes, at))) return at;
  let end = at + 1;
  while (rest(byteAt(bytes, end))) end += 1;
  return end;
}

/** Where an attribute's value, unquoted, in single quotes or in double quotes, that starts at `at` ends, or `at`. */
function valueEnd(bytes: Buffer, at: number, find: Find): number {
  const quote = byteAt(bytes, at);
  if (quote === DOUBLE_QUOTE || quote === SINGLE_QUOTE) {
    const close = find(quote === DOUBLE_QUOTE ? DOUBLE_QUOTED : SINGLE_QUOTED, at + 1);
    return close === -1 ? at : close + 1;
  }
  let end = at;
  while (end < bytes.byteLength && !NOT_UNQUOTED.has(bytes[end] as number)) end += 1;
  return end;
}

/** Where an attribute, a name and, optionally, `=` and a value, that starts at `at` ends, or `at`. */
function attributeEnd(bytes: Buffer, at: number, find: Find): number {
  const name = nameEnd(bytes, at, isAttributeStart, isAttributeByte);
  if (name === at) return at;
  const equals = tagSpaceEnd(bytes, name);
  if (byteAt(bytes, equals) !== EQUALS) return name;
  const value = tagSpaceEnd(bytes, equals + 1);
  const end = valueEnd(bytes, value, find);
  return end === value ? name : end;
}

/**
 * Where an HTML open or closing tag ends, when one starts at `at`, as
 * CommonMark's grammar for raw HTML has them: `<`, a tag name of an ASCII
 * letter and then letters, digits or `-`, attributes, an optional `/` and
 * `>`, or `</`, a tag name and `>`, each with the whitespace it allows.
 */
function tagAt(bytes: Buffer, at: number, find: Find): number {
  if (byteAt(bytes, at + 1) === SLASH) {
    const name = nameEnd(bytes, at + 2, isLetter, isTagNameByte);
    if (name === at + 2) return at;
    const close = tagSpaceEnd(bytes, name);
    return byteAt(bytes, close) === GREATER_THAN ? close + 1 : at;
  }
  let end = nameEnd(bytes, at + 1, isLetter, isTagNameByte);
  if (end === at + 1) return at;
  for (;;) {
    const space = tagSpaceEnd(bytes, end);
    const attribute = space > end ? attributeEnd(bytes, space, find) : space;
    if (attribute === space) {
      const close = byteAt(bytes, space) === SLASH ? space + 1 : space;
      return byteAt(bytes, close) === GREATER_THAN ? close + 1 : at;
    }
    end = attribute;
  }
}

/** Where `end`, found from `at` on, is passed, or `at` when it was not found. */
const pastFound = (at: number, found: number, end: Buffer) =>
  found === -1 ? at : found + end.byteLength;

/**
 * Where raw HTML ends, when it starts at `at`, as CommonMark's grammar has
 * it: an open or closing tag, a comment, `<!--` to the first `-->` after
 * `<!-`, a processing instruction, `<?` to `?>`, a declaration, `<!` and an
 * ASCII letter to `>`, or a CDATA section, `<![CDATA[` to `]]>`.
 */
function htmlAt(bytes: Buffer, at: number, find: Find): number {
  if (byteAt(bytes, at) !== LESS_THAN) return at;
  const next = byteAt(bytes, at + 1);
  if (next === QUESTION_MARK) return pastFound(at, find(PROCESSING_END, at + 2), PROCESSING_END);
  if (next !== EXCLAMATION_MARK) return tagAt(bytes, at, find);
  if (bytesAt(bytes, at + 1, COMMENT_START)) {
    return pastFound(at, find(COMMENT_END, at + 2), COMMENT_END);
  }
  if (bytesAt(bytes, at + 1, CDATA_START)) {
    return pastFound(at, find(CDATA_END, at + 1 + CDATA_START.byteLength), CDATA_END);
  }
  if (!isLetter(byteAt(bytes, at + 2))) return at;
  return pastFound(at, find(DECLARATION_END, at + 3), DECLARATION_END);
}

/**
 * Bytes with their open and closing tags left out once, with one `Find` for
 * them all, so that a tag that leaving one out makes is kept.
 */
function withoutTagsOnce(bytes: Buffer): Buffer {
  const find = finder(bytes);
  return without(bytes, (inside, at) => (inside[at] === LESS_THAN ? tagAt(inside, at, find) : at));
}

/** The most times HTML is left out, each time from what the last left. */
const MOST_HTML_PASSES = 16;

/** Bytes with their raw HTML left out, and again while that leaves out more, as `<Mutex>` once `<T>` is out of `<Mutex<T>>`. */
function withoutHtml(bytes: Buffer): Buffer {
  let out = bytes;
  for (let pass = 0; pass < MOST_HTML_PASSES; pass += 1) {
    const find = finder(out);
    const next = without(out, (inside, at) => htmlAt(inside, at, find));
    if (next.byteLength === out.byteLength) return out;
    out = next;
  }
  return out;
}

/** The first characters of the prompt Codex makes its title from (`thread_title.rs:351`). */
const EXCERPT_CHARACTERS = 2000;

/** The first 2,000 characters of UTF-8 bytes, as Codex takes them, counted by their lead bytes. */
function excerptOf(bytes: Buffer): Buffer {
  let count = 0;
  for (let at = 0; at < bytes.byteLength; at += 1) {
    if (((bytes[at] as number) & 0xc0) === 0x80) continue;
    if (count === EXCERPT_CHARACTERS) return bytes.subarray(0, at);
    count += 1;
  }
  return bytes;
}

/** Whether the line from `at` to `end` holds only spaces and tabs. */
function isBlank(bytes: Buffer, at: number, end: number): boolean {
  for (let index = at; index < end; index += 1) {
    if (bytes[index] !== SPACE && bytes[index] !== TAB) return false;
  }
  return true;
}

const isAlphanumeric = (byte: number) => isLetter(byte) || isDigit(byte);

/** Whether `word`, of small ASCII letters and digits, is at `at` in `bytes`, its letters in either case. */
function isWordAt(bytes: Buffer, at: number, word: Buffer): boolean {
  if (at + word.byteLength > bytes.byteLength) return false;
  for (let index = 0; index < word.byteLength; index += 1) {
    const byte = bytes[at + index] as number;
    if (!isAlphanumeric(byte) || (byte | 0x20) !== word[index]) return false;
  }
  return true;
}

/** The tags whose HTML block, of CommonMark's first type, ends at a line holding their closing tag. */
const RAW_TEXT_TAGS = ["pre", "style", "script", "textarea"].map(
  (name) => [Buffer.from(name), Buffer.from(`</${name}>`)] as const,
);

/** The tags that start an HTML block of CommonMark's sixth type, as pulldown-cmark lists them. */
const BLOCK_TAGS = (
  "address article aside base basefont blockquote body caption center col colgroup dd details " +
  "dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 " +
  "head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p " +
  "param search section summary table tbody td tfoot th thead title tr track ul"
)
  .split(" ")
  .map((name) => Buffer.from(name));

const BANG = Buffer.from("!");
const QUESTION = Buffer.from("?");

/**
 * What ends an HTML block of CommonMark's first five types that `line`, from
 * its `<`, starts: the closing tag of `<pre`, `<style`, `<script` or
 * `<textarea` before whitespace, `>` or the line's end, `-->` after `<!--`,
 * `?>` after `<?`, `]]>` after `<![CDATA[` and `>` after `<!` and a letter.
 * Null when it starts none.
 */
function rawHtmlEnd(line: Buffer): Buffer | null {
  for (const [name, closing] of RAW_TEXT_TAGS) {
    if (!isWordAt(line, 1, name)) continue;
    const after = byteAt(line, 1 + name.byteLength);
    if (
      after === -1 ||
      after === GREATER_THAN ||
      (after >= 0x09 && after <= 0x0d) ||
      after === SPACE
    ) {
      return closing;
    }
  }
  if (bytesAt(line, 1, COMMENT_START)) return COMMENT_END;
  if (bytesAt(line, 1, QUESTION)) return PROCESSING_END;
  if (bytesAt(line, 1, CDATA_START)) return CDATA_END;
  return bytesAt(line, 1, BANG) && isLetter(byteAt(line, 2)) ? DECLARATION_END : null;
}

/**
 * Whether `line`, from its `<`, starts an HTML block of CommonMark's sixth
 * type: `<` or `</`, one of its block tags' names in either case, then
 * whitespace, `>`, `/>` or the line's end.
 */
function startsBlockTag(line: Buffer): boolean {
  const name = byteAt(line, 1) === SLASH ? 2 : 1;
  let end = name;
  while (isAlphanumeric(byteAt(line, end))) end += 1;
  const known = BLOCK_TAGS.some(
    (tag) => tag.byteLength === end - name && isWordAt(line, name, tag),
  );
  const after = byteAt(line, end);
  return (
    known &&
    (after === -1 ||
      after === SPACE ||
      after === TAB ||
      after === GREATER_THAN ||
      (after === SLASH && byteAt(line, end + 1) === GREATER_THAN))
  );
}

/** Whether `line`, from its `<`, is one whole open or closing tag and then only spaces or tabs, CommonMark's seventh type. */
function isLoneTag(line: Buffer): boolean {
  const tag = tagAt(line, 0, finder(line));
  return tag > 0 && isBlank(line, tag, line.byteLength);
}

/** What ends an HTML block: a line that holds `line`, or, when it is null, a blank line. */
interface HtmlBlock {
  line: Buffer | null;
}

/**
 * The HTML block that the line from `at` to `end` starts, after up to three
 * spaces, or null. The seventh type cannot break into a paragraph.
 */
function htmlBlockAt(bytes: Buffer, at: number, end: number, paragraph: boolean): HtmlBlock | null {
  const start = pastIndent(bytes, at);
  if (start >= end || bytes[start] !== LESS_THAN) return null;
  const line = bytes.subarray(start, end);
  const raw = rawHtmlEnd(line);
  if (raw !== null) return { line: raw };
  return startsBlockTag(line) || (!paragraph && isLoneTag(line)) ? { line: null } : null;
}

/** Where spaces and tabs from `at` end. */
function pastSpaces(bytes: Buffer, at: number): number {
  let end = at;
  while (byteAt(bytes, end) === SPACE || byteAt(bytes, end) === TAB) end += 1;
  return end;
}

/** The most parentheses a link destination can open inside it, as pulldown-cmark allows. */
const MOST_NESTED_PARENTHESES = 5;

/**
 * Where a link destination that starts at `at` ends: `<` to `>`, on one line
 * and with no `<` between, or a run of bytes past space whose parentheses
 * are balanced. -1 when none does.
 */
function destinationEnd(bytes: Buffer, at: number): number {
  const pointed = byteAt(bytes, at) === LESS_THAN;
  let nested = 0;
  let end = pointed ? at + 1 : at;
  for (; end < bytes.byteLength; end += 1) {
    const byte = bytes[end] as number;
    if (byte === BACKSLASH && isPunctuation(byteAt(bytes, end + 1))) end += 1;
    else if (pointed) {
      if (byte === GREATER_THAN) return end + 1;
      if (byte === LESS_THAN || isLineEnding(byte)) return -1;
    } else if (byte <= SPACE) break;
    else if (byte === OPENING_PARENTHESIS) {
      if (nested > MOST_NESTED_PARENTHESES) return -1;
      nested += 1;
    } else if (byte === CLOSING_PARENTHESIS) {
      if (nested === 0) break;
      nested -= 1;
    }
  }
  return pointed || nested > 0 ? -1 : end;
}

/** Where a link title, in double or single quotes or in parentheses, that starts at `at` ends, on one line, or -1. */
function titleEnd(bytes: Buffer, at: number): number {
  const open = byteAt(bytes, at);
  if (open !== DOUBLE_QUOTE && open !== SINGLE_QUOTE && open !== OPENING_PARENTHESIS) return -1;
  const close = open === OPENING_PARENTHESIS ? CLOSING_PARENTHESIS : open;
  for (let end = at + 1; end < bytes.byteLength; end += 1) {
    const byte = bytes[end] as number;
    if (byte === close) return end + 1;
    if (isLineEnding(byte) || (open === OPENING_PARENTHESIS && byte === OPENING_PARENTHESIS))
      return -1;
    if (byte === BACKSLASH && isPunctuation(byteAt(bytes, end + 1))) end += 1;
  }
  return -1;
}

/** The most bytes a link label holds. */
const MOST_LABEL_BYTES = 999;

/**
 * Where a link label's closing `]` is, when its `[` is at `at`: at most 999
 * bytes, with no `[` that is not escaped and not whitespace alone. -1 when
 * none is.
 */
function labelEnd(bytes: Buffer, at: number): number {
  let text = false;
  for (let end = at + 1; end <= at + 1 + MOST_LABEL_BYTES && end < bytes.byteLength; end += 1) {
    const byte = bytes[end] as number;
    if (byte === CLOSING_BRACKET) return text ? end : -1;
    if (byte === OPENING_BRACKET) return -1;
    if (spaceAt(bytes, end) === 0) text = true;
    if (byte === BACKSLASH && isPunctuation(byteAt(bytes, end + 1))) end += 1;
  }
  return -1;
}

/**
 * A link label, from `at` to `end`, as CommonMark matches labels: ASCII
 * letters made small, each run of whitespace made one space, and trimmed.
 */
function labelKey(bytes: Buffer, at: number, end: number): Buffer {
  const out = Buffer.alloc(end - at);
  let length = 0;
  let spaced = false;
  let index = at;
  while (index < end) {
    const width = spaceAt(bytes, index);
    if (width > 0) {
      spaced = length > 0;
      index += width;
      continue;
    }
    if (spaced) {
      out[length] = SPACE;
      length += 1;
      spaced = false;
    }
    const byte = bytes[index] as number;
    out[length] = byte >= 0x41 && byte <= 0x5a ? byte | 0x20 : byte;
    length += 1;
    index += 1;
  }
  return out.subarray(0, length);
}

/**
 * The label of the link reference definition that the line from `at` to
 * `end` is, after up to three spaces: a label, `:`, a destination on the same
 * line and, after whitespace, an optional title, then only spaces or tabs.
 * Null when the line is none.
 */
function definitionLabel(bytes: Buffer, at: number, end: number): Buffer | null {
  const line = bytes.subarray(pastIndent(bytes, at), end);
  if (byteAt(line, 0) !== OPENING_BRACKET) return null;
  const label = labelEnd(line, 0);
  if (label === -1 || byteAt(line, label + 1) !== COLON) return null;
  const start = pastSpaces(line, label + 2);
  const destination = destinationEnd(line, start);
  if (destination === -1 || destination === start) return null;
  const space = pastSpaces(line, destination);
  const title = space > destination ? titleEnd(line, space) : -1;
  const rest = title === -1 ? space : pastSpaces(line, title);
  return rest === line.byteLength ? labelKey(line, 1, label) : null;
}

/** Where a line's text starts, past any spaces and block quote or list item markers, and which of those it passed. */
interface Inside {
  start: number;
  quoted: boolean;
  listed: boolean;
}

/** Where the text of the line that starts at `at` starts, past its markers. */
function inside(bytes: Buffer, at: number): Inside {
  const passed: Inside = { start: at, quoted: false, listed: false };
  for (;;) {
    passed.start = pastSpaces(bytes, passed.start);
    const marker = listMarkerAt(bytes, passed.start, true);
    if (byteAt(bytes, passed.start) === GREATER_THAN) {
      passed.start += 1;
      passed.quoted = true;
    } else if (marker > passed.start) {
      passed.start = marker;
      passed.listed = true;
    } else return passed;
  }
}

/**
 * Where the line from `at` to `end` is cut once a fence and its language are
 * left out of it: three or more backticks, with no backtick in the rest of
 * the line, or three or more tildes, at `start`, past the line's markers.
 * `end` when no fence starts there.
 */
function fenceInfoAt(bytes: Buffer, start: number, end: number): number {
  const fence = fenceOf(bytes, start, end);
  return fence !== null && opens(bytes, fence, end) ? start : end;
}

/** Whether the line from `at` to `end` is an ATX heading or a thematic break, either of which ends a paragraph. */
function standsAlone(bytes: Buffer, at: number, end: number): boolean {
  const start = pastIndent(bytes, at);
  const first = byteAt(bytes, start);
  if (first === NUMBER_SIGN) {
    let after = start;
    while (after < end && bytes[after] === NUMBER_SIGN) after += 1;
    return after - start <= 6 && (after === end || bytes[after] === SPACE || bytes[after] === TAB);
  }
  if (first !== ASTERISK && first !== HYPHEN && first !== UNDERSCORE) return false;
  let marks = 0;
  for (let index = start; index < end; index += 1) {
    if (bytes[index] === first) marks += 1;
    else if (bytes[index] !== SPACE && bytes[index] !== TAB) return false;
  }
  return marks >= 3;
}

/** What a copy of the prompt leaves out beyond its fence lines. */
interface Blocks {
  /** HTML blocks, as CommonMark starts and ends them, outside fenced code. */
  html?: boolean;
  /** Link reference definitions. */
  definitions?: boolean;
  /** A fence and its language after block quote or list item markers, or deeper than three spaces. */
  fenceInfo?: boolean;
  /**
   * The same, also in the text of a fenced block whose fence is indented, as
   * in a list item, whose end can close the block for Codex.
   */
  fenceInfoInCode?: boolean;
}

/**
 * A copy of the prompt's bytes, which of them are a fenced code block's text,
 * and the labels of the link reference definitions left out of it.
 */
interface Copy {
  bytes: Buffer;
  code: Uint8Array;
  labels: Buffer[];
}

/**
 * A copy of bytes with each line that opens or closes a fenced code block
 * left out, its line ending kept, paired as CommonMark pairs them, and, as
 * `blocks` says, more. The lines between are kept, marked as code, and a
 * block that is never closed runs to the end.
 */
function blockCopy(bytes: Buffer, blocks: Blocks): Copy {
  const out = Buffer.alloc(bytes.byteLength);
  const code = new Uint8Array(bytes.byteLength);
  let length = 0;
  let open: Fence | null = null;
  let openIndented = false;
  let html: HtmlBlock | null = null;
  let paragraph = false;
  const labels: Buffer[] = [];
  let at = 0;
  while (at < bytes.byteLength) {
    const end = lineEnd(bytes, at);
    const blank = isBlank(bytes, at, end);
    let empty = blank;
    const fence = fenceOf(bytes, at, end);
    let kept = end;
    let inCode = false;
    if (html !== null) {
      kept = blank && html.line === null ? end : at;
      if (html.line === null ? blank : bytes.subarray(at, end).indexOf(html.line) !== -1)
        html = null;
    } else if (open !== null) {
      if (fence !== null && closes(bytes, fence, end, open)) {
        open = null;
        kept = at;
      } else {
        inCode = true;
        if (blocks.fenceInfoInCode === true && openIndented) {
          kept = fenceInfoAt(bytes, inside(bytes, at).start, end);
        }
      }
    } else if (fence !== null && opens(bytes, fence, end)) {
      open = fence;
      openIndented = bytes[at] === SPACE;
      kept = at;
    } else {
      const text = inside(bytes, at);
      empty = text.start >= end;
      html = blocks.html === true ? htmlBlockAt(bytes, at, end, paragraph) : null;
      const label =
        html === null && blocks.definitions === true && !paragraph
          ? definitionLabel(bytes, at, end)
          : null;
      if (html !== null) {
        kept = at;
        // A block of the first five types can end on the line it starts.
        const line = bytes.subarray(pastIndent(bytes, at), end);
        if (html.line !== null && line.indexOf(html.line) !== -1) html = null;
      } else if (label !== null) {
        labels.push(label);
        kept = at;
      } else if (
        blocks.html === true &&
        (text.quoted || text.listed) &&
        htmlBlockAt(bytes, text.start, end, paragraph && !text.listed) !== null
      ) {
        // After a block quote's or a list item's marker, only the rest of the line is left out.
        kept = text.start;
      } else if (blocks.fenceInfo === true) kept = fenceInfoAt(bytes, text.start, end);
    }
    paragraph = kept === end && !empty && !inCode && html === null && !standsAlone(bytes, at, end);
    const start = length;
    length += bytes.copy(out, length, at, kept);
    const next = pastLineEnding(bytes, end);
    length += bytes.copy(out, length, end, next);
    if (inCode) code.fill(1, start, length);
    at = next;
  }
  return { bytes: out.subarray(0, length), code: code.subarray(0, length), labels };
}

/**
 * The first run, after run `after`, `length` backticks long and in the same
 * stretch of text, by `byLength`, each length's runs in order. -1 when none is.
 */
function nextRun(
  byLength: Map<number, number[]>,
  stretches: readonly number[],
  length: number,
  after: number,
): number {
  const runs = byLength.get(length) ?? [];
  let low = 0;
  let high = runs.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((runs[middle] as number) <= after) low = middle + 1;
    else high = middle;
  }
  const run = runs[low];
  return run !== undefined && stretches[run] === stretches[after] ? run : -1;
}

/**
 * Where each code span in a copy's text ends, by where it starts: a run of
 * backticks to the next run as long, as CommonMark pairs them. A backslash
 * before a run that opens one makes its first backtick text, while in a span
 * a backslash is text, so a run closes one whatever comes before it. Text in
 * a fenced code block holds no span.
 */
function codeSpans({ bytes, code }: Copy): Map<number, number> {
  const starts: number[] = [];
  const lengths: number[] = [];
  const stretches: number[] = [];
  const byLength = new Map<number, number[]>();
  let stretch = 0;
  let at = 0;
  while (at < bytes.byteLength) {
    if (code[at] === 1) stretch += 1;
    if (code[at] === 1 || bytes[at] !== BACKTICK) {
      at += 1;
      continue;
    }
    const start = at;
    while (at < bytes.byteLength && bytes[at] === BACKTICK && code[at] !== 1) at += 1;
    const run = starts.length;
    starts.push(start);
    lengths.push(at - start);
    stretches.push(stretch);
    const same = byLength.get(at - start);
    if (same === undefined) byLength.set(at - start, [run]);
    else same.push(run);
  }
  const spans = new Map<number, number>();
  let text = 0;
  let run = 0;
  while (run < starts.length) {
    let start = starts[run] as number;
    let slashes = 0;
    while (start - slashes > text && bytes[start - slashes - 1] === BACKSLASH) slashes += 1;
    const escaped = slashes % 2 === 1 ? 1 : 0;
    start += escaped;
    const length = (lengths[run] as number) - escaped;
    const close = length > 0 ? nextRun(byLength, stretches, length, run) : -1;
    if (close === -1) {
      run += 1;
      continue;
    }
    text = (starts[close] as number) + (lengths[close] as number);
    spans.set(start, text);
    run = close + 1;
  }
  return spans;
}

/**
 * The named entities decoded: HTML's five, a few marks, and the Latin-1
 * letters, by their names' bytes as one number, so that no name is turned
 * into text.
 */
const NAMED_ENTITIES = new Map<number, number>();

/** A name of up to six ASCII bytes as one number. */
function packed(bytes: Buffer, at: number, end: number): number {
  let value = 0;
  for (let index = at; index < end; index += 1) value = value * 256 + (bytes[index] as number);
  return value;
}

const MOST_ENTITY_NAME_BYTES = 6;

const LATIN_1_LETTERS = [
  [
    0xc0,
    "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml",
  ],
  [0xd0, "ETH Ntilde Ograve Oacute Ocirc Otilde Ouml"],
  [0xd8, "Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig"],
  [
    0xe0,
    "agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml",
  ],
  [0xf0, "eth ntilde ograve oacute ocirc otilde ouml"],
  [0xf8, "oslash ugrave uacute ucirc uuml yacute thorn yuml"],
] as const;

for (const [first, names] of LATIN_1_LETTERS) {
  for (const [index, name] of names.split(" ").entries()) {
    const bytes = Buffer.from(name);
    NAMED_ENTITIES.set(packed(bytes, 0, bytes.byteLength), first + index);
  }
}
for (const [name, code] of [
  ["amp", 0x26],
  ["lt", 0x3c],
  ["gt", 0x3e],
  ["quot", 0x22],
  ["apos", 0x27],
  ["nbsp", 0xa0],
  ["copy", 0xa9],
  ["reg", 0xae],
  ["laquo", 0xab],
  ["raquo", 0xbb],
  ["deg", 0xb0],
  ["middot", 0xb7],
  ["times", 0xd7],
  ["divide", 0xf7],
  ["ndash", 0x2013],
  ["mdash", 0x2014],
  ["lsquo", 0x2018],
  ["rsquo", 0x2019],
  ["ldquo", 0x201c],
  ["rdquo", 0x201d],
  ["bull", 0x2022],
  ["hellip", 0x2026],
  ["euro", 0x20ac],
  ["trade", 0x2122],
  ["larr", 0x2190],
  ["rarr", 0x2192],
] as const) {
  const bytes = Buffer.from(name);
  NAMED_ENTITIES.set(packed(bytes, 0, bytes.byteLength), code);
}

const isHexDigit = (byte: number) =>
  isDigit(byte) || ((byte | 0x20) >= 0x61 && (byte | 0x20) <= 0x66);

/**
 * The character an entity that starts at `at` stands for, and where it ends,
 * or null: `&#`, up to seven digits and `;`, `&#x`, up to six hex digits and
 * `;`, or one of the names decoded and `;`. A number that is no character
 * stands for U+FFFD, as for pulldown-cmark.
 */
function entityAt(bytes: Buffer, at: number): { code: number; end: number } | null {
  if (byteAt(bytes, at + 1) !== NUMBER_SIGN) {
    let end = at + 1;
    while (end - at - 1 <= MOST_ENTITY_NAME_BYTES && isAlphanumeric(byteAt(bytes, end))) end += 1;
    const code =
      end - at - 1 <= MOST_ENTITY_NAME_BYTES && byteAt(bytes, end) === SEMICOLON
        ? NAMED_ENTITIES.get(packed(bytes, at + 1, end))
        : undefined;
    return code === undefined ? null : { code, end: end + 1 };
  }
  const hex = (byteAt(bytes, at + 2) | 0x20) === LETTER_X;
  const start = at + (hex ? 3 : 2);
  let end = start;
  let code = 0;
  while (end - start < (hex ? 6 : 7) && (hex ? isHexDigit : isDigit)(byteAt(bytes, end))) {
    code = code * (hex ? 16 : 10) + hexValue(bytes[end] as number);
    end += 1;
  }
  if (end === start || byteAt(bytes, end) !== SEMICOLON) return null;
  const none = code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff);
  return { code: none ? 0xfffd : code, end: end + 1 };
}

/**
 * Where a link's destination and title end, when they follow the `]` at `at`
 * as `(`, spacing, a destination, a title, spacing and `)`, or where a
 * reference's label ends, `[`, a label one of `labels` defines and `]`. A
 * collapsed reference's `[]` ends there too, when the text since `opened`,
 * the byte after the last `[` outside code, is a label `labels` defines. `at`
 * when none does.
 */
function linkPartEnd(bytes: Buffer, at: number, labels: readonly Buffer[], opened: number): number {
  const next = byteAt(bytes, at + 1);
  if (next === OPENING_BRACKET) {
    if (byteAt(bytes, at + 2) === CLOSING_BRACKET) {
      const key =
        opened === -1 || at - opened > MOST_LABEL_BYTES ? null : labelKey(bytes, opened, at);
      return key !== null && labels.some((defined) => defined.equals(key)) ? at + 3 : at;
    }
    const label = labelEnd(bytes, at + 1);
    if (label === -1) return at;
    const key = labelKey(bytes, at + 2, label);
    return labels.some((defined) => defined.equals(key)) ? label + 1 : at;
  }
  if (next !== OPENING_PARENTHESIS) return at;
  const destination = destinationEnd(bytes, tagSpaceEnd(bytes, at + 2));
  if (destination === -1) return at;
  let end = tagSpaceEnd(bytes, destination);
  const title = titleEnd(bytes, end);
  if (title !== -1) end = tagSpaceEnd(bytes, title);
  return byteAt(bytes, end) === CLOSING_PARENTHESIS ? end + 1 : at;
}

/** What a copy of the prompt changes in its text outside code. */
interface Inline {
  /** Backslash escapes of ASCII punctuation undone. */
  escapes?: boolean;
  /** Entities turned into the bytes of their characters. */
  entities?: boolean;
  /**
   * Links' and images' destinations and titles, and references' labels, left
   * out after every `]`, or only after one that pairs with a `[` before it.
   * Code spans are paired across blocks here, so one can hide a link's `[`
   * that Codex sees, and after every `]` catches that. Codex keeps what follows
   * a `]` with no `[`, and the other catches that.
   */
  links?: "every" | "paired";
}

/**
 * A copy's bytes with their text outside code changed as `inline` says. A
 * code span and a fenced code block's text are kept as they are, as Codex
 * keeps code. What is undone is never longer than what it stands for, so the
 * copy is never longer than the bytes.
 */
function inlineCopy(copy: Copy, inline: Inline): Buffer {
  const { bytes, code } = copy;
  const spans = codeSpans(copy);
  const out = Buffer.alloc(bytes.byteLength);
  let length = 0;
  let at = 0;
  let opened = -1;
  /** How many `[` outside code have no `]` yet. */
  let open = 0;
  while (at < bytes.byteLength) {
    const byte = bytes[at] as number;
    if (byte === OPENING_BRACKET && code[at] !== 1) {
      opened = at + 1;
      open += 1;
    }
    const span = spans.get(at);
    if (code[at] === 1 || span !== undefined) {
      const end = span ?? at + 1;
      length += bytes.copy(out, length, at, end);
      at = end;
      continue;
    }
    if (byte === BACKSLASH && isPunctuation(byteAt(bytes, at + 1))) {
      if (inline.escapes !== true) {
        out[length] = byte;
        length += 1;
      }
      out[length] = bytes[at + 1] as number;
      length += 1;
      at += 2;
      continue;
    }
    const entity = inline.entities === true && byte === AMPERSAND ? entityAt(bytes, at) : null;
    if (entity !== null) {
      length += putUtf8(out, length, entity.code);
      at = entity.end;
      continue;
    }
    if (byte === CLOSING_BRACKET) {
      const links = inline.links === "every" || (inline.links === "paired" && open > 0);
      const link = links ? linkPartEnd(bytes, at, copy.labels, opened) : at;
      open = Math.max(0, open - 1);
      if (link > at) {
        at = link;
        continue;
      }
    }
    out[length] = byte;
    length += 1;
    at += 1;
  }
  return out.subarray(0, length);
}

const withoutListMarkers = (bytes: Buffer) => without(bytes, listMarkerAt);

/** The first view in which bytes are not empty, or null when they are empty in every view. */
function viewOf(bytes: Buffer): View | null {
  return VIEWS.find((view) => seenIn(view, bytes).byteLength > 0) ?? null;
}

/** What a view keeps of a name: all of it, its end trimmed, and, when it ends with `…`, what comes before that. */
interface Seen {
  whole: Buffer;
  start: Buffer | null;
}

/** A name, and what each view keeps of it, worked out once however many comparisons ask. */
type Name = (view: View) => Seen;

function nameOf(bytes: Buffer): Name {
  const end = endOfText(bytes);
  const cut = bytesAt(bytes, end - ELLIPSIS.byteLength, ELLIPSIS) ? end - ELLIPSIS.byteLength : -1;
  const seen: (Seen | undefined)[] = [];
  return (view) =>
    (seen[view] ??= {
      whole: seenIn(view, bytes.subarray(0, end)),
      start: cut === -1 ? null : seenIn(view, bytes.subarray(0, cut)),
    });
}

/**
 * Whether a name, seen in `view`, is all of `prompt`, the prompt seen in it,
 * or, when `cut` and the name ends with `…`, its start once the `…` is taken
 * off. Only the name's end is trimmed: whitespace at its start is in no view.
 */
function matches(view: View, prompt: Buffer, name: Name, cut: boolean): boolean {
  const { whole, start } = name(view);
  if (whole.byteLength > 0 && prompt.equals(whole)) return true;
  return cut && start !== null && start.byteLength > 0 && bytesAt(prompt, 0, start);
}

/**
 * Whether `name` matches `prompt`, as written or with its list markers left
 * out, each seen in the first view in which it is not empty.
 */
function isNamedFor(prompt: Buffer, name: Name, cut: boolean): boolean {
  return [prompt, withoutListMarkers(prompt)].some((compared) => {
    const view = viewOf(compared);
    return view !== null && matches(view, seenIn(view, compared), name, cut);
  });
}

/** How many characters UTF-8 bytes hold: every byte but a continuation byte starts one. */
function characters(bytes: Buffer): number {
  let count = 0;
  for (const byte of bytes) if ((byte & 0xc0) !== 0x80) count += 1;
  return count;
}

/** Whether each character of `needle` comes in order within `haystack`, both UTF-8. */
function inOrderWithin(needle: Buffer, haystack: Buffer): boolean {
  let from = 0;
  let at = 0;
  while (at < needle.byteLength) {
    let next = at + 1;
    while (next < needle.byteLength && ((needle[next] as number) & 0xc0) === 0x80) next += 1;
    const found = haystack.indexOf(needle.subarray(at, next), from);
    if (found === -1) return false;
    from = found + next - at;
    at = next;
  }
  return true;
}

/** How many characters Codex's cut leaves before the `…`: 59, or 58 when the 59th was a space it trimmed. */
const CUT_LENGTHS = new Set([58, 59]);

/**
 * What the first view keeps of a name that, trimmed, is cut as Codex cuts a
 * title, with 58 or 59 characters before its `…`, or null when it is not cut
 * so or the view keeps nothing of it.
 */
function cutLetters(named: Buffer): Buffer | null {
  const name = trimmed(named);
  if (!bytesAt(name, name.byteLength - ELLIPSIS.byteLength, ELLIPSIS)) return null;
  const start = name.subarray(0, name.byteLength - ELLIPSIS.byteLength);
  if (!CUT_LENGTHS.has(characters(start))) return null;
  const letters = seenIn(LETTERS, start);
  return letters.byteLength > 0 ? letters : null;
}

const ESCAPES: Inline = { escapes: true };

/** The last copies of the prompt compared, each built only when none before it matched. */
const MORE_COPIES: readonly { blocks: Blocks; inline: Inline }[] = [
  { blocks: { html: true }, inline: ESCAPES },
  { blocks: { definitions: true }, inline: { escapes: true, links: "every" } },
  { blocks: { fenceInfo: true }, inline: ESCAPES },
  {
    blocks: { html: true, definitions: true, fenceInfo: true },
    inline: { escapes: true, entities: true, links: "every" },
  },
  { blocks: { fenceInfo: true, fenceInfoInCode: true }, inline: ESCAPES },
  { blocks: { definitions: true }, inline: { escapes: true, links: "paired" } },
  {
    blocks: { html: true, definitions: true, fenceInfo: true },
    inline: { escapes: true, entities: true, links: "paired" },
  },
];

/**
 * Whether `name` is `prompt`, whole or cut with `…`. The prompt is trimmed
 * and cut to Codex's excerpt, its fence lines are left out and its escapes
 * undone, and the two are compared with their HTML left out, the name whole
 * with its HTML kept, and, when leaving HTML out leaves nothing of the prompt
 * in any view or of the name in the prompt's view, both with their HTML
 * kept. Then the prompt with its escapes kept and the name are compared with
 * their tags left out once. A name cut as Codex cuts one is compared with the
 * excerpt, and with its entities decoded, by its letters, in order. Last,
 * copies of the prompt with its escapes kept, its entities decoded, its HTML
 * blocks left out, its links' destinations, labels and definitions left out,
 * its fences' languages left out after block quote and list markers, all of
 * these, and its fences' languages left out in an indented block's text too,
 * are each compared with the name in the same three ways.
 */
function isPromptName(walked: Buffer, name: string): boolean {
  const excerpt = excerptOf(trimmed(walked));
  const nameBytes = Buffer.from(name, "utf8");
  const named = nameOf(nameBytes);
  const namedOut = nameOf(withoutHtml(nameBytes));
  const isOut = (copy: Buffer) => {
    const out = withoutHtml(copy);
    if (isNamedFor(out, namedOut, true) || isNamedFor(out, named, false)) return true;
    const view = viewOf(out);
    const leftNothing = view === null || namedOut(view).whole.byteLength === 0;
    return leftNothing && isNamedFor(copy, named, true);
  };
  const fenced = blockCopy(excerpt, {});
  if (isOut(withoutEscapes(fenced.bytes))) return true;
  // Leaving tags out again can join a `<` in text and a `>` in a code span into one Codex never saw.
  if (isNamedFor(withoutTagsOnce(fenced.bytes), nameOf(withoutTagsOnce(nameBytes)), true)) {
    return true;
  }
  const decoded = inlineCopy(fenced, { escapes: true, entities: true });
  const letters = cutLetters(nameBytes);
  if (
    letters !== null &&
    (inOrderWithin(letters, seenIn(LETTERS, excerpt)) ||
      inOrderWithin(letters, seenIn(LETTERS, decoded)))
  ) {
    return true;
  }
  if (isOut(fenced.bytes) || isOut(decoded)) return true;
  return MORE_COPIES.some(({ blocks, inline }) =>
    isOut(inlineCopy(blockCopy(excerpt, blocks), inline)),
  );
}

/**
 * Whether `name` is the first prompt that is not whitespace alone among the
 * whole lines of `head`, the bytes read from the start of a session's file,
 * whole or cut with `…`. Null when no such prompt is whole in them.
 */
export function isFirstPromptName(head: Buffer, name: string): boolean | null {
  let start = 0;
  let newline = head.indexOf(NEWLINE);
  while (newline !== -1) {
    const line = head.subarray(start, newline);
    const strings = promptStrings(line);
    if (strings !== null) {
      const prompt = promptOf(line, strings);
      if (endOfText(prompt) > 0) return isPromptName(prompt, name);
      // Whitespace alone: Codex takes the next prompt for one whose text trims to nothing.
    }
    start = newline + 1;
    newline = head.indexOf(NEWLINE, start);
  }
  return null;
}
