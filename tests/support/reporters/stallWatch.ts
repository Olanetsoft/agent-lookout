// Ends a test run that has stopped moving. On Windows CI a component test file
// has more than once sat open without a word, never passing and never failing,
// until the job's time limit cancelled it. A test stuck waiting on something is
// cut off by its own timeout. A page or worker whose thread is blocked, by a test
// or by the browser, is not, since its timeout runs on that thread, and neither
// is a stalled connection to the browser. In the logs these look the same. The
// file is different each time and reruns pass, so I think it is the browser or
// its connection, but the logs can't tell them apart. The watch catches all of them.
//
// While a run goes, each report of a file, a test, a suite, a hook, a log, an
// annotation or an artifact counts as movement. When none comes for `QUIET_MS`,
// the watch prints which test files are still open, each as it last reported,
// and ends the process with a failure. In watch mode, or under a debugger, it
// does nothing.

import { url as inspectorUrl } from "node:inspector";

import type { Reporter } from "vitest/node";

/**
 * How long a run may go with nothing reported before it is ended: 3 minutes.
 *
 * In a passing run the longest wait for a report is a test or a hook that runs
 * almost to its timeout. The timeouts here are 5 s a unit test, 30 s an
 * integration test and 15 s a component test, Vitest's own for a browser, with
 * 10 s a hook in Node and 30 s one in the browser. Vitest gives a browser page
 * 60 s to connect. The longest a test sets for itself is 60 s, the tour's
 * director test, and 120 s in the check against the real `claude`, which runs
 * only when asked. 3 minutes is above all of them with a minute to spare, and a
 * stalled run on Windows still ends well inside the job's 20 minutes.
 */
export const QUIET_MS = 3 * 60_000;

/** What the watch reads of a project. */
interface ProjectLike {
  readonly name: string;
}

/** What the watch reads of a test file, from a specification or a module. */
interface FileLike {
  readonly moduleId: string;
  readonly project: ProjectLike;
}

interface ModuleLike extends FileLike {
  readonly type: "module";
}

interface SuiteLike {
  readonly type: "suite";
  readonly fullName: string;
  readonly module: FileLike;
}

interface TestLike {
  readonly fullName: string;
  readonly module: FileLike;
}

type HookLike =
  | { readonly name: "beforeAll" | "afterAll"; readonly entity: SuiteLike | ModuleLike }
  | { readonly name: "beforeEach" | "afterEach"; readonly entity: TestLike };

/** What the watch reads of the Vitest it reports to. */
interface VitestLike {
  readonly config: {
    readonly watch: boolean;
    readonly root: string;
    readonly inspector: { readonly enabled?: boolean };
  };
}

export interface StallWatchOptions {
  /** How long the run may go with nothing reported. `QUIET_MS` unless a test sets it. */
  quietMs?: number;
  /** The time in milliseconds, from any fixed start. */
  now?: () => number;
  /** Runs `run` once, `ms` from now, and gives back what cancels it. */
  after?: (ms: number, run: () => void) => () => void;
  /** Where the message goes. */
  write?: (text: string) => void;
  /** Ends the process with this code. */
  exit?: (code: number) => void;
  /** Whether to add the message as a GitHub Actions error, as on a CI runner. */
  githubActions?: boolean;
  /**
   * Whether a debugger can stop this run: Node's inspector is open in Vitest's
   * own process. An editor's debugger opens it there, from a debug terminal or a
   * launch setup, and so does attaching to a running Vitest.
   */
  debuggerOpen?: () => boolean;
}

/** Where a test file is in a run, from not yet queued to started. */
type FileState = "waiting" | "queued" | "collected" | "started";

interface OpenFile {
  readonly file: FileLike;
  state: FileState;
  /** What a started file last reported it is in: the tests running, and the beforeAll and afterAll hooks. */
  readonly within: Set<string>;
  /** The test it last reported a result for. */
  lastFinished?: string;
}

/** The order open files are listed in: the furthest along first. */
const STATE_ORDER: Record<FileState, number> = { started: 0, collected: 1, queued: 2, waiting: 3 };

/** Marks a watch. `Symbol.for` gives the same symbol in each copy of this module a config load makes. */
const MARK: unique symbol = Symbol.for("agent-lookout:stall-watch");

/** A Vitest reporter that ends a run in which nothing has reported for a while. */
export class StallWatch implements Reporter {
  readonly [MARK] = true;
  private readonly quietMs: number;
  private readonly now: () => number;
  private readonly after: (ms: number, run: () => void) => () => void;
  private readonly write: (text: string) => void;
  private readonly exit: (code: number) => void;
  private readonly githubActions: boolean;
  private readonly debuggerOpen: () => boolean;

