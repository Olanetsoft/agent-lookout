import { afterEach, describe, expect, test, vi } from "vitest";

import { QUIET_MS, StallWatch, stallWatch } from "@tests/support/reporters/stallWatch";

const ROOT = "/Users/example/code/demo";

/** A clock the test moves by hand, with the timers the watch sets on it. */
function fakeClock() {
  let time = 0;
  let timers: { at: number; run: () => void }[] = [];
  return {
    now: () => time,
    after(ms: number, run: () => void) {
      const timer = { at: time + ms, run };
      timers.push(timer);
      return () => {
        timers = timers.filter((one) => one !== timer);
      };
    },
    /** Moves the clock on, running each timer that falls due on the way, in order. */
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const due = timers.filter((one) => one.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((one) => one !== due);
        time = due.at;
        due.run();
      }
      time = end;
    },
    pending: () => timers.length,
  };
}

/**
 * A watch on the fake clock, told by Vitest how the run was started, that writes
 * down what it prints and each exit. Its debugger can be opened mid-run, and
 * whether it is on GitHub Actions is left to the environment only when asked.
 */
function setUp({
  watchMode = false,
  inspect = false,
  debuggerOpen = false,
  githubActions = false as boolean | "from the environment",
  root = ROOT,
} = {}) {
  const clock = fakeClock();
  const written: string[] = [];
  const exits: number[] = [];
  const inspector = { open: debuggerOpen };
  const watch = new StallWatch({
    now: clock.now,
    after: clock.after,
    write: (text) => written.push(text),
    exit: (code) => exits.push(code),
    debuggerOpen: () => inspector.open,
    ...(githubActions === "from the environment" ? {} : { githubActions }),
  });
  watch.onInit({ config: { watch: watchMode, root, inspector: { enabled: inspect } } });
  return {
    watch,
    clock,
    written,
    exits,
    output: () => written.join(""),
    openDebugger: () => {
      inspector.open = true;
    },
  };
}

/** The line under the list of open files, which says it can be behind. */
const CAN_BE_BEHIND =
  "A page or worker that freezes can leave its last reports unsent, so a file can be further on than shown.";

/** A test file of a project, as Vitest gives one in a specification and as a module. */
function file(name: string, project = "component") {
  return { type: "module" as const, moduleId: `${ROOT}/${name}`, project: { name: project } };
}

function testIn(module: ReturnType<typeof file>, fullName: string) {
  return { fullName, module };
}

function suiteIn(module: ReturnType<typeof file>, fullName: string) {
  return { type: "suite" as const, fullName, module };
}

/** Everything Vitest reports for a file from its queueing to its end, with one test in it. */
function runThrough(watch: StallWatch, module: ReturnType<typeof file>, name = "works") {
  const one = testIn(module, name);
  watch.onTestModuleQueued(module);
  watch.onTestModuleCollected(module);
  watch.onTestModuleStart(module);
  watch.onTestCaseReady(one);
  watch.onTestCaseResult(one);
  watch.onTestModuleEnd(module);
}

describe("a run that keeps reporting", () => {
  test("prints nothing and never exits, and leaves no timer once it ends", () => {
    const { watch, clock, written, exits } = setUp();
    const first = file("tests/component/a.test.tsx");
    const second = file("tests/component/b.test.tsx");
    watch.onTestRunStart([first, second]);
    clock.advance(QUIET_MS - 1);
    runThrough(watch, first);
    clock.advance(QUIET_MS - 1);
    runThrough(watch, second);
    clock.advance(QUIET_MS - 1);
    watch.onTestRunEnd();

    expect(clock.pending()).toBe(0);
    clock.advance(10 * QUIET_MS);
    expect(written).toEqual([]);
    expect(exits).toEqual([]);
  });

  test("each kind of report resets the quiet time", () => {
    const { watch, clock, written, exits } = setUp();
    const module = file("tests/component/a.test.tsx");
    const suite = suiteIn(module, "Rail");
    const one = testIn(module, "Rail > opens");
    const reports = [
      () => watch.onTestModuleQueued(module),
      () => watch.onTestModuleCollected(module),
      () => watch.onTestModuleStart(module),
      () => watch.onHookStart({ name: "beforeAll", entity: module }),
      () => watch.onHookEnd({ name: "beforeAll", entity: module }),
      () => watch.onTestSuiteReady(),
      () => watch.onTestCaseReady(one),
      () => watch.onHookStart({ name: "beforeEach", entity: one }),
      () => watch.onHookEnd({ name: "beforeEach", entity: one }),
      () => watch.onUserConsoleLog(),
      () => watch.onTestCaseAnnotate(),
      () => watch.onTestCaseArtifactRecord(),
      () => watch.onTestCaseResult(one),
      () => watch.onHookStart({ name: "afterAll", entity: suite }),
      () => watch.onHookEnd({ name: "afterAll", entity: suite }),
      () => watch.onTestSuiteResult(),
    ];
    watch.onTestRunStart([module]);
    for (const report of reports) {
      clock.advance(QUIET_MS - 1);
      report();
    }
    clock.advance(QUIET_MS - 1);
    expect(written).toEqual([]);

    // The quiet time runs from the last report, not from the first timer.
    clock.advance(1);
    expect(exits).toEqual([1]);
  });
});

