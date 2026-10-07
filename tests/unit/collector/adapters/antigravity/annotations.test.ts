import { describe, expect, test } from "vitest";

import {
  ANNOTATION_LIMIT_BYTES,
  createTitleReader,
  readTitle,
  unescapeTextFormat,
} from "@collector/adapters/antigravity/annotations";
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

  test("has its escapes undone, with a letter outside ASCII written byte by byte", () => {
    expect(unescapeTextFormat("Caf\\303\\251 notes")).toBe("Café notes");
    expect(unescapeTextFormat('A \\"quoted\\" word')).toBe('A "quoted" word');
    expect(unescapeTextFormat("Tab\\there")).toBe("Tab\there");
    expect(unescapeTextFormat("\\xe2\\x9c\\x93 done")).toBe("✓ done");
    expect(unescapeTextFormat("Plain 🙂 text")).toBe("Plain 🙂 text");
    expect(unescapeTextFormat("Caf\\u00e9 \\U0001F642")).toBe("Café 🙂");
  });

  test("is none when an escape is not one, or the bytes are not UTF-8", () => {
    expect(unescapeTextFormat("bad \\q escape")).toBeNull();
    expect(unescapeTextFormat("ends in \\")).toBeNull();
    expect(unescapeTextFormat("\\377 alone")).toBeNull();
    expect(unescapeTextFormat("\\u12 short")).toBeNull();
    expect(unescapeTextFormat("\\ud800 alone")).toBeNull();
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
