import { describe, expect, test } from "vitest";

import {
  ANNOTATION_LIMIT_BYTES,
  createTitleReader,
  readTitle,
  unescapeTextFormat,
} from "@collector/adapters/antigravity/shared/annotations";
import { AGY_HOME, annotationPath, conversationId, NOW } from "@tests/fixtures/antigravity";
import { memoryFiles } from "@tests/support/adapters/antigravityAdapter";

const ID = conversationId("a1");

describe("a title in protocol buffer text format", () => {
  test("is read as agy writes it", () => {
    expect(readTitle('title:"List Directory Contents"\n')).toBe("List Directory Contents");
    expect(readTitle('title: "Rename a helper"')).toBe("Rename a helper");
  });

  test("is the top-level title, not one inside another message", () => {
    expect(readTitle('step {\n  title: "Inner"\n}\ntitle: "Outer"\n')).toBe("Outer");
    expect(readTitle('step {\n  title: "Inner"\n}\n')).toBeNull();
  });

  test("is read among other fields, and only the title", () => {
    expect(readTitle('summary:"other words"\ntitle:"Tidy the notes"\nstarred:true\n')).toBe(
      "Tidy the notes",
    );
  });

  test("is read as Antigravity 2.23.1 writes it, with the time it was last seen on the same line", () => {
    expect(
      readTitle('title:"Fix the build" last_user_view_time:{seconds:1767225600 nanos:120000000}'),
    ).toBe("Fix the build");
    expect(readTitle('last_user_view_time:{seconds:1 nanos:2} title:"Fix the build"\n')).toBe(
      "Fix the build",
    );
  });

  test("is read in every other form the text format allows", () => {
    expect(readTitle("title:'Single quotes'")).toBe("Single quotes");
    expect(readTitle("title: \"Two \" 'parts'")).toBe("Two parts");
    expect(readTitle('title: "Split\n" "across lines"')).toBeNull();
    expect(readTitle('title: "Split"\n  " across lines"')).toBe("Split across lines");
    expect(readTitle('title:"With a comma", pinned:true;')).toBe("With a comma");
    expect(readTitle('# a comment\ntitle:"After a comment" # and one after\n')).toBe(
      "After a comment",
    );
    expect(readTitle('title:"A \\"quote\\" and a \' mark"')).toBe('A "quote" and a \' mark');
    expect(readTitle('\uFEFFtitle:"After a byte order mark"')).toBe("After a byte order mark");
  });

  test("in several quoted parts has each part's escapes undone on its own, then the bytes joined", () => {
    expect(readTitle('title: "Q\\60" "7"')).toBe("Q07");
    expect(readTitle('title: "Caf\\303" "\\251"')).toBe("Café");
  });

  test("passes over values of every kind without taking a title from them", () => {
    expect(
      readTitle(
        "count:-3 ratio:1.5e-3 flag:true kind:DONE hex:0x1F inf:-inf\n" +
          '[some.extension] { title: "In an extension" }\n' +
          '[type.googleapis.com/a.Note] < title: "In an Any" >\n' +
          'tags:["a", "b"] steps:[{title:"In a list"}, <title:"Also">]\n' +
          'nested { deeper < title:"Deep" > }\n' +
          'half:.5 [example.com/~a/b%20c/x.Y] { title: "In an Any with more of a URL" }\n' +
          'title:"The real one"',
      ),
    ).toBe("The real one");
    expect(readTitle('note:"title:\\"Not a field\\""')).toBeNull();
  });

  test("is none when it is not a string, is given twice, or the text is not text format", () => {
    expect(readTitle("title:7")).toBeNull();
    expect(readTitle('title:{text:"x"}')).toBeNull();
    expect(readTitle('title:"One" title:"Two"')).toBeNull();
    expect(readTitle('title:"Unclosed')).toBeNull();
    expect(readTitle('step { title:"x" ')).toBeNull();
    expect(readTitle('step { title:"x" ] title:"y"')).toBeNull();
    expect(readTitle('title:"Fine" }')).toBeNull();
    expect(readTitle('title:"Fine" @')).toBeNull();
    expect(readTitle("title:")).toBeNull();
    expect(readTitle('title:7 title:"x"')).toBeNull();
    expect(readTitle('title:{a:1} title:"x"')).toBeNull();
    expect(readTitle('a { ] } title:"x"')).toBeNull();
    expect(readTitle('foo: , title:"x"')).toBeNull();
  });

  test("is none for a string with no `:` before it, which the format allows only for a message", () => {
    expect(readTitle('title "No colon"')).toBeNull();
    expect(readTitle('count 5 title:"x"')).toBeNull();
    expect(readTitle('title#:"Top title" note:\n"Value of note"')).toBeNull();
    expect(readTitle('note { a:1 } title:"x"')).toBe("x");
  });

  test("is none when any string or space in the file is not text format, even outside the title", () => {
    expect(readTitle('note:"bad \\q" title:"x"')).toBeNull();
    expect(readTitle('note:"a\\\n" title:"x"')).toBeNull();
    expect(readTitle('title:"x"\u00a0')).toBeNull();
  });

  test("has its escapes undone, with a letter outside ASCII written byte by byte", () => {
    expect(unescapeTextFormat("Caf\\303\\251 notes")).toBe("Café notes");
    expect(unescapeTextFormat('A \\"quoted\\" word')).toBe('A "quoted" word');
    expect(unescapeTextFormat("Tab\\there")).toBe("Tab\there");
    expect(unescapeTextFormat("\\xe2\\x9c\\x93 done")).toBe("✓ done");
    expect(unescapeTextFormat("Plain 🙂 text")).toBe("Plain 🙂 text");
    expect(unescapeTextFormat("Caf\\u00e9 \\U0001F642")).toBe("Café 🙂");
    expect(unescapeTextFormat("\\ud83d\\ude42 as a pair")).toBe("🙂 as a pair");
  });

  test("is none when an escape is not one, or the bytes are not UTF-8", () => {
    expect(unescapeTextFormat("bad \\q escape")).toBeNull();
    expect(unescapeTextFormat("ends in \\")).toBeNull();
    expect(unescapeTextFormat("\\377 alone")).toBeNull();
    expect(unescapeTextFormat("\\u12 short")).toBeNull();
    expect(unescapeTextFormat("\\ud800 alone")).toBeNull();
    expect(unescapeTextFormat("\\ude42 alone")).toBeNull();
    expect(unescapeTextFormat("\\ud83d\\u0041 not a pair")).toBeNull();
    expect(unescapeTextFormat("\\U0000d83d in eight")).toBeNull();
    expect(unescapeTextFormat("\\U00110000 too high")).toBeNull();
    expect(readTitle('title:"bad \\q"')).toBeNull();
  });

  test("is cleaned as any session's name is, and an empty one is none", () => {
    expect(readTitle('title:"  Two\\nlines  "')).toBe("Two lines");
    expect(readTitle('title:""')).toBeNull();
    expect(readTitle("no title here")).toBeNull();
    expect(readTitle('subtitle:"Not this"')).toBeNull();
  });
});

