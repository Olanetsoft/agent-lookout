import { describe, expect, test } from "vitest";

import {
  folderOfShellLine,
  idOfFileName,
  isSessionFileName,
  LINE_END_KEEP_BYTES,
  LINE_KEEP_BYTES,
  MAX_WAITING_FOR,
  readHeader,
  readLine,
  type KeptLine,
  type ReadLine,
} from "@collector/adapters/unreal-agent/lines";
import {
  goTime,
  headerLine,
  operationLine,
  PRIVATE_ARGUMENTS,
  PRIVATE_ID,
  PRIVATE_WORDS,
  PROJECT,
  record,
  SESSION_ID,
  SessionLines,
  shellOperation,
  shellState,
  STARTED_AT,
  uuidOf,
} from "@tests/fixtures/unreal-agent/unrealAgent";
import { watchDecoding } from "@tests/support/adapters/unreal-agent/decodeSpy";

/** A whole line as the reader keeps it: its first bytes, its last ones, and whether it was cut. */
function kept(line: string | Buffer): KeptLine {
  const bytes = typeof line === "string" ? Buffer.from(line.replace(/\n$/, "")) : line;
  return {
    head: bytes.subarray(0, LINE_KEEP_BYTES),
    end: bytes.subarray(Math.max(0, bytes.byteLength - LINE_END_KEEP_BYTES)),
    cut: bytes.byteLength > LINE_KEEP_BYTES,
  };
}

/** The lines of a file after its first. */
function linesOf(text: string): string[] {
  return text.split("\n").slice(1, -1);
}

/** The one line a builder adds, by the step given. */
function lineOf(build: (lines: SessionLines) => void): string {
  const lines = new SessionLines(SESSION_ID, STARTED_AT, { header: false });
  lines.turn(STARTED_AT);
  const before = lines.text().length;
  build(lines);
  return lines.text().slice(before).replace(/\n$/, "");
}

const itemOf = (line: string) => {
  const read = readLine(kept(line));
  return read.kind === "item" ? read.item : read;
};

const OP = uuidOf(5, 1);
const AT = STARTED_AT + 1000;

describe("the first line", () => {
  test("gives the session's ID and when it was made", () => {
    const line = headerLine(SESSION_ID, STARTED_AT).trimEnd();
    expect(readHeader(Buffer.from(line))).toEqual({
      state: "ok",
      id: SESSION_ID,
      createdAt: STARTED_AT,
    });
    // A time with a fraction of nine digits, as Go writes one.
    const fine = line.replace(goTime(STARTED_AT), goTime(STARTED_AT, "123456789"));
    expect(readHeader(Buffer.from(fine))).toEqual({
      state: "ok",
      id: SESSION_ID,
      createdAt: STARTED_AT + 123,
    });
  });

  test("of a newer format is a newer Unreal Agent's, and of the first or another shape is not read", () => {
    expect(readHeader(Buffer.from(headerLine(SESSION_ID, STARTED_AT, 3).trimEnd()))).toEqual({
      state: "newer",
    });
    expect(readHeader(Buffer.from(headerLine(SESSION_ID, STARTED_AT, 1).trimEnd()))).toEqual({
      state: "broken",
    });
    const line = headerLine().trimEnd();
    for (const broken of [
      line.replace('"}}}', '","Extra":1}}}'),
      line.replace(SESSION_ID, "a_b"),
      line.replace(goTime(STARTED_AT), "yesterday at noon"),
      `${line} `,
      '{"type":"item"}',
    ]) {
      expect(readHeader(Buffer.from(broken)), broken).toEqual({ state: "broken" });
    }
  });
});

