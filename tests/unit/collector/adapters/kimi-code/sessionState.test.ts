import { describe, expect, test } from "vitest";

import {
  createStateReader,
  MAX_STATE_BYTES,
  parseSessionState,
} from "@collector/adapters/kimi-code/sessionState";
import {
  BUCKET,
  CREATED_AT,
  KIMI_HOME,
  NOW,
  PRIVATE_WORDS,
  PROJECT,
  sessionFolder,
  sessionIdOf,
  stateFields,
  stateFile,
  stateText,
  UPDATED_AT,
} from "@tests/fixtures/kimi-code/kimiCode";
import { memoryFiles, oneChangeEach } from "@tests/support/adapters/kimi-code/kimiCodeAdapter";

const ID = sessionIdOf(1);
const PLACE = { id: ID, bucket: BUCKET };

const parsed = (changes: Record<string, unknown> = {}, platform: NodeJS.Platform = "darwin") =>
  parseSessionState(stateText(ID, changes), platform);

describe("parseSessionState", () => {
  test("keeps the folder, the times and how the last turn ended", () => {
    expect(parsed()).toEqual({
      folder: PROJECT,
      ownName: null,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      lastTurnFailed: false,
      listed: true,
    });
    expect(parsed({ lastTurnReason: "failed" })?.lastTurnFailed).toBe(true);
  });

  test("keeps nothing of what was said", () => {
    expect(JSON.stringify(parsed())).not.toContain(PRIVATE_WORDS);
  });

  describe("the title", () => {
    test("is dropped when it is the default, the start of the first prompt", () => {
      expect(parsed({ titleKind: "replaceable", isCustomTitle: false })?.ownName).toBeNull();
    });

    test("is dropped when nothing says where it came from", () => {
      const { titleKind: _kind, isCustomTitle: _custom, ...rest } = stateFields(ID);
      expect(parseSessionState(JSON.stringify(rest), "darwin")?.ownName).toBeNull();
    });

    test("is kept when a person set it", () => {
      const set = { title: "demo release", titleKind: "custom", isCustomTitle: true };
      expect(parsed(set)?.ownName).toBe("demo release");
    });

    test("is kept when titleKind says a person set it, whatever isCustomTitle says", () => {
      const set = { title: "demo release", titleKind: "custom", isCustomTitle: false };
      expect(parsed(set)?.ownName).toBe("demo release");
    });

    test("is kept beside a `replaceable` an older writer left, as Kimi Code keeps it", () => {
      const set = { title: "demo release", titleKind: "replaceable", isCustomTitle: true };
      expect(parsed(set)?.ownName).toBe("demo release");
    });

    test("is kept when Kimi Code's model set it", () => {
      expect(parsed({ title: "demo release", titleKind: "generated" })?.ownName).toBe(
        "demo release",
      );
    });

    test("is kept from a file older than `titleKind`, as Kimi Code keeps it", () => {
      const { titleKind: _kind, ...rest } = stateFields(ID, {
        title: "demo release",
        isCustomTitle: true,
      });
      expect(parseSessionState(JSON.stringify(rest), "darwin")?.ownName).toBe("demo release");
    });

    test("is dropped for a session brought in from another program, whatever it says", () => {
      for (const custom of [{ imported_from: "claude-code" }, { imported_from_kimi_cli: true }]) {
        expect(parsed({ title: "x", titleKind: "generated", custom })?.ownName).toBeNull();
        expect(parsed({ title: "x", isCustomTitle: true, custom })?.ownName).toBeNull();
      }
    });

    test("that is not text is none", () => {
      expect(parsed({ title: 5, titleKind: "custom" })?.ownName).toBeNull();
    });
  });

  test("a session the person archived, and a child session, are not listed", () => {
    expect(parsed({ archived: true })?.listed).toBe(false);
    expect(parsed({ custom: { child_session_kind: "child" } })?.listed).toBe(false);
    expect(parsed({ custom: { child_session_kind: "other" } })?.listed).toBe(true);
  });

  test("a bad value in a field is treated as none", () => {
    expect(
      parsed({ cwd: "relative", createdAt: "soon", updatedAt: null, lastTurnReason: 3 }),
    ).toMatchObject({ folder: null, createdAt: null, updatedAt: null, lastTurnFailed: false });
    expect(parsed({ custom: "not a record" })?.listed).toBe(true);
    expect(parseSessionState('{"createdAt":1e999}', "darwin")?.createdAt).toBeNull();
  });

  test("keeps a folder by the system's own rules", () => {
    expect(parsed({ cwd: "C:\\code\\demo" }, "win32")?.folder).toBe("C:\\code\\demo");
    expect(parsed({ cwd: "C:\\code\\demo" }, "darwin")?.folder).toBeNull();
  });

  test("what is not a JSON object is no state", () => {
    for (const text of ["", "not json", "null", "[]", "5"]) {
      expect(parseSessionState(text, "darwin"), text).toBeNull();
    }
  });
});

