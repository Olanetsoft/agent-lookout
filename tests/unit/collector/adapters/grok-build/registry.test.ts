import { describe, expect, test } from "vitest";

import {
  createRegistryReader,
  entryOf,
  isGrokSessionId,
  MAX_ENTRIES,
  MAX_REGISTRY_BYTES,
  openedAtOf,
  parseRegistry,
} from "@collector/adapters/grok-build/registry";
import {
  entry,
  GROK_HOME,
  MINUTE,
  NOW,
  OPENED_AT,
  openedAt,
  OTHER_SESSION_ID,
  PID,
  PROJECT,
  REGISTRY_FILE,
  registryText,
  SECRET,
  SESSION_ID,
} from "@tests/fixtures/grok-build/grokBuild";
import {
  memoryFiles,
  OTHER_UID,
  ownedFiles,
  TEST_UID,
  writeRegistry,
  type MemoryFiles,
} from "@tests/support/adapters/grok-build/grokBuildAdapter";

function readerOf(files: MemoryFiles, platform: NodeJS.Platform = "darwin") {
  const owned = ownedFiles(files);
  return {
    owned,
    reader: createRegistryReader({ home: GROK_HOME, io: owned.io, platform, euid: TEST_UID }),
  };
}

describe("an entry", () => {
  test("keeps its ID, process, folder and time, and nothing else", () => {
    expect(entryOf(entry({ ipc: SECRET, name: SECRET }), "darwin")).toEqual({
      sessionId: SESSION_ID,
      pid: PID,
      cwd: PROJECT,
      openedAt: OPENED_AT,
    });
  });

  test("is passed over for an ID that cannot name a folder", () => {
    for (const id of ["..", ".", "a/b", "a\\b", "", "x".repeat(129), 7, null, "a b"]) {
      expect(entryOf(entry({ session_id: id }), "darwin"), String(id)).toBeNull();
    }
    expect(isGrokSessionId("my-session.1_x")).toBe(true);
  });

  test("is passed over for a process ID that is not one", () => {
    for (const pid of [0, -1, 1.5, "4242", null, 2 ** 31]) {
      expect(entryOf(entry({ pid }), "darwin"), String(pid)).toBeNull();
    }
    expect(entryOf(entry({ pid: 2 ** 31 - 1 }), "darwin")).not.toBeNull();
  });

  test("is passed over for a folder that is relative, too long or holds a control character", () => {
    for (const cwd of [
      "code/demo",
      "~/code",
      "",
      `/x/${"a".repeat(4096)}`,
      "/Users/example/a\nb",
      "/a\u0007b",
      3,
    ]) {
      expect(entryOf(entry({ cwd }), "darwin"), String(cwd)).toBeNull();
    }
    expect(entryOf(entry({ cwd: "C:\\Users\\example\\demo" }), "win32")).toMatchObject({
      cwd: "C:\\Users\\example\\demo",
    });
    expect(entryOf(entry({ cwd: "C:\\Users\\example\\demo" }), "darwin")).toBeNull();
  });

  test("is passed over for a time that is not one chrono writes", () => {
    for (const value of [
      "2026-11-18",
      "yesterday",
      1_700_000_000_000,
      "2026-13-01T00:00:00Z",
      "2026-02-30T00:00:00Z",
    ]) {
      expect(entryOf(entry({ opened_at: value }), "darwin"), String(value)).toBeNull();
    }
  });

  test("its time, to the second or with 3, 6 or 9 digits, in UTC or with an offset", () => {
    expect(openedAtOf("2026-11-18T11:50:00Z")).toBe(Date.UTC(2026, 10, 18, 11, 50));
    expect(openedAtOf("2026-11-18T11:50:00.250Z")).toBe(Date.UTC(2026, 10, 18, 11, 50, 0, 250));
    expect(openedAtOf("2026-11-18T11:50:00.250999Z")).toBe(Date.UTC(2026, 10, 18, 11, 50, 0, 250));
    expect(openedAtOf(openedAt(OPENED_AT))).toBe(OPENED_AT);
    expect(openedAtOf("2026-11-18T12:50:00+01:00")).toBe(Date.UTC(2026, 10, 18, 11, 50));
    expect(openedAtOf("2026-11-18T10:50:00-01:00")).toBe(Date.UTC(2026, 10, 18, 11, 50));
  });
});