describe("item lines", () => {
  test("give each input's kind and mode, and nothing of its text or reason", () => {
    expect(itemOf(lineOf((l) => l.settings(AT)))).toEqual({ kind: "input", input: "settings" });
    expect(itemOf(lineOf((l) => l.message(AT)))).toEqual({ kind: "input", input: "external" });
    expect(itemOf(lineOf((l) => l.whenIdle(AT)))).toEqual({ kind: "input", input: "when_idle" });
    expect(itemOf(lineOf((l) => l.hard(AT)))).toEqual({ kind: "input", input: "hard" });
    expect(itemOf(lineOf((l) => l.heartbeat(AT)))).toEqual({ kind: "input", input: "heartbeat" });
  });

  test("give a turn's ID and kind", () => {
    const line = lineOf((l) => l.turn(AT, "compaction"));
    expect(itemOf(line)).toEqual({ kind: "turn", id: uuidOf(3, 2), type: "compaction" });
    // The first turn has no turn before it.
    const first = new SessionLines(SESSION_ID, STARTED_AT, { header: false }).turn(AT).text();
    expect(itemOf(first)).toEqual({ kind: "turn", id: uuidOf(3, 1), type: "regular" });
  });

  test("give the number and time of every item", () => {
    const read = readLine(kept(lineOf((l) => l.message(AT))));
    expect(read).toMatchObject({ kind: "item", sequence: 2, at: AT });
  });

  test("tell a reply by how it stopped and its line's last bytes", () => {
    const turnId = uuidOf(3, 1);
    const reply = (options: Parameters<SessionLines["reply"]>[1]) =>
      itemOf(lineOf((l) => l.reply(AT, options)));
    expect(reply({})).toEqual({ kind: "reply", turnId, outcome: "complete" });
    expect(reply({ stop: "refused" })).toMatchObject({ outcome: "failed" });
    expect(reply({ stop: "max_output_tokens" })).toMatchObject({ outcome: "failed" });
    expect(reply({ stop: "" })).toMatchObject({ outcome: "unclear" });
    expect(reply({ stop: "a_new_stop" })).toMatchObject({ outcome: "unclear" });
    const failure = { Code: "server_error", Message: PRIVATE_WORDS };
    expect(reply({ stop: "", failure })).toMatchObject({ outcome: "failed" });
    expect(reply({ stop: "complete", failure })).toMatchObject({ outcome: "failed" });
    // An ending of neither shape is a line not read.
    const line = lineOf((l) => l.reply(AT));
    expect(itemOf(line.replace(',"Failure":null}}}}}', ',"Failure":null,"More":1}}}}}'))).toEqual({
      kind: "unread",
    });
  });

  test("tell a long failed reply from its last bytes, though its middle is not kept", () => {
    const text = "x".repeat(1.5 * 1024 * 1024);
    const failure = { Code: "server_error", Message: PRIVATE_WORDS };
    const line = Buffer.from(lineOf((l) => l.reply(AT, { stop: "", failure, text })));
    const cut = kept(line);
    expect(cut.cut).toBe(true);
    expect(readLine(cut)).toMatchObject({ item: { kind: "reply", outcome: "failed" } });
    const fine = Buffer.from(lineOf((l) => l.reply(AT, { text })));
    expect(readLine(kept(fine))).toMatchObject({ item: { kind: "reply", outcome: "complete" } });
  });

  test("give a tool call's first and second status, with the commands it waits for", () => {
    const ops = [shellOperation(OP, "ready"), shellOperation(uuidOf(5, 2), "ready")];
    expect(itemOf(lineOf((l) => l.created(AT, "call_1", ops)))).toEqual({
      kind: "status-created",
      ids: [OP, uuidOf(5, 2)],
    });
    for (const status of ["completed", "failed", "canceled"]) {
      expect(
        itemOf(lineOf((l) => l.completed(AT, "call_1", [shellOperation(OP, status)]))),
      ).toEqual({ kind: "status-completed", ids: [OP] });
    }
    // A command with no output limit, as a view_image one is.
    const image = {
      ID: OP,
      Type: "view_image",
      Version: 1,
      Status: "ready",
      State: { Path: PRIVATE_WORDS },
    };
    expect(itemOf(lineOf((l) => l.created(AT, "call_1", [image])))).toMatchObject({
      kind: "status-created",
    });
    // Any other first status is a line not read.
    expect(
      itemOf(lineOf((l) => l.created(AT, "call_1", [shellOperation(OP, "awaiting")]))),
    ).toEqual({
      kind: "unread",
    });
  });

  test("tell a tool call that failed at once by its error alone", () => {
    expect(itemOf(lineOf((l) => l.error(AT, "call_1")))).toEqual({ kind: "status-done" });
    expect(itemOf(lineOf((l) => l.error(AT, "call_1", true)))).toEqual({ kind: "status-done" });
    // A status that waits for nothing, which v0.3.1 does not write.
    const none = lineOf((l) => l.error(AT, "call_1")).replace(
      `"Error":"${PRIVATE_WORDS}"`,
      '"Error":""',
    );
    expect(itemOf(none)).toEqual({ kind: "status-done" });
    // An empty error marked as cut is a shape this does not read.
    const truncated = lineOf((l) => l.error(AT, "call_1", true)).replace(
      `"Error":"${PRIVATE_WORDS}"`,
      '"Error":""',
    );
    expect(itemOf(truncated)).toEqual({ kind: "unread" });
  });

  test("do not read a status with no commands after it, as a fork's parent's are", () => {
    const line = lineOf((l) => l.created(AT, "call_1", [shellOperation(OP, "ready")]));
    const inherited = `${line.slice(0, line.indexOf(',"Operations":'))}}}`;
    expect(itemOf(inherited)).toEqual({ kind: "unread" });
  });

  test(`do not read a status that waits for more than ${MAX_WAITING_FOR} commands`, () => {
    const ops = (n: number) =>
      Array.from({ length: n }, (_, i) => shellOperation(uuidOf(5, i + 1), "ready"));
    expect(itemOf(lineOf((l) => l.created(AT, "call_1", ops(MAX_WAITING_FOR))))).toMatchObject({
      kind: "status-created",
    });
    expect(itemOf(lineOf((l) => l.created(AT, "call_1", ops(MAX_WAITING_FOR + 1))))).toEqual({
      kind: "unread",
    });
  });

  test("pass over IDs that hold quotes and backslashes", () => {
    const odd = 'odd \\" id \\\\ "quoted" \\';
    const input = record("item", {
      Item: {
        Sequence: 1,
        RecordedAt: goTime(AT),
        Kind: "input",
        Data: { ID: odd, Kind: "external", Payload: PRIVATE_WORDS },
      },
    });
    expect(itemOf(input)).toEqual({ kind: "input", input: "external" });
    const reply = lineOf((l) => l.reply(AT, { responseId: odd }));
    expect(itemOf(reply)).toMatchObject({ kind: "reply", outcome: "complete" });
    const status = lineOf((l) => l.created(AT, odd, [shellOperation(OP, "ready")]));
    expect(itemOf(status)).toMatchObject({ kind: "status-created" });
    // A skip that stopped at the first `\` would not find the field after the ID.
    expect(JSON.stringify(odd)).toContain('\\"');
  });

  test("give a fork by its kind alone", () => {
    expect(itemOf(lineOf((l) => l.fork(AT)))).toEqual({ kind: "fork" });
  });

  test("do not read an unknown kind, input kind or mode", () => {
    const line = lineOf((l) => l.message(AT));
    expect(itemOf(line.replace('"Kind":"input"', '"Kind":"note"'))).toEqual({ kind: "unread" });
    expect(itemOf(line.replace('"Kind":"external"', '"Kind":"crash"'))).toEqual({ kind: "unread" });
    const control = lineOf((l) => l.control(AT, "soft", "a reason"));
    expect(itemOf(control)).toEqual({ kind: "unread" });
    expect(itemOf(lineOf((l) => l.control(AT, "pause")))).toEqual({ kind: "unread" });
    expect(readLine(kept('{"type":"note","data":{}}'))).toEqual({ kind: "unread" });
    expect(readLine(kept("not json at all"))).toEqual({ kind: "unread" });
  });
});