describe("createStateReader", () => {
  const set = (changes: Record<string, unknown> = {}) => {
    const files = memoryFiles(() => NOW);
    files.write(stateFile(ID), stateText(ID, changes));
    const reader = createStateReader(KIMI_HOME, files.io, "darwin");
    return { files, reader };
  };
  const look = (files: ReturnType<typeof memoryFiles>) => files.io.lstat(stateFile(ID));

  test("opens a file only when it changed", async () => {
    const { files, reader } = set();
    await reader.read(PLACE, await look(files));
    await reader.read(PLACE, await look(files));
    expect(files.opened()).toEqual([stateFile(ID)]);

    files.write(stateFile(ID), stateText(ID, { lastTurnReason: "failed" }), { mtimeMs: NOW + 1 });
    const read = await reader.read(PLACE, await look(files));
    expect(read).toMatchObject({ state: "ok", session: { lastTurnFailed: true } });
  });

  test.each(oneChangeEach(stateText(ID), NOW))(
    "opens a file again when only its %s changes",
    async (_what, change) => {
      const { files, reader } = set();
      await reader.read(PLACE, await look(files));
      change(files, stateFile(ID));
      files.forget();
      await reader.read(PLACE, await look(files));
      expect(files.opened()).toEqual([stateFile(ID)]);
    },
  );

  test("a broken file is none, and is not opened again until it changes", async () => {
    const { files, reader } = set();
    files.write(stateFile(ID), "{ not json");
    expect(await reader.read(PLACE, await look(files))).toEqual({ state: "none" });
    await reader.read(PLACE, await look(files));
    expect(files.opened()).toHaveLength(1);
  });

  test("a file over the limit is not read", async () => {
    const { files, reader } = set();
    files.write(stateFile(ID), "x".repeat(MAX_STATE_BYTES + 1));
    expect(await reader.read(PLACE, await look(files))).toEqual({ state: "too-large" });
    expect(files.reads).toEqual([]);
    expect(files.openHandles()).toBe(0);
  });

  test("a link in place of the file, or of a folder on the way to it, is not opened", async () => {
    const { files, reader } = set();
    files.remove(stateFile(ID));
    files.special(stateFile(ID));
    expect(await reader.read(PLACE, await look(files))).toEqual({ state: "none" });

    const linked = memoryFiles(() => NOW);
    linked.special(sessionFolder(ID));
    const through = createStateReader(KIMI_HOME, linked.io, "darwin");
    expect(await through.read(PLACE, { kind: "file", size: 2, mtimeMs: NOW, ino: 1 })).toEqual({
      state: "none",
    });
    expect(linked.opened()).toEqual([]);
  });

  test("forgets every session it is told to", async () => {
    const { files, reader } = set();
    await reader.read(PLACE, await look(files));
    reader.keepOnly(new Set());
    await reader.read(PLACE, await look(files));
    expect(files.opened()).toHaveLength(2);
  });
});
