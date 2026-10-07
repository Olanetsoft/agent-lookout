import { describe, expect, test } from "vitest";

import {
  conversationIdOfDatabase,
  conversationIdOfFolder,
  createConversationFinder,
  OLD_REFRESH_MS,
} from "@collector/adapters/antigravity/conversations";
import {
  AGY_HOME,
  conversationId,
  databasePath,
  DAY,
  finishedTurn,
  MINUTE,
  NOW,
  SECOND,
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
    }));
    expect({ state: listing.state, conversations: written }).toEqual({
      state: "ok",
      conversations: [
        {
          id: A,
          transcript: transcriptPath(AGY_HOME, A),
          transcriptInfo: expect.objectContaining({ kind: "file" }),
          writtenAt: NOW - 3 * MINUTE,
          lastWriteAt: NOW - MINUTE,
        },
        {
          id: B,
          transcript: transcriptPath(AGY_HOME, B),
          transcriptInfo: null,
          writtenAt: null,
          lastWriteAt: NOW - 2 * MINUTE,
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
    expect(lookedAt(A)).toBe(3);
    expect(lookedAt(OLD)).toBe(0);

    files.forget();
    await finder.list(clock.now(), (id) => id === OLD);
    expect(lookedAt(OLD)).toBe(3);

    files.forget();
    clock.advance(OLD_REFRESH_MS);
    await finder.list(clock.now(), never);
    expect(lookedAt(OLD)).toBe(3);
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