describe("operation lines", () => {
  test("give a command's ID and whether it ended", () => {
    const expected: [string, boolean][] = [
      ["ready", false],
      ["awaiting", false],
      ["canceling", false],
      ["", false],
      ["completed", true],
      ["failed", true],
      ["canceled", true],
    ];
    for (const [status, terminal] of expected) {
      expect(readLine(kept(operationLine(shellOperation(OP, status)))), status).toMatchObject({
        kind: "operation",
        id: OP,
        terminal,
      });
    }
    expect(readLine(kept(operationLine(shellOperation(OP, "paused"))))).toEqual({ kind: "unread" });
  });

  test("read a command with no output limit, and of another type", () => {
    const line = operationLine({
      ID: OP,
      Type: "skill_use",
      Version: 1,
      Status: "completed",
      State: {},
    });
    expect(readLine(kept(line))).toEqual({ kind: "operation", id: OP, terminal: true });
  });

  test("mark where a shell command's state begins, for version 3 alone", () => {
    const read = readLine(kept(operationLine(shellOperation(OP, "awaiting"))));
    expect(read).toHaveProperty("shellStateAt");
    const v4 = { ...shellOperation(OP, "awaiting"), Version: 4 };
    expect(readLine(kept(operationLine(v4)))).not.toHaveProperty("shellStateAt");
  });
});

