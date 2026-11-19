import { describe, expect, test } from "vitest";

import {
  createSessionFiles,
  MAX_PLAN_BYTES,
  MAX_SUMMARY_BYTES,
  planWaitsIn,
  titleOf,
} from "@collector/adapters/grok-build/sessionFiles";
import {
  NOW,
  OPENED_AT,
  planPath,
  planText,
  SECOND,
  SECRET,
  sessionFolder,
  SESSION_ID,
  summaryPath,
  summaryText,
  TYPED_TITLE,
} from "@tests/fixtures/grok-build/grokBuild";
import {
  memoryFiles,
  OTHER_UID,
  ownedFiles,
  TEST_UID,
  writePlan,
  writeSummary,
  type MemoryFiles,
} from "@tests/support/adapters/grok-build/grokBuildAdapter";
import { watchDecodingWhile } from "@tests/support/adapters/unreal-agent/decodeSpy";

const bytes = (text: string) => Buffer.from(text);

function filesOf(files: MemoryFiles) {
  const owned = ownedFiles(files);
  return {
    owned,
    reader: createSessionFiles({ io: owned.io, platform: "darwin", euid: TEST_UID }),
  };
}

describe("a title", () => {
  test("is read only when it is marked as set by the person", () => {
    expect(titleOf(bytes(summaryText({ title: "Release checklist", manual: true })))).toBe(
      "Release checklist",
    );
    expect(titleOf(bytes(summaryText({ title: TYPED_TITLE })))).toBeNull();
    expect(titleOf(bytes(summaryText()))).toBeNull();
  });

  test("the mark inside a string, or inside another object, is not the mark", () => {
    const inString = summaryText({
      title: TYPED_TITLE,
      extra: { last_recap: '\n  "title_is_manual": true,' },
    });
    expect(titleOf(bytes(inString))).toBeNull();
    const nested = summaryText({
      title: TYPED_TITLE,
      extra: { worktree: { title_is_manual: true } },
    });
    expect(titleOf(bytes(nested))).toBeNull();
    const notTrue = summaryText({ title: TYPED_TITLE, extra: { title_is_manual: "true" } });
    expect(titleOf(bytes(notTrue))).toBeNull();
    // Not JSON a writer makes: the mark must be followed by a comma or a line break.
    const trailing = `{\n  "generated_title": "${TYPED_TITLE}",\n  "title_is_manual": truest\n}`;
    expect(titleOf(bytes(trailing))).toBeNull();
    const last = `{\n  "generated_title": "Release checklist",\n  "title_is_manual": true\n}`;
    expect(titleOf(bytes(last))).toBe("Release checklist");
  });

  test("is one JSON string, its escapes undone, cleaned and cut as every name is", () => {
    expect(titleOf(bytes(summaryText({ title: 'Fix "auth"\tflow é', manual: true })))).toBe(
      'Fix "auth" flow é',
    );
    expect(titleOf(bytes(summaryText({ title: "x".repeat(300), manual: true })))).toHaveLength(200);
    expect(titleOf(bytes(summaryText({ title: "   ", manual: true })))).toBeNull();
  });

  test("over 1 KiB is not read", () => {
    expect(titleOf(bytes(summaryText({ title: "x".repeat(1_025), manual: true })))).toBeNull();
  });

  test("a compact or cut-off file gives none", () => {
    const value = JSON.parse(summaryText({ title: "Release checklist", manual: true }));
    expect(titleOf(bytes(JSON.stringify(value)))).toBeNull();
    const whole = summaryText({ title: "Release checklist", manual: true });
    expect(titleOf(bytes(whole.slice(0, -3)))).toBeNull();
  });
});

describe("a plan waiting", () => {
  test("true, false, or a file without the field, which an older Grok Build reads as false", () => {
    expect(planWaitsIn(bytes(planText(true)))).toBe(true);
    expect(planWaitsIn(bytes(planText(false)))).toBe(false);
    expect(planWaitsIn(bytes(planText(undefined)))).toBe(false);
  });

  test("a compact file says false, and a cut-off one nothing", () => {
    expect(planWaitsIn(bytes(JSON.stringify(JSON.parse(planText(true)))))).toBe(false);
    expect(planWaitsIn(bytes(planText(true).slice(0, -5)))).toBeNull();
  });

  test("a value that is not true or false says nothing", () => {
    expect(planWaitsIn(bytes('{\n  "awaiting_plan_approval": truex\n}'))).toBeNull();
    expect(planWaitsIn(bytes('{\n  "awaiting_plan_approval": 1\n}'))).toBeNull();
  });
});

