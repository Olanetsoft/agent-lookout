import { describe, expect, test } from "vitest";

import { CHATS_REFRESH_MS, createChatLister } from "@collector/adapters/gemini-cli/chats";
import type { Project } from "@collector/adapters/gemini-cli/projects";
import {
  chatName,
  chatPath,
  DAY,
  HOUR,
  idleSession,
  ids,
  NOW,
  PROJECT,
  SLUG,
  TMP_DIR,
  workingSession,
} from "@tests/fixtures/gemini-cli/geminiCli";
import { folderTimes, memoryFiles } from "@tests/support/adapters/geminiCliAdapter";
import { asWritten } from "@tests/support/paths";

const PROJECT_FOLDER: Project = { slug: SLUG, dir: `${TMP_DIR}/${SLUG}`, cwd: PROJECT };
const CHATS = `${TMP_DIR}/${SLUG}/chats`;

function setUp() {
  const files = memoryFiles();
  const timed = folderTimes(files.io);
  const lister = createChatLister({ io: timed.io });
  const recent = (now = NOW) => lister.recent([PROJECT_FOLDER], now);
  return { files, timed, recent };
}

describe("a project's session files", () => {
  test("are only the session-*.jsonl files: no leftovers of a rewrite, older files or subagents", async () => {
    const { files, recent } = setUp();
    const working = chatPath(chatName(NOW - HOUR, ids.working));
    files.write(working, workingSession());
    files.write(`${working}.tmp-123`, "placeholder: must never be opened");
    files.write(`${working}.unreadable-1790856000000`, "placeholder: must never be opened");
    files.write(chatPath("session-2026-09-30T08-00-00000000.json"), "{}");
    files.write(`${CHATS}/${ids.working}/agent-0001.jsonl`, "placeholder: must never be opened");
    files.write(chatPath("notes.jsonl"), "placeholder: must never be opened");
    files.special(chatPath(chatName(NOW - 2 * HOUR, ids.idle)));

    const { refs, older } = await recent();
    expect(refs.map((ref) => asWritten(ref.path))).toEqual([working]);
    expect(refs[0]?.project).toEqual(PROJECT_FOLDER);
    expect(older).toBe(1);
    // Nothing is opened here, and the subagent's folder is never listed.
    expect(files.opened()).toEqual([]);
    expect(files.count("readdir", (target) => target.includes(ids.working))).toBe(0);
  });

  test("an older file is counted only when it changed in the last day", async () => {
    const { files, recent } = setUp();
    files.write(chatPath("session-2026-09-01T08-00-00000000.json"), "{}", {
      mtimeMs: NOW - 2 * DAY,
    });
    files.write(chatPath("session-2026-10-01T08-00-00000000.json"), "{}");
    expect((await recent()).older).toBe(1);
  });

  test("a file not written to for a day is left out, and not looked at again until the next listing", async () => {
    const { files, recent } = setUp();
    const old = chatPath(chatName(NOW - 2 * DAY, ids.idle));
    files.write(old, idleSession(), { mtimeMs: NOW - DAY - 1 });
    expect((await recent(NOW)).refs).toEqual([]);

    files.forget();
    expect((await recent(NOW + 2_000)).refs).toEqual([]);
    expect(files.count("lstat", (target) => target === old)).toBe(0);

    // Taken up again: the next listing finds it.
    files.append(old, "\n", { mtimeMs: NOW + 3_000 });
    expect((await recent(NOW + 4_000)).refs).toEqual([]);
    expect((await recent(NOW + CHATS_REFRESH_MS)).refs.map((ref) => asWritten(ref.path))).toEqual([
      old,
    ]);
  });

  test("a file written to since the last listing is looked at on every call", async () => {
    const { files, recent } = setUp();
    const working = chatPath(chatName(NOW - HOUR, ids.working));
    files.write(working, workingSession(), { mtimeMs: NOW - 10_000 });
    expect((await recent(NOW)).refs[0]?.info.mtimeMs).toBe(NOW - 10_000);
    files.append(working, "\n", { mtimeMs: NOW + 1_000 });
    expect((await recent(NOW + 2_000)).refs[0]?.info.mtimeMs).toBe(NOW + 1_000);
  });

  test("the folder is listed again when its time moves, or at least every 30 seconds", async () => {
    const { files, timed, recent } = setUp();
    files.write(chatPath(chatName(NOW - HOUR, ids.working)), workingSession());
    await recent(NOW);

    files.forget();
    files.write(chatPath(chatName(NOW, ids.idle)), idleSession());
    expect((await recent(NOW + 2_000)).refs).toHaveLength(1);
    expect(files.count("readdir")).toBe(0);

    timed.touch(CHATS, NOW + 3_000);
    expect((await recent(NOW + 4_000)).refs).toHaveLength(2);
    expect(files.count("readdir")).toBe(1);

    files.forget();
    await recent(NOW + 6_000);
    expect(files.count("readdir")).toBe(0);
    await recent(NOW + 4_000 + CHATS_REFRESH_MS);
    expect(files.count("readdir")).toBe(1);
  });

  test("a project with no chats folder yet has no files, and that is no error", async () => {
    const { files, recent } = setUp();
    files.mkdir(`${TMP_DIR}/${SLUG}`);
    expect(await recent()).toEqual({ refs: [], older: 0 });
    // Nor is a folder that cannot be listed.
    files.mkdir(CHATS);
    files.fail(CHATS);
    expect(await recent()).toEqual({ refs: [], older: 0 });
  });
});