describe("the title reader", () => {
  function setUp() {
    const files = memoryFiles(() => NOW);
    const reader = createTitleReader({ home: AGY_HOME, io: files.io });
    return { files, reader };
  }

  test("reads a conversation's title, and again only once it changed", async () => {
    const { files, reader } = setUp();
    files.write(annotationPath(AGY_HOME, ID), 'title:"List Directory Contents"');
    expect(await reader.read(ID)).toBe("List Directory Contents");
    await reader.read(ID);
    expect(files.calls.filter((call) => call.method === "openRegular")).toHaveLength(1);
    files.rewrite(annotationPath(AGY_HOME, ID), 'title:"Count the files"', { mtimeMs: NOW + 1 });
    expect(await reader.read(ID)).toBe("Count the files");
  });

  test("gives none for a conversation with no annotation, without throwing", async () => {
    const { reader } = setUp();
    expect(await reader.read(ID)).toBeNull();
  });

  test("never opens an annotation that is not an ordinary file, or is too large", async () => {
    const { files, reader } = setUp();
    files.special(annotationPath(AGY_HOME, ID));
    expect(await reader.read(ID)).toBeNull();
    const big = conversationId("b2");
    files.write(annotationPath(AGY_HOME, big), `title:"${"x".repeat(ANNOTATION_LIMIT_BYTES)}"`);
    expect(await reader.read(big)).toBeNull();
    expect(files.calls.filter((call) => call.method === "openRegular")).toEqual([]);
  });
});
