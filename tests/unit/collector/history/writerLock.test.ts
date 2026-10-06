import { expect, test } from "vitest";

import { createWriterLock, LOCK_STALE_MS } from "@collector/history/writerLock";
import { fakeHistoryFs } from "@tests/support/node/historyFs";

const DIR = "/Users/example/.agent-lookout/history";
const FILE = `${DIR}/writer.lock`;
const T0 = 1_791_204_000_000;

/** A lock's text, as a copy writes it. */
const lockText = (fields: Record<string, unknown>) => `${JSON.stringify(fields)}\n`;

function setUp(
  options: { pid?: number; alive?: number[]; token?: string; sources?: string | null } = {},
) {
  let now = T0;
  const fs = fakeHistoryFs(() => now);
  fs.folders.add(DIR);
  const alive = new Set(options.alive ?? []);
  const make = (token: string, sources = options.sources) =>
    createWriterLock({
      fs,
      file: FILE,
      pid: options.pid ?? 100,
      now: () => now,
      isAlive: (pid) => alive.has(pid),
      token,
      sources,
    });
  const lock = make(options.token ?? "aaaa1111");
  return {
    fs,
    lock,
    alive,
    /** Another lock in the same process, as a dev server's reload makes for a moment. */
    another: (token: string, sources?: string | null) => make(token, sources),
    later: (ms: number) => {
      now += ms;
    },
  };
}

test("with nobody holding it, the lock is taken and names this process, its own mark and the folders it reads", async () => {
  const { fs, lock } = setUp({ pid: 100, sources: "f1f1" });
  expect(await lock.take()).toBe(true);
  expect(lock.held).toBe(true);
  expect(JSON.parse(fs.text(FILE) as string)).toEqual({
    pid: 100,
    token: "aaaa1111",
    sources: "f1f1",
  });
});

test("left to itself, its mark is a random one of 16 hex digits", async () => {
  const fs = fakeHistoryFs(() => T0);
  fs.folders.add(DIR);
  const lock = createWriterLock({ fs, file: FILE, pid: 100, now: () => T0 });
  await lock.take();
  expect(JSON.parse(fs.text(FILE) as string)).toEqual({
    pid: 100,
    token: expect.stringMatching(/^[0-9a-f]{16}$/),
  });
});

test("a lock another running copy keeps fresh is not taken", async () => {
  const { fs, lock } = setUp({ pid: 100, alive: [200] });
  fs.put(FILE, lockText({ pid: 200, token: "bbbb" }));
  expect(await lock.take()).toBe(false);
  expect(lock.held).toBe(false);
  expect(lock.heldByOtherSources).toBe(false);
  expect(fs.text(FILE)).toBe(lockText({ pid: 200, token: "bbbb" }));
});

test("a copy that reads sessions from other folders is told apart from one that reads the same", async () => {
  const { fs, lock } = setUp({ pid: 100, alive: [200], sources: "f1f1" });
  fs.put(FILE, lockText({ pid: 200, token: "bbbb", sources: "e2e2" }));
  expect(await lock.take()).toBe(false);
  expect(lock.heldByOtherSources).toBe(true);

  fs.put(FILE, lockText({ pid: 200, token: "bbbb", sources: "f1f1" }));
  expect(lock.takeNow()).toBe(false);
  expect(lock.heldByOtherSources).toBe(false);

  // A lock that does not say which folders its copy reads says nothing either way.
  fs.put(FILE, lockText({ pid: 200, token: "bbbb" }));
  expect(await lock.take()).toBe(false);
  expect(lock.heldByOtherSources).toBe(false);
});

test("a lock whose process has gone is taken over", async () => {
  const { fs, lock } = setUp({ pid: 100, alive: [] });
  fs.put(FILE, lockText({ pid: 200, token: "bbbb" }));
  expect(await lock.take()).toBe(true);
  expect(JSON.parse(fs.text(FILE) as string)).toEqual({ pid: 100, token: "aaaa1111" });
});

test("a lock left unrefreshed for 30 seconds is taken over, though its process id is in use again", async () => {
  const { fs, lock, later } = setUp({ pid: 100, alive: [200] });
  fs.put(FILE, lockText({ pid: 200, token: "bbbb" }));
  later(LOCK_STALE_MS - 1);
  expect(await lock.take()).toBe(false);
  later(1);
  expect(await lock.take()).toBe(true);
});

test("a fresh lock that names nobody may be one being written, and is taken only once stale", async () => {
  const { fs, lock, later } = setUp({ pid: 100 });
  fs.put(FILE, "");
  expect(await lock.take()).toBe(false);
  later(LOCK_STALE_MS);
  expect(await lock.take()).toBe(true);
});