describe("the list", () => {
  test("is the newest first, one entry for each session, the newer kept", () => {
    const list = parseRegistry(
      registryText([
        entry({ session_id: OTHER_SESSION_ID, opened_at: openedAt(OPENED_AT - MINUTE) }),
        entry({ pid: 1 }),
        entry({ pid: 2, opened_at: openedAt(OPENED_AT + MINUTE) }),
        entry({ session_id: "..", opened_at: openedAt(NOW) }),
      ]),
      "darwin",
    );
    expect(list?.map((item) => [item.sessionId, item.pid])).toEqual([
      [SESSION_ID, 2],
      [OTHER_SESSION_ID, PID],
    ]);
  });

  test("keeps at most 200 entries, the newest", () => {
    const many = Array.from({ length: MAX_ENTRIES + 5 }, (_, index) =>
      entry({ session_id: `s-${index}`, opened_at: openedAt(OPENED_AT + index * 1000) }),
    );
    const list = parseRegistry(registryText(many), "darwin");
    expect(list).toHaveLength(MAX_ENTRIES);
    expect(list?.[0]?.sessionId).toBe(`s-${MAX_ENTRIES + 4}`);
    expect(list?.at(-1)?.sessionId).toBe("s-5");
  });

  test("an empty file is an empty list, and text that is not a list is none", () => {
    expect(parseRegistry("", "darwin")).toEqual([]);
    expect(parseRegistry("  \n", "darwin")).toEqual([]);
    expect(parseRegistry("[", "darwin")).toBeNull();
    expect(parseRegistry("{}", "darwin")).toBeNull();
    expect(parseRegistry('[1, null, "x"]', "darwin")).toEqual([]);
  });
});

describe("reading the list", () => {
  test("reads it, and opens it again only when it changed", async () => {
    const files = memoryFiles();
    const { reader } = readerOf(files);
    writeRegistry(files, [entry()], NOW - MINUTE);
    expect(await reader.read()).toEqual({
      state: "ok",
      entries: [{ sessionId: SESSION_ID, pid: PID, cwd: PROJECT, openedAt: OPENED_AT }],
    });
    files.forget();
    await reader.read();
    expect(files.opened()).toEqual([]);
    writeRegistry(files, [], NOW - MINUTE);
    expect(await reader.read()).toEqual({ state: "ok", entries: [] });
    expect(files.opened()).toEqual([REGISTRY_FILE]);
  });

  test("a new file with the same size and time is read again", async () => {
    const files = memoryFiles();
    const { reader } = readerOf(files);
    writeRegistry(files, [entry({ pid: 1111 })], NOW - MINUTE);
    await reader.read();
    writeRegistry(files, [entry({ pid: 2222 })], NOW - MINUTE);
    expect(await reader.read()).toMatchObject({ state: "ok", entries: [{ pid: 2222 }] });
  });

  test("no file is no session", async () => {
    const { reader } = readerOf(memoryFiles());
    expect(await reader.read()).toEqual({ state: "missing" });
  });

  test("one over 1 MiB, or that does not parse, fails the poll", async () => {
    const files = memoryFiles();
    const { reader } = readerOf(files);
    files.write(REGISTRY_FILE, " ".repeat(MAX_REGISTRY_BYTES + 1));
    expect(await reader.read()).toEqual({ state: "error", why: "too-large" });
    files.write(REGISTRY_FILE, `[{"session_id": "${SESSION_ID}"`);
    expect(await reader.read()).toEqual({ state: "error", why: "broken" });
    expect(files.opened()).toEqual([REGISTRY_FILE]);
  });

  test("a link or a pipe is not opened, and nor is another user's file or one with a second name", async () => {
    const files = memoryFiles();
    const { owned, reader } = readerOf(files);
    files.special(REGISTRY_FILE);
    expect(await reader.read()).toEqual({ state: "error", why: "unreadable" });
    writeRegistry(files, [entry()]);
    owned.set(REGISTRY_FILE, { uid: OTHER_UID });
    expect(await reader.read()).toEqual({ state: "error", why: "unreadable" });
    owned.set(REGISTRY_FILE, { uid: TEST_UID, nlink: 2 });
    expect(await reader.read()).toEqual({ state: "error", why: "unreadable" });
    expect(files.opened()).toEqual([]);
  });

  test("a file read before is not trusted again once it has a second name", async () => {
    const files = memoryFiles();
    const { owned, reader } = readerOf(files);
    writeRegistry(files, [entry()]);
    expect(await reader.read()).toMatchObject({ state: "ok" });
    owned.set(REGISTRY_FILE, { nlink: 2 });
    expect(await reader.read()).toEqual({ state: "error", why: "unreadable" });
  });

  test("an open that fails is not kept", async () => {
    const files = memoryFiles();
    const { reader } = readerOf(files);
    writeRegistry(files, [entry()]);
    files.failOpen(REGISTRY_FILE);
    expect(await reader.read()).toEqual({ state: "error", why: "unreadable" });
    files.heal(REGISTRY_FILE);
    expect(await reader.read()).toMatchObject({ state: "ok", entries: [{ pid: PID }] });
  });
});
