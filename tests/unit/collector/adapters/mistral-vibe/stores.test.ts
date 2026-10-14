import { describe, expect, test } from "vitest";

import {
  createStoreReader,
  isStoreName,
  legacyWrittenSince,
  readPointer,
  scanStores,
  STORE_FORMAT,
} from "@collector/adapters/mistral-vibe/stores";
import {
  CWD,
  DAY,
  HOUR,
  NOW,
  PRIVATE_WORDS,
  SESSION_DIR,
  SUBAGENT_ID,
  current,
  document,
  generationName,
  journalPath,
  sessionId,
  storePath,
} from "@tests/fixtures/mistralVibe";
import { memoryFiles, writeStore } from "@tests/support/adapters/mistralVibeAdapter";
import { asWritten } from "@tests/support/paths";

const STORES = `${SESSION_DIR}/unified`;
const A = sessionId("a1");

const generationOf = (id: string, sequence = 4) =>
  `${SESSION_DIR}/${storePath(id)}/generations/${generationName(sequence)}`;

describe("what CURRENT says", () => {
  const pointer = (fields: Record<string, unknown>) =>
    readPointer(
      {
        store_format: STORE_FORMAT,
        store_format_minor: 8,
        session_id: A,
        generation: generationName(4),
        ...fields,
      },
      A,
    );

  test("the generation it names and the store's minor, 1 when it gives none", () => {
    expect(pointer({})).toEqual({ generation: generationName(4), minor: 8 });
    expect(pointer({ store_format_minor: 7 })).toEqual({ generation: generationName(4), minor: 7 });
    expect(pointer({ store_format_minor: undefined })).toEqual({
      generation: generationName(4),
      minor: 1,
    });
  });

  test("another store format, another session's, or a generation that is not 16 digits is not read", () => {
    expect(pointer({ store_format: "mistral.vibe.unified-session-store/v2" })).toBeNull();
    expect(pointer({ session_id: sessionId("b1") })).toBeNull();
    expect(pointer({ generation: "4" })).toBeNull();
    expect(pointer({ generation: "../0000000000004" })).toBeNull();
    expect(pointer({ store_format_minor: true })).toBeNull();
    expect(pointer({ store_format_minor: 0 })).toBeNull();
    expect(readPointer([], A)).toBeNull();
  });
});

