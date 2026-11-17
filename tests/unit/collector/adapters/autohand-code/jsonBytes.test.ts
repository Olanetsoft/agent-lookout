import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  asciiOf,
  folderAt,
  isIdByte,
  isWholeObject,
  literalOf,
  runAt,
  timeAt,
  topKey,
  topStringKey,
  valueAfter,
  wholeNumberAt,
  wordAt,
} from "@collector/adapters/autohand-code/jsonBytes";

const bytes = (text: string) => Buffer.from(text);

describe("the outer object's keys", () => {
  test("are found only after a line break and exactly two spaces", () => {
    const text = bytes('{\n  "pid": 7,\n  "activity": {\n    "pid": 8\n  }\n}\n');
    const at = valueAfter(text, topKey("pid"));
    expect(wholeNumberAt(text, at)).toBe(7);
    // A key of an object inside, after four spaces, is not one.
    expect(valueAfter(bytes('{\n    "pid": 8\n}'), topKey("pid"))).toBe(-1);
    // Nor are the same words in a string, where JSON writes a line break as `\n`.
    expect(valueAfter(bytes('{\n  "text": "\\n  \\"pid\\": 9"\n}'), topKey("pid"))).toBe(-1);
    expect(valueAfter(bytes('{"pid":7}'), topKey("pid"))).toBe(-1);
  });

  test("a string key is found up to its opening quote", () => {
    const text = bytes('{\n  "mode": "rpc"\n}');
    const at = valueAfter(text, topStringKey("mode"));
    expect(wordAt(text, at, [bytes('interactive"'), bytes('rpc"')])).toBe(1);
    expect(wordAt(text, at, [bytes('rp"')])).toBe(-1);
    expect(wordAt(text, -1, [bytes('rpc"')])).toBe(-1);
  });
});

describe("runAt", () => {
  test("takes 1 to max allowed bytes before a quote", () => {
    const text = bytes('abc-1.2_x"rest');
    expect(runAt(text, 0, 9, isIdByte)?.equals(bytes("abc-1.2_x"))).toBe(true);
    expect(runAt(text, 0, 8, isIdByte)).toBeNull();
    expect(runAt(bytes('"x'), 0, 9, isIdByte)).toBeNull();
    expect(runAt(bytes("abc"), 0, 9, isIdByte)).toBeNull();
    expect(runAt(bytes('a/b"'), 0, 9, isIdByte)).toBeNull();
    expect(runAt(bytes('a b"'), 0, 9, isIdByte)).toBeNull();
    expect(runAt(text, -1, 9, isIdByte)).toBeNull();
  });
});

describe("wholeNumberAt", () => {
  test("takes 1 to 10 digits before a comma, from their values", () => {
    expect(wholeNumberAt(bytes("4242,"), 0)).toBe(4242);
    expect(wholeNumberAt(bytes("1234567890,"), 0)).toBe(1_234_567_890);
    expect(wholeNumberAt(bytes("12345678901,"), 0)).toBeNull();
    expect(wholeNumberAt(bytes("42"), 0)).toBeNull();
    expect(wholeNumberAt(bytes("42.5,"), 0)).toBeNull();
    expect(wholeNumberAt(bytes("-42,"), 0)).toBeNull();
    expect(wholeNumberAt(bytes(","), 0)).toBeNull();
    expect(wholeNumberAt(bytes("42,"), -1)).toBeNull();
  });
});

describe("literalOf", () => {
  test("reads one JSON string, up to the first quote no backslash escapes", () => {
    expect(literalOf(bytes('"a \\"b\\" \\\\"tail'), 0, 100)).toBe('a "b" \\');
    expect(literalOf(bytes('"\\u00e9t\\u00e9"'), 0, 100)).toBe("été");
    expect(literalOf(bytes('"été"'), 0, 100)).toBe("été");
    expect(literalOf(bytes('""'), 0, 100)).toBe("");
  });

  test("gives nothing for a string longer than the most, cut off, or that JSON does not read", () => {
    expect(literalOf(bytes('"abcdef"'), 0, 5)).toBeNull();
    expect(literalOf(bytes('"abcde"'), 0, 5)).toBe("abcde");
    expect(literalOf(bytes('"abc'), 0, 100)).toBeNull();
    expect(literalOf(bytes('"ab\\'), 0, 100)).toBeNull();
    expect(literalOf(bytes('"bad \\q escape"'), 0, 100)).toBeNull();
    expect(literalOf(bytes('"line\nbreak"'), 0, 100)).toBeNull();
    expect(literalOf(bytes("abc"), 0, 100)).toBeNull();
    expect(literalOf(bytes('"abc"'), -1, 100)).toBeNull();
  });
});

