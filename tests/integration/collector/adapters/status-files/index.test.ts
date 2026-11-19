import { execFileSync, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, onTestFinished, test } from "vitest";

import {
  createStatusFileAdapter,
  STATUS_DIR_ENV,
  type StatusFileAdapterOptions,
} from "@collector/adapters/status-files/index";
import { MAX_FILE_BYTES, MAX_FILES } from "@collector/adapters/status-files/statusFile";
import { nodeIo, type ReadOnlyIo } from "@collector/files/readOnlyIo";
import { statusFile } from "@tests/fixtures/statusFiles";
import { tempDir } from "@tests/support/node/tempFiles";
import { asWritten } from "@tests/support/paths";

/** The real file system, with every call written down. */
function recordingIo() {
  const calls: { method: keyof ReadOnlyIo; path: string }[] = [];
  const io: ReadOnlyIo = {
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
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
    stdio: "ignore",
  });
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

  // Windows keeps no named pipes among files.
  test.skipIf(process.platform === "win32")(
    "a named pipe called .json is skipped without the poll waiting on it",
    async () => {
      const { folder, poll } = await watch();
      execFileSync("mkfifo", [path.join(folder, "pipe.json")]);
      await writeFile(path.join(folder, "night-shift.json"), statusFile());
      const result = await poll();

      expect(result.sessions).toHaveLength(1);
      expect(result.health.watching?.[3]).toEqual({ label: "Files skipped", value: "1" });
    },
  );

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

  // Windows has no POSIX file modes, so a folder cannot be made unlistable this way there.
  test.skipIf(process.platform === "win32")("a folder it cannot list is not working", async () => {
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

const GUIDE = fileURLToPath(new URL("../../../../../docs/GUIDE.md", import.meta.url));

/** What each of an example's waits prints in place of waiting, once its file is written. */
const PAUSED = "<paused>";

/** The one code block in a language under "Your own agents" in docs/GUIDE.md, as published. */
async function guideExample(language: string): Promise<string> {
  const text = await readFile(GUIDE, "utf8");
  const start = text.indexOf("\n## Your own agents\n");
  expect(start, 'docs/GUIDE.md has no "## Your own agents"').toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const end = rest.indexOf("\n## ");
  const section = end === -1 ? rest : rest.slice(0, end);
  const blocks = [...section.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)].filter(
    (block) => block[1] === language,
  );
  expect(blocks, `"Your own agents" has one ${language} example`).toHaveLength(1);
  return blocks[0]?.[2] ?? "";
}

/** Whether a program runs here. */
function runs(program: string): boolean {
  try {
    execFileSync(program, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * How an example in the guide is run: saved under the name the guide gives it,
 * with each of its waits replaced by a stop that prints `PAUSED` and lasts
 * until the test sends a line. Nothing else in it is changed.
 */
interface Runner {
  name: string;
  language: string;
  file: string;
  available: boolean;
  command(folder: string): Promise<[string, string[]]>;
}

const RUNNERS: Runner[] = [
  {
    name: "Python",
    language: "python",
    file: "my_agent.py",
    available: runs("python3"),
    async command() {
      const driver = [
        "import runpy, sys, time",
        "def pause(seconds):",
        `    print("${PAUSED}", flush=True)`,
        "    sys.stdin.readline()",
        "time.sleep = pause",
        'runpy.run_path("my_agent.py", run_name="__main__")',
      ].join("\n");
      return ["python3", ["-c", driver]];
    },
  },
  {
    name: "Node",
    language: "js",
    file: "my-agent.mjs",
    available: true,
    async command(folder) {
      const driver = path.join(folder, "pauses.mjs");
      await writeFile(
        driver,
        [
          'import readline from "node:readline";',
          "const lines = readline.createInterface({ input: process.stdin })[Symbol.asyncIterator]();",
          "globalThis.setTimeout = (resume) => {",
          `  console.log("${PAUSED}");`,
          "  lines.next().then(() => resume());",
          "};",
        ].join("\n"),
      );
      return [process.execPath, ["--import", pathToFileURL(driver).href, "my-agent.mjs"]];
    },
  },
];

/** A program the test talks to through its stdin and stdout, which is stopped when the test ends. */
function startProgram(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let errors = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (errors += chunk));
  child.on("error", (error) => (errors += String(error)));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  });
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return {
    child,
    exited,
    /** Resolves at the next line that is `marker`, and fails with `ended` if the program ends first. */
    async until(marker: string, ended: string) {
      for (;;) {
        const line = await lines.next();
        if (line.done) throw new Error(`${ended}\n${errors}`);
        if (line.value === marker) return;
      }
    },
  };
}

/** One run of an example, in a folder of its own, which is stopped when the test ends. */
async function startExample(runner: Runner, parent: string, env: NodeJS.ProcessEnv) {
  const work = path.join(parent, "work");
  await mkdir(work);
  await writeFile(path.join(work, runner.file), await guideExample(runner.language));
  const [command, args] = await runner.command(work);
  // By its real path, which is the one the example finds itself in on macOS,
  // and on Windows its long name, rather than the short one a temporary folder
  // can be given.
  const cwd = await realpath(work);
  const { child, exited, until } = startProgram(command, args, cwd, env);
  return {
    pid: child.pid,
    cwd,
    /** Resolves once the example has written its file and come to its next wait. */
    paused: () => until(PAUSED, "The example ended before its next wait."),
    /** Lets it go on from the wait it is at. */
    goOn() {
      child.stdin.write("\n");
    },
    /** Lets it go on from its last wait to its end. */
    end() {
      child.stdin.end("\n");
      return exited;
    },
    kill(signal: NodeJS.Signals) {
      child.kill(signal);
      return exited;
    },
  };
}

/** The adapter on a folder that does not exist yet, and the environment an example runs in. */
async function setUp() {
  const watched = await watch({ make: false });
  const home = path.join(watched.parent, "home");
  // Windows keeps the home folder in USERPROFILE.
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    [STATUS_DIR_ENV]: watched.folder,
  };
  return { ...watched, env };
}

