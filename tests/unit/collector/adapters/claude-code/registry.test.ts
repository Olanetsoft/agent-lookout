import { describe, expect, test } from "vitest";

import {
  isRegistryFileName,
  parseRegistryEntry,
  readRegistry,
  type RegistryIo,
} from "@collector/adapters/claude-code/registry";
import { ids, pids, registryFile } from "@tests/fixtures/claudeCode";

describe("isRegistryFileName", () => {
  test("only names that end in .json are registry files", () => {
    expect(isRegistryFileName("4242.json")).toBe(true);
    expect(isRegistryFileName("4242.0f3a9c1d.key")).toBe(false);
    expect(isRegistryFileName("4242.json.key")).toBe(false);
    expect(isRegistryFileName("4242.key")).toBe(false);
    expect(isRegistryFileName("4242.json.tmp")).toBe(false);
    expect(isRegistryFileName("4242")).toBe(false);
    expect(isRegistryFileName(".json")).toBe(false);
    expect(isRegistryFileName(".hidden.json")).toBe(false);
  });
});

describe("parseRegistryEntry", () => {
  test("keeps the fields the adapter uses", () => {
    expect(parseRegistryEntry(registryFile())).toEqual({
      pid: pids.busy,
      sessionId: ids.busy,
      cwd: "/Users/example/code/demo",
      startedAt: 1_700_000_000_000,
      kind: "interactive",
      entrypoint: "claude-vscode",
      name: "demo-project",
      status: "busy",
      statusUpdatedAt: 1_700_000_030_000,
      procStart: "Tue Nov 14 22:13:20 2023",
    });
  });

  test("times that are not whole numbers are dropped", () => {
    const entry = parseRegistryEntry(registryFile({ startedAt: 1.5, statusUpdatedAt: 0.25 }));
    expect(entry).not.toBeNull();
    expect(entry?.startedAt).toBeUndefined();
    expect(entry?.statusUpdatedAt).toBeUndefined();
  });

  test("a start time of the wrong type is dropped", () => {
    expect(
      parseRegistryEntry(registryFile({ procStart: 1_700_000_000 }))?.procStart,
    ).toBeUndefined();
  });

  test("a file with a stray closing brace is not an entry", () => {
    expect(parseRegistryEntry(`${registryFile()}}`)).toBeNull();
  });

  test("empty, cut-off and non-object content is not an entry", () => {
    expect(parseRegistryEntry("")).toBeNull();
    expect(parseRegistryEntry('{"pid": 4242, "sessionId": "0000')).toBeNull();
    expect(parseRegistryEntry("null")).toBeNull();
    expect(parseRegistryEntry("[]")).toBeNull();
    expect(parseRegistryEntry('"4242"')).toBeNull();
  });

  test("an entry needs a pid that could be a real process", () => {
    expect(parseRegistryEntry(registryFile({ pid: undefined }))).toBeNull();
    expect(parseRegistryEntry(registryFile({ pid: "4242" }))).toBeNull();
    expect(parseRegistryEntry(registryFile({ pid: 0 }))).toBeNull();
    expect(parseRegistryEntry(registryFile({ pid: -1 }))).toBeNull();
    expect(parseRegistryEntry(registryFile({ pid: 42.5 }))).toBeNull();
  });

  test("fields of the wrong type are dropped, not trusted", () => {
    const entry = parseRegistryEntry(
      registryFile({ entrypoint: 7, statusUpdatedAt: "yesterday", name: null, status: {} }),
    );
    expect(entry).not.toBeNull();
    expect(entry).toMatchObject({ pid: pids.busy, sessionId: ids.busy });
    expect(entry?.entrypoint).toBeUndefined();
    expect(entry?.statusUpdatedAt).toBeUndefined();
    expect(entry?.name).toBeUndefined();
    expect(entry?.status).toBeUndefined();
  });

  test("a file far larger than any registry entry is not parsed", () => {
    expect(parseRegistryEntry(registryFile({ padding: "x".repeat(300_000) }))).toBeNull();
  });
});

describe("readRegistry, with a stand-in for the folder", () => {
  test("a file that vanishes between the listing and the read is skipped", async () => {
    const io: RegistryIo = {
      readdir: async () => [`${pids.busy}.json`, `${pids.idle}.json`],
      readFile: async (file) => {
        if (file.endsWith(`${pids.idle}.json`)) {
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        }
        return registryFile();
      },
    };
    const registry = await readRegistry("/Users/example/.claude/sessions", io);
    expect(registry.readable && [...registry.entries.keys()]).toEqual([pids.busy]);
  });

  test("a file read while it is being written stands for the entry the last read found in it, once", async () => {
    const file = `${pids.busy}.json`;
    let content = registryFile({ pid: pids.busy, status: "busy" });
    const io: RegistryIo = { readdir: async () => [file], readFile: async () => content };
    const dir = "/Users/example/.claude/sessions";
    const parsedBy = (read: Awaited<ReturnType<typeof readRegistry>>) =>
      read.readable ? read.parsed : undefined;

    const first = await readRegistry(dir, io);
    // Emptied, and not yet written again.
    content = "";
    const second = await readRegistry(dir, io, parsedBy(first));
    expect(second.readable && second.entries.get(pids.busy)).toMatchObject({ status: "busy" });
    // Still not whole the next time: no longer stood in for.
    const third = await readRegistry(dir, io, parsedBy(second));
    expect(third.readable && [...third.entries.keys()]).toEqual([]);
  });

  test("a file that has gone since the last read is not stood in for", async () => {
    const io: RegistryIo = {
      readdir: async () => [`${pids.busy}.json`],
      readFile: async () => {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      },
    };
    const before = new Map([[`${pids.busy}.json`, { pid: pids.busy, status: "busy" }]]);
    const registry = await readRegistry("/Users/example/.claude/sessions", io, before);
    expect(registry.readable && [...registry.entries.keys()]).toEqual([]);
  });

  test("a directory that cannot be listed for another reason is unreadable, not missing", async () => {
    const io: RegistryIo = {
      readdir: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
      readFile: async () => "",
    };
    expect(await readRegistry("/Users/example/.claude/sessions", io)).toEqual({
      readable: false,
      missing: false,
    });
  });
});
