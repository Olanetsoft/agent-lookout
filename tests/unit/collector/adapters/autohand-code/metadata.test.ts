import { describe, expect, test } from "vitest";

import {
  createMetadataReader,
  MAX_METADATA_BYTES,
  metadataOf,
} from "@collector/adapters/autohand-code/metadata";
import {
  CREATED_AT,
  MINUTE,
  NOW,
  PROJECT,
  SECOND,
  SESSIONS_DIR,
  SESSION_ID,
  importedMetadata,
  metadata,
  metadataPath,
  metadataRecord,
  sessionDir,
  transferredMetadata,
  written,
  writtenEscaped,
} from "@tests/fixtures/autohand-code/autohandCode";
import {
  memoryFiles,
  OTHER_UID,
  ownedFiles,
  TEST_UID,
  writeMetadata,
  type MemoryFiles,
} from "@tests/support/adapters/autohand-code/autohandCodeAdapter";

const of = (text: string) => metadataOf(Buffer.from(text), "darwin");

describe("metadataOf", () => {
  test("finds the kept fields of a session's metadata.json, as bytes", () => {
    expect(of(metadata({ status: "completed", closedAt: NOW - MINUTE }))).toEqual({
      status: "completed",
      createdAt: CREATED_AT,
      lastActiveAt: NOW - 30 * SECOND,
      closedAt: NOW - MINUTE,
      importedAt: null,
      projectPath: PROJECT,
      title: null,
      client: "terminal",
    });
    expect(of(metadata({ status: "crashed", client: "vscode" }))).toMatchObject({
      status: "crashed",
      client: "vscode",
      closedAt: null,
    });
    expect(of(metadata({ client: "acp" }))?.client).toBeNull();
    expect(of(metadata({ status: "paused" }))?.status).toBe("other");
    expect(of(metadata({ automode: true }))?.status).toBe("active");
  });

  test("reads a title only when titleSource says you gave it", () => {
    expect(of(metadata({ titleSource: "user", title: "Fix the login form" }))?.title).toBe(
      "Fix the login form",
    );
    expect(
      of(writtenEscaped(metadataRecord({ titleSource: "user", title: "Café menu" })))?.title,
    ).toBe("Café menu");
    // Autohand Code's own title can be your first words.
    expect(of(metadata({ titleSource: "auto" }))?.title).toBeNull();
    // The words in the summary, where JSON escapes them, are not the key.
    expect(of(metadata())?.title).toBeNull();
    // A fork keeps the name you gave the session it came from.
    expect(of(metadata({ fork: true, titleSource: "user", title: "Billing" }))?.title).toBe(
      "Billing",
    );
  });

  test("a status in the summary is not the session's", () => {
    expect(of(metadata({ status: "active" }))?.status).toBe("active");
  });

  test("reads an import and a web transfer, whose keys come in other orders", () => {
    expect(
      of(importedMetadata({ importedAt: NOW - MINUTE, closedAt: NOW - 2 * MINUTE })),
    ).toMatchObject({ status: "completed", importedAt: NOW - MINUTE, closedAt: NOW - 2 * MINUTE });
    expect(of(transferredMetadata({ importedAt: NOW - MINUTE }))).toMatchObject({
      status: "completed",
      importedAt: NOW - MINUTE,
      closedAt: null,
      client: null,
      projectPath: PROJECT,
    });
    // An `importedAt` outside `importedFrom` is not the import's.
    const elsewhere = written({
      status: "completed",
      note: { importedAt: "2026-11-10T11:59:00.000Z" },
    });
    expect(of(elsewhere)?.importedAt).toBeNull();
  });

  test("a file cut off as it was written, or with no status, is not read", () => {
    expect(of(metadata().slice(0, -30))).toBeNull();
    expect(of(written({ sessionId: SESSION_ID }))).toBeNull();
    expect(of("")).toBeNull();
    expect(of(JSON.stringify(metadataRecord()))).toBeNull();
  });
});

function reader(files: MemoryFiles, owned = ownedFiles(files)) {
  return createMetadataReader({
    sessionsDir: SESSIONS_DIR,
    io: owned.io,
    platform: "darwin",
    euid: TEST_UID,
  });
}

const lstatOf = async (files: MemoryFiles, owned = ownedFiles(files)) =>
  owned.io.lstat(metadataPath());