describe("the folder of a shell command", () => {
  const folderOf = (line: string) => {
    const head = Buffer.from(line.replace(/\n$/, ""));
    const read = readLine(kept(head)) as ReadLine;
    return read.kind === "operation" && read.shellStateAt !== undefined
      ? folderOfShellLine(head, read.shellStateAt, "darwin")
      : "no shell line";
  };
  const shellLine = (state: Record<string, unknown>) =>
    operationLine(shellOperation(OP, "awaiting", state));

  test("is the one part decoded, past the command and the shell", () => {
    expect(folderOf(shellLine(shellState()))).toBe(PROJECT);
    expect(folderOf(shellLine(shellState({ directory: "/Users/example/work/demo café" })))).toBe(
      "/Users/example/work/demo café",
    );
  });

  test("is the real one, when the command holds what looks like another", () => {
    const command = '","Shell":"x","Directory":"/fake"},"BaseDirectory":"';
    expect(folderOf(shellLine(shellState({ command })))).toBe(PROJECT);
    const quoted = 'echo \\"done\\" \\\\';
    expect(folderOf(shellLine(shellState({ command: quoted })))).toBe(PROJECT);
  });

  test("is none from two records written into one line", () => {
    const line = operationLine(shellOperation(OP, "awaiting")).replace(/\n$/, "");
    const cut = line.slice(0, line.indexOf('"Command":"') + 20);
    expect(folderOf(cut + headerLine())).toBeNull();
    // Nor from a second command's record: its folder is not this line's.
    const other = operationLine(
      shellOperation(OP, "awaiting", shellState({ directory: "/Users/example/work/other" })),
    );
    expect(folderOf(cut + other)).toBeNull();
  });

  test("is none when it is not a folder this system could have", () => {
    for (const directory of [
      "relative/demo-project",
      "",
      "/Users/example/a\u0001b",
      `/${"a".repeat(4096)}`,
    ]) {
      expect(folderOf(shellLine(shellState({ directory }))), directory).toBeNull();
    }
    // A token longer than 16 KiB is not read.
    expect(folderOf(shellLine(shellState({ directory: `/${"a".repeat(17 * 1024)}` })))).toBeNull();
  });

  test("is none for a shell command of another version", () => {
    const v4 = { ...shellOperation(OP, "awaiting"), Version: 4 };
    expect(folderOf(operationLine(v4))).toBe("no shell line");
  });
});

describe("session file names", () => {
  test("are an ID of letters, digits and dashes, then .session.jsonl", () => {
    expect(isSessionFileName(`${SESSION_ID}.session.jsonl`)).toBe(true);
    expect(isSessionFileName(`${"a".repeat(241)}.session.jsonl`)).toBe(true);
    for (const name of [
      `${"a".repeat(242)}.session.jsonl`,
      ".session-123.tmp",
      ".session.jsonl",
      "a_b.session.jsonl",
      "operations",
      "notes.jsonl",
      "20261006-120000.jsonl",
      `${SESSION_ID}.session.jsonl.tmp`,
    ]) {
      expect(isSessionFileName(name), name).toBe(false);
    }
    expect(idOfFileName(`${SESSION_ID}.session.jsonl`)).toBe(SESSION_ID);
  });
});

describe("what is turned into text", () => {
  test("is only IDs, times and the folder, whatever a file holds", () => {
    const lines = new SessionLines();
    lines.settings(AT).message(AT, PRIVATE_ID).heartbeat(AT).turn(AT);
    lines.reply(AT, { calls: ["call.Private.1"], failure: { Code: "x", Message: PRIVATE_WORDS } });
    lines.created(AT, PRIVATE_ID, [shellOperation(OP, "ready")]);
    lines.operation(shellOperation(OP, "completed", shellState({ ended: true })));
    lines.completed(AT, PRIVATE_ID, [shellOperation(OP, "completed", shellState({ ended: true }))]);
    lines.error(AT, PRIVATE_ID).turn(AT, "compaction").reply(AT).fork(AT);
    const text = lines.text();
    const allowed = new Set([
      SESSION_ID,
      goTime(STARTED_AT),
      goTime(AT),
      uuidOf(3, 1),
      uuidOf(3, 2),
      OP,
      PROJECT,
      JSON.stringify(PROJECT),
    ]);
    const seen = watchDecoding(() => {
      readHeader(Buffer.from(text.slice(0, text.indexOf("\n"))));
      for (const line of linesOf(text)) {
        const read = readLine(kept(line));
        if (read.kind === "operation" && read.shellStateAt !== undefined) {
          folderOfShellLine(Buffer.from(line), read.shellStateAt, "darwin");
        }
      }
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const value of seen) expect(allowed, value).toContain(value);
    for (const word of [PRIVATE_WORDS, PRIVATE_ARGUMENTS, PRIVATE_ID]) {
      expect(seen.join("\n")).not.toContain(word);
    }
  });
});