test("something that is not a file where the lock goes is left alone, and nobody writes", async () => {
  const { fs, lock, later } = setUp({ pid: 100 });
  fs.put(FILE, "", "link");
  later(LOCK_STALE_MS * 10);
  expect(await lock.take()).toBe(false);
  expect(fs.entries.get(FILE)?.kind).toBe("link");
});

test("keeping it marks it fresh, and notices when another copy has taken it", async () => {
  const { fs, lock, later } = setUp({ pid: 100 });
  await lock.take();
  later(10_000);
  expect(await lock.keep()).toBe(true);
  expect(fs.entries.get(FILE)?.mtimeMs).toBe(T0 + 10_000);

  fs.put(FILE, lockText({ pid: 300, token: "cccc" }));
  expect(await lock.keep()).toBe(false);
  expect(lock.held).toBe(false);
});

test("a lock deleted under it is held no more, and is taken again when nobody else has", async () => {
  const { fs, lock } = setUp({ pid: 100 });
  await lock.take();
  fs.entries.delete(FILE);
  expect(await lock.keep()).toBe(false);
  expect(lock.held).toBe(false);
  expect(await lock.take()).toBe(true);
  expect(JSON.parse(fs.text(FILE) as string)).toEqual({ pid: 100, token: "aaaa1111" });
});

test("taken at once, as a copy starts writing, it follows the same rules", () => {
  const free = setUp({ pid: 100 });
  expect(free.lock.takeNow()).toBe(true);
  expect(JSON.parse(free.fs.text(FILE) as string)).toEqual({ pid: 100, token: "aaaa1111" });

  const taken = setUp({ pid: 100, alive: [200] });
  taken.fs.put(FILE, lockText({ pid: 200, token: "bbbb" }));
  expect(taken.lock.takeNow()).toBe(false);

  const left = setUp({ pid: 100, alive: [] });
  left.fs.put(FILE, lockText({ pid: 200, token: "bbbb" }));
  expect(left.lock.takeNow()).toBe(true);
  expect(JSON.parse(left.fs.text(FILE) as string)).toEqual({ pid: 100, token: "aaaa1111" });
});

test("letting it go deletes the file, at once, so the next copy can take it", async () => {
  const { fs, lock } = setUp({ pid: 100 });
  await lock.take();
  lock.releaseNow();
  expect(lock.held).toBe(false);
  expect(fs.entries.has(FILE)).toBe(false);
  // A lock it does not hold is not touched.
  fs.put(FILE, lockText({ pid: 200, token: "bbbb" }));
  lock.releaseNow();
  expect(fs.entries.has(FILE)).toBe(true);
});

test("a lock another copy has taken over since is not deleted as this one lets go", async () => {
  const { fs, lock } = setUp({ pid: 100 });
  await lock.take();
  fs.put(FILE, lockText({ pid: 200, token: "bbbb" }));
  lock.releaseNow();
  expect(lock.held).toBe(false);
  expect(fs.text(FILE)).toBe(lockText({ pid: 200, token: "bbbb" }));
});

test("checked at once, it is held only while the file is still its own", async () => {
  const { fs, lock } = setUp({ pid: 100 });
  expect(lock.stillHeldNow()).toBe(false);
  await lock.take();
  expect(lock.stillHeldNow()).toBe(true);
  fs.put(FILE, lockText({ pid: 200, token: "bbbb" }));
  expect(lock.stillHeldNow()).toBe(false);
  expect(lock.held).toBe(false);
});

test("two locks in one process are told apart by their marks: neither takes, keeps or deletes the other's", async () => {
  const { fs, lock, another, later } = setUp({ pid: 100, alive: [100] });
  expect(await lock.take()).toBe(true);
  // A dev server's reload builds a second collector before the first one stops.
  const second = another("bbbb2222");
  expect(await second.take()).toBe(false);
  expect(second.takeNow()).toBe(false);
  expect(await lock.keep()).toBe(true);

  // Once the first has gone 30 seconds without marking it fresh, the second
  // takes it over, and the first neither deletes nor keeps it.
  later(LOCK_STALE_MS);
  expect(await second.take()).toBe(true);
  lock.releaseNow();
  expect(JSON.parse(fs.text(FILE) as string)).toEqual({ pid: 100, token: "bbbb2222" });
  expect(await lock.keep()).toBe(false);

  // Let go, it is taken at once by the next.
  second.releaseNow();
  expect(fs.entries.has(FILE)).toBe(false);
  expect(await another("cccc3333").take()).toBe(true);
});

test("this lock's own file, left from before, is taken back", async () => {
  const { fs, lock } = setUp({ pid: 100, alive: [100] });
  fs.put(FILE, lockText({ pid: 100, token: "aaaa1111" }));
  expect(await lock.take()).toBe(true);
});