for (const runner of RUNNERS) {
  describe.skipIf(!runner.available)(
    `the ${runner.name} example in docs/GUIDE.md, run against the status-file source`,
    () => {
      test("its session appears as it starts, waits on a question, works again, and goes as it ends", async () => {
        const { folder, parent, poll, env } = await setUp();
        expect((await poll()).health.state).toBe("not-set-up");
        const example = await startExample(runner, parent, env);

        await example.paused();
        const working = await poll();
        expect(working.sessions).toMatchObject([
          {
            id: "status-files:my-agent.json",
            agent: "my-agent",
            name: "docs-site",
            cwd: example.cwd,
            project: "work",
            surface: "terminal",
            status: "working",
            pid: example.pid,
            alive: true,
          },
        ]);
        expect(working.health.watching?.slice(2)).toEqual([
          { label: "Files read", value: "1" },
          { label: "Files skipped", value: "0" },
        ]);
        // The file was renamed into place: nothing else is left in the folder.
        expect(await readdir(folder)).toEqual(["my-agent.json"]);
        const written = JSON.parse(await readFile(path.join(folder, "my-agent.json"), "utf8"));
        expect(working.sessions[0]?.statusSince).toBe(written.since);

        example.goOn();
        await example.paused();
        const waiting = await poll();
        expect(waiting.sessions).toMatchObject([
          { name: "docs-site", status: "needs-you", waitingReason: "question" },
        ]);
        const waitedFrom = waiting.sessions[0]?.statusSince ?? Infinity;
        expect(waitedFrom).toBeGreaterThanOrEqual(written.since);

        example.goOn();
        await example.paused();
        const again = await poll();
        expect(again.sessions).toMatchObject([{ name: "docs-site", status: "working" }]);
        expect(again.sessions[0]?.statusSince).toBeGreaterThanOrEqual(waitedFrom);

        expect(await example.end()).toEqual({ code: 0, signal: null });
        expect(await readdir(folder)).toEqual([]);
        expect((await poll()).sessions).toEqual([]);
      }, 20_000);

      const STOPS: [string, NodeJS.Signals][] = [
        ["Ctrl-C", "SIGINT"],
        ["kill", "SIGTERM"],
        ["a closed terminal", "SIGHUP"],
      ];
      for (const [stop, signal] of STOPS) {
        // Windows has no POSIX signals: a signal sent there ends the program outright.
        test.skipIf(process.platform === "win32")(
          `stopped by ${stop}, it deletes its file`,
          async () => {
            const { folder, parent, poll, env } = await setUp();
            const example = await startExample(runner, parent, env);
            await example.paused();
            example.goOn();
            await example.paused();
            expect((await poll()).sessions).toMatchObject([{ status: "needs-you" }]);

            await example.kill(signal);
            expect(await readdir(folder)).toEqual([]);
            expect((await poll()).sessions).toEqual([]);
          },
          20_000,
        );
      }

      test("killed outright, it leaves its file, and its session goes because of its pid", async () => {
        const { folder, parent, poll, env } = await setUp();
        const example = await startExample(runner, parent, env);
        await example.paused();
        expect((await poll()).sessions).toMatchObject([{ status: "working", alive: true }]);

        expect(await example.kill("SIGKILL")).toEqual({ code: null, signal: "SIGKILL" });
        expect(await readdir(folder)).toEqual(["my-agent.json"]);
        const after = await poll();
        expect(after.sessions).toEqual([]);
        expect(after.health.detail).toContain(
          "1 file names a process that has ended, so its session is not shown.",
        );
      }, 20_000);

      test("with no setting, it makes ~/.agent-lookout/sessions and writes there", async () => {
        const { parent, env } = await setUp();
        const home = path.join(parent, "home");
        const folder = path.join(home, ".agent-lookout", "sessions");
        const adapter = createStatusFileAdapter({ env: {}, homeDir: home });
        const { [STATUS_DIR_ENV]: _setting, ...withoutSetting } = env;
        const example = await startExample(runner, parent, withoutSetting);

        await example.paused();
        expect(await readdir(folder)).toEqual(["my-agent.json"]);
        expect((await adapter.poll()).sessions).toMatchObject([{ status: "working" }]);

        example.goOn();
        await example.paused();
        example.goOn();
        await example.paused();
        await example.end();
        expect(await readdir(folder)).toEqual([]);
      }, 20_000);
    },
  );
}

