import { execFileSync } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { TRANSCRIPT_TAIL_BYTES } from "@collector/adapters/claude-code/transcript/transcriptFile";
import { nodeIo, type ReadOnlyIo } from "@collector/files/readOnlyIo";
import { feedEntries, ids, pids, registryFile } from "@tests/fixtures/claudeCode";
import { prompt, said, transcript } from "@tests/fixtures/claudeTranscript";
import {
  adapterFor,
  BIN,
  now as NOW,
  prints,
  watching,
} from "@tests/support/adapters/claudeCodeAdapter";
import { makeClaudeHome, tempDir } from "@tests/support/node/tempFiles";

// The Claude Code adapter reading what a session last said from real
// transcripts, in a Claude Code folder of the test's own, when it is asked.

const BUSY = `claude-code:${ids.busy}`;
const FOLDER = "-Users-example-code-demo";

/**
 * A Claude Code folder with two sessions, one working and one idle, and a
 * claude command that lists the same two: no session waits, so no poll reads
 * a transcript to say what one is asking.
 */
async function quietHome() {
  const home = await makeClaudeHome({
    [`${pids.busy}.json`]: registryFile(),
    [`${pids.idle}.json`]: registryFile({
      pid: pids.idle,
      sessionId: ids.idle,
      cwd: "/Users/example/code/demo-site",
      name: "demo-site",
      status: "idle",
    }),
  });
  const run = prints(
    JSON.stringify(
      feedEntries.filter((entry) => entry.pid === pids.busy || entry.pid === pids.idle),
    ),
  );
  return { home, run };
}

/** Writes a transcript into `projects/<folder>` of a Claude Code folder. */
async function writeTranscript(home: string, sessionId: string, content: string) {
  const dir = path.join(home, "projects", FOLDER);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await writeFile(file, content);
  return file;
}

/** The real file system, with every call and every byte range read written down. */
function watchedIo() {
  const touched: { method: keyof ReadOnlyIo; path: string }[] = [];
  const reads: { path: string; position: number; length: number }[] = [];
  const io: ReadOnlyIo = {
    readdir: (dir) => (touched.push({ method: "readdir", path: dir }), nodeIo.readdir(dir)),
    stat: (target) => (touched.push({ method: "stat", path: target }), nodeIo.stat(target)),
    lstat: (target) => (touched.push({ method: "lstat", path: target }), nodeIo.lstat(target)),
    openRegular: async (file) => {
      touched.push({ method: "openRegular", path: file });
      const open = await nodeIo.openRegular(file);
      return {
        info: open.info,
        read: (position, length) => {
          reads.push({ path: file, position, length });
          return open.read(position, length);
        },
        close: () => open.close(),
      };
    },
  };
  const opened = () =>
    touched.filter((call) => call.method === "openRegular").map((call) => call.path);
  return { io, touched, reads, opened };
}

/** A clock the test moves. */
function clock() {
  let at = NOW;
  return {
    now: () => at,
    advance(ms: number) {
      at += ms;
    },
  };
}

