import { describe, expect, test } from "vitest";

import {
  clean,
  cut,
  MAX_MESSAGE_LENGTH,
  MAX_NAME_LENGTH,
  MAX_WAITING_TEXT_LENGTH,
  messageText,
  oneLine,
  sessionName,
  waitingText,
} from "@core/text";

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

  test.each(REORDERING)(
    "turns the mark U+%s into a space, as clean and waitingText do",
    (_, mark) => {
      expect(oneLine(`checkout${mark}flow`)).toBe("checkout flow");
    },
  );

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

describe("what a waiting session is asking", () => {
  test("is made one line, cleaned of control characters and of marks that reorder it", () => {
    expect(waitingText("Run: npm test\n  && npm run lint")).toBe("Run: npm test && npm run lint");
    expect(waitingText("Edit: \u202esrc/app.ts\u0007")).toBe("Edit: src/app.ts");
  });

  test("is cut to 200 characters with an ellipsis, never inside a letter", () => {
    expect(MAX_WAITING_TEXT_LENGTH).toBe(200);
    const cutText = waitingText(`Which ${"🦉".repeat(300)}?`) as string;
    expect(Array.from(cutText)).toHaveLength(200);
    expect(cutText.endsWith("🦉…")).toBe(true);
  });

  test("is none when there is nothing to say, or it is not text", () => {
    expect(waitingText("")).toBeUndefined();
    expect(waitingText(" \n\t ")).toBeUndefined();
    expect(waitingText(null)).toBeUndefined();
    expect(waitingText(42)).toBeUndefined();
  });
});

describe("what a session last said", () => {
  test("keeps its line breaks, with \\r\\n, \\r and the line and paragraph separators made \\n", () => {
    expect(messageText("One.\nTwo.\r\nThree.\rFour.\u2028Five.\u2029Six.")).toEqual({
      text: "One.\nTwo.\nThree.\nFour.\nFive.\nSix.",
      cut: false,
    });
  });

  test("has a tab made two spaces, and any other control character a space", () => {
    expect(messageText("a\tb\u0000c\u0007d\u001be\u007ff\u0085g")?.text).toBe("a  b c d e f g");
  });

  test.each(REORDERING)("has the mark U+%s taken out", (_, mark) => {
    expect(messageText(`checkout${mark}flow`)?.text).toBe("checkoutflow");
  });

  test("has the spaces at the end of each line trimmed, and at most one blank line in a row", () => {
    expect(messageText("\n\n  Done.   \n\n\n\n  - the list  \n\t\n")?.text).toBe(
      "Done.\n\n  - the list",
    );
    expect(messageText("Above.\n \n\u00a0\n\nBelow.")?.text).toBe("Above.\n\nBelow.");
  });

  test("is none when there is nothing to say, or it is not text", () => {
    expect(messageText("")).toBeUndefined();
    expect(messageText(" \n\t \r\n ")).toBeUndefined();
    expect(messageText("\u0000\u200e\u2028")).toBeUndefined();
    expect(messageText(null)).toBeUndefined();
    expect(messageText(42)).toBeUndefined();
    expect(messageText(["words"])).toBeUndefined();
  });

  test("is whole up to 2,000 characters, counted once it is cleaned", () => {
    expect(MAX_MESSAGE_LENGTH).toBe(2000);
    expect(messageText("x".repeat(2000))).toEqual({ text: "x".repeat(2000), cut: false });
    expect(messageText(`${"x".repeat(1990)}${" ".repeat(50)}\n\n\n`)).toEqual({
      text: "x".repeat(1990),
      cut: false,
    });
  });

  test("over 2,000 characters keeps its last 2,000, and says it was cut", () => {
    expect(messageText(`${"a".repeat(500)}${"b".repeat(2000)}`)).toEqual({
      text: "b".repeat(2000),
      cut: true,
    });
  });

  test("when cut, starts after a line break within the first 200 characters it keeps", () => {
    // What is kept starts with 150 y's and a line break, so it starts after it.
    expect(messageText(`${"x".repeat(1000)}${"y".repeat(150)}\n${"z".repeat(1849)}`)).toEqual({
      text: "z".repeat(1849),
      cut: true,
    });
    // And a blank line there leaves no line break at its start.
    expect(messageText(`${"x".repeat(1000)}${"y".repeat(10)}\n\n${"z".repeat(1988)}`)).toEqual({
      text: "z".repeat(1988),
      cut: true,
    });
    // A line break further in than 200 is not where it starts.
    const far = `${"y".repeat(250)}\n${"z".repeat(1749)}`;
    expect(messageText(`${"x".repeat(1000)}${far}`)).toEqual({ text: far, cut: true });
  });

  test("when cut, a line break after the first 199 characters it keeps is the last that counts", () => {
    // The 200th character kept is a line break, so it starts after it.
    expect(messageText(`${"x".repeat(1000)}${"y".repeat(199)}\n${"z".repeat(1800)}`)).toEqual({
      text: "z".repeat(1800),
      cut: true,
    });
    // The 201st is not, so it starts where it was cut.
    const kept = `${"y".repeat(200)}\n${"z".repeat(1799)}`;
    expect(messageText(`${"x".repeat(1000)}${kept}`)).toEqual({ text: kept, cut: true });
  });

  test("when cut in a run of spaces, is trimmed at its start, so cleaning it again changes nothing", () => {
    const once = messageText(`${"x".repeat(10)}${" ".repeat(300)}${"y".repeat(1990)}`)!;
    expect(once).toEqual({ text: "y".repeat(1990), cut: true });
    expect(messageText(once.text)?.text).toBe(once.text);
    // Indentation where it starts after a line break is trimmed too.
    const indented = messageText(`${"x".repeat(1000)}${"y".repeat(10)}\n    ${"z".repeat(1985)}`)!;
    expect(indented).toEqual({ text: "z".repeat(1985), cut: true });
    expect(messageText(indented.text)?.text).toBe(indented.text);
  });

  test("a very long run of spaces or tabs inside a line is cleaned in good time", () => {
    const started = performance.now();
    const spaces = messageText(`a${" ".repeat(250_000)}b`)!;
    const tabs = messageText(`a${"\t".repeat(50_000)}done`)!;
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(spaces.cut).toBe(true);
    expect(spaces.text).toBe("b");
    expect(tabs.cut).toBe(true);
    expect(tabs.text).toBe("done");
  });

  test("when cut, is cut between code points, so no letter is broken in two", () => {
    expect(messageText(`a${"🦉".repeat(2000)}`)).toEqual({ text: "🦉".repeat(2000), cut: true });
    const owls = messageText("🦉".repeat(2500))!;
    expect(owls.cut).toBe(true);
    expect(Array.from(owls.text)).toHaveLength(2000);
    expect(owls.text).toBe("🦉".repeat(2000));
  });
});
