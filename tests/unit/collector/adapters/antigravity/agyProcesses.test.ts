import { describe, expect, test } from "vitest";

import {
  AGY_TABLE_ARGS,
  agyCommandLineArgs,
  createAgyProcessReader,
  isAgyProgram,
  parseAgyTable,
  readAgyCommandLine,
  type RunPs,
} from "@collector/adapters/antigravity/agyProcesses";
import { conversationId, lstart, MINUTE, NOW } from "@tests/fixtures/antigravity";

const A = conversationId("a1");

/** A line of `ps -A -o pid=,ppid=,lstart=,comm=` as macOS prints it. */
const row = (pid: number, ppid: number, startedAt: number, program: string) =>
  `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${lstart(startedAt)}     ${program}`;

describe("parseAgyTable", () => {
  test("keeps the agy programs, with their start to the second, and drops every other process", () => {
    const table = [
      row(1, 0, NOW - 60 * MINUTE, "/sbin/launchd"),
      row(501, 1, NOW - 30 * MINUTE, "-zsh"),
      row(812, 501, NOW - 5 * MINUTE, "agy"),
      row(813, 501, NOW - 4 * MINUTE, "/Users/example/.local/bin/agy"),
      row(814, 1, NOW - 3 * MINUTE, "/Applications/Some Editor.app/Contents/MacOS/agy"),
      row(815, 501, NOW - 2 * MINUTE, "/usr/local/bin/agy-helper"),
      row(816, 501, NOW - 2 * MINUTE, "/opt/agy/bin/node"),
      "garbage",
      "",
    ].join("\n");
    expect(parseAgyTable(table)).toEqual([
      {
        pid: 812,
        ppid: 501,
        start: lstart(NOW - 5 * MINUTE).replace(/\s+/g, " "),
        startedAt: NOW - 5 * MINUTE,
      },
      {
        pid: 813,
        ppid: 501,
        start: lstart(NOW - 4 * MINUTE).replace(/\s+/g, " "),
        startedAt: NOW - 4 * MINUTE,
      },
      {
        pid: 814,
        ppid: 1,
        start: lstart(NOW - 3 * MINUTE).replace(/\s+/g, " "),
        startedAt: NOW - 3 * MINUTE,
      },
    ]);
  });

  test("knows agy by the last part of its program's name, on any system", () => {
    expect(isAgyProgram("agy")).toBe(true);
    expect(isAgyProgram("C:\\Users\\example\\agy.exe")).toBe(true);
    expect(isAgyProgram("agyx")).toBe(false);
    expect(isAgyProgram("/usr/bin/agy/")).toBe(false);
  });
});

describe("readAgyCommandLine", () => {
  test("an agy started to talk is a session, with the conversation it names", () => {
    expect(readAgyCommandLine("agy")).toEqual({ session: true });
    expect(readAgyCommandLine("/Users/example/.local/bin/agy -c")).toEqual({ session: true });
    expect(readAgyCommandLine(`agy --conversation ${A}`)).toEqual({
      session: true,
      conversation: A,
    });
    expect(readAgyCommandLine(`agy --model auto --conversation=${A.toUpperCase()}`)).toEqual({
      session: true,
      conversation: A,
    });
    expect(readAgyCommandLine(`agy -conversation ${A} -p again`)).toEqual({
      session: true,
      conversation: A,
    });
  });

  test("a conversation that is not an id is not one", () => {
    expect(readAgyCommandLine("agy --conversation latest")).toEqual({ session: true });
    expect(readAgyCommandLine("agy --conversation")).toEqual({ session: true });
  });

  test("agy's own commands, and options that print and end, are not sessions", () => {
    for (const command of [
      "remote-control start",
      "remote-control",
      "mic-serve",
      "update",
      "models",
      "mcp list",
      "plugin install demo",
      "changelog",
      "help",
      "--help",
      "--version",
    ]) {
      expect(readAgyCommandLine(`/Users/example/.local/bin/agy ${command}`), command).toEqual({
        session: false,
      });
    }
  });

  test("a prompt given with -p is a session, whatever its words", () => {
    expect(readAgyCommandLine("agy -p update the models in remote-control")).toEqual({
      session: true,
    });
    expect(readAgyCommandLine("agy --print look at /tmp/agy models")).toEqual({ session: true });
  });

  test("the program is found in a path with spaces, and a folder named agy is not it", () => {
    expect(readAgyCommandLine("/Users/example/My Tools/agy update")).toEqual({ session: false });
    expect(readAgyCommandLine("/opt/agy/bin/agy update")).toEqual({ session: false });
    expect(readAgyCommandLine("something else entirely")).toEqual({ session: true });
  });
});

/** A stand-in for `ps`: answers the table and the command lines, and writes down each run. */
function standInPs(
  table: string,
  lines: Record<number, string>,
  options: { tableOk?: boolean } = {},
) {
  const runs: { args: readonly string[]; utc: boolean }[] = [];
  const run: RunPs = async (args, runOptions) => {
    runs.push({ args, utc: runOptions?.utc === true });
    if (args.includes("-A")) return { ok: options.tableOk ?? true, stdout: table };
    const pids = (args[args.length - 1] as string).split(",").map(Number);
    const printed = pids.filter((pid) => lines[pid] !== undefined);
    return {
      ok: printed.length === pids.length,
      stdout: printed.map((pid) => `${String(pid).padStart(5)} ${lines[pid]}`).join("\n"),
    };
  };
  return { run, runs };
}

