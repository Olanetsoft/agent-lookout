import { execFileSync, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createStatusFileAdapter,
  STATUS_DIR_ENV,
  type StatusFileAdapterOptions,
} from "@collector/adapters/status-files/index";
import { MAX_FILE_BYTES, MAX_FILES } from "@collector/adapters/status-files/statusFile";
import { nodeIo, type CodexIo } from "@collector/adapters/codex/io";
import { statusFile } from "@tests/fixtures/statusFiles";
import { tempDir } from "@tests/support/node/tempFiles";

/** The real file system, with every call written down. */
function recordingIo() {
  const calls: { method: keyof CodexIo; path: string }[] = [];
  const io: CodexIo = {
    readdir: (target) => (calls.push({ method: "readdir", path: target }), nodeIo.readdir(target)),
    stat: (target) => (calls.push({ method: "stat", path: target }), nodeIo.stat(target)),
    lstat: (target) => (calls.push({ method: "lstat", path: target }), nodeIo.lstat(target)),
    openRegular: (target) => (
      calls.push({ method: "openRegular", path: target }),
      nodeIo.openRegular(target)
    ),
  };
  return { io, calls };
}

/**
 * The adapter pointed at a real temporary folder through its setting, reading
 * real files and asking the system whether real processes are alive. The clock
 * is the real one, so a file's modified time and the clock agree.
 */
async function watch(options: { make?: boolean } & Partial<StatusFileAdapterOptions> = {}) {
  const parent = await tempDir();
  const folder = path.join(parent, "sessions");
  if (options.make !== false) await mkdir(folder);
  const recorded = recordingIo();
  const adapter = createStatusFileAdapter({
    env: { [STATUS_DIR_ENV]: folder },
    homeDir: path.join(parent, "home"),
    io: recorded.io,
    ...options,
  });
  return {
    parent,
    folder,
    calls: recorded.calls,
    poll: () => adapter.poll(),
    write: (name: string, content: string) => writeFile(path.join(folder, name), content),
  };
}

/** Every name in a folder with its contents, to show that nothing in it changed. */
async function contentsOf(folder: string): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};
  for (const name of (await readdir(folder)).sort()) {
    const file = path.join(folder, name);
    const info = await stat(file).catch(() => null);
    contents[name] = info?.isFile() ? await readFile(file, "utf8") : "not a file";
  }
  return contents;
}

/** A process that runs until it is stopped, and is stopped when the test ends. */
async function runningProcess() {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return {
    pid: child.pid as number,
    async stop() {
      child.kill("SIGKILL");
      await exited;
    },
  };
}

