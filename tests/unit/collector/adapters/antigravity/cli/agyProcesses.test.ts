import { describe, expect, test } from "vitest";

import {
  AGY_TABLE_ARGS,
  agyCommandLineArgs,
  createAgyProcessReader,
  isAgyProgram,
  parseAgyTable,
  readAgyCommandLine,
  type RunPs,
} from "@collector/adapters/antigravity/cli/agyProcesses";
import { conversationId, lstart, MINUTE, NOW } from "@tests/fixtures/antigravity";

const A = conversationId("a1");
const B = conversationId("b2");

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

  test.each([
    ["-r", `agy -r ${A}`],
    ["--resume", `agy --resume ${A}`],
    ["-resume", `agy -resume ${A}`],
    ["--resume=", `agy --model auto --resume=${A.toUpperCase()}`],
    ["-resume=", `agy -resume=${A} -p again`],
    ["-r, its id in capitals", `/Users/example/.local/bin/agy -r ${A.toUpperCase()}`],
    ["-r after another option's value", `agy --project demo-project -r ${A} --mode plan`],
    ["-r after a prompt", `agy -p summarise the notes -r ${A}`],
    ["--resume after a prompt", `agy -i go on with the notes --resume=${A}`],
  ])("%s names the conversation, as --conversation does", (_what, line) => {
    expect(readAgyCommandLine(line)).toEqual({ session: true, conversation: A });
  });

  test.each([
    ["-r with no id", "agy -r"],
    ["-r with a word that is no id", "agy -r latest"],
    ["-r with only the start of an id", `agy -r ${A.slice(0, 8)}`],
    ["-r with more than an id", `agy -r ${A}-x`],
    ["--resume with no id", "agy --resume"],
    ["--resume with a word that is no id", "agy --resume=latest"],
    ["-r as another option's value", "agy --project -r --mode plan"],
    ["-r in a prompt", "agy -p remove the folder with rm -r build"],
    ["--resume in a prompt", "agy -i say what --resume does to a conversation"],
    ["an id in a prompt after another word", `agy -p look for -r or ${A} in the notes`],
    ["another option that begins as one of them", `agy -rf ${A} --resumed ${A} --resume-all=${A}`],
    // Nothing agy publishes writes it so, and it is not guessed.
    ["-r with a =", `agy -r=${A}`],
  ])("%s names no conversation", (_what, line) => {
    expect(readAgyCommandLine(line)).toEqual({ session: true });
  });

  test("an option with a whole id after it in a prompt cannot be told from the option, however it is spelt", () => {
    for (const option of ["--conversation", "--resume", "-r"]) {
      expect(readAgyCommandLine(`agy -p say what ${option} ${A} opens`), option).toEqual({
        session: true,
        conversation: A,
      });
    }
    // The first one stands.
    expect(readAgyCommandLine(`agy -r ${A} -p say what --conversation ${B} opens`)).toEqual({
      session: true,
      conversation: A,
    });
  });

  test("--remote-agent as the first word is not a session on this computer", () => {
    for (const rest of [
      "--remote-agent",
      "-remote-agent",
      "--remote-agent --project=demo-project",
      "--remote-agent -c",
      `--remote-agent --conversation=${A}`,
      `--remote-agent -r ${A}`,
      "--remote-agent -i tidy the notes",
    ]) {
      expect(readAgyCommandLine(`/Users/example/.local/bin/agy ${rest}`), rest).toEqual({
        session: false,
        remoteAgent: true,
      });
    }
  });

  test("--remote-agent anywhere else in the line, or another option like it, is a session", () => {
    for (const rest of [
      "--model auto --remote-agent",
      "-c --remote-agent",
      "-p explain what --remote-agent does",
      "-i --remote-agent",
      "--remote-agents",
      "--remote-agent=false",
      "--remote-control",
      "remote-agent",
    ]) {
      expect(readAgyCommandLine(`agy ${rest}`), rest).toEqual({ session: true });
    }
    expect(readAgyCommandLine(`agy -r ${A} --remote-agent`)).toEqual({
      session: true,
      conversation: A,
    });
  });

  test("agy acp, which an editor runs, is a session that names no conversation", () => {
    for (const rest of [
      "acp",
      "acp --sandbox --add-dir /Users/example/code/demo",
      "acp --process-per-session",
      `acp --agent -r ${A}`,
    ]) {
      expect(readAgyCommandLine(`/Users/example/.local/bin/agy ${rest}`), rest).toEqual({
        session: true,
        acp: true,
      });
    }
    // Anywhere else in the line it can be a prompt's word.
    for (const rest of ["-p explain what acp does", "--acp", "acps", "-c acp"]) {
      expect(readAgyCommandLine(`agy ${rest}`), rest).toEqual({ session: true });
    }
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
      remoteAgents: [],
    });
    expect(ps.runs).toEqual([
      { args: AGY_TABLE_ARGS, utc: true },
      { args: agyCommandLineArgs([812, 813, 814, 900, 901]), utc: false },
    ]);
  });

  test("an agy acp is told apart, and the programs it starts for its sessions belong to it", async () => {
    const editors = [
      row(700, 1, NOW - 9 * MINUTE, "/Applications/Some Editor.app/Contents/MacOS/editor"),
      row(701, 700, NOW - 8 * MINUTE, "/Users/example/.local/bin/agy"),
      row(702, 701, NOW - 7 * MINUTE, "/Users/example/.local/bin/agy"),
    ].join("\n");
    const ps = standInPs(editors, {
      701: "/Users/example/.local/bin/agy acp --process-per-session",
      702: "/Users/example/.local/bin/agy --worker",
    });
    const reader = createAgyProcessReader({ run: ps.run, platform: "darwin" });
    expect(await reader.read()).toEqual({
      ok: true,
      sessions: [{ startedAt: NOW - 8 * MINUTE, acp: true }],
      remoteAgents: [],
    });
    // Nothing more is asked of ps for it.
    expect(ps.runs.map((run) => run.args)).toEqual([
      AGY_TABLE_ARGS,
      agyCommandLineArgs([701, 702]),
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
      remoteAgents: [],
    });
  });

  test("a program started with --remote-agent is named apart, and one resumed with -r or --resume names its conversation", async () => {
    const ps = standInPs(table, {
      812: `agy -r ${A}`,
      813: `agy --remote-agent --conversation=${B}`,
      814: `agy --resume ${B}`,
      // Started by the agy in 812. It is no session, and may write a log all the same.
      900: "agy --remote-agent",
      901: "agy --model auto",
    });
    const reader = createAgyProcessReader({ run: ps.run, platform: "darwin" });
    expect(await reader.read()).toEqual({
      ok: true,
      sessions: [
        { startedAt: NOW - 5 * MINUTE, conversation: A },
        { startedAt: NOW - 3 * MINUTE, conversation: B },
      ],
      // By its start alone: it names no conversation kept on this computer.
      remoteAgents: [{ startedAt: NOW - 4 * MINUTE }, { startedAt: NOW - 2 * MINUTE }],
    });
    // The same two runs as for any other line, and nothing more is asked of ps.
    expect(ps.runs).toEqual([
      { args: AGY_TABLE_ARGS, utc: true },
      { args: agyCommandLineArgs([812, 813, 814, 900, 901]), utc: false },
    ]);
  });

  test("a program whose parent ended between the two runs is a session of its own", async () => {
    const ps = standInPs(
      [row(812, 501, NOW - 5 * MINUTE, "agy"), row(900, 812, NOW - 2 * MINUTE, "agy")].join("\n"),
      { 900: "agy" },
    );
    const reader = createAgyProcessReader({ run: ps.run, platform: "darwin" });
    expect(await reader.read()).toEqual({
      ok: true,
      sessions: [{ startedAt: NOW - 2 * MINUTE }],
      remoteAgents: [],
    });
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
      remoteAgents: [],
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
      remoteAgents: [],
    });
  });

  test("with no agy program, only the table is asked for", async () => {
    const ps = standInPs(row(501, 1, NOW, "-zsh"), {});
    const reader = createAgyProcessReader({ run: ps.run, platform: "linux" });
    expect(await reader.read()).toEqual({ ok: true, sessions: [], remoteAgents: [] });
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