  /** Off until Vitest says the run is neither watched nor debugged. */
  private armable = false;
  private root = "";
  private running = false;
  private lastReport = 0;
  private cancelTimer: (() => void) | undefined;
  /** Every file of the run that has not ended, in the run's order. */
  private readonly open = new Map<string, OpenFile>();

  constructor(options: StallWatchOptions = {}) {
    this.quietMs = options.quietMs ?? QUIET_MS;
    this.now = options.now ?? (() => performance.now());
    this.after = options.after ?? afterUnref;
    this.write = options.write ?? ((text) => void process.stdout.write(text));
    this.exit = options.exit ?? exitOnceWritten;
    this.githubActions = options.githubActions ?? process.env.GITHUB_ACTIONS === "true";
    this.debuggerOpen = options.debuggerOpen ?? (() => inspectorUrl() !== undefined);
  }

  onInit(vitest: VitestLike): void {
    // A person in watch mode, or stopped at a breakpoint, can leave a run quiet as
    // long as they like. Vitest sets `inspector.enabled` only for `--inspect` and
    // `--inspect-brk`, or the same in the config, so an editor's debugger is
    // found by Node's inspector instead.
    this.armable =
      !vitest.config.watch && vitest.config.inspector.enabled !== true && !this.debuggerOpen();
    this.root = vitest.config.root;
  }

  onTestRunStart(specifications: ReadonlyArray<FileLike>): void {
    if (!this.armable) return;
    this.onTestRunEnd();
    for (const file of specifications) {
      this.open.set(keyOf(file), { file, state: "waiting", within: new Set() });
    }
    this.running = true;
    this.lastReport = this.now();
    this.schedule(this.quietMs);
  }

  onTestRunEnd(): void {
    this.running = false;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.open.clear();
  }

  onTestModuleQueued(module: FileLike): void {
    this.moveTo(module, "queued");
  }

  onTestModuleCollected(module: FileLike): void {
    this.moveTo(module, "collected");
  }

  onTestModuleStart(module: FileLike): void {
    this.moveTo(module, "started");
  }

  onTestModuleEnd(module: FileLike): void {
    this.moved();
    this.open.delete(keyOf(module));
  }

  onTestCaseReady(test: TestLike): void {
    this.moved();
    this.open.get(keyOf(test.module))?.within.add(`"${test.fullName}"`);
  }

  onTestCaseResult(test: TestLike): void {
    this.moved();
    const open = this.open.get(keyOf(test.module));
    if (!open) return;
    open.within.delete(`"${test.fullName}"`);
    open.lastFinished = test.fullName;
  }

  onHookStart(hook: HookLike): void {
    this.moved();
    // A beforeEach or an afterEach runs inside its test, which is already named.
    if (hook.name === "beforeAll" || hook.name === "afterAll") {
      this.open.get(keyOf(fileOf(hook.entity)))?.within.add(hookName(hook.name, hook.entity));
    }
  }

  onHookEnd(hook: HookLike): void {
    this.moved();
    if (hook.name === "beforeAll" || hook.name === "afterAll") {
      this.open.get(keyOf(fileOf(hook.entity)))?.within.delete(hookName(hook.name, hook.entity));
    }
  }

  onTestSuiteReady(): void {
    this.moved();
  }

  onTestSuiteResult(): void {
    this.moved();
  }

  onTestCaseAnnotate(): void {
    this.moved();
  }

  onTestCaseArtifactRecord(): void {
    this.moved();
  }

  onUserConsoleLog(): void {
    this.moved();
  }

  private moved(): void {
    if (this.running) this.lastReport = this.now();
  }

  private moveTo(file: FileLike, state: FileState): void {
    this.moved();
    if (!this.running) return;
    const key = keyOf(file);
    const open = this.open.get(key);
    if (open) open.state = state;
    else this.open.set(key, { file, state, within: new Set() });
  }

  /** One timer at a time: when it fires early, because something reported, it is set again for the rest. */
  private schedule(ms: number): void {
    this.cancelTimer = this.after(ms, () => {
      this.cancelTimer = undefined;
      if (!this.running) return;
      const quiet = this.now() - this.lastReport;
      if (quiet < this.quietMs) this.schedule(this.quietMs - quiet);
      // A debugger opened since the run began, as one attached to look at it, keeps the run.
      else if (this.debuggerOpen()) this.onTestRunEnd();
      else this.stall();
    });
  }