describe("createAgyProcessReader", () => {
  const table = [
    row(501, 1, NOW - 30 * MINUTE, "-zsh"),
    row(812, 501, NOW - 5 * MINUTE, "agy"),
    row(813, 501, NOW - 4 * MINUTE, "agy"),
    row(814, 1, NOW - 3 * MINUTE, "agy"),
    // A program the agy in 812 started itself.
    row(900, 812, NOW - 2 * MINUTE, "agy"),
    // A program the remote-control service in 814 started.
    row(901, 814, NOW - MINUTE, "agy"),
  ].join("\n");
  const lines = {
    812: `agy --conversation ${A}`,
    813: "agy -p summarise the notes",
    814: "agy remote-control daemon",
    900: "agy --internal",
    901: "agy --model auto",
  };

  test("asks for the table in UTC, then the command lines of the agy programs alone", async () => {
    const ps = standInPs(table, lines);
    const reader = createAgyProcessReader({ run: ps.run, platform: "darwin" });
    expect(await reader.read()).toEqual({
      ok: true,
      sessions: [
        { startedAt: NOW - 5 * MINUTE, conversation: A },
        { startedAt: NOW - 4 * MINUTE },
        { startedAt: NOW - MINUTE },
      ],
    });
    expect(ps.runs).toEqual([
      { args: AGY_TABLE_ARGS, utc: true },
      { args: agyCommandLineArgs([812, 813, 814, 900, 901]), utc: false },
    ]);
  });

  test("a program a session started belongs to it, and one an agy that is no session started is a session of its own", async () => {
    const tree = [
      row(812, 501, NOW - 5 * MINUTE, "agy"),
      row(900, 812, NOW - 4 * MINUTE, "agy"),
      // Started by 900, which 812 started: still 812's.
      row(902, 900, NOW - 3 * MINUTE, "agy"),
      row(814, 1, NOW - 60 * MINUTE, "agy"),
      row(901, 814, NOW - 2 * MINUTE, "agy"),
    ].join("\n");
    const ps = standInPs(tree, {
      812: "agy",
      900: "agy mcp serve",
      902: "agy --internal",
      814: "agy remote-control daemon",
      901: `agy --conversation ${A}`,
    });
    const reader = createAgyProcessReader({ run: ps.run, platform: "darwin" });
    expect(await reader.read()).toEqual({
      ok: true,
      sessions: [{ startedAt: NOW - 5 * MINUTE }, { startedAt: NOW - 2 * MINUTE, conversation: A }],
    });
  });

  test("a program whose parent ended between the two runs is a session of its own", async () => {
    const ps = standInPs(
      [row(812, 501, NOW - 5 * MINUTE, "agy"), row(900, 812, NOW - 2 * MINUTE, "agy")].join("\n"),
      { 900: "agy" },
    );
    const reader = createAgyProcessReader({ run: ps.run, platform: "darwin" });
    expect(await reader.read()).toEqual({ ok: true, sessions: [{ startedAt: NOW - 2 * MINUTE }] });
  });

  test("reads a program's command line once, for as long as it runs", async () => {
    const ps = standInPs(table, lines);
    const reader = createAgyProcessReader({ run: ps.run, platform: "darwin" });
    await reader.read();
    await reader.read();
    expect(ps.runs.filter((run) => !run.args.includes("-A"))).toHaveLength(1);
  });

  test("a program that ended between the two runs is not a session", async () => {
    const ps = standInPs(table, { 812: lines[812], 814: lines[814] });
    const reader = createAgyProcessReader({ run: ps.run, platform: "darwin" });
    expect(await reader.read()).toEqual({
      ok: true,
      sessions: [{ startedAt: NOW - 5 * MINUTE, conversation: A }],
    });
  });

  test("a program whose command line could not be read at all is a session that names nothing", async () => {
    const ps = standInPs(table, {});
    const reader = createAgyProcessReader({ run: ps.run, platform: "darwin" });
    expect(await reader.read()).toEqual({
      ok: true,
      sessions: [
        { startedAt: NOW - 5 * MINUTE },
        { startedAt: NOW - 4 * MINUTE },
        { startedAt: NOW - 3 * MINUTE },
      ],
    });
  });

  test("with no agy program, only the table is asked for", async () => {
    const ps = standInPs(row(501, 1, NOW, "-zsh"), {});
    const reader = createAgyProcessReader({ run: ps.run, platform: "linux" });
    expect(await reader.read()).toEqual({ ok: true, sessions: [] });
    expect(ps.runs).toHaveLength(1);
  });

  test("a table that could not be had says so", async () => {
    const ps = standInPs(table, lines, { tableOk: false });
    const reader = createAgyProcessReader({ run: ps.run, platform: "darwin" });
    expect(await reader.read()).toEqual({ ok: false });
  });

  test("on Windows nothing is run", async () => {
    const ps = standInPs(table, lines);
    const reader = createAgyProcessReader({ run: ps.run, platform: "win32" });
    expect(await reader.read()).toEqual({ ok: false });
    expect(ps.runs).toEqual([]);
  });

  test("never throws", async () => {
    const reader = createAgyProcessReader({
      run: async () => {
        throw new Error("ps went away");
      },
      platform: "darwin",
    });
    expect(await reader.read()).toEqual({ ok: false });
  });
});