/** What the stand-in for Amp prints each time it has done what it was told. */
const DONE = "<done>";

/**
 * A stand-in for Amp, written by hand from its Plugin API page, with only what
 * the guide's plugin uses: `on` for `session.start`, `threads.get` with a state
 * to watch and to get, `system.workspaceRoot`, `system.executor.kind`,
 * `helpers.filePathFromURI`, `logger` and `onDispose`. It loads the plugin by
 * calling its default export, then does what each line from the test says and
 * prints `DONE`. A thread is running until the test says otherwise. The
 * plugin's minute is no timer: it comes when the test says so.
 */
const AMP_STAND_IN = [
  'import readline from "node:readline";',
  'import { fileURLToPath, pathToFileURL } from "node:url";',
  "const [kind, root] = process.argv.slice(2);",
  "let minute = () => {};",
  "globalThis.setInterval = (callback) => ((minute = callback), 1);",
  "globalThis.clearInterval = () => (minute = () => {});",
  "const threads = new Map();",
  "function threadOf(id) {",
  "  if (!threads.has(id)) {",
  '    const thread = { value: "running", watchers: new Set() };',
  "    thread.state = {",
  "      get: async () => thread.value,",
  "      subscribe(watcher) {",
  "        thread.watchers.add(watcher);",
  "        return { unsubscribe: () => thread.watchers.delete(watcher) };",
  "      },",
  "    };",
  "    threads.set(id, thread);",
  "  }",
  "  return threads.get(id);",
  "}",
  "const handlers = new Map();",
  "const disposers = [];",
  "const amp = {",
  '  system: { workspaceRoot: root === "none" ? null : new URL(root), executor: { kind } },',
  "  helpers: { filePathFromURI: (uri) => fileURLToPath(uri.toString()) },",
  "  logger: { log: (...values) => console.error(...values) },",
  "  on: (event, handler) => (handlers.set(event, handler), { unsubscribe() {} }),",
  "  threads: { get: (id) => ({ id, state: threadOf(id).state }) },",
  "  onDispose: (callback) => (disposers.push(callback), { unsubscribe() {} }),",
  "};",
  'const plugin = await import(pathToFileURL("agent-lookout.ts").href);',
  "await plugin.default(amp);",
  `console.log("${DONE}");`,
  "for await (const line of readline.createInterface({ input: process.stdin })) {",
  "  const command = JSON.parse(line);",
  '  if (command.start) await handlers.get("session.start")?.({ thread: { id: command.start } }, {});',
  "  if (command.state) {",
  "    const thread = threadOf(command.thread);",
  "    thread.value = command.state;",
  "    for (const watcher of thread.watchers) watcher(command.state);",
  "  }",
  "  if (command.minute) minute();",
  "  if (command.dispose) for (const callback of disposers) await callback();",
  `  console.log("${DONE}");`,
  "}",
].join("\n");