describe("a run that stalls", () => {
  test("names exactly the files still open, furthest along first, each as it last reported, then exits with a failure", () => {
    const { watch, clock, output, exits } = setUp();
    const ended = file("tests/component/dashboard/components/ui/controls/Button.test.tsx");
    const started = file("tests/component/dashboard/components/ui/controls/Checkbox.test.tsx");
    const queued = file("tests/component/dashboard/components/rail/Rail.test.tsx");
    const waiting = file(
      "tests/component/dashboard/components/ui/controls/SegmentedControl.test.tsx",
    );
    // Given in the reverse of the order they get to, so the list's own order shows.
    watch.onTestRunStart([waiting, queued, started, ended]);
    runThrough(watch, ended);
    watch.onTestModuleQueued(started);
    watch.onTestModuleCollected(started);
    watch.onTestModuleStart(started);
    const passed = testIn(started, "Checkbox > ticks on a click");
    watch.onTestCaseReady(passed);
    watch.onTestCaseResult(passed);
    watch.onTestCaseReady(testIn(started, "Checkbox > ticks on Space"));
    watch.onTestModuleQueued(queued);

    clock.advance(QUIET_MS - 1);
    expect(output()).toBe("");
    clock.advance(1);

    expect(output()).toBe(
      [
        "",
        "The test run stalled: nothing has reported for 3 minutes, and 3 test files are still open, each as it last reported:",
        '  |component| tests/component/dashboard/components/ui/controls/Checkbox.test.tsx: started, in "Checkbox > ticks on Space", last finished "Checkbox > ticks on a click"',
        "  |component| tests/component/dashboard/components/rail/Rail.test.tsx: queued, not started",
        "  |component| tests/component/dashboard/components/ui/controls/SegmentedControl.test.tsx: not queued yet",
        CAN_BE_BEHIND,
        "The run is ended here with a failure rather than left to hang.",
        "",
      ].join("\n"),
    );
    expect(exits).toEqual([1]);

    // It ends the run once, and does not watch on.
    expect(clock.pending()).toBe(0);
    clock.advance(10 * QUIET_MS);
    expect(exits).toEqual([1]);
  });

  test("leaves out a file once it ends, wherever it ended from", () => {
    const { watch, clock, output } = setUp();
    const ran = file("tests/unit/core/sessions/diff.test.ts", "unit");
    const failedEarly = file("tests/unit/core/sessions/status.test.ts", "unit");
    const left = file("tests/integration/collector/hosts/standalone.test.ts", "integration");
    watch.onTestRunStart([ran, failedEarly, left]);
    runThrough(watch, ran);
    // A file that fails as it is imported starts and ends with no test.
    watch.onTestModuleQueued(failedEarly);
    watch.onTestModuleStart(failedEarly);
    watch.onTestModuleEnd(failedEarly);
    watch.onTestModuleQueued(left);
    watch.onTestModuleCollected(left);
    clock.advance(QUIET_MS);

    expect(output()).toBe(
      [
        "",
        "The test run stalled: nothing has reported for 3 minutes, and 1 test file is still open, each as it last reported:",
        "  |integration| tests/integration/collector/hosts/standalone.test.ts: collected, not started",
        CAN_BE_BEHIND,
        "The run is ended here with a failure rather than left to hang.",
        "",
      ].join("\n"),
    );
  });

  test("names the beforeAll or afterAll a started file last reported, or that it reported no test running", () => {
    const { watch, clock, output } = setUp();
    const inFileHook = file("tests/component/a.test.tsx");
    const inSuiteHook = file("tests/component/b.test.tsx");
    const inEachHook = file("tests/component/c.test.tsx");
    const between = file("tests/component/d.test.tsx");
    const notYet = file("tests/component/e.test.tsx");
    const modules = [inFileHook, inSuiteHook, inEachHook, between, notYet];
    watch.onTestRunStart(modules);
    for (const module of modules) {
      watch.onTestModuleQueued(module);
      watch.onTestModuleStart(module);
    }
    watch.onHookStart({ name: "beforeAll", entity: inFileHook });
    const suite = suiteIn(inSuiteHook, "Rail > when folded");
    watch.onHookStart({ name: "beforeAll", entity: suite });
    watch.onHookEnd({ name: "beforeAll", entity: suite });
    watch.onHookStart({ name: "afterAll", entity: suite });
    // A beforeEach runs inside its test, so the test alone is named.
    const opens = testIn(inEachHook, "Rail > opens");
    watch.onTestCaseReady(opens);
    watch.onHookStart({ name: "beforeEach", entity: opens });
    const done = testIn(between, "works");
    watch.onTestCaseReady(done);
    watch.onTestCaseResult(done);
    clock.advance(QUIET_MS);

    expect(output()).toContain(
      [
        "  |component| tests/component/a.test.tsx: started, in beforeAll of the file",
        '  |component| tests/component/b.test.tsx: started, in afterAll of "Rail > when folded"',
        '  |component| tests/component/c.test.tsx: started, in "Rail > opens"',
        '  |component| tests/component/d.test.tsx: started, in no test, last finished "works"',
        "  |component| tests/component/e.test.tsx: started, in no test yet",
        CAN_BE_BEHIND,
      ].join("\n"),
    );
  });

  test("lists a file that reports though the run did not list it at its start", () => {
    const { watch, clock, output } = setUp();
    const listed = file("tests/unit/core/sessions/diff.test.ts", "unit");
    const unlisted = file("tests/unit/core/sessions/status.test.ts", "unit");
    watch.onTestRunStart([listed]);
    watch.onTestModuleQueued(unlisted);
    clock.advance(QUIET_MS);

    expect(output()).toContain(
      [
        "  |unit| tests/unit/core/sessions/status.test.ts: queued, not started",
        "  |unit| tests/unit/core/sessions/diff.test.ts: not queued yet",
      ].join("\n"),
    );
  });

  test("names a file from the root on Windows, whichever slashes each is written with", () => {
    const { watch, clock, output } = setUp({ root: "C:\\Users\\example\\code\\demo\\" });
    const forward = {
      moduleId: "C:/Users/example/code/demo/tests/unit/core/sessions/diff.test.ts",
      project: { name: "unit" },
    };
    const backward = {
      moduleId: "C:\\Users\\example\\code\\demo\\tests\\unit\\core\\sessions\\status.test.ts",
      project: { name: "unit" },
    };
    watch.onTestRunStart([forward, backward]);
    watch.onTestModuleQueued(forward);
    watch.onTestModuleQueued(backward);
    clock.advance(QUIET_MS);

    expect(output()).toContain(
      [
        "  |unit| tests/unit/core/sessions/diff.test.ts: queued, not started",
        "  |unit| tests/unit/core/sessions/status.test.ts: queued, not started",
      ].join("\n"),
    );
  });

  test("says so when every file has ended but the run has not", () => {
    const { watch, clock, output, exits } = setUp();
    const only = file("tests/component/a.test.tsx");
    watch.onTestRunStart([only]);
    runThrough(watch, only);
    clock.advance(QUIET_MS);

    expect(output()).toBe(
      [
        "",
        "The test run stalled: nothing has reported for 3 minutes, and every test file has ended, but the run has not.",
        "The run is ended here with a failure rather than left to hang.",
        "",
      ].join("\n"),
    );
    expect(exits).toEqual([1]);
  });

  test("on GitHub Actions, adds the same message as one error line", () => {
    const { watch, clock, written } = setUp({ githubActions: true });
    const started = file("tests/component/a.test.tsx");
    watch.onTestRunStart([started]);
    watch.onTestModuleQueued(started);
    watch.onTestModuleStart(started);
    watch.onTestCaseReady(testIn(started, "fills 50% of the bar"));
    clock.advance(QUIET_MS);

    expect(written).toHaveLength(2);
    expect(written[1]).toBe(
      "::error title=Test run stalled::The test run stalled: nothing has reported for 3 minutes, and 1 test file is still open, each as it last reported:%0A" +
        '  |component| tests/component/a.test.tsx: started, in "fills 50%25 of the bar"%0A' +
        `${CAN_BE_BEHIND}%0A` +
        "The run is ended here with a failure rather than left to hang.\n",
    );
  });

  describe("when not told whether it is on GitHub Actions", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    for (const [value, lines] of [
      ["true", 2],
      [undefined, 1],
    ] as const) {
      test(`reads GITHUB_ACTIONS, here ${value === undefined ? "not set" : `"${value}"`}`, () => {
        vi.stubEnv("GITHUB_ACTIONS", value);
        const { watch, clock, written } = setUp({ githubActions: "from the environment" });
        watch.onTestRunStart([file("tests/component/a.test.tsx")]);
        clock.advance(QUIET_MS);

        expect(written).toHaveLength(lines);
        if (lines === 2) expect(written[1]).toMatch(/^::error title=Test run stalled::/);
      });
    }
  });
});