describe("what a Claude Code session last said", () => {
  test("is never read by a poll, and is read once when it is asked for", async () => {
    const { home, run } = await quietHome();
    const file = await writeTranscript(
      home,
      ids.busy,
      transcript([prompt("Tidy the docs"), said("I tidied the docs.")]),
    );
    const { io, touched, opened } = watchedIo();
    const adapter = adapterFor(home, { run, transcriptIo: io });

    for (let poll = 0; poll < 3; poll += 1) {
      const { sessions } = await adapter.poll();
      expect(sessions.map((session) => session.status).sort()).toEqual(["idle", "working"]);
    }
    expect(touched).toEqual([]);
    expect(adapter.lastMessagesKept).toBe(0);

    const [first, second] = await Promise.all([
      adapter.lastMessage(BUSY),
      adapter.lastMessage(BUSY),
    ]);
    expect(first).toEqual({ message: { text: "I tidied the docs.", cut: false } });
    expect(second).toEqual(first);
    expect(opened()).toEqual([file]);
    expect(adapter.lastMessagesKept).toBe(1);

    // A session the last poll did not list is not read at all.
    touched.length = 0;
    await expect(adapter.lastMessage(`claude-code:${ids.permission}`)).resolves.toBeNull();
    expect(touched).toEqual([]);
  });

  test("for a background job known only by its job id, is not found, and no file is touched", async () => {
    const { home } = await quietHome();
    await writeTranscript(home, ids.background, transcript([said("PRIVATE-JOB reply")]));
    const job = feedEntries.find((entry) => entry.id === "job-0001");
    const run = prints(JSON.stringify([{ ...job, sessionId: undefined, state: "working" }]));
    const { io, touched } = watchedIo();
    const adapter = adapterFor(home, { run, transcriptIo: io });
    const { sessions } = await adapter.poll();
    expect(sessions.map((session) => session.id)).toContain("claude-code:job-0001");

    await expect(adapter.lastMessage("claude-code:job-0001")).resolves.toEqual({
      message: null,
      reason: "not-found",
    });
    expect(touched).toEqual([]);
    expect(adapter.lastMessagesKept).toBe(0);
  });

  test("is read from the last 256 KB of a transcript of many megabytes, and no more", async () => {
    expect(TRANSCRIPT_TAIL_BYTES).toBe(256 * 1024);
    const { home, run } = await quietHome();
    const early = transcript(
      Array.from({ length: 4_000 }, (_, index) =>
        prompt(`An early prompt, number ${index}, ${"padded ".repeat(100)}`),
      ),
    );
    const content = early + transcript([said("The build is green.")]);
    expect(content.length).toBeGreaterThan(2 * 1024 * 1024);
    const file = await writeTranscript(home, ids.busy, content);
    const { io, reads } = watchedIo();
    const adapter = adapterFor(home, { run, transcriptIo: io });
    await adapter.poll();

    await expect(adapter.lastMessage(BUSY)).resolves.toEqual({
      message: { text: "The build is green.", cut: false },
    });
    const size = Buffer.byteLength(content);
    expect(reads).toEqual([
      { path: file, position: size - TRANSCRIPT_TAIL_BYTES, length: TRANSCRIPT_TAIL_BYTES },
    ]);
  });

  test("is not read through a link, found there or put in the transcript's place later", async () => {
    const { home, run } = await quietHome();
    const elsewhere = path.join(await tempDir(), "transcript.jsonl");
    await writeFile(elsewhere, transcript([said("PRIVATE-ELSEWHERE reply")]));
    const dir = path.join(home, "projects", FOLDER);
    await mkdir(dir, { recursive: true });
    const named = path.join(dir, `${ids.busy}.jsonl`);
    await symlink(elsewhere, named);
    const time = clock();
    const { io, opened } = watchedIo();
    const adapter = adapterFor(home, { run, transcriptIo: io, now: time.now });
    await adapter.poll();

    const linked = await adapter.lastMessage(BUSY);
    expect(linked).toEqual({ message: null, reason: "not-found" });
    expect(opened()).toEqual([]);

    // Found as a file, then a link put in its place: the open refuses it.
    await rm(named);
    await writeFile(named, transcript([said("A reply of its own.")]));
    time.advance(10_000);
    await expect(adapter.lastMessage(BUSY)).resolves.toEqual({
      message: { text: "A reply of its own.", cut: false },
    });
    await rm(named);
    await symlink(elsewhere, named);
    time.advance(1_000);
    const swapped = await adapter.lastMessage(BUSY);
    expect(swapped).toEqual({ message: null, reason: "unreadable" });
    expect(JSON.stringify([linked, swapped])).not.toContain("PRIVATE");
  });

  // Windows keeps no named pipes among files.
  test.skipIf(process.platform === "win32")(
    "is not read from a named pipe, found there or put in the transcript's place later, and does not wait on one",
    async () => {
      const { home, run } = await quietHome();
      const dir = path.join(home, "projects", FOLDER);
      await mkdir(dir, { recursive: true });
      const named = path.join(dir, `${ids.busy}.jsonl`);
      // Opening a pipe for reading waits for a writer. Nobody will ever write to this one.
      execFileSync("mkfifo", [named]);
      const time = clock();
      const { io, opened } = watchedIo();
      const adapter = adapterFor(home, { run, transcriptIo: io, now: time.now });
      await adapter.poll();

      const started = Date.now();
      await expect(adapter.lastMessage(BUSY)).resolves.toEqual({
        message: null,
        reason: "not-found",
      });
      expect(opened()).toEqual([]);

      await rm(named);
      await writeFile(named, transcript([said("A reply of its own.")]));
      time.advance(10_000);
      await adapter.lastMessage(BUSY);
      await rm(named);
      execFileSync("mkfifo", [named]);
      time.advance(1_000);
      await expect(adapter.lastMessage(BUSY)).resolves.toEqual({
        message: null,
        reason: "unreadable",
      });
      expect(Date.now() - started).toBeLessThan(3_000);
    },
    8_000,
  );

  test.each([
    ["AGENT_LOOKOUT_WAITING_TEXT", "Off"],
    ["AGENT_LOOKOUT_LAST_MESSAGE", "last message of a waiting session"],
  ])(
    "is never read with %s=off, which the answer names, and the source says so",
    async (setting, transcriptRead) => {
      const { home, run } = await quietHome();
      await writeTranscript(home, ids.busy, transcript([said("PRIVATE-REPLY")]));
      const { io, touched } = watchedIo();
      const adapter = adapterFor(home, {
        env: { AGENT_LOOKOUT_CLAUDE_HOME: home, AGENT_LOOKOUT_CLAUDE_BIN: BIN, [setting]: " off " },
        run,
        transcriptIo: io,
      });
      const { health } = await adapter.poll();

      await expect(adapter.lastMessage(BUSY)).resolves.toEqual({
        message: null,
        reason: "off",
        setting,
      });
      expect(touched).toEqual([]);
      expect(adapter.lastMessagesKept).toBe(0);
      expect(health.watching).toEqual(
        watching(
          path.join(home, "sessions"),
          "every 2 seconds",
          "every 30 seconds",
          undefined,
          transcriptRead,
        ),
      );
    },
  );

  test("is forgotten once its session leaves the list, and not read for it again", async () => {
    const { home, run } = await quietHome();
    await writeTranscript(home, ids.busy, transcript([said("Done.")]));
    const { io, touched } = watchedIo();
    const ended = new Set<number>();
    const adapter = adapterFor(home, {
      run,
      transcriptIo: io,
      isAlive: (pid) => !ended.has(pid),
    });
    await adapter.poll();
    await adapter.lastMessage(BUSY);
    expect(adapter.lastMessagesKept).toBe(1);

    // Its process ends, so the next poll does not list it.
    ended.add(pids.busy);
    const { sessions } = await adapter.poll();
    expect(sessions.map((session) => session.id)).not.toContain(BUSY);
    expect(adapter.lastMessagesKept).toBe(0);
    touched.length = 0;
    await expect(adapter.lastMessage(BUSY)).resolves.toBeNull();
    expect(touched).toEqual([]);
  });

  test("is forgotten when a poll fails, and read again once a poll lists the session", async () => {
    const { home, run } = await quietHome();
    await writeTranscript(home, ids.busy, transcript([said("Done.")]));
    const { io, touched } = watchedIo();
    let failing = false;
    const adapter = adapterFor(home, {
      run,
      transcriptIo: io,
      isAlive: () => {
        if (failing) throw new Error("The stand-in was told to throw.");
        return true;
      },
    });
    await adapter.poll();
    await adapter.lastMessage(BUSY);
    expect(adapter.lastMessagesKept).toBe(1);

    failing = true;
    expect((await adapter.poll()).health.state).toBe("error");
    expect(adapter.lastMessagesKept).toBe(0);
    touched.length = 0;
    await expect(adapter.lastMessage(BUSY)).resolves.toBeNull();
    expect(touched).toEqual([]);

    failing = false;
    await adapter.poll();
    await expect(adapter.lastMessage(BUSY)).resolves.toEqual({
      message: { text: "Done.", cut: false },
    });
  });
});