describe("a session's store", () => {
  test("gives its generation, the journal segment it names, its state, folder and kind", async () => {
    const files = memoryFiles();
    writeStore(files, {
      id: A,
      state: { id: A, status: "running", title: "demo-project refactor" },
    });
    const read = await createStoreReader(STORES, files.io).read(A);
    expect(read.state).toBe("ok");
    if (read.state !== "ok") return;
    expect(read.store).toEqual({
      generation: generationName(4),
      tooNew: false,
      journal: "journal/0000000000000005.jsonl",
      snapshot: expect.objectContaining({ statusType: "running", title: "demo-project refactor" }),
      cwd: CWD,
      kind: "root",
      deleting: false,
    });
    expect(JSON.stringify(read.store)).not.toContain(PRIVATE_WORDS);
  });

  test("never opens the conversation, its chunks, the sidecar or Vibe's index", async () => {
    const files = memoryFiles();
    writeStore(files, { id: A });
    files.write(`${STORES}/.session-index.json`, document({ sessions: [PRIVATE_WORDS] }));
    await createStoreReader(STORES, files.io).read(A);
    expect(files.opened()).toEqual([
      `${SESSION_DIR}/${storePath(A)}/CURRENT`,
      `${generationOf(A)}/manifest.json`,
      `${generationOf(A)}/projection-state.json`,
      `${generationOf(A)}/runtime-state.json`,
    ]);
  });

  test("reads a generation once, and CURRENT again only when it changes", async () => {
    const files = memoryFiles();
    writeStore(files, { id: A });
    const reader = createStoreReader(STORES, files.io);
    await reader.read(A);
    files.forget();
    await reader.read(A);
    expect(files.opened()).toEqual([]);

    // Vibe saves the session again: a new generation, and CURRENT replaced.
    writeStore(files, { id: A, sequence: 9, state: { id: A, status: "idle", title: "renamed" } });
    files.forget();
    const read = await reader.read(A);
    expect(read.state === "ok" && read.store.generation).toBe(generationName(9));
    expect(read.state === "ok" && read.store.snapshot?.title).toBe("renamed");
    expect(files.opened()).toContain(`${generationOf(A, 9)}/manifest.json`);
  });

  test("minor 7 and minor 8 are read, a higher minor is a store too new for its status", async () => {
    for (const minor of [7, 8]) {
      const files = memoryFiles();
      writeStore(files, { id: A, minor });
      const read = await createStoreReader(STORES, files.io).read(A);
      expect(read.state === "ok" && read.store.tooNew, `minor ${minor}`).toBe(false);
    }
    const files = memoryFiles();
    writeStore(files, { id: A, minor: 9 });
    const read = await createStoreReader(STORES, files.io).read(A);
    expect(read.state === "ok" && read.store).toMatchObject({ tooNew: true, cwd: CWD });
  });

  test("a newer Vibe's generation that does not read as this one's still gives the session, with nothing more", async () => {
    const files = memoryFiles();
    writeStore(files, { id: A, minor: 9 });
    files.rewrite(`${generationOf(A)}/manifest.json`, "a format this adapter cannot read");
    const read = await createStoreReader(STORES, files.io).read(A);
    expect(read.state === "ok" && read.store).toEqual({
      generation: generationName(4),
      tooNew: true,
      journal: null,
      snapshot: null,
      cwd: null,
      kind: null,
      deleting: false,
    });
  });

  test("a CURRENT of another format, another session or no generation is not a store it reads", async () => {
    const files = memoryFiles();
    writeStore(files, { id: A, storeFormat: "mistral.vibe.unified-session-store/v2" });
    expect((await createStoreReader(STORES, files.io).read(A)).state).toBe("invalid");
    files.rewrite(`${SESSION_DIR}/${storePath(A)}/CURRENT`, current({ id: sessionId("b1") }));
    expect((await createStoreReader(STORES, files.io).read(A)).state).toBe("invalid");
    files.rewrite(`${SESSION_DIR}/${storePath(A)}/CURRENT`, "not json");
    expect((await createStoreReader(STORES, files.io).read(A)).state).toBe("invalid");
  });

  test("no CURRENT is no store: a session not saved yet, or one deleted", async () => {
    const files = memoryFiles();
    expect((await createStoreReader(STORES, files.io).read(A)).state).toBe("missing");
    files.mkdir(`${SESSION_DIR}/${storePath(A)}`);
    expect((await createStoreReader(STORES, files.io).read(A)).state).toBe("missing");
  });

  test("a generation that goes while it is read sends it back to CURRENT once, which names the next", async () => {
    const files = memoryFiles();
    writeStore(files, { id: A, sequence: 4 });
    writeStore(files, { id: A, sequence: 6, state: { id: A, status: "idle", title: "newer" } });
    // CURRENT still names 4 when it is first read, and 6 by the time it is read again.
    const root = `${SESSION_DIR}/${storePath(A)}`;
    files.rewrite(`${root}/CURRENT`, current({ id: A, sequence: 4 }));
    files.remove(generationOf(A, 4));
    let reads = 0;
    const io = {
      ...files.io,
      async openRegular(file: string) {
        if (asWritten(file) === `${root}/CURRENT` && ++reads === 2) {
          files.rewrite(`${root}/CURRENT`, current({ id: A, sequence: 6 }));
        }
        return files.io.openRegular(file);
      },
    };
    const read = await createStoreReader(STORES, io).read(A);
    expect(read.state === "ok" && read.store.snapshot?.title).toBe("newer");
  });

  test("a generation gone for good keeps what was read before, until the next poll", async () => {
    const files = memoryFiles();
    writeStore(files, { id: A, sequence: 4, state: { id: A, title: "before" } });
    const reader = createStoreReader(STORES, files.io);
    await reader.read(A);
    // CURRENT moves to a generation that is not there.
    files.rewrite(`${SESSION_DIR}/${storePath(A)}/CURRENT`, current({ id: A, sequence: 7 }), {
      mtimeMs: NOW + 1,
    });
    const read = await reader.read(A);
    expect(read.state === "ok" && read.store.snapshot?.title).toBe("before");
    // With nothing read before, there is nothing to show.
    expect((await createStoreReader(STORES, files.io).read(A)).state).toBe("unreadable");
  });

  test("a public state that still holds its history, with no chunks, is read the same, and keeps none of it", async () => {
    const files = memoryFiles();
    writeStore(files, {
      id: A,
      state: { id: A, status: "running", title: "demo-project refactor" },
    });
    const file = `${generationOf(A)}/projection-state.json`;
    const projection = JSON.parse(new TextDecoder().decode(await read(files, file)));
    projection.snapshot.history.entries = [{ id: "entry-1", type: "message", text: PRIVATE_WORDS }];
    files.rewrite(file, document(projection));
    const result = await createStoreReader(STORES, files.io).read(A);
    expect(result.state === "ok" && result.store.snapshot?.statusType).toBe("running");
    expect(JSON.stringify(result)).not.toContain(PRIVATE_WORDS);
  });

  // The limits PRIVACY.md gives. Each file is padded with spaces JSON allows,
  // so it would read as it is but for its size.
  test.each([
    {
      file: "CURRENT",
      at: () => `${SESSION_DIR}/${storePath(A)}/CURRENT`,
      limit: 4 * 1024,
      expected: { state: "invalid" },
      opened: 1,
    },
    {
      file: "manifest.json",
      at: () => `${generationOf(A)}/manifest.json`,
      limit: 256 * 1024,
      expected: { state: "unreadable" },
      opened: 2,
    },
    {
      file: "projection-state.json",
      at: () => `${generationOf(A)}/projection-state.json`,
      limit: 4 * 1024 * 1024,
      expected: { state: "ok", store: { snapshot: null, cwd: CWD } },
      opened: 4,
    },
    {
      file: "runtime-state.json",
      at: () => `${generationOf(A)}/runtime-state.json`,
      limit: 8 * 1024 * 1024,
      expected: {
        state: "ok",
        store: { snapshot: expect.objectContaining({ statusType: "idle" }), cwd: null },
      },
      opened: 4,
    },
  ])(
    "a $file larger than its limit, $limit bytes, is not read",
    async ({ at, limit, expected, opened }) => {
      const files = memoryFiles();
      writeStore(files, { id: A });
      const file = at();
      const bytes = await read(files, file);
      const padding = " ".repeat(limit + 1 - bytes.byteLength);
      files.rewrite(file, `${padding}${new TextDecoder().decode(bytes)}`);
      files.forget();
      const result = await createStoreReader(STORES, files.io).read(A);
      expect(result).toMatchObject(expected);
      // The file is opened and never read, and nothing that needs it is opened after it.
      expect(files.opened()).toHaveLength(opened);
      expect(files.reads.filter((each) => each.path === file)).toEqual([]);
    },
  );

  test("a manifest that names the conversation for a file it reads names nothing it opens", async () => {
    const files = memoryFiles();
    writeStore(files, { id: A });
    const manifest = JSON.parse(
      new TextDecoder().decode(await read(files, `${generationOf(A)}/manifest.json`)),
    );
    manifest.projection_state.path = "checkpoint.json";
    manifest.runtime_state.path = "checkpoint.json";
    files.rewrite(`${generationOf(A)}/manifest.json`, document(manifest));
    files.forget();
    const result = await createStoreReader(STORES, files.io).read(A);
    expect(result.state === "ok" && result.store).toMatchObject({ snapshot: null, cwd: null });
    expect(files.opened().some((file) => file.endsWith("checkpoint.json"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_WORDS);
  });

  test("a subagent, a fork and a session being deleted say so", async () => {
    const files = memoryFiles();
    const B = sessionId("b1");
    const C = sessionId("c1");
    writeStore(files, { id: A, kind: "subagent" });
    writeStore(files, { id: B, kind: "fork" });
    writeStore(files, { id: C, lifecycle: "deleting_tree" });
    const reader = createStoreReader(STORES, files.io);
    const [a, b, c] = await Promise.all([reader.read(A), reader.read(B), reader.read(C)]);
    expect(a.state === "ok" && a.store.kind).toBe("subagent");
    expect(b.state === "ok" && b.store.kind).toBe("fork");
    expect(c.state === "ok" && c.store.deleting).toBe(true);
  });

  test("a manifest naming a journal outside the store, or a generation file that is a path, is not followed", async () => {
    const files = memoryFiles();
    writeStore(files, { id: A });
    const manifest = JSON.parse(
      String(new TextDecoder().decode(await read(files, `${generationOf(A)}/manifest.json`))),
    );
    manifest.recovery_journal_segment.path = "../elsewhere/0000000000000005.jsonl";
    manifest.runtime_state.path = "../../elsewhere.json";
    files.rewrite(`${generationOf(A)}/manifest.json`, document(manifest));
    const result = await createStoreReader(STORES, files.io).read(A);
    expect(result.state === "ok" && result.store).toMatchObject({ journal: null, cwd: null });
    expect(files.opened().some((file) => file.includes("elsewhere"))).toBe(false);
  });
});

async function read(files: ReturnType<typeof memoryFiles>, file: string) {
  const handle = await files.io.openRegular(file);
  try {
    return await handle.read(0, handle.info.size);
  } finally {
    await handle.close();
  }
}

describe("looking through unified/", () => {
  test("names each session's store with when Vibe last wrote to its CURRENT or a journal segment", async () => {
    const files = memoryFiles();
    const B = sessionId("b1");
    const C = sessionId("c1");
    writeStore(files, { id: A });
    writeStore(files, { id: B });
    writeStore(files, { id: C });
    files.rewrite(`${SESSION_DIR}/${storePath(B)}/CURRENT`, current({ id: B }), {
      mtimeMs: NOW - DAY,
    });
    files.rewrite(`${SESSION_DIR}/${journalPath(B)}`, "", { mtimeMs: NOW - 2 * DAY });
    // A rename journaled with no save after it, beside the segment before.
    const journalOfC = `${SESSION_DIR}/${storePath(C)}/journal`;
    files.rewrite(`${SESSION_DIR}/${storePath(C)}/CURRENT`, current({ id: C }), {
      mtimeMs: NOW - 2 * DAY,
    });
    files.rewrite(`${SESSION_DIR}/${journalPath(C)}`, "", { mtimeMs: NOW - HOUR });
    files.write(`${journalOfC}/0000000000000001.jsonl`, "", { mtimeMs: NOW - 3 * DAY });
    // Anything else there is not a segment, and a link is not followed.
    files.write(`${journalOfC}/0000000000000009.jsonl.tmp`, "");
    files.special(`${journalOfC}/0000000000000010.jsonl`);
    expect(await scanStores(STORES, files.io)).toEqual({
      state: "ok",
      written: new Map([
        [A, NOW],
        [B, NOW - DAY],
        [C, NOW - HOUR],
      ]),
    });
    expect(files.opened()).toEqual([]);
  });

  test("leaves out Vibe's index, temporary files, subagents, links and folders with no CURRENT", async () => {
    const files = memoryFiles();
    writeStore(files, { id: A });
    writeStore(files, { id: SUBAGENT_ID });
    files.write(`${STORES}/.session-index.json`, "{}");
    files.write(`${STORES}/.CURRENT.0123456789abcdef.tmp`, "{}");
    files.special(`${STORES}/${sessionId("b1")}`);
    files.mkdir(`${STORES}/${sessionId("c1")}`);
    files.mkdir(`${STORES}/not a session`);
    const scan = await scanStores(STORES, files.io);
    expect(scan.state === "ok" && [...scan.written.keys()]).toEqual([A]);
    expect(files.opened()).toEqual([]);
  });

  test("says whether the folder is missing or cannot be listed", async () => {
    const files = memoryFiles();
    expect(await scanStores(STORES, files.io)).toEqual({ state: "missing" });
    files.mkdir(STORES);
    files.fail(STORES);
    expect(await scanStores(STORES, files.io)).toEqual({ state: "unreadable" });
  });

  test("the names of stores are session ids, not hidden and not a subagent's", () => {
    expect(isStoreName(A)).toBe(true);
    expect(isStoreName("my-session_2")).toBe(true);
    for (const name of [".session-index.json", SUBAGENT_ID, "-x", "a b", ""]) {
      expect(isStoreName(name), name).toBe(false);
    }
  });
});

describe("sessions the older engine saved", () => {
  test("a folder saved since then is found, newest first, and nothing in it is opened", async () => {
    const files = memoryFiles();
    files.write(`${SESSION_DIR}/session_20260930_101500_0a1b2c3d/meta.json`, "{}");
    files.write(`${SESSION_DIR}/session_20261001_090000_1a2b3c4d/meta.json`, "{}");
    files.touch(`${SESSION_DIR}/session_20260930_101500_0a1b2c3d`, NOW - 3 * DAY);
    files.touch(`${SESSION_DIR}/session_20261001_090000_1a2b3c4d`, NOW - HOUR);
    expect(await legacyWrittenSince(SESSION_DIR, files.io, NOW - DAY)).toBe(NOW - HOUR);
    expect(files.count("lstat")).toBe(1);
    expect(await legacyWrittenSince(SESSION_DIR, files.io, NOW)).toBeNull();
    expect(files.opened()).toEqual([]);
  });

  test("a custom prefix is found too, and Vibe's other folders are not taken for sessions", async () => {
    const files = memoryFiles();
    files.write(`${SESSION_DIR}/work_20261001_090000_1a2b3c4d/meta.json`, "{}");
    files.touch(`${SESSION_DIR}/work_20261001_090000_1a2b3c4d`, NOW - HOUR);
    files.mkdir(`${SESSION_DIR}/unified`);
    files.mkdir(`${SESSION_DIR}/active`);
    files.mkdir(`${SESSION_DIR}/.last_session`);
    expect(await legacyWrittenSince(SESSION_DIR, files.io, NOW - DAY)).toBe(NOW - HOUR);
    files.remove(`${SESSION_DIR}/work_20261001_090000_1a2b3c4d`);
    expect(await legacyWrittenSince(SESSION_DIR, files.io, 0)).toBeNull();
  });
});