describe("reading the files", () => {
  test("each is read when it changes, with its time", async () => {
    const files = memoryFiles();
    const { reader } = filesOf(files);
    writeSummary(files, summaryText({ title: "Release checklist", manual: true }));
    writePlan(files, planText(true), { mtimeMs: NOW - 9 * SECOND });
    expect(await reader.title(SESSION_ID, sessionFolder())).toBe("Release checklist");
    expect(await reader.plan(SESSION_ID, sessionFolder())).toEqual({
      state: "ok",
      waits: true,
      writtenAt: NOW - 9 * SECOND,
    });
    files.forget();
    await reader.title(SESSION_ID, sessionFolder());
    await reader.plan(SESSION_ID, sessionFolder());
    expect(files.opened()).toEqual([]);
    writePlan(files, planText(false), { mtimeMs: NOW });
    expect(await reader.plan(SESSION_ID, sessionFolder())).toEqual({
      state: "ok",
      waits: false,
      writtenAt: NOW,
    });
  });

  test("no file is no title and no plan waiting", async () => {
    const { reader } = filesOf(memoryFiles());
    expect(await reader.title(SESSION_ID, sessionFolder())).toBeNull();
    expect(await reader.plan(SESSION_ID, sessionFolder())).toEqual({ state: "missing" });
  });

  test("files over their limit are not opened", async () => {
    const files = memoryFiles();
    const { reader } = filesOf(files);
    writeSummary(
      files,
      `${summaryText({ title: "x", manual: true })}${" ".repeat(MAX_SUMMARY_BYTES)}`,
    );
    writePlan(files, `${planText(true)}${" ".repeat(MAX_PLAN_BYTES)}`);
    expect(await reader.title(SESSION_ID, sessionFolder())).toBeNull();
    expect(await reader.plan(SESSION_ID, sessionFolder())).toEqual({ state: "unknown" });
    expect(files.opened()).toEqual([]);
  });

  test("a plan file that is not a whole object says nothing", async () => {
    const files = memoryFiles();
    const { reader } = filesOf(files);
    writePlan(files, planText(true).slice(0, 20));
    expect(await reader.plan(SESSION_ID, sessionFolder())).toEqual({ state: "unknown" });
  });

  test("a link, another user's file or one with a second name is not read, even after one that was", async () => {
    const files = memoryFiles();
    const { owned, reader } = filesOf(files);
    writePlan(files, planText(true));
    writeSummary(files, summaryText({ title: "Release checklist", manual: true }));
    expect(await reader.plan(SESSION_ID, sessionFolder())).toMatchObject({ state: "ok" });
    expect(await reader.title(SESSION_ID, sessionFolder())).toBe("Release checklist");
    owned.set(planPath(), { nlink: 2 });
    owned.set(summaryPath(), { uid: OTHER_UID });
    expect(await reader.plan(SESSION_ID, sessionFolder())).toEqual({ state: "unknown" });
    expect(await reader.title(SESSION_ID, sessionFolder())).toBeNull();
    owned.clear(planPath());
    files.special(planPath());
    expect(await reader.plan(SESSION_ID, sessionFolder())).toEqual({ state: "unknown" });
  });

  test("an open that fails is not kept", async () => {
    const files = memoryFiles();
    const { reader } = filesOf(files);
    writePlan(files, planText(true));
    files.failOpen(planPath());
    expect(await reader.plan(SESSION_ID, sessionFolder())).toEqual({ state: "unknown" });
    files.heal(planPath());
    expect(await reader.plan(SESSION_ID, sessionFolder())).toMatchObject({
      state: "ok",
      waits: true,
    });
  });

  test("the time is the open file's, never before its lstat's", async () => {
    const files = memoryFiles();
    const owned = ownedFiles(files);
    writePlan(files, planText(true), { mtimeMs: OPENED_AT + 5 * SECOND });
    const io = {
      ...owned.io,
      async openRegular(file: string) {
        const open = await owned.io.openRegular(file);
        return { ...open, info: { ...open.info, mtimeMs: OPENED_AT } };
      },
    };
    const reader = createSessionFiles({ io, platform: "darwin", euid: TEST_UID });
    expect(await reader.plan(SESSION_ID, sessionFolder())).toMatchObject({
      writtenAt: OPENED_AT + 5 * SECOND,
    });
  });

  test("nothing but a marked title is turned into text", async () => {
    const files = memoryFiles();
    const { reader } = filesOf(files);
    writeSummary(files, summaryText({ title: TYPED_TITLE }));
    writePlan(files, planText(true));
    const read = [
      await reader.title(SESSION_ID, sessionFolder()),
      await reader.plan(SESSION_ID, sessionFolder()),
    ];
    expect(JSON.stringify(read)).not.toContain(SECRET);
    expect(JSON.stringify(read)).not.toContain("quartzmandolin");
  });

  test("it forgets the sessions it is told to", async () => {
    const files = memoryFiles();
    const { reader } = filesOf(files);
    writeSummary(files, summaryText());
    writePlan(files, planText(false));
    await reader.title(SESSION_ID, sessionFolder());
    await reader.plan(SESSION_ID, sessionFolder());
    expect(reader.kept).toBe(1);
    reader.keepOnly(new Set());
    expect(reader.kept).toBe(0);
  });
  test("of both files only a marked title is turned into text", async () => {
    const files = memoryFiles();
    const { reader } = filesOf(files);
    writeSummary(files, summaryText({ title: "Release checklist", manual: true }));
    writePlan(files, planText(true));
    const seen = await watchDecodingWhile(async () => {
      await reader.title(SESSION_ID, sessionFolder());
      await reader.plan(SESSION_ID, sessionFolder());
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const text of seen) expect(["Release checklist", '"Release checklist"']).toContain(text);
    writeSummary(files, summaryText({ title: TYPED_TITLE }));
    const unmarked = await watchDecodingWhile(async () => {
      await reader.title(SESSION_ID, sessionFolder());
    });
    expect(unmarked).toEqual([]);
  });
});
