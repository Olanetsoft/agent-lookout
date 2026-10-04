import { describe, expect, test } from "vitest";

import {
  createFeedReader,
  FEED_ARGS,
  FEED_ARGS_WITHOUT_ALL,
  FEED_TIMEOUT_MS,
  feedEnvironment,
  RETRY_ALL_AFTER_READS,
  pickSessionList,
  readFeed,
  toFeedEntry,
  validPid,
  type RunCommand,
  type RunResult,
} from "@collector/adapters/claude-code/feed";
import { feedEntries, feedJson, feedJsonWithTrailingText } from "@tests/fixtures/claudeCode";

const env = { PATH: "/usr/bin:/bin" };

/** A stand-in for the command that returns fixed output and records how it was called. */
function fakeRun(result: Awaited<ReturnType<RunCommand>>) {
  const calls: { file: string; args: readonly string[]; timeoutMs: number; env: object }[] = [];
  const run: RunCommand = async (file, args, options) => {
    calls.push({ file, args, ...options });
    return result;
  };
  return { run, calls };
}

const one = [{ pid: 4242, sessionId: "00000000-0000-4000-8000-000000000001", status: "busy" }];
const oneJson = JSON.stringify(one);

describe("readFeed", () => {
  test("runs `claude agents --json --all` with a 5 second timeout", async () => {
    const { run, calls } = fakeRun({ ok: true, stdout: "[]" });
    await readFeed("/usr/local/bin/claude", run, { env });
    expect(FEED_TIMEOUT_MS).toBe(5_000);
    expect(FEED_ARGS).toEqual(["agents", "--json", "--all"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      file: "/usr/local/bin/claude",
      args: ["agents", "--json", "--all"],
      timeoutMs: 5_000,
    });
  });

  test("gives the child process the quiet environment", async () => {
    const { run, calls } = fakeRun({ ok: true, stdout: "[]" });
    await readFeed("/usr/local/bin/claude", run, { env });
    expect(calls[0]?.env).toEqual(feedEnvironment(env));
  });

  test("reads the entries from a clean array", async () => {
    const { run } = fakeRun({ ok: true, stdout: feedJson });
    expect(await readFeed("claude", run, { env })).toEqual({ ok: true, entries: feedEntries });
  });

  test("reads the entries when another tool prints after the array", async () => {
    const { run } = fakeRun({ ok: true, stdout: feedJsonWithTrailingText });
    expect(await readFeed("claude", run, { env })).toEqual({ ok: true, entries: feedEntries });
  });

  test("an empty array is a good answer with no sessions", async () => {
    const { run } = fakeRun({ ok: true, stdout: "[]\n" });
    expect(await readFeed("claude", run, { env })).toEqual({ ok: true, entries: [] });
  });

  test("items that are not usable sessions are dropped and the rest kept", async () => {
    const stdout = JSON.stringify([
      null,
      "text",
      42,
      [],
      {},
      { name: "no identity at all", cwd: "/Users/example/code/demo" },
      { pid: 4242, status: "idle" },
    ]);
    const { run } = fakeRun({ ok: true, stdout });
    expect(await readFeed("claude", run, { env })).toEqual({
      ok: true,
      entries: [{ pid: 4242, status: "idle" }],
    });
  });

  test("a list in which nothing reads as a session is a failure, not an empty list", async () => {
    // Reporting no sessions here would announce every running session as ended.
    for (const stdout of ['[1, "a", null]', "[12345] wrapper started", '[{"level": "info"}]']) {
      const { run } = fakeRun({ ok: true, stdout });
      expect(await readFeed("claude", run, { env })).toEqual({
        ok: false,
        problem:
          "The claude agents --json command printed a list, but nothing in it could be read as a session",
      });
    }
  });

  test("output that is not a list is a failure, in plain words", async () => {
    for (const stdout of ["", "Not logged in.", '{"error": "unsupported"}', '[{"pid": 1}, ']) {
      const { run } = fakeRun({ ok: true, stdout });
      expect(await readFeed("claude", run, { env })).toEqual({
        ok: false,
        problem: "The claude agents --json command did not print a list of sessions",
      });
    }
  });

  test("a command that fails is a failure that says how", async () => {
    const { run } = fakeRun({ ok: false, problem: "stopped with exit code 1" });
    expect(await readFeed("claude", run, { env })).toEqual({
      ok: false,
      problem: "The claude agents --json command stopped with exit code 1",
    });
  });
});

