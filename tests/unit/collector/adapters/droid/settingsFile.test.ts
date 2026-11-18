import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  archivedIn,
  createSettingsReader,
  holdsArchivedAt,
  looksWhole,
  MAX_SETTINGS_BYTES,
  settingsPathFor,
} from "@collector/adapters/droid/settingsFile";
import type { FileInfo, OpenFile, ReadOnlyIo } from "@collector/files/readOnlyIo";
import {
  NOW,
  PRIVATE_TAG,
  PROJECT_FOLDER,
  SECOND,
  SESSION_ID,
  sessionPath,
  SESSIONS,
  settings,
  settingsPath,
} from "@tests/fixtures/droid/droid";
import { memoryFiles, type MemoryFiles } from "@tests/support/adapters/droid/droidAdapter";
import { watchDecodingWhile } from "@tests/support/adapters/unreal-agent/decodeSpy";
import { asWritten } from "@tests/support/paths";

const SETTINGS = settingsPath();
const ARCHIVED = settings({ archivedAt: "2026-09-01T00:00:00Z" });

const readerOf = (files: MemoryFiles) => createSettingsReader(SESSIONS, files.io);

describe("the settings file's place and bytes", () => {
  test("is beside the session's file, named for its ID, and never outside that folder", () => {
    expect(asWritten(settingsPathFor(sessionPath(), SESSION_ID))).toBe(SETTINGS);
    expect(asWritten(settingsPathFor(sessionPath(SESSION_ID, SESSIONS), SESSION_ID))).toBe(
      `${SESSIONS}/${SESSION_ID}.settings.json`,
    );
    // An ID has no folder in it, so its settings file stays in the session's folder.
    const odd = settingsPathFor(sessionPath("a..b"), "a..b");
    expect(asWritten(path.dirname(odd))).toBe(PROJECT_FOLDER);
  });

  test("looks whole when it ends as a JSON object does", () => {
    expect(looksWhole(Buffer.from("{}"))).toBe(true);
    expect(looksWhole(Buffer.from('{"a":1}\n \t\r\n'))).toBe(true);
    for (const text of ["", "  ", '{"a":1', '{"a":"}"', "[]", "{}x"]) {
      expect(looksWhole(Buffer.from(text)), text).toBe(false);
    }
  });

  test('holds "archivedAt" only as a key or a value', () => {
    expect(holdsArchivedAt(Buffer.from(ARCHIVED))).toBe(true);
    expect(holdsArchivedAt(Buffer.from(settings()))).toBe(false);
    expect(holdsArchivedAt(Buffer.from(settings({ tags: [{ name: '"archivedAt"' }] })))).toBe(
      false,
    );
  });

  test("marks a session archived only when archivedAt is text that is not empty", () => {
    expect(archivedIn(ARCHIVED)).toBe(true);
    expect(archivedIn(settings({ archivedAt: "x" }))).toBe(true);
    for (const archivedAt of ["", true, 1, null, ["2026"], { at: "2026" }, undefined]) {
      expect(archivedIn(settings({ archivedAt })), String(archivedAt)).toBe(false);
    }
    for (const text of ["", "[]", "null", "5", '"x"', "{", "{} {}"]) {
      expect(archivedIn(text), text).toBeUndefined();
    }
  });
});

