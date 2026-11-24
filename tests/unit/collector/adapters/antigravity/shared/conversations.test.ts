import { describe, expect, test } from "vitest";

import {
  conversationIdOfDatabase,
  conversationIdOfFolder,
  createConversationFinder,
  OLD_REFRESH_MS,
  rowsOf,
  type ConversationFiles,
} from "@collector/adapters/antigravity/shared/conversations";
import {
  AGY_HOME,
  conversationId,
  databasePath,
  DAY,
  finishedTurn,
  MINUTE,
  NOW,
  SECOND,
  subagentsPath,
  transcriptPath,
} from "@tests/fixtures/antigravity";
import { handClock, memoryFiles } from "@tests/support/adapters/antigravityAdapter";
import { asWritten } from "@tests/support/paths";

const A = conversationId("a1");
const B = conversationId("b2");
const OLD = conversationId("c3");

const never = () => false;

function setUp() {
  const clock = handClock(NOW);
  const files = memoryFiles(clock.now);
  const finder = createConversationFinder({ home: AGY_HOME, io: files.io });
  return { clock, files, finder };
}

test("names are conversation ids, in lower case, and nothing else is", () => {
  expect(conversationIdOfFolder(A.toUpperCase())).toBe(A);
  expect(conversationIdOfFolder("tempmediaStorage")).toBeNull();
  expect(conversationIdOfFolder(`${A}.json`)).toBeNull();
  expect(conversationIdOfDatabase(`${A}.db`)).toBe(A);
  expect(conversationIdOfDatabase(`${A}.db-wal`)).toBe(A);
  expect(conversationIdOfDatabase(`${A}.db-shm`)).toBeNull();
  expect(conversationIdOfDatabase("conversation_summaries.db")).toBeNull();
});

describe("listing conversations", () => {
  test("finds them by their folders and databases, with when the transcript was written and the newest write of the three files", async () => {
    const { files, finder } = setUp();
    files.write(transcriptPath(AGY_HOME, A), finishedTurn(0, NOW).join(""), {
      mtimeMs: NOW - 3 * MINUTE,
    });
    files.write(databasePath(AGY_HOME, A), "", { mtimeMs: NOW - 5 * MINUTE });
    files.write(databasePath(AGY_HOME, A, true), "", { mtimeMs: NOW - MINUTE + 0.25 });
    // A database whose transcript is not written yet.
    files.write(databasePath(AGY_HOME, B), "", { mtimeMs: NOW - 2 * MINUTE });
    files.mkdir(`${AGY_HOME}/brain/not-a-conversation`);

    const listing = await finder.list(NOW, never);
    if (listing.state !== "ok") throw new Error("The folder was not listed.");
    const written = listing.conversations.map((files) => ({
      ...files,
      transcript: asWritten(files.transcript),
      database: asWritten(files.database),
    }));
    expect({ state: listing.state, conversations: written }).toEqual({
      state: "ok",
      conversations: [
        {
          id: A,
          transcript: transcriptPath(AGY_HOME, A),
          transcriptInfo: expect.objectContaining({ kind: "file" }),
          writtenAt: NOW - 3 * MINUTE,
          database: databasePath(AGY_HOME, A),
          databaseInfo: expect.objectContaining({ kind: "file", mtimeMs: NOW - 5 * MINUTE }),
          logThere: true,
          lastWriteAt: NOW - MINUTE,
          parents: [],
        },
        {
          id: B,
          transcript: transcriptPath(AGY_HOME, B),
          transcriptInfo: null,
          writtenAt: null,
          database: databasePath(AGY_HOME, B),
          databaseInfo: expect.objectContaining({ kind: "file" }),
          logThere: false,
          lastWriteAt: NOW - 2 * MINUTE,
          parents: [],
        },
      ],
    });
    // Only looked at: nothing is opened.
    expect(files.count("openRegular")).toBe(0);
  });

  test("says when there is no brain folder, and when it cannot be listed", async () => {
    const { files, finder } = setUp();
    expect(await finder.list(NOW, never)).toEqual({ state: "missing" });
    files.mkdir(`${AGY_HOME}/brain`);
    files.fail(`${AGY_HOME}/brain`);
    expect(await finder.list(NOW, never)).toEqual({ state: "unreadable" });
  });

  test("a transcript that is not an ordinary file is not one", async () => {
    const { files, finder } = setUp();
    files.special(transcriptPath(AGY_HOME, A));
    const listing = await finder.list(NOW, never);
    expect(listing).toMatchObject({
      state: "ok",
      conversations: [{ id: A, transcriptInfo: null, writtenAt: null, lastWriteAt: null }],
    });
  });

  test("looks at a conversation not written for a day only every 30 seconds, unless it may be open", async () => {
    const { clock, files, finder } = setUp();
    files.write(transcriptPath(AGY_HOME, A), "", { mtimeMs: NOW - MINUTE });
    files.write(transcriptPath(AGY_HOME, OLD), "", { mtimeMs: NOW - 2 * DAY });
    await finder.list(NOW, never);
    const lookedAt = (id: string) => files.count("lstat", (target) => target.includes(id));
    files.forget();

    clock.advance(2 * SECOND);
    await finder.list(clock.now(), never);
    // Its three files and its folder of records.
    expect(lookedAt(A)).toBe(4);
    expect(lookedAt(OLD)).toBe(0);

    files.forget();
    await finder.list(clock.now(), (id) => id === OLD);
    expect(lookedAt(OLD)).toBe(4);

    files.forget();
    clock.advance(OLD_REFRESH_MS);
    await finder.list(clock.now(), never);
    expect(lookedAt(OLD)).toBe(4);
  });

  test("looks at a conversation on every poll while its database changed in the last day, so its transcript is found once written", async () => {
    const { clock, files, finder } = setUp();
    files.write(databasePath(AGY_HOME, B), "", { mtimeMs: NOW - MINUTE });
    await finder.list(NOW, never);
    files.write(transcriptPath(AGY_HOME, B), finishedTurn(0, NOW).join(""), { mtimeMs: NOW });
    clock.advance(2 * SECOND);
    const listing = await finder.list(clock.now(), never);
    expect(listing).toMatchObject({ conversations: [{ id: B, writtenAt: NOW, lastWriteAt: NOW }] });
  });

  test("finds a day-old conversation written again within 30 seconds", async () => {
    const { clock, files, finder } = setUp();
    files.write(transcriptPath(AGY_HOME, OLD), "", { mtimeMs: NOW - 2 * DAY });
    await finder.list(NOW, never);
    files.append(transcriptPath(AGY_HOME, OLD), "x", { mtimeMs: NOW + SECOND });
    clock.advance(OLD_REFRESH_MS);
    const listing = await finder.list(clock.now(), never);
    expect(listing).toMatchObject({ conversations: [{ id: OLD, writtenAt: NOW + SECOND }] });
  });

  test("forgets a conversation once its folder and database are gone", async () => {
    const { files, finder } = setUp();
    files.write(transcriptPath(AGY_HOME, A), "");
    await finder.list(NOW, never);
    files.remove(`${AGY_HOME}/brain/${A}`);
    expect(await finder.list(NOW + SECOND, never)).toEqual({ state: "ok", conversations: [] });
  });
});