describe("timeAt", () => {
  test("reads a time as Date.toISOString writes it", () => {
    expect(timeAt(bytes('2026-11-10T12:00:00.000Z"'), 0)).toBe(Date.UTC(2026, 10, 10, 12));
    expect(timeAt(bytes('2026-11-10T13:00:00+01:00"'), 0)).toBe(Date.UTC(2026, 10, 10, 12));
  });

  test("gives nothing for anything else", () => {
    expect(timeAt(bytes('2026-11-10 12:00:00"'), 0)).toBeNull();
    expect(timeAt(bytes('1762776000000"'), 0)).toBeNull();
    expect(timeAt(bytes("2026-11-10T12:00:00.000Z"), 0)).toBeNull();
    expect(timeAt(bytes(`${"1".repeat(41)}"`), 0)).toBeNull();
    expect(timeAt(bytes('2026-13-45T99:99:99.000Z"'), 0)).toBeNull();
  });
});

describe("folderAt", () => {
  test("keeps only a whole path with no control character", () => {
    expect(folderAt(bytes('"/Users/example/code"'), 0, 100, "darwin")).toBe("/Users/example/code");
    expect(folderAt(bytes('"code/demo"'), 0, 100, "darwin")).toBeNull();
    expect(folderAt(bytes('""'), 0, 100, "darwin")).toBeNull();
    expect(folderAt(bytes('"/a\\u0007b"'), 0, 100, "darwin")).toBeNull();
    expect(folderAt(bytes('"C:\\\\code\\\\demo"'), 0, 100, "win32")).toBe("C:\\code\\demo");
    expect(folderAt(bytes('"C:\\\\code\\\\demo"'), 0, 100, "linux")).toBeNull();
  });
});

describe("isWholeObject", () => {
  test("is an object from its first byte to its last, with at most a line break after", () => {
    expect(isWholeObject(bytes("{\n}\n"))).toBe(true);
    expect(isWholeObject(bytes('{\n  "a": 1\n}'))).toBe(true);
    expect(isWholeObject(bytes('{\n  "a": 1\n'))).toBe(false);
    expect(isWholeObject(bytes('{\n  "a": 1\n}\n\n'))).toBe(false);
    expect(isWholeObject(bytes("[]"))).toBe(false);
    expect(isWholeObject(bytes("}"))).toBe(false);
    expect(isWholeObject(bytes(""))).toBe(false);
  });
});

test("asciiOf turns at most the most bytes into text", () => {
  expect(asciiOf(bytes("abc"), 3)).toBe("abc");
  expect(asciiOf(bytes("abcd"), 3)).toBeNull();
});

test("only jsonBytes.ts in the adapter's folder turns bytes into text, parses or reads a whole file", () => {
  const folder = new URL("../../../../../src/collector/adapters/autohand-code/", import.meta.url);
  const words = [
    "decodeAtMost",
    "JSON.parse",
    "toString(",
    "TextDecoder",
    "StringDecoder",
    "fromCharCode",
    "fromCodePoint",
    "latin1Slice",
    "asciiSlice",
    "utf8Slice",
    "readFile",
  ];
  const files = readdirSync(fileURLToPath(folder));
  expect(files).toContain("jsonBytes.ts");
  for (const file of files) {
    if (file === "jsonBytes.ts") continue;
    const text = readFileSync(fileURLToPath(new URL(file, folder)), "utf8");
    for (const word of words) expect(text, `${file}: ${word}`).not.toContain(word);
  }
});