describe("reading a settings file", () => {
  test("keeps only a yes or no, and never decodes a whole file without archivedAt", async () => {
    const files = memoryFiles();
    files.write(SETTINGS, settings());
    const reader = readerOf(files);
    let answer: boolean | undefined;
    const seen = await watchDecodingWhile(async () => {
      answer = await reader.archived(SETTINGS);
    });
    expect(answer).toBe(false);
    for (const text of seen) expect(text).not.toContain(PRIVATE_TAG);
    expect(files.reads).toEqual([
      { path: asWritten(SETTINGS), position: 0, length: MAX_SETTINGS_BYTES + 1 },
    ]);
    expect(files.openHandles()).toBe(0);
  });

  test("leaves a session listed when its settings file is missing, a link or larger than 16 KiB, and opens none of them", async () => {
    const files = memoryFiles();
    const reader = readerOf(files);
    expect(await reader.archived(SETTINGS)).toBe(false);
    files.special(SETTINGS);
    expect(await reader.archived(SETTINGS)).toBe(false);
    files.write(SETTINGS, ARCHIVED + " ".repeat(MAX_SETTINGS_BYTES + 1 - ARCHIVED.length));
    expect((await files.io.lstat(SETTINGS)).size).toBe(MAX_SETTINGS_BYTES + 1);
    expect(await reader.archived(SETTINGS)).toBe(false);
    expect(files.count("openRegular")).toBe(0);

    // At the limit it is read.
    files.write(SETTINGS, ARCHIVED + " ".repeat(MAX_SETTINGS_BYTES - ARCHIVED.length));
    expect(await reader.archived(SETTINGS)).toBe(true);
  });

  test("reads no more than 16 KiB and a byte, and refuses a file that gives more than its lstat said", async () => {
    const files = memoryFiles();
    files.write(SETTINGS, ARCHIVED);
    const big = new Uint8Array(MAX_SETTINGS_BYTES + 1).fill(0x20);
    const io: ReadOnlyIo = {
      ...files.io,
      async openRegular(target): Promise<OpenFile> {
        const file = await files.io.openRegular(target);
        return {
          info: file.info,
          close: () => file.close(),
          async read(position, length) {
            expect(position + length).toBeLessThanOrEqual(MAX_SETTINGS_BYTES + 1);
            const bytes = new Uint8Array(big);
            bytes.set(new TextEncoder().encode(ARCHIVED));
            return bytes.slice(position, position + length);
          },
        };
      },
    };
    expect(await createSettingsReader(SESSIONS, io).archived(SETTINGS)).toBe(false);
    expect(files.openHandles()).toBe(0);
  });

  test("reads nothing of a file that grew past 16 KiB between its lstat and its open", async () => {
    const files = memoryFiles();
    files.write(SETTINGS, ARCHIVED);
    const io: ReadOnlyIo = {
      ...files.io,
      async lstat(target) {
        const info = await files.io.lstat(target);
        // Written larger just after it was looked up, in place.
        if (asWritten(target) === SETTINGS) {
          files.rewrite(SETTINGS, ARCHIVED + " ".repeat(MAX_SETTINGS_BYTES), {
            mtimeMs: info.mtimeMs,
          });
        }
        return info;
      },
    };
    expect(await createSettingsReader(SESSIONS, io).archived(SETTINGS)).toBe(false);
    expect(files.count("openRegular")).toBe(1);
    expect(files.reads).toEqual([]);
    expect(files.openHandles()).toBe(0);
  });

  test("opens a file again only when its size, modified time or identity changes, and looks it up on every poll", async () => {
    const files = memoryFiles();
    files.write(SETTINGS, ARCHIVED);
    const reader = readerOf(files);
    expect(await reader.archived(SETTINGS)).toBe(true);
    expect(await reader.archived(SETTINGS)).toBe(true);
    expect(files.count("lstat", (target) => target === SETTINGS)).toBe(2);
    expect(files.count("openRegular")).toBe(1);

    files.rewrite(SETTINGS, settings({ archivedAt: undefined }), { mtimeMs: NOW + SECOND });
    expect(await reader.archived(SETTINGS)).toBe(false);
    files.rewrite(SETTINGS, ARCHIVED, { mtimeMs: NOW + 2 * SECOND });
    expect(await reader.archived(SETTINGS)).toBe(true);
    expect(files.count("openRegular")).toBe(3);
  });

  test("shows what it showed while the file is half written, gone or not JSON, until it holds still for a poll", async () => {
    const goes = [
      (files: MemoryFiles, at: number) => files.rewrite(SETTINGS, "", { mtimeMs: at }),
      (files: MemoryFiles, at: number) =>
        files.rewrite(SETTINGS, ARCHIVED.slice(0, 20), { mtimeMs: at }),
      (files: MemoryFiles, at: number) =>
        files.rewrite(SETTINGS, '{"archivedAt": "x", }', { mtimeMs: at }),
      (files: MemoryFiles) => files.remove(SETTINGS),
    ];
    for (const [index, go] of goes.entries()) {
      const files = memoryFiles();
      files.write(SETTINGS, ARCHIVED);
      const reader = readerOf(files);
      expect(await reader.archived(SETTINGS)).toBe(true);
      go(files, NOW + SECOND);
      expect(await reader.archived(SETTINGS), String(index)).toBe(true);
      // Unchanged since: what it holds is what it shows, as for a reader that never saw it.
      expect(await readerOf(files).archived(SETTINGS)).toBe(false);
      expect(await reader.archived(SETTINGS), String(index)).toBe(false);
      expect(await reader.archived(SETTINGS), String(index)).toBe(false);
      expect(files.openHandles()).toBe(0);
    }
  });

  test("a whole file without archivedAt shows at once that the session is not archived", async () => {
    const files = memoryFiles();
    files.write(SETTINGS, ARCHIVED);
    const reader = readerOf(files);
    expect(await reader.archived(SETTINGS)).toBe(true);
    files.rewrite(SETTINGS, settings(), { mtimeMs: NOW + SECOND });
    expect(await reader.archived(SETTINGS)).toBe(false);
  });

  test("a file that cannot be looked up or read shows what it showed, and is tried again next poll", async () => {
    const files = memoryFiles();
    files.write(SETTINGS, ARCHIVED);
    const reader = readerOf(files);
    expect(await reader.archived(SETTINGS)).toBe(true);

    files.rewrite(SETTINGS, settings(), { mtimeMs: NOW + SECOND });
    files.failOpen(SETTINGS);
    expect(await reader.archived(SETTINGS)).toBe(true);
    expect(await reader.archived(SETTINGS)).toBe(true);
    expect(files.count("openRegular")).toBe(3);
    files.heal(SETTINGS);
    expect(await reader.archived(SETTINGS)).toBe(false);

    files.rewrite(SETTINGS, ARCHIVED, { mtimeMs: NOW + 2 * SECOND });
    expect(await reader.archived(SETTINGS)).toBe(true);
    files.fail(SETTINGS);
    expect(await reader.archived(SETTINGS)).toBe(true);
    files.heal(SETTINGS);

    // One never read counts as not archived.
    const other = settingsPath("other");
    files.write(other, ARCHIVED);
    files.failOpen(other);
    expect(await reader.archived(other)).toBe(false);
    files.heal(other);
    expect(await reader.archived(other)).toBe(true);
    expect(files.openHandles()).toBe(0);
  });

  test("a file replaced between its lstat and its open is read again on the next poll", async () => {
    const files = memoryFiles();
    files.write(SETTINGS, ARCHIVED);
    let swap = true;
    const io: ReadOnlyIo = {
      ...files.io,
      async lstat(target) {
        const info = await files.io.lstat(target);
        // The lstat finds one file, and the open another.
        if (swap && asWritten(target) === SETTINGS) {
          swap = false;
          return { ...info, ino: info.ino + 1000 } satisfies FileInfo;
        }
        return info;
      },
    };
    const reader = createSettingsReader(SESSIONS, io);
    expect(await reader.archived(SETTINGS)).toBe(false);
    expect(files.openHandles()).toBe(0);
    expect(await reader.archived(SETTINGS)).toBe(true);
  });

  test("never opens a settings file in a project folder that is not a real folder, and does not take note of it", async () => {
    const files = memoryFiles();
    files.write(SETTINGS, ARCHIVED);
    let linked = true;
    const io: ReadOnlyIo = {
      ...files.io,
      async lstat(target) {
        const info = await files.io.lstat(target);
        return linked && asWritten(target) === PROJECT_FOLDER
          ? ({ ...info, kind: "other" } satisfies FileInfo)
          : info;
      },
    };
    const reader = createSettingsReader(SESSIONS, io);
    expect(await reader.archived(SETTINGS)).toBe(false);
    expect(files.count("openRegular")).toBe(0);
    linked = false;
    expect(await reader.archived(SETTINGS)).toBe(true);
  });

  test("forgets every file it is not told to keep", async () => {
    const files = memoryFiles();
    files.write(SETTINGS, ARCHIVED);
    const reader = readerOf(files);
    await reader.archived(SETTINGS);
    reader.keepOnly(new Set());
    await reader.archived(SETTINGS);
    expect(files.count("openRegular")).toBe(2);
    reader.keepOnly(new Set([SETTINGS]));
    await reader.archived(SETTINGS);
    expect(files.count("openRegular")).toBe(2);
  });
});
