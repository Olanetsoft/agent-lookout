import { describe, expect, test } from "vitest";

import { clean, cut, MAX_NAME_LENGTH, oneLine, sessionName } from "@core/text";

/** Marks that make text run the other way, by code point: the ends of each run of them. */
const REORDERING = ["061C", "200E", "200F", "202A", "202E", "2066", "2069"].map(
  (code) => [code, String.fromCodePoint(parseInt(code, 16))] as const,
);

describe("oneLine", () => {
  test("turns line breaks and control characters into single spaces", () => {
    expect(oneLine("a\r\nb\tc\u0000d   e")).toBe("a b c d e");
    expect(oneLine("  padded  ")).toBe("padded");
    expect(oneLine("first second third")).toBe("first second third");
  });

  test.each(REORDERING)("turns the mark U+%s into a space, as every other rule does", (_, mark) => {
    expect(oneLine(`checkout${mark}flow`)).toBe("checkout flow");
  });

  test("cuts a long name with an ellipsis, between letters", () => {
    expect(oneLine("abcdefghij", 5)).toBe("abcd…");
    expect(oneLine("abcde", 5)).toBe("abcde");
    // Four letters outside the basic plane, each two UTF-16 units, are never split.
    expect(oneLine("🚀🚀🚀🚀🚀🚀", 4)).toBe("🚀🚀🚀…");
    expect(oneLine("x".repeat(100))).toBe(`${"x".repeat(79)}…`);
  });
});

describe("a session's name", () => {
  test.each(REORDERING)("has the mark U+%s made a space", (_, mark) => {
    expect(sessionName(`docs${mark}gnp.exe`)).toBe("docs gnp.exe");
  });

  test("has control characters made spaces, and is trimmed, and nothing left is none", () => {
    expect(sessionName("\tsearch-indexing\u0007\n")).toBe("search-indexing");
    expect(sessionName(" \u0000 ")).toBeUndefined();
  });

  test("is cut to 200 characters, never inside a letter", () => {
    expect(MAX_NAME_LENGTH).toBe(200);
    expect(sessionName("a".repeat(250))).toBe("a".repeat(200));
    expect(Array.from(sessionName("🚀".repeat(250))!)).toHaveLength(200);
  });

  test("clean and cut take anything, and only text gives text", () => {
    expect(clean(42)).toBeUndefined();
    expect(cut(null, 10)).toBeUndefined();
    expect(cut("mobile-onboarding", 6)).toBe("mobile");
  });
});