/** What the stand-in for Amp is told: a thread's session starts, its state changes, a minute passes, or Amp unloads the plugin. */
type AmpCommand =
  { start: string } | { thread: string; state: string } | { minute: true } | { dispose: true };

/**
 * Whether this Node runs a TypeScript file with its types stripped, as the Amp
 * example needs. Node 22.12 to 22.17 do it only with the flag, and later Node
 * takes the flag too.
 */
function stripsTypes(): boolean {
  try {
    const answer = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "--print", "process.features.typescript"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return ["strip", "transform"].includes(answer.trim());
  } catch {
    return false;
  }
}

/**
 * The guide's Amp plugin, as published, saved as `agent-lookout.ts` in a folder
 * of its own and loaded by the stand-in for Amp with its types stripped. `kind`
 * is the executor's kind, and `root` the workspace's address, or `none`.
 */
async function startAmp(parent: string, env: NodeJS.ProcessEnv, kind: string, root: string) {
  const work = path.join(parent, "amp");
  await mkdir(work);
  await writeFile(path.join(work, "agent-lookout.ts"), await guideExample("ts"));
  await writeFile(path.join(work, "amp.mjs"), AMP_STAND_IN);
  // So that every Node takes the plugin as a module, as Amp's runtime does.
  await writeFile(path.join(work, "package.json"), '{ "type": "module" }\n');
  const args = ["--experimental-strip-types", "amp.mjs", kind, root];
  const { child, exited, until } = startProgram(process.execPath, args, work, env);
  const done = () => until(DONE, "The plugin's run ended.");
  await done();
  return {
    pid: child.pid,
    /** Resolves once the stand-in and the plugin have done it. */
    async send(command: AmpCommand) {
      child.stdin.write(`${JSON.stringify(command)}\n`);
      await done();
    },
    end() {
      child.stdin.end();
      return exited;
    },
    kill(signal: NodeJS.Signals) {
      child.kill(signal);
      return exited;
    },
  };
}

const THREAD = "T-demo-1";
const AMP_FILE = `amp-${THREAD}.json`;