describe("the metadata reader", () => {
  test("opens a metadata.json only when it changed", async () => {
    const files = memoryFiles();
    writeMetadata(files, metadata());
    const metadataReader = reader(files);
    expect((await metadataReader.read(SESSION_ID, await lstatOf(files))).state).toBe("ok");
    await metadataReader.read(SESSION_ID, await lstatOf(files));
    expect(files.opened()).toHaveLength(1);
    writeMetadata(files, metadata({ status: "completed" }), { mtimeMs: NOW + SECOND });
    const changed = await metadataReader.read(SESSION_ID, await lstatOf(files));
    expect(changed.state === "ok" && changed.facts.status).toBe("completed");
    expect(files.opened()).toHaveLength(2);
  });

  test("takes the time the file had as it was opened, never one before its lookup's", async () => {
    const files = memoryFiles();
    writeMetadata(files, metadata({ status: "active" }), { mtimeMs: NOW - MINUTE });
    const looked = await lstatOf(files);
    // Written again between the lookup and the open, in place.
    files.rewrite(metadataPath(), metadata({ status: "crashed" }), { mtimeMs: NOW });
    const read = await reader(files).read(SESSION_ID, looked);
    expect(read).toMatchObject({ state: "ok", writtenAt: NOW, facts: { status: "crashed" } });

    const back = memoryFiles();
    writeMetadata(back, metadata(), { mtimeMs: NOW - MINUTE });
    const later = { ...(await lstatOf(back)), mtimeMs: NOW };
    expect(await reader(back).read(SESSION_ID, later)).toMatchObject({ writtenAt: NOW });
  });

  test("never opens one over 1 MiB by its lstat", async () => {
    const files = memoryFiles();
    writeMetadata(files, written({ status: "active", pad: "p".repeat(MAX_METADATA_BYTES) }));
    const metadataReader = reader(files);
    for (let read = 0; read < 2; read += 1) {
      expect(await metadataReader.read(SESSION_ID, await lstatOf(files))).toEqual({
        state: "too-large",
      });
    }
    expect(files.opened()).toEqual([]);
    expect(files.reads).toEqual([]);
  });

  test("reads none in a folder that is a link or another user's, nor one with a second name or another user's", async () => {
    const cases: [string, Partial<{ uid: number; nlink: number }>][] = [
      [sessionDir(), { uid: OTHER_UID }],
      [metadataPath(), { uid: OTHER_UID }],
      [metadataPath(), { nlink: 2 }],
    ];
    for (const [target, mark] of cases) {
      const files = memoryFiles();
      const owned = ownedFiles(files);
      writeMetadata(files, metadata());
      const looked = await lstatOf(files);
      owned.set(target, mark);
      expect(await reader(files, owned).read(SESSION_ID, looked), target).toEqual({
        state: "none",
      });
      expect(files.reads, target).toEqual([]);
    }
    const files = memoryFiles();
    writeMetadata(files, metadata());
    const looked = await lstatOf(files);
    files.remove(sessionDir());
    files.special(sessionDir());
    expect(await reader(files).read(SESSION_ID, looked)).toEqual({ state: "none" });
  });

  test("a folder or file found one it would not read as metadata.json is opened is not kept, so it is read once it is the user's again", async () => {
    const cases: [string, Partial<{ uid: number; nlink: number }>, number][] = [
      [sessionDir(), { uid: OTHER_UID }, 1],
      [metadataPath(), { uid: OTHER_UID }, 2],
      [metadataPath(), { nlink: 2 }, 2],
    ];
    for (const [target, mark, opens] of cases) {
      const files = memoryFiles();
      const owned = ownedFiles(files);
      writeMetadata(files, metadata({ status: "crashed" }));
      const metadataReader = reader(files, owned);
      const looked = await lstatOf(files, owned);
      // Another user's, or given a second name, after the poll looked it up.
      owned.set(target, mark);
      expect(await metadataReader.read(SESSION_ID, looked), target).toEqual({ state: "none" });
      owned.clear(target);
      const back = await metadataReader.read(SESSION_ID, await lstatOf(files, owned));
      expect(back.state === "ok" && back.facts.status, target).toBe("crashed");
      expect(files.opened(), target).toHaveLength(opens);
    }
  });

  test("one cut off as it was written stands in from the read before, once", async () => {
    const files = memoryFiles();
    writeMetadata(files, metadata({ status: "crashed" }));
    const metadataReader = reader(files);
    await metadataReader.read(SESSION_ID, await lstatOf(files));
    writeMetadata(files, metadata().slice(0, 40), { mtimeMs: NOW + SECOND });
    const standIn = await metadataReader.read(SESSION_ID, await lstatOf(files));
    expect(standIn.state === "ok" && standIn.facts.status).toBe("crashed");
    expect(await metadataReader.read(SESSION_ID, await lstatOf(files))).toEqual({
      state: "broken",
    });
  });

  test("one that could not be read stands in from before once, and is opened again on the next poll", async () => {
    const files = memoryFiles();
    writeMetadata(files, metadata({ status: "crashed" }));
    const metadataReader = reader(files);
    await metadataReader.read(SESSION_ID, await lstatOf(files));
    writeMetadata(files, metadata({ status: "completed" }), { mtimeMs: NOW + SECOND });
    files.failOpen(metadataPath());
    const standIn = await metadataReader.read(SESSION_ID, await lstatOf(files));
    expect(standIn.state === "ok" && standIn.facts.status).toBe("crashed");
    expect(await metadataReader.read(SESSION_ID, await lstatOf(files))).toEqual({ state: "none" });
    files.heal(metadataPath());
    const healed = await metadataReader.read(SESSION_ID, await lstatOf(files));
    expect(healed.state === "ok" && healed.facts.status).toBe("completed");
  });

  test("forgets what it read of a session it is told to", async () => {
    const files = memoryFiles();
    writeMetadata(files, metadata());
    const metadataReader = reader(files);
    await metadataReader.read(SESSION_ID, await lstatOf(files));
    metadataReader.keepOnly(new Set());
    await metadataReader.read(SESSION_ID, await lstatOf(files));
    expect(files.opened()).toHaveLength(2);
  });
});