  private stall(): void {
    this.running = false;
    const message = this.message();
    this.write(`\n${message}\n`);
    if (this.githubActions) this.write(`::error title=Test run stalled::${escapeData(message)}\n`);
    this.exit(1);
  }

  private message(): string {
    const files = [...this.open.values()].sort(
      (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state],
    );
    const quiet = `nothing has reported for ${spell(this.quietMs)}`;
    const end = "The run is ended here with a failure rather than left to hang.";
    if (files.length === 0) {
      return [
        `The test run stalled: ${quiet}, and every test file has ended, but the run has not.`,
        end,
      ].join("\n");
    }
    const count = files.length === 1 ? "1 test file is" : `${files.length} test files are`;
    return [
      `The test run stalled: ${quiet}, and ${count} still open, each as it last reported:`,
      ...files.map((open) => `  ${this.nameOf(open.file)}: ${whereIs(open)}`),
      // Vitest sends most of a page's or a worker's reports at most every 100 ms,
      // and holds the rest for a timer of that page or worker, which a frozen one
      // never runs.
      "A page or worker that freezes can leave its last reports unsent, so a file can be further on than shown.",
      end,
    ].join("\n");
  }

  /** A file as Vitest names it: `|project| path`, the path from the root, with forward slashes. */
  private nameOf(file: FileLike): string {
    const id = file.moduleId.replaceAll("\\", "/");
    const root = this.root.replaceAll("\\", "/").replace(/\/+$/, "");
    const path = root !== "" && id.startsWith(`${root}/`) ? id.slice(root.length + 1) : id;
    return file.project.name ? `|${file.project.name}| ${path}` : path;
  }
}

/**
 * The Vite plugin that puts a `StallWatch` among the reporters of a Vitest run.
 *
 * Vitest calls it for each project, once it has picked the reporters and before
 * it makes them. Adding the watch to that list keeps the reporters Vitest picked:
 * the default one, or the agent one when an agent runs the tests, the GitHub
 * Actions one in CI, or those named with `--reporter`. Naming reporters in the
 * config would replace them. Each project loads the config again, with a plugin
 * and a watch of its own, so the first one adds its watch and the rest find it by
 * its mark.
 */
export function stallWatch(options: StallWatchOptions = {}) {
  return {
    name: "agent-lookout:stall-watch",
    configureVitest({ vitest }: { vitest: { config: { reporters: unknown[] } } }) {
      const { reporters } = vitest.config;
      if (!reporters.some(isStallWatch)) reporters.push(new StallWatch(options));
    },
  };
}

/** Whether a reporter is a watch, made by any copy of this module. */
function isStallWatch(reporter: unknown): boolean {
  return typeof reporter === "object" && reporter !== null && MARK in reporter;
}

function keyOf(file: FileLike): string {
  return `${file.project.name}\n${file.moduleId}`;
}

function fileOf(entity: SuiteLike | ModuleLike): FileLike {
  return entity.type === "module" ? entity : entity.module;
}

function hookName(name: "beforeAll" | "afterAll", entity: SuiteLike | ModuleLike): string {
  return entity.type === "module" ? `${name} of the file` : `${name} of "${entity.fullName}"`;
}

function whereIs(open: OpenFile): string {
  switch (open.state) {
    case "started": {
      const within =
        open.within.size > 0
          ? `in ${[...open.within].join(", ")}`
          : open.lastFinished === undefined
            ? "in no test yet"
            : "in no test";
      return open.lastFinished === undefined
        ? `started, ${within}`
        : `started, ${within}, last finished "${open.lastFinished}"`;
    }
    case "collected":
      return "collected, not started";
    case "queued":
      return "queued, not started";
    case "waiting":
      return "not queued yet";
  }
}

/** A time as the message says it: whole minutes, or seconds. */
function spell(ms: number): string {
  if (ms % 60_000 === 0) return ms === 60_000 ? "1 minute" : `${ms / 60_000} minutes`;
  return `${Math.round(ms / 1_000)} seconds`;
}

/** The message of a GitHub Actions command, escaped so its line breaks do not end it. */
function escapeData(text: string): string {
  return text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/** A timer that never keeps Node running on its own. */
function afterUnref(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

/**
 * Ends the process once what was written has gone out: a pipe, as CI reads
 * output through, can still hold the message when `process.exit` runs. A
 * second on, it ends anyway.
 */
function exitOnceWritten(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1_000).unref();
  process.stdout.write("", () => process.exit(code));
}