describe("telling a conversation another one started", () => {
  const CHILD = conversationId("d4");

  const write = (files: ReturnType<typeof memoryFiles>, id: string, mtimeMs: number) =>
    files.write(transcriptPath(AGY_HOME, id), finishedTurn(0, mtimeMs).join(""), { mtimeMs });

  function record(
    files: ReturnType<typeof memoryFiles>,
    parent: string,
    child: string,
    at: number,
  ) {
    files.write(subagentsPath(AGY_HOME, parent, `${child}.json`), "{}", { mtimeMs: at });
    files.touch(subagentsPath(AGY_HOME, parent), at);
  }

  async function childrenOf(finder: ReturnType<typeof setUp>["finder"], now: number) {
    const listing = await finder.list(now, never);
    if (listing.state !== "ok") throw new Error("The folder was not listed.");
    return listing.conversations
      .filter((files) => files.parents.length > 0)
      .map((files) => files.id);
  }

  test("a child is in the list, with what started it and when it was written", async () => {
    const { files, finder } = setUp();
    write(files, A, NOW - 3 * MINUTE);
    write(files, CHILD, NOW - MINUTE);
    record(files, A, CHILD, NOW - 2 * MINUTE);
    const listing = await finder.list(NOW, never);
    expect(listing).toMatchObject({
      conversations: [
        { id: A, parents: [], writtenAt: NOW - 3 * MINUTE },
        { id: CHILD, parents: [A], writtenAt: NOW - MINUTE },
      ],
    });
    expect(files.count("openRegular")).toBe(0);
  });

  test("a child of a conversation not written for days is one, from the poll that first sees it", async () => {
    const { clock, files, finder } = setUp();
    write(files, OLD, NOW - 3 * DAY);
    write(files, A, NOW - MINUTE);
    expect(await childrenOf(finder, NOW)).toEqual([]);

    clock.advance(2 * SECOND);
    record(files, OLD, CHILD, clock.now());
    write(files, CHILD, clock.now());
    expect(await childrenOf(finder, clock.now())).toEqual([CHILD]);
  });

  test("the one that started a child, and the one that started that, are looked at with it, their folders first", async () => {
    const { clock, files, finder } = setUp();
    const NESTED = conversationId("e5");
    write(files, OLD, NOW - 3 * DAY);
    write(files, CHILD, NOW - 2 * DAY);
    write(files, NESTED, NOW - MINUTE);
    record(files, OLD, CHILD, NOW - 3 * DAY);
    record(files, CHILD, NESTED, NOW - 2 * DAY);
    expect(await childrenOf(finder, NOW)).toEqual([CHILD, NESTED]);

    files.forget();
    clock.advance(2 * SECOND);
    write(files, OLD, clock.now());
    expect(await finder.list(clock.now(), never)).toMatchObject({
      conversations: [{ id: OLD, writtenAt: clock.now() }, { id: CHILD }, { id: NESTED }],
    });
    const looked = files.calls.filter((call) => call.method === "lstat").map((call) => call.path);
    for (const [parent, child] of [
      [OLD, CHILD],
      [CHILD, NESTED],
    ]) {
      const folder = looked.indexOf(subagentsPath(AGY_HOME, parent));
      expect(folder).toBeGreaterThanOrEqual(0);
      expect(looked.indexOf(subagentsPath(AGY_HOME, parent, `${child}.json`))).toBeGreaterThan(
        folder,
      );
    }
  });

  test("a link put in the place of an old conversation's folder is seen on the next poll, and nothing is looked up through it", async () => {
    const { clock, files, finder } = setUp();
    write(files, OLD, NOW - 3 * DAY);
    write(files, CHILD, NOW - MINUTE);
    record(files, OLD, CHILD, NOW - 3 * DAY);
    expect(await childrenOf(finder, NOW)).toEqual([CHILD]);

    // The record is still found at the same path, as it is through a link.
    files.special(subagentsPath(AGY_HOME, OLD));
    files.forget();
    clock.advance(2 * SECOND);
    expect(await childrenOf(finder, clock.now())).toEqual([]);
    expect(files.count(undefined, (target) => target.endsWith(`${CHILD}.json`))).toBe(0);
  });

  test("one failed look at a folder lists none of its children, for a conversation in use or an old one", async () => {
    for (const age of [MINUTE, 2 * DAY]) {
      const { clock, files, finder } = setUp();
      write(files, A, NOW - age);
      write(files, CHILD, NOW - SECOND);
      record(files, A, CHILD, NOW - age);
      expect(await childrenOf(finder, NOW)).toEqual([CHILD]);
      files.fail(subagentsPath(AGY_HOME, A), "EIO");
      clock.advance(OLD_REFRESH_MS);
      expect(await childrenOf(finder, clock.now())).toEqual([CHILD]);
      files.heal(subagentsPath(AGY_HOME, A));
      clock.advance(2 * SECOND);
      expect(await childrenOf(finder, clock.now())).toEqual([CHILD]);
    }
  });

  test("a record one poll late, of a conversation resumed after days, is found on the next poll", async () => {
    const { clock, files, finder } = setUp();
    write(files, OLD, NOW - 3 * DAY);
    expect(await childrenOf(finder, NOW)).toEqual([]);

    clock.advance(2 * SECOND);
    write(files, OLD, clock.now());
    write(files, CHILD, clock.now());
    expect(await childrenOf(finder, clock.now())).toEqual([]);
    record(files, OLD, CHILD, clock.now());
    clock.advance(2 * SECOND);
    expect(await childrenOf(finder, clock.now())).toEqual([CHILD]);
  });

  test("a record added after its conversation was first seen is found: on the next poll for a conversation in use, within 30 seconds for an old one", async () => {
    const { clock, files, finder } = setUp();
    const OTHER = conversationId("e5");
    write(files, OLD, NOW - 3 * DAY);
    write(files, A, NOW - MINUTE);
    write(files, CHILD, NOW - SECOND);
    write(files, OTHER, NOW - SECOND);
    expect(await childrenOf(finder, NOW)).toEqual([]);

    record(files, A, CHILD, NOW);
    record(files, OLD, OTHER, NOW);
    clock.advance(2 * SECOND);
    expect(await childrenOf(finder, clock.now())).toEqual([CHILD]);
    clock.set(NOW + OLD_REFRESH_MS);
    expect(await childrenOf(finder, clock.now())).toEqual([CHILD, OTHER]);
  });

  test("a poll looks up no folder of a conversation not written for a day, and lists none that did not change", async () => {
    const { clock, files, finder } = setUp();
    const parents = ["11", "22", "33", "44", "55"].map(conversationId);
    for (const parent of parents) {
      write(files, parent, NOW - 2 * DAY);
      record(files, parent, conversationId(`9${parent.slice(-1)}`), NOW - 2 * DAY);
    }
    write(files, A, NOW - MINUTE);
    record(files, A, B, NOW - MINUTE);
    await finder.list(NOW, never);
    files.forget();

    clock.advance(2 * SECOND);
    await finder.list(clock.now(), never);
    const folders = files.calls.filter((call) => call.path.includes("subagents"));
    expect(folders).toEqual([{ method: "lstat", path: subagentsPath(AGY_HOME, A) }]);

    // Every 30 seconds, one look up each, and still nothing listed.
    files.forget();
    clock.advance(OLD_REFRESH_MS);
    await finder.list(clock.now(), never);
    const again = files.calls.filter((call) => call.path.includes("subagents"));
    expect(again.every((call) => call.method === "lstat")).toBe(true);
    expect(again.map((call) => call.path).sort()).toEqual(
      [A, ...parents].map((parent) => subagentsPath(AGY_HOME, parent)).sort(),
    );
  });

  test("a conversation that has only a database has no folder of records to look up", async () => {
    const { files, finder } = setUp();
    files.write(databasePath(AGY_HOME, B), "", { mtimeMs: NOW - MINUTE });
    files.mkdir(`${AGY_HOME}/brain`);
    await finder.list(NOW, never);
    await finder.list(NOW + 2 * SECOND, never);
    expect(files.count(undefined, (target) => target.includes("subagents"))).toBe(0);
  });

  test("once the one that started it is deleted, its records with it, it is a child no longer", async () => {
    const { clock, files, finder } = setUp();
    write(files, A, NOW - MINUTE);
    write(files, CHILD, NOW - MINUTE);
    record(files, A, CHILD, NOW - MINUTE);
    // Its database can stay longer than its folder.
    files.write(databasePath(AGY_HOME, A), "", { mtimeMs: NOW - MINUTE });
    expect(await childrenOf(finder, NOW)).toEqual([CHILD]);
    files.remove(`${AGY_HOME}/brain/${A}`);
    files.forget();
    clock.advance(2 * SECOND);
    expect(await childrenOf(finder, clock.now())).toEqual([]);
    // Nothing of its folder is kept to be looked up.
    expect(files.count(undefined, (target) => target.startsWith(subagentsPath(AGY_HOME, A)))).toBe(
      0,
    );
  });
});