describe.skipIf(!stripsTypes())(
  "the Amp plugin in docs/GUIDE.md, run against the status-file source",
  () => {
    test("a thread shows as working, then waiting for permission, then idle, and goes when Amp unloads the plugin", async () => {
      const { folder, parent, poll, env } = await setUp();
      const project = path.join(parent, "demo-project");
      await mkdir(project);
      expect((await poll()).health.state).toBe("not-set-up");
      const amp = await startAmp(parent, env, "local", pathToFileURL(project).href);

      await amp.send({ start: THREAD });
      const working = await poll();
      expect(working.sessions).toMatchObject([
        {
          id: `status-files:${AMP_FILE}`,
          agent: "Amp",
          name: "demo-project",
          project: "demo-project",
          surface: "terminal",
          status: "working",
          pid: amp.pid,
          alive: true,
        },
      ]);
      expect(asWritten(working.sessions[0]?.cwd ?? "")).toBe(asWritten(project));
      // Renamed into place, with only the fields the guide lists, and no name.
      expect(await readdir(folder)).toEqual([AMP_FILE]);
      const file = path.join(folder, AMP_FILE);
      const written = JSON.parse(await readFile(file, "utf8"));
      expect(Object.keys(written).sort()).toEqual([
        "agent",
        "app",
        "cwd",
        "pid",
        "since",
        "status",
      ]);
      expect(working.sessions[0]?.statusSince).toBe(written.since);

      await amp.send({ thread: THREAD, state: "awaiting-approval" });
      const waiting = await poll();
      expect(waiting.sessions).toMatchObject([
        { status: "needs-you", waitingReason: "permission" },
      ]);
      const waitedFrom = waiting.sessions[0]?.statusSince ?? Infinity;
      expect(waitedFrom).toBeGreaterThanOrEqual(written.since);

      // Working again, its file is written again each minute, with the same since.
      await amp.send({ thread: THREAD, state: "running" });
      const again = await readFile(file, "utf8");
      expect(JSON.parse(again).since).toBeGreaterThanOrEqual(waitedFrom);
      const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
      await utimes(file, tenMinutesAgo, tenMinutesAgo);
      await amp.send({ minute: true });
      expect((await stat(file)).mtimeMs).toBeGreaterThan(tenMinutesAgo.getTime() + 60_000);
      expect(await readFile(file, "utf8")).toBe(again);

      await amp.send({ thread: THREAD, state: "error" });
      expect((await poll()).sessions).toMatchObject([{ status: "failed" }]);

      await amp.send({ thread: THREAD, state: "idle" });
      expect((await poll()).sessions).toMatchObject([{ status: "idle" }]);
      // Opening the thread again starts its session again, and changes nothing.
      const idle = await readFile(file, "utf8");
      await amp.send({ start: THREAD });
      expect(await readFile(file, "utf8")).toBe(idle);

      await amp.send({ dispose: true });
      expect(await readdir(folder)).toEqual([]);
      expect((await poll()).sessions).toEqual([]);
      // Once unloaded, it writes nothing, whatever the thread does.
      await amp.send({ thread: THREAD, state: "running" });
      await amp.send({ minute: true });
      expect(await readdir(folder)).toEqual([]);
      expect(await amp.end()).toEqual({ code: 0, signal: null });
    }, 20_000);

    for (const kind of ["remote", "unknown"]) {
      test(`a thread whose executor is ${kind} writes nothing`, async () => {
        const { parent, poll, env } = await setUp();
        const amp = await startAmp(parent, env, kind, "none");
        await amp.send({ start: THREAD });
        await amp.send({ thread: THREAD, state: "awaiting-approval" });
        await amp.send({ minute: true });

        expect(await readdir(parent)).not.toContain("sessions");
        expect((await poll()).health.state).toBe("not-set-up");
      }, 20_000);
    }

    test("killed outright, it leaves its file, and its session goes because of its pid", async () => {
      const { folder, parent, poll, env } = await setUp();
      const amp = await startAmp(parent, env, "local", "none");
      await amp.send({ start: THREAD });
      // With no workspace, the session is named after its file.
      expect((await poll()).sessions).toMatchObject([
        { name: `amp-${THREAD}`, cwd: null, status: "working", alive: true },
      ]);

      expect(await amp.kill("SIGKILL")).toEqual({ code: null, signal: "SIGKILL" });
      expect(await readdir(folder)).toEqual([AMP_FILE]);
      const after = await poll();
      expect(after.sessions).toEqual([]);
      expect(after.health.detail).toContain(
        "1 file names a process that has ended, so its session is not shown.",
      );
    }, 20_000);

    test("with no setting, it makes ~/.agent-lookout/sessions and writes there", async () => {
      const { parent, env } = await setUp();
      const home = path.join(parent, "home");
      const folder = path.join(home, ".agent-lookout", "sessions");
      const adapter = createStatusFileAdapter({ env: {}, homeDir: home });
      const { [STATUS_DIR_ENV]: _setting, ...withoutSetting } = env;
      const amp = await startAmp(parent, withoutSetting, "local", "none");

      await amp.send({ start: THREAD });
      expect(await readdir(folder)).toEqual([AMP_FILE]);
      expect((await adapter.poll()).sessions).toMatchObject([{ status: "working" }]);

      await amp.send({ dispose: true });
      expect(await readdir(folder)).toEqual([]);
    }, 20_000);
  },
);