describe("feedEnvironment", () => {
  test("adds the two variables that keep Claude Code from updating and reporting, and nothing else", () => {
    expect(feedEnvironment({ PATH: "/usr/bin:/bin", HOME: "/Users/example" })).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/example",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    });
  });

  test("names no proxy the person did not set", () => {
    const quiet = feedEnvironment({ PATH: "/usr/bin:/bin" });
    for (const name of Object.keys(quiet)) {
      expect(name).not.toMatch(/proxy/i);
    }
  });

  test("a proxy the person has set, and what they exempted from it, reach the command as they are", () => {
    const theirs = {
      HTTPS_PROXY: "http://proxy.example:8080",
      https_proxy: "http://proxy.example:8080",
      HTTP_PROXY: "http://proxy.example:8080",
      http_proxy: "http://proxy.example:8080",
      NO_PROXY: "api.example,localhost",
      no_proxy: "*",
    };
    expect(feedEnvironment(theirs)).toEqual({
      ...theirs,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    });
  });

  test("the two variables are set whatever they were before", () => {
    const quiet = feedEnvironment({
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0",
      DISABLE_AUTOUPDATER: "",
    });
    expect(quiet.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(quiet.DISABLE_AUTOUPDATER).toBe("1");
  });

  test("the environment it was given is left as it was", () => {
    const original = { PATH: "/usr/bin:/bin", NO_PROXY: "localhost" };
    const quiet = feedEnvironment(original);
    expect(quiet).not.toBe(original);
    expect(original).toEqual({ PATH: "/usr/bin:/bin", NO_PROXY: "localhost" });
  });
});

describe("pickSessionList", () => {
  test("text before the list that happens to be valid JSON is not the list", () => {
    for (const prefix of ["[12345] wrapper started\n", "[1] 4242\n", '{"hook": "started"}\n']) {
      expect(pickSessionList(`${prefix}${oneJson}`)).toEqual({ ok: true, entries: one });
    }
  });

  test("an empty array before the real list does not hide it", () => {
    expect(pickSessionList(`[] \n${oneJson}`)).toEqual({ ok: true, entries: one });
  });

  test("an empty list followed by another tool's JSON is still an empty list", () => {
    expect(pickSessionList('[]\n{"tracker": "unrelated"}\n[{"tracked": "12m"}]\n[1, 2]')).toEqual({
      ok: true,
      entries: [],
    });
  });

  test("the first list with a session in it wins over any later one", () => {
    const later = JSON.stringify([{ pid: 5150, status: "idle" }]);
    expect(pickSessionList(`${oneJson}\n${later}`)).toEqual({ ok: true, entries: one });
  });

  test("many bracketed log lines before the list do not hide it", () => {
    const lines = Array.from({ length: 500 }, (_, line) => `[log ${line}] starting`).join("\n");
    expect(pickSessionList(`${lines}\n${oneJson}`)).toEqual({ ok: true, entries: one });
  });

  test("a list that was cut off is a failure, never a shorter list", () => {
    expect(pickSessionList('[{"pid": 1, "tags": [{"pid": 2}]}, {"pid"')).toEqual({
      ok: false,
      problem: "did not print a list of sessions",
    });
  });
});

describe("the feed reader and Claude Code versions without --all", () => {
  /** A command that answers each call from a script and records the arguments. */
  function scriptedRun(answer: (args: readonly string[]) => RunResult) {
    const calls: (readonly string[])[] = [];
    const run: RunCommand = async (_file, args) => {
      calls.push(args);
      return answer(args);
    };
    return { run, calls };
  }

  const refusesAll = (args: readonly string[]): RunResult =>
    args.includes("--all")
      ? { ok: false, problem: "stopped with exit code 1", exitCode: 1 }
      : { ok: true, stdout: oneJson };

  test("a binary that refuses --all is asked again the plain way", async () => {
    const { run, calls } = scriptedRun(refusesAll);
    expect(await createFeedReader(run).read("claude", { env })).toEqual({ ok: true, entries: one });
    expect(calls).toEqual([FEED_ARGS, FEED_ARGS_WITHOUT_ALL]);
    expect(FEED_ARGS_WITHOUT_ALL).toEqual(["agents", "--json"]);
  });

  test("and from then on only the plain way, so each read runs one command", async () => {
    const { run, calls } = scriptedRun(refusesAll);
    const reader = createFeedReader(run);
    await reader.read("claude", { env });
    await reader.read("claude", { env });
    await reader.read("claude", { env });
    expect(calls).toEqual([
      FEED_ARGS,
      FEED_ARGS_WITHOUT_ALL,
      FEED_ARGS_WITHOUT_ALL,
      FEED_ARGS_WITHOUT_ALL,
    ]);
  });

  test("the reader says which binaries it is reading the plain way", async () => {
    const { run } = scriptedRun((args) =>
      args.includes("--all") ? refusesAll(args) : { ok: true, stdout: oneJson },
    );
    const reader = createFeedReader(run);
    expect(reader.readsPlainly("/old/claude")).toBe(false);
    await reader.read("/old/claude", { env });
    expect(reader.readsPlainly("/old/claude")).toBe(true);
    expect(reader.readsPlainly("/new/claude")).toBe(false);

    const current = createFeedReader(scriptedRun(() => ({ ok: true, stdout: oneJson })).run);
    await current.read("/new/claude", { env });
    expect(current.readsPlainly("/new/claude")).toBe(false);
  });

  test("the retry comes after 10 plain reads, which is five minutes at one read every 30 seconds", () => {
    expect(RETRY_ALL_AFTER_READS).toBe(10);
  });

  test("after about five minutes of plain reads --all is tried once more", async () => {
    const { run, calls } = scriptedRun(refusesAll);
    const reader = createFeedReader(run);
    for (let read = 0; read < RETRY_ALL_AFTER_READS; read += 1)
      await reader.read("claude", { env });
    // One refused --all at the start, then one plain command per read.
    expect(calls.filter((args) => args.includes("--all"))).toHaveLength(1);
    expect(calls).toHaveLength(RETRY_ALL_AFTER_READS + 1);

    await reader.read("claude", { env });
    expect(calls.slice(-2)).toEqual([FEED_ARGS, FEED_ARGS_WITHOUT_ALL]);
    await reader.read("claude", { env });
    expect(calls.at(-1)).toEqual(FEED_ARGS_WITHOUT_ALL);
    expect(calls.filter((args) => args.includes("--all"))).toHaveLength(2);
  });

  test("a binary updated while the collector runs is read with --all from the retry on", async () => {
    let updated = false;
    const { run, calls } = scriptedRun((args) =>
      updated ? { ok: true, stdout: oneJson } : refusesAll(args),
    );
    const reader = createFeedReader(run);
    for (let read = 0; read < RETRY_ALL_AFTER_READS; read += 1)
      await reader.read("claude", { env });
    updated = true;
    await reader.read("claude", { env });
    await reader.read("claude", { env });
    expect(calls.slice(-2)).toEqual([FEED_ARGS, FEED_ARGS]);
  });

  test("what one binary refused is not held against another", async () => {
    const { run, calls } = scriptedRun(refusesAll);
    const reader = createFeedReader(run);
    await reader.read("/old/claude", { env });
    await reader.read("/new/claude", { env });
    expect(calls[2]).toEqual(FEED_ARGS);
  });

  test("a binary that knows --all is never asked twice", async () => {
    const { run, calls } = scriptedRun(() => ({ ok: true, stdout: oneJson }));
    const reader = createFeedReader(run);
    await reader.read("claude", { env });
    await reader.read("claude", { env });
    expect(calls).toEqual([FEED_ARGS, FEED_ARGS]);
  });

  test("a command that hangs or never starts is not run a second time", async () => {
    for (const problem of ["did not answer within 5 seconds", "could not be started"]) {
      const { run, calls } = scriptedRun(() => ({ ok: false, problem }));
      expect(await createFeedReader(run).read("claude", { env })).toEqual({
        ok: false,
        problem: `The claude agents --json command ${problem}`,
      });
      expect(calls).toEqual([FEED_ARGS]);
    }
  });

  test("a command that fails both ways is a failure, and --all is tried again next time", async () => {
    const { run, calls } = scriptedRun(() => ({
      ok: false,
      problem: "stopped with exit code 1",
      exitCode: 1,
    }));
    const reader = createFeedReader(run);
    expect(await reader.read("claude", { env })).toEqual({
      ok: false,
      problem: "The claude agents --json command stopped with exit code 1",
    });
    await reader.read("claude", { env });
    expect(calls).toEqual([FEED_ARGS, FEED_ARGS_WITHOUT_ALL, FEED_ARGS, FEED_ARGS_WITHOUT_ALL]);
  });
});

describe("toFeedEntry", () => {
  test("keeps known fields and drops everything else", () => {
    expect(
      toFeedEntry({
        pid: 4242,
        cwd: "/Users/example/code/demo",
        kind: "interactive",
        startedAt: 1_700_000_000_000,
        sessionId: "00000000-0000-4000-8000-000000000001",
        name: "demo-project",
        status: "waiting",
        waitingFor: "permission prompt",
        somethingNew: { nested: true },
      }),
    ).toEqual({
      pid: 4242,
      cwd: "/Users/example/code/demo",
      kind: "interactive",
      startedAt: 1_700_000_000_000,
      sessionId: "00000000-0000-4000-8000-000000000001",
      name: "demo-project",
      status: "waiting",
      waitingFor: "permission prompt",
    });
  });

  test("fields of the wrong type are dropped, not trusted", () => {
    const entry = toFeedEntry({
      sessionId: "00000000-0000-4000-8000-000000000001",
      pid: "4242",
      name: 12,
      cwd: null,
      startedAt: "2023-11-14",
      status: ["busy"],
    });
    expect(entry).not.toBeNull();
    expect(Object.entries(entry ?? {}).filter(([, value]) => value !== undefined)).toEqual([
      ["sessionId", "00000000-0000-4000-8000-000000000001"],
    ]);
  });

  test("a start time that is not a whole number is dropped", () => {
    expect(toFeedEntry({ pid: 4242, startedAt: 1.5 })?.startedAt).toBeUndefined();
    expect(toFeedEntry({ pid: 4242, startedAt: Number.NaN })?.startedAt).toBeUndefined();
    expect(toFeedEntry({ pid: 4242, startedAt: 1_700_000_000_000 })?.startedAt).toBe(
      1_700_000_000_000,
    );
  });
});

describe("validPid", () => {
  test("only positive whole numbers are process ids", () => {
    expect(validPid(4242)).toBe(4242);
    // Signalling pid 0 or a negative pid would address a whole process group.
    expect(validPid(0)).toBeUndefined();
    expect(validPid(-4242)).toBeUndefined();
    expect(validPid(1.5)).toBeUndefined();
    expect(validPid(Number.NaN)).toBeUndefined();
    expect(validPid("4242")).toBeUndefined();
    expect(validPid(null)).toBeUndefined();
  });
});