describe("the status-file source, on a real folder", () => {
  test("with no folder it is not set up, and it makes no folder", async () => {
    const { parent, folder, poll } = await watch({ make: false });
    const result = await poll();

    expect(result.health.state).toBe("not-set-up");
    expect(result.health.detail).toContain(`make the folder ${folder}`);
    expect(result.sessions).toEqual([]);
    expect(await readdir(parent)).toEqual([]);
  });

  test("an empty folder is watched and empty", async () => {
    const { poll } = await watch();
    const result = await poll();
    expect(result.health.state).toBe("ok");
    expect(result.health.watching?.slice(2)).toEqual([
      { label: "Files read", value: "0" },
      { label: "Files skipped", value: "0" },
    ]);
    expect(result.sessions).toEqual([]);
  });

  test("a file a script writes appears at the next poll, needs you when it says so, and goes when deleted", async () => {
    const { folder, poll, write } = await watch();
    await poll();

    await write("night-shift.json", statusFile({ status: "working" }));
    const working = await poll();
    expect(working.sessions).toMatchObject([
      {
        id: "status-files:night-shift.json",
        source: "status-files",
        agent: "Night Shift",
        name: "checkout-flow",
        status: "working",
      },
    ]);
    const workingSince = working.sessions[0]?.statusSince ?? 0;
    expect(workingSince).toBeGreaterThan(0);

    await write("night-shift.json", statusFile({ status: "waiting", reason: "permission" }));
    const waiting = await poll();
    expect(waiting.sessions).toMatchObject([{ status: "needs-you", waitingReason: "permission" }]);
    expect(waiting.sessions[0]?.statusSince).toBeGreaterThanOrEqual(workingSince);

    await rm(path.join(folder, "night-shift.json"));
    expect((await poll()).sessions).toEqual([]);
  });

  test("a session whose process ends is dropped at the next poll", async () => {
    const { poll, write } = await watch();
    const agent = await runningProcess();
    await write("night-shift.json", statusFile({ pid: agent.pid }));

    expect((await poll()).sessions).toMatchObject([{ pid: agent.pid, alive: true }]);

    await agent.stop();
    const after = await poll();
    expect(after.sessions).toEqual([]);
    expect(after.health.detail).toContain(
      "1 file names a process that has ended, so its session is not shown.",
    );
  });

  test("a link out of the folder is skipped and counted, and what it points at is never opened", async () => {
    const { parent, folder, poll, calls } = await watch();
    const outside = path.join(parent, "outside.json");
    await writeFile(outside, statusFile({ name: "outside-the-folder" }));
    await symlink(outside, path.join(folder, "escape.json"));
    await symlink("../outside.json", path.join(folder, "relative.json"));
    await writeFile(path.join(folder, "night-shift.json"), statusFile());
    const result = await poll();

    expect(result.sessions.map((session) => session.name)).toEqual(["checkout-flow"]);
    expect(result.health.watching?.slice(2)).toEqual([
      { label: "Files read", value: "1" },
      { label: "Files skipped", value: "2" },
    ]);
    expect(calls.some((call) => call.path === outside)).toBe(false);
  });

  test("a named pipe called .json is skipped without the poll waiting on it", async () => {
    const { folder, poll } = await watch();
    execFileSync("mkfifo", [path.join(folder, "pipe.json")]);
    await writeFile(path.join(folder, "night-shift.json"), statusFile());
    const result = await poll();

    expect(result.sessions).toHaveLength(1);
    expect(result.health.watching?.[3]).toEqual({ label: "Files skipped", value: "1" });
  });

  test(`more than ${MAX_FILES} files, and files over 16 KB, are skipped and counted`, async () => {
    const { poll, write } = await watch();
    for (let index = 0; index < MAX_FILES + 3; index += 1) {
      await write(
        `agent-${String(index).padStart(3, "0")}.json`,
        statusFile({ name: `s-${index}` }),
      );
    }
    await write("aaa-large.json", statusFile({ name: "x".repeat(MAX_FILE_BYTES) }));
    const result = await poll();

    // The large file was written last, and takes one of the 200 places.
    expect(result.sessions).toHaveLength(MAX_FILES - 1);
    expect(result.health.watching?.slice(2)).toEqual([
      { label: "Files read", value: String(MAX_FILES - 1) },
      { label: "Files skipped", value: "5" },
    ]);
  });

  test(`files left behind, over ${MAX_FILES} of them, never push out a session that has just begun`, async () => {
    const { folder, poll, write } = await watch();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    for (let index = 0; index < MAX_FILES; index += 1) {
      const name = `night-shift-run-${String(index).padStart(4, "0")}.json`;
      await write(name, statusFile({ status: "finished" }));
      await utimes(path.join(folder, name), twoDaysAgo, twoDaysAgo);
    }
    await write(
      "night-shift-run-0200.json",
      statusFile({ name: "billing-webhooks", status: "waiting" }),
    );
    const result = await poll();

    expect(result.sessions).toMatchObject([{ name: "billing-webhooks", status: "needs-you" }]);
    expect(result.health.watching?.slice(2)).toEqual([
      { label: "Files read", value: String(MAX_FILES) },
      { label: "Files skipped", value: "1" },
    ]);
  });

  test("a file caught half written does not break a poll, and shows again once whole", async () => {
    const { poll, write } = await watch();
    const whole = statusFile({ status: "waiting" });
    await write("night-shift.json", whole.slice(0, 25));
    const half = await poll();
    expect(half.health.state).toBe("ok");
    expect(half.sessions).toEqual([]);

    await write("night-shift.json", whole);
    expect((await poll()).sessions).toMatchObject([{ status: "needs-you" }]);

    // Caught half written after a good read, what it said stands for a poll.
    await write("night-shift.json", "");
    expect((await poll()).sessions).toMatchObject([{ status: "needs-you" }]);
  });

  test("a file rewritten in place while it is read never breaks a poll", async () => {
    const { poll, write } = await watch();
    await write("night-shift.json", statusFile());
    await poll();

    let writing = true;
    const writer = (async () => {
      for (let round = 0; writing; round += 1) {
        const status = round % 2 === 0 ? "working" : "waiting";
        await write("night-shift.json", statusFile({ status, padding: "x".repeat(round % 4000) }));
      }
    })();
    try {
      for (let round = 0; round < 100; round += 1) {
        const result = await poll();
        expect(result.health.state).toBe("ok");
        expect(result.sessions.length).toBeLessThanOrEqual(1);
        for (const session of result.sessions) {
          expect(["working", "needs-you"]).toContain(session.status);
        }
      }
    } finally {
      writing = false;
      await writer;
    }
  });

  test("Agent Lookout changes nothing in the folder", async () => {
    const { folder, poll, write } = await watch();
    await write("night-shift.json", statusFile({ status: "waiting" }));
    await write("broken.json", "{");
    await write("notes.txt", "kept as it is");
    await write("large.json", statusFile({ name: "x".repeat(MAX_FILE_BYTES) }));
    const before = await contentsOf(folder);

    for (let round = 0; round < 3; round += 1) await poll();

    expect(await contentsOf(folder)).toEqual(before);
  });

  test("a folder it cannot list is not working", async () => {
    const { folder, poll } = await watch();
    await chmod(folder, 0o000);
    try {
      expect((await poll()).health).toMatchObject({
        state: "error",
        detail: `Status files could not be read: the folder ${folder} could not be listed.`,
      });
    } finally {
      await chmod(folder, 0o755);
    }
  });

  test("a file where the folder should be is no folder, so nothing is set up", async () => {
    const { folder, poll } = await watch();
    await rm(folder, { recursive: true });
    await writeFile(folder, "a file where the folder should be");
    expect((await poll()).health.state).toBe("not-set-up");
  });
});