describe("the conversations with a row of their own", () => {
  const C = conversationId("e5");
  const D = conversationId("f6");

  /** Conversations as they are found, from what started each and when it was written. */
  const found = (...each: [id: string, parents: string[], writtenAt: number | null][]) =>
    each.map(([id, parents, writtenAt]): ConversationFiles => ({
      id,
      parents,
      writtenAt,
      transcript: transcriptPath(AGY_HOME, id),
      transcriptInfo: null,
      database: databasePath(AGY_HOME, id),
      databaseInfo: null,
      logThere: false,
      lastWriteAt: writtenAt,
    }));
  const rows = (conversations: ConversationFiles[], own?: ReadonlySet<string>) =>
    rowsOf(conversations, own).map(({ id, writtenAt }) => [id, writtenAt]);

  test("what a child writes counts as a write of the one that started it, however deep, when it is the newer", () => {
    expect(rows(found([A, [], 10], [B, [], 20], [C, [A], 30], [D, [C], 40]))).toEqual([
      [A, 40],
      [B, 20],
    ]);
    expect(rows(found([A, [], 50], [C, [A], 30]))).toEqual([[A, 50]]);
    // One that two started counts for both, and one not looked at for neither.
    expect(rows(found([A, [], 10], [B, [], 20], [C, [A, B], 30], [D, [A], null]))).toEqual([
      [A, 30],
      [B, 30],
    ]);
  });

  test("for nothing else: not for when its files were written, nor for one with no transcript", () => {
    const [row] = rowsOf(found([A, [], 10], [C, [A], 30]));
    expect(row).toMatchObject({ writtenAt: 30, lastWriteAt: 10 });
    expect(rows(found([A, [], null], [C, [A], 30]))).toEqual([[A, null]]);
  });

  test("one that is its own has a row, and what those it started write counts as its own alone", () => {
    const conversations = found([A, [], 10], [C, [A], 30], [D, [C], 40]);
    expect(rows(conversations, new Set([C]))).toEqual([
      [A, 10],
      [C, 40],
    ]);
  });

  test("records that lead only round to one another tell nothing", () => {
    expect(rows(found([A, [B], 10], [B, [A], 20], [C, [A], 30]))).toEqual([
      [A, 10],
      [B, 20],
      [C, 30],
    ]);
    // With one above them that none is kept of, they lead up to it.
    expect(rows(found([A, [B, D], 10], [B, [A], 20], [D, [], 5]))).toEqual([[D, 20]]);
  });

  test("one whose record is kept by a conversation that has gone has a row", () => {
    expect(rows(found([C, [A], 30]))).toEqual([[C, 30]]);
  });
});