describe("a run the watch leaves alone", () => {
  for (const [name, options] of [
    ["in watch mode", { watchMode: true }],
    ["started with --inspect or --inspect-brk", { inspect: true }],
    [
      "with Node's inspector open in Vitest's process, as an editor's debugger opens it",
      {
        debuggerOpen: true,
      },
    ],
  ] as const) {
    test(`never arms ${name}`, () => {
      const { watch, clock, written, exits } = setUp(options);
      const module = file("tests/component/a.test.tsx");
      watch.onTestRunStart([module]);
      watch.onTestModuleQueued(module);
      watch.onTestModuleStart(module);

      expect(clock.pending()).toBe(0);
      clock.advance(10 * QUIET_MS);
      expect(written).toEqual([]);
      expect(exits).toEqual([]);
    });
  }

  test("lets a run go once a debugger opens during it, as one attached to look at the stall", () => {
    const { watch, clock, written, exits, openDebugger } = setUp();
    const module = file("tests/component/a.test.tsx");
    watch.onTestRunStart([module]);
    watch.onTestModuleQueued(module);
    openDebugger();
    clock.advance(QUIET_MS);

    expect(written).toEqual([]);
    expect(exits).toEqual([]);
    expect(clock.pending()).toBe(0);
  });
});

describe("stallWatch", () => {
  test("adds one watch beside the reporters Vitest picked, though each project brings a plugin of its own", () => {
    const reporters: unknown[] = [
      ["default", {}],
      ["github-actions", {}],
    ];
    // Each project loads the config again, so each has a plugin of its own, and
    // a plugin can be asked more than once.
    const plugins = [stallWatch(), stallWatch(), stallWatch()];
    for (const plugin of [...plugins, plugins[0]]) {
      plugin.configureVitest({ vitest: { config: { reporters } } });
    }

    expect(reporters).toHaveLength(3);
    expect(reporters.slice(0, 2)).toEqual([
      ["default", {}],
      ["github-actions", {}],
    ]);
    expect(reporters[2]).toBeInstanceOf(StallWatch);
  });

  test("finds a watch that another copy of the module made, by its mark", () => {
    const fromAnotherCopy = { [Symbol.for("agent-lookout:stall-watch")]: true };
    const reporters: unknown[] = [["default", {}], fromAnotherCopy];
    stallWatch().configureVitest({ vitest: { config: { reporters } } });

    expect(reporters).toEqual([["default", {}], fromAnotherCopy]);
  });
});
