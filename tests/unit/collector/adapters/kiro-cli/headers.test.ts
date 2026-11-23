import { expect, test } from "vitest";

import {
  createHeaderReader,
  MAX_HEADER_BYTES,
  parseV2Header,
  parseV3Header,
} from "@collector/adapters/kiro-cli/headers";
import {
  CREATED_AT,
  NOW,
  PROJECT,
  uuidOf,
  v2Header,
  v3Header,
  v3IdOf,
} from "@tests/fixtures/kiro-cli/kiroCli";
import { memoryFiles } from "@tests/support/adapters/kiro-cli/kiroCliAdapter";

test("a V3 header gives its title, its first workspace folder and when it was made", () => {
  expect(parseV3Header(v3Header(v3IdOf(1)), "darwin")).toEqual({
    title: "Tidy the demo tests",
    folder: PROJECT,
    createdAt: CREATED_AT,
    subagent: false,
  });
  // Only the first folder, and only an absolute path.
  const two = v3Header(v3IdOf(1), { workspacePaths: [PROJECT, "/Users/example/code/other"] });
  expect(parseV3Header(two, "darwin")?.folder).toBe(PROJECT);
  for (const workspacePaths of [[], ["code/demo"], "/Users/example", [7], undefined]) {
    expect(parseV3Header(v3Header(v3IdOf(1), { workspacePaths }), "darwin")?.folder).toBeNull();
  }
  expect(
    parseV3Header(v3Header(v3IdOf(1), { workspacePaths: ["C:\\code\\demo"] }), "win32")?.folder,
  ).toBe("C:\\code\\demo");
});

test("a V3 header is a subagent's only when createdReason says so and it names its parent", () => {
  const parentSessionId = v3IdOf(9);
  const subagent = (changes: Record<string, unknown>) =>
    parseV3Header(v3Header(v3IdOf(1), changes), "darwin")?.subagent;
  expect(subagent({ createdReason: "subagent", parentSessionId })).toBe(true);
  // A rewind or a tangent is a conversation the person forked, and is listed.
  for (const createdReason of ["rewind", "tangent", "human", undefined]) {
    expect(subagent({ createdReason, parentSessionId }), String(createdReason)).toBe(false);
  }
  for (const parent of [undefined, "", "  ", 7]) {
    expect(subagent({ createdReason: "subagent", parentSessionId: parent }), String(parent)).toBe(
      false,
    );
  }
});

test("a V2 header gives its folder and when it was made, never its title, and says when it is a subagent's", () => {
  // V2's title is the first prompt word for word, so it is never read.
  expect(parseV2Header(v2Header(uuidOf(1)), "linux")).toEqual({
    title: null,
    folder: PROJECT,
    createdAt: CREATED_AT,
    subagent: false,
  });
  expect(parseV2Header(v2Header(uuidOf(1), { title: "Demo title" }), "linux")?.title).toBeNull();
  const subagent = (changes: Record<string, unknown>) =>
    parseV2Header(v2Header(uuidOf(2), changes), "linux")?.subagent;
  // A header that names its parent is a subagent's unless session_created_reason is rewind or tangent, below.
  // V2 writes subagent there on top-level sessions too, so no other reason, and no reason at all, clears it.
  for (const reason of ["subagent", "human", undefined]) {
    expect(
      subagent({ parent_session_id: uuidOf(1), session_created_reason: reason }),
      String(reason),
    ).toBe(true);
  }
  // A rewind or a tangent names the session it was forked from, and is listed.
  for (const reason of ["rewind", "tangent"]) {
    expect(subagent({ parent_session_id: uuidOf(1), session_created_reason: reason }), reason).toBe(
      false,
    );
  }
  expect(subagent({ parent_session_id: " " })).toBe(false);
});

test("a V3 title of spaces, the literal (no title), or one that is not text is none", () => {
  for (const title of ["", "   ", "(no title)", " (no title) ", 12, null]) {
    expect(
      parseV3Header(v3Header(v3IdOf(1), { title }), "darwin")?.title,
      String(title),
    ).toBeNull();
  }
  expect(parseV3Header(v3Header(v3IdOf(1), { title: "  Spaced  " }), "darwin")?.title).toBe(
    "Spaced",
  );
});

test("a header that is not a JSON object is none", () => {
  for (const text of ["", "[]", "null", "{", '"text"']) {
    expect(parseV3Header(text, "darwin"), text).toBeNull();
    expect(parseV2Header(text, "darwin"), text).toBeNull();
  }
});

test("a header is read only as an ordinary file of 4 MiB or less, and again only once it changed", async () => {
  const files = memoryFiles(() => NOW);
  const headers = createHeaderReader(files.io, "darwin");
  const file = "/Users/example/.kiro/sessions/cli/one.json";
  files.write(file, v2Header(uuidOf(1)));
  expect(await headers.read(file, await files.io.lstat(file), "v2")).toMatchObject({ state: "ok" });
  files.forget();
  await headers.read(file, await files.io.lstat(file), "v2");
  expect(files.opened()).toEqual([]);

  files.write(file, `${v2Header(uuidOf(1))}${" ".repeat(MAX_HEADER_BYTES)}`);
  expect(await headers.read(file, await files.io.lstat(file), "v2")).toEqual({
    state: "too-large",
  });
  files.write(file, "not json");
  expect(await headers.read(file, await files.io.lstat(file), "v2")).toEqual({ state: "none" });
  files.special(file);
  expect(await headers.read(file, await files.io.lstat(file), "v2")).toEqual({ state: "none" });
});
