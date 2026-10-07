// Starts the built app the way a person starts it, with `npm start`, and checks
// that it finds a session of each kind. CI runs it on Linux and on Windows. To
// run it by hand:
//
//   npm run build
//   npm run start:check
//
// With `--command`, it starts the command that follows in place of `npm start`,
// in the folder it is run from. CI uses that to check the package as a person
// gets it from npm: packed, installed into a folder of its own, and started
// with `npx --yes=false agent-lookout`.
//
// It reads none of this machine's own agents. It makes folders of its own, in
// the system's temporary folder or, with `-- --dir <folder>`, in that folder: a
// Claude Code folder whose registry names two stand-ins for Claude Code's
// processes, small Node programs this script starts that only wait, a copy
// of tests/fixtures/codex-home, a folder with one status file, and a folder
// for the history the app keeps, so nothing is written to this machine's. It starts
// the app on a port the system picks, with the claude command, tmux and
// Terminal left alone, and asks only `/api/health`, `/api/sessions`, the
// dashboard's page and its script. Then it runs the same command's `mcp`, as
// an agent's app would, and checks over its stdin and stdout that it lists its
// tools and names the session that needs you. In the package, `mcp` runs the
// MCP SDK bundled into it, so this is what shows that bundle works. Then it
// stops the app, and every process it started, each by its own process ID,
// and removes the folders.
//
// On Windows `npm start` is run as npm's own script, `npm_execpath`, with this
// Node, because `npm` there is a `.cmd`, which only a shell runs. Windows has
// no `ps`, so the processes under the app are listed by PowerShell, and a
// registry file whose process is not the one it names is not looked for,
// since Agent Lookout compares no start times there. Windows has no Ctrl+C to
// send another program either, so the app is ended with every process under
// it by `taskkill`, and the check is that nothing is left and nothing answers.
//
// It prints one line for each check and exits with 0 when all pass, 1 when one
// fails and 2 when it could not get as far as checking.

import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { get } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** How long the app gets to start, and then to find every session. */
const START_TIMEOUT_MS = 30_000;
const FIND_TIMEOUT_MS = 20_000;
/** How long the app gets to stop once `npm start` has been asked to. */
const STOP_TIMEOUT_MS = 15_000;
/** How long `mcp` gets to answer each message, and to end once its stdin is closed. */
const MCP_TIMEOUT_MS = 15_000;

/** The tools `mcp` serves. */
const MCP_TOOLS = ["list_sessions", "sessions_needing_you", "sources"];

/** The ids the stand-in registry files give their sessions. */
const WAITING_ID = "00000000-0000-4000-8000-00000000a001";
const LEFTOVER_ID = "00000000-0000-4000-8000-00000000a002";
/** A start time in the shape `ps` prints, and one the leftover's process did not have. */
const ANOTHER_START = "Thu Jan  1 00:00:00 1970";

/**
 * The Codex sessions in the copy that a Codex program has open, with the
 * status the fixture gives each. These do not depend on the date the check is
 * run, since an open session is shown whatever day its file was written.
 */
const CODEX_OPEN = [
  ["00000000-0000-4000-8000-0000000000c1", "working"],
  ["00000000-0000-4000-8000-0000000000c2", "idle"],
  ["00000000-0000-4000-8000-0000000000c4", "idle"],
  ["00000000-0000-4000-8000-0000000000c6", "working"],
  // Resumed, so its file is in a day folder older than yesterday's.
  ["00000000-0000-4000-8000-0000000000c9", "working"],
];

const SOURCES = [
  ["claude-code", "Claude Code"],
  ["codex", "Codex"],
  ["status-files", "Status files"],
];

const onWindows = process.platform === "win32";

/** Where Windows keeps its own programs. */
const system32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");

/** What this script started, so that everything is stopped whatever happens. */
const started = { standIns: [], npm: null, mcp: null, dir: null };
let failures = 0;

function pass(line) {
  console.log(`ok    ${line}`);
}

function fail(line) {
  failures += 1;
  console.log(`FAIL  ${line}`);
}

function skip(line) {
  console.log(`skip  ${line}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs a program directly, with no shell, and resolves with what it printed, whatever its exit code. */
function run(file, args, env, timeout = 5_000) {
  return new Promise((resolve) => {
    execFile(file, args, { env, encoding: "utf8", timeout, windowsHide: true }, (_error, stdout) =>
      resolve(String(stdout ?? "")),
    );
  });
}

/** Starts a process and resolves once it is running, with the child. */
function startProcess(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, options);
    child.once("spawn", () => resolve(child));
    child.once("error", reject);
  });
}

/**
 * Resolves once the child has exited, with its exit code or the signal that
 * ended it, or with null if it has not exited within `ms`.
 */
function exitOf(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode ?? child.signalCode);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    child.once("exit", (code, signalName) => {
      clearTimeout(timer);
      resolve(code ?? signalName);
    });
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Sends a signal to one process, by its own ID. */
function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch {
    // It has already gone.
  }
}

/** One GET to the app. Rejects when nothing answers. */
function getText(base, route) {
  return new Promise((resolve, reject) => {
    const request = get(`${base}${route}`, { timeout: 2_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode, type: response.headers["content-type"], body }),
      );
    });
    request.on("timeout", () => request.destroy(new Error("no answer in time")));
    request.on("error", reject);
  });
}

/** One GET to the app, as JSON. Rejects when nothing answers or the answer is not JSON. */
async function getJson(base, route) {
  const { status, body } = await getText(base, route);
  return { status, json: JSON.parse(body) };
}

/**
 * Each process's ID and its parent's, a line each: from `ps`, or on Windows,
 * which has none, from PowerShell, which takes a few seconds to start.
 */
function processTable() {
  if (onWindows) {
    return run(
      path.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }",
      ],
      process.env,
      30_000,
    );
  }
  return run("ps", ["-A", "-o", "pid=,ppid="], { PATH: "/usr/bin:/bin", LC_ALL: "C" });
}

/** Every process below this one, from one reading of the table, by walking down from it. */
async function descendantsOf(pid) {
  const printed = await processTable();
  const children = new Map();
  for (const line of printed.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const [child, parent] = [Number(match[1]), Number(match[2])];
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found = [];
  const queue = [pid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (!found.includes(child)) {
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
}

/** The folders and files the app is pointed at. */
async function makeFolders(dir, waitingPid, leftoverPid) {
  const claudeHome = path.join(dir, "claude");
  const codexHome = path.join(dir, "codex");
  const statusDir = path.join(dir, "status");
  const historyDir = path.join(dir, "history");
  const work = path.join(dir, "work");
  await mkdir(path.join(claudeHome, "sessions"), { recursive: true });
  await mkdir(statusDir, { recursive: true });
  await mkdir(path.join(work, "checkout-flow"), { recursive: true });
  await mkdir(path.join(work, "docs-refresh"), { recursive: true });

  // What Claude Code records as `procStart`, asked of `ps` the way it asks.
  // Windows has no `ps`, and Claude Code there records none.
  const procStart = onWindows
    ? undefined
    : (
        await run("ps", ["-o", "lstart=", "-p", String(waitingPid)], {
          PATH: "/usr/bin:/bin",
          LC_ALL: "C",
          TZ: "UTC",
        })
      ).trim();

  const startedAt = Date.now();
  const entry = (pid, fields) =>
    writeFile(
      path.join(claudeHome, "sessions", `${pid}.json`),
      JSON.stringify({ pid, kind: "interactive", entrypoint: "cli", startedAt, ...fields }),
    );
  await entry(waitingPid, {
    sessionId: WAITING_ID,
    cwd: path.join(work, "checkout-flow"),
    name: "checkout-flow",
    status: "waiting",
    waitingFor: "permission prompt",
    statusUpdatedAt: startedAt,
    procStart,
  });
  // A file left behind by a session that crashed, whose pid now belongs to another process.
  await entry(leftoverPid, {
    sessionId: LEFTOVER_ID,
    cwd: path.join(work, "checkout-flow"),
    name: "left-behind",
    status: "busy",
    statusUpdatedAt: startedAt,
    procStart: ANOTHER_START,
  });

  await cp(path.join(root, "tests", "fixtures", "codex-home"), codexHome, { recursive: true });

  await writeFile(
    path.join(statusDir, "docs-refresh.json"),
    JSON.stringify({
      agent: "Night Shift",
      name: "docs-refresh",
      cwd: path.join(work, "docs-refresh"),
      status: "working",
      pid: waitingPid,
    }),
  );

  return { claudeHome, codexHome, statusDir, historyDir, procStart };
}

/**
 * The environment `npm start` is given: this one, without any setting of
 * Agent Lookout's own or Codex's, and with the folders made for the check. The
 * claude command is not run, tmux and Terminal are not asked, and npm does not
 * look for a newer version of itself.
 */
function appEnv(folders) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("AGENT_LOOKOUT_") && name !== "CODEX_HOME",
    ),
  );
  return {
    ...env,
    AGENT_LOOKOUT_HOST: "127.0.0.1",
    AGENT_LOOKOUT_PORT: "0",
    AGENT_LOOKOUT_CLAUDE_HOME: folders.claudeHome,
    AGENT_LOOKOUT_CLAUDE_FEED: "off",
    AGENT_LOOKOUT_CODEX_HOME: folders.codexHome,
    AGENT_LOOKOUT_STATUS_DIR: folders.statusDir,
    AGENT_LOOKOUT_HISTORY_DIR: folders.historyDir,
    AGENT_LOOKOUT_TMUX: "off",
    AGENT_LOOKOUT_TERMINAL_JUMP: "off",
    npm_config_update_notifier: "false",
  };
}

/**
 * How `npm start` is run. On Windows `npm` is a `.cmd`, which only a shell
 * runs, so npm's own script is run with this Node: the one `npm run` names in
 * `npm_execpath`, or else the one that comes with this Node.
 */
function npmStart() {
  if (!onWindows) return { file: "npm", args: ["start"] };
  const named = process.env.npm_execpath;
  const script =
    named && /\.c?js$/.test(named)
      ? named
      : path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return { file: process.execPath, args: [script, "start"] };
}

/** What starts the app: `npm start` in this folder, or the command `--command` gives, where this runs. */
function startCommandOf(argv) {
  const at = argv.indexOf("--command");
  if (at === -1) return { ...npmStart(), cwd: root, label: "npm start" };
  const [file, ...args] = argv.slice(at + 1);
  if (!file) return null;
  return { file, args, cwd: process.cwd(), label: [file, ...args].join(" ") };
}

const start = startCommandOf(process.argv.slice(2));

/** Starts the app and resolves with the address it prints, or rejects with what it printed. */
async function startApp(env) {
  const npm = await startProcess(start.file, start.args, {
    cwd: start.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  started.npm = npm;
  let printed = "";
  npm.stdout.on("data", (chunk) => (printed += chunk));
  npm.stderr.on("data", (chunk) => (printed += chunk));

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const address = /is running at (http:\/\/127\.0\.0\.1:\d+)/.exec(printed)?.[1];
    if (address) return { address, printed: () => printed };
    if (npm.exitCode !== null || npm.signalCode !== null) break;
    await wait(100);
  }
  throw new Error(`${start.label} did not say where it is running. It printed:\n${printed}`);
}

/** Asks for the sessions until every source has been read once, or the time is up. */
async function readSessions(address) {
  const deadline = Date.now() + FIND_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = (await getJson(address, "/api/sessions")).json;
      const states = SOURCES.map(([id]) => last.sources.find((source) => source.id === id)?.state);
      const codexSeen = CODEX_OPEN.every(([id]) =>
        last.sessions.some((session) => session.id === `codex:${id}`),
      );
      if (states.every((state) => state !== undefined && state !== "searching") && codexSeen) {
        return last;
      }
    } catch {
      // Not answering yet.
    }
    await wait(500);
  }
  return last;
}

function check(snapshot, procStart) {
  for (const [id, label] of SOURCES) {
    const source = snapshot.sources.find((item) => item.id === id);
    if (source?.state === "ok") pass(`${label} is read`);
    else fail(`${label} is ${source ? `${source.state}: ${source.detail ?? ""}` : "not listed"}`);
  }

  const byId = (id) => snapshot.sessions.find((session) => session.id === id);

  const waiting = byId(`claude-code:${WAITING_ID}`);
  if (waiting?.status === "needs-you" && waiting.waitingReason === "permission") {
    pass(`Claude Code session ${waiting.name} needs you, for permission`);
  } else {
    fail(`Claude Code session checkout-flow is ${waiting ? waiting.status : "not listed"}`);
  }

  if (onWindows) {
    skip(
      "A registry file whose process started at another time is not looked for: Windows has no ps, so Agent Lookout compares no start times there",
    );
  } else if (byId(`claude-code:${LEFTOVER_ID}`) === undefined) {
    pass("A registry file whose process started at another time is left out");
  } else {
    fail(
      `A registry file whose process started at another time is listed, so a start time as this ps prints it, ${JSON.stringify(procStart)}, was not understood`,
    );
  }

  for (const [id, status] of CODEX_OPEN) {
    const session = byId(`codex:${id}`);
    if (session?.status === status) pass(`Codex session ${session.name} is ${status}`);
    else fail(`Codex session ${id} is ${session ? session.status : "not listed"}, not ${status}`);
  }

  const fromFile = snapshot.sessions.find(
    (session) => session.source === "status-files" && session.name === "docs-refresh",
  );
  if (fromFile?.status === "working" && fromFile.agent === "Night Shift") {
    pass(`Status file session ${fromFile.name} of ${fromFile.agent} is working`);
  } else {
    fail(`Status file session docs-refresh is ${fromFile ? fromFile.status : "not listed"}`);
  }
}

/** Checks that the dashboard's page is served, and the script it names. */
async function checkPage(address) {
  const page = await getText(address, "/").catch(() => null);
  const script = page?.body.match(/<script type="module"[^>]*\ssrc="(\/assets\/[^"]+\.js)"/)?.[1];
  if (page?.status !== 200 || !page.type?.startsWith("text/html") || !script) {
    fail(`The dashboard's page is not served at ${address}/`);
    return;
  }
  const code = await getText(address, script).catch(() => null);
  if (code?.status === 200 && code.type?.startsWith("text/javascript")) {
    pass(`The dashboard's page is served, with its script ${script}`);
  } else {
    fail(`The dashboard's script ${script} is not served`);
  }
}

/**
 * The command that runs `mcp` and asks the app at `address`: the command
 * `--command` gives, or `bin/agent-lookout.mjs` in this folder for `npm start`.
 */
function mcpCommandOf(address) {
  const args = ["mcp", "--url", address];
  if (start.label === "npm start") {
    const bin = path.join(root, "bin", "agent-lookout.mjs");
    return { file: process.execPath, args: [bin, ...args], cwd: root, label: "agent-lookout mcp" };
  }
  return {
    file: start.file,
    args: [...start.args, ...args],
    cwd: start.cwd,
    label: `${start.label} mcp`,
  };
}

/**
 * Starts `mcp` and speaks the Model Context Protocol to it over its stdin and
 * stdout, one JSON message a line, as an agent's app does. Checks that it
 * lists its tools, and that sessions_needing_you names the Claude Code session
 * that needs you, then closes its stdin and checks that it ends with 0.
 */
async function checkMcp(address, env) {
  const command = mcpCommandOf(address);
  const mcp = await startProcess(command.file, command.args, {
    cwd: command.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  started.mcp = mcp;
  let stderr = "";
  mcp.stderr.on("data", (chunk) => (stderr += chunk));
  const answers = new Map();
  let unread = "";
  mcp.stdout.on("data", (chunk) => {
    unread += chunk;
    let end;
    while ((end = unread.indexOf("\n")) !== -1) {
      const line = unread.slice(0, end).trim();
      unread = unread.slice(end + 1);
      if (line === "") continue;
      try {
        const message = JSON.parse(line);
        answers.get(message.id)?.(message);
      } catch {
        fail(`${command.label} printed a line that is not JSON: ${line.slice(0, 200)}`);
      }
    }
  });
  let lastId = 0;
  const send = (message) => mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const ask = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++lastId;
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), MCP_TIMEOUT_MS);
      answers.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      });
      send({ id, method, params });
    });

  try {
    const hello = await ask("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "start-check", version: "1" },
    });
    send({ method: "notifications/initialized" });
    const listed = (await ask("tools/list", {})).tools.map((tool) => tool.name).sort();
    if (JSON.stringify(listed) === JSON.stringify(MCP_TOOLS)) {
      pass(`${command.label} ${hello.serverInfo.version} lists its tools: ${listed.join(", ")}`);
    } else {
      fail(
        `${command.label} lists ${listed.join(", ") || "no tools"}, not ${MCP_TOOLS.join(", ")}`,
      );
    }
    const needing = await ask("tools/call", { name: "sessions_needing_you", arguments: {} });
    const waiting = needing.structuredContent?.sessions ?? [];
    if (
      !needing.isError &&
      waiting.some((session) => session.name === "checkout-flow" && session.reason === "permission")
    ) {
      pass(`Its sessions_needing_you says checkout-flow needs you, for permission`);
    } else {
      fail(`Its sessions_needing_you answered ${JSON.stringify(needing).slice(0, 300)}`);
    }
  } catch (error) {
    fail(`${command.label} did not answer: ${error.message}. It printed on stderr:\n${stderr}`);
  }

  mcp.stdin.end();
  const code = await exitOf(mcp, MCP_TIMEOUT_MS);
  if (code === 0) {
    pass(`${command.label} ended with exit code 0 once its stdin was closed`);
  } else {
    const ended = code === null ? "went on running" : `ended with ${code}`;
    fail(`${command.label} ${ended} once its stdin was closed`);
    for (const pid of [mcp.pid, ...(await descendantsOf(mcp.pid))]) signal(pid, "SIGKILL");
  }
  started.mcp = null;
}

/**
 * Ends a process and every process under it, on Windows, with the system's
 * own `taskkill`. Only a process ID this script started is ever handed to it.
 */
function endTree(pid) {
  return run(path.join(system32, "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], process.env);
}

/**
 * Stops the app as Ctrl+C in its terminal does, by sending SIGINT to npm
 * and to every process under it at once, each by its own ID, and checks that
 * the app stopped with it. Windows cannot send Ctrl+C to another program's
 * console, so there npm is ended with every process under it, as closing its
 * window would.
 */
async function stopApp(address) {
  const npm = started.npm;
  const below = await descendantsOf(npm.pid);
  if (onWindows) await endTree(npm.pid);
  else for (const pid of [npm.pid, ...below]) signal(pid, "SIGINT");
  const how = onWindows ? "once it was ended" : "on Ctrl+C";
  const code = await exitOf(npm, STOP_TIMEOUT_MS);
  started.npm = null;
  if (code === null) {
    fail(`${start.label} did not stop ${how}`);
    signal(npm.pid, "SIGKILL");
  }

  let answering = true;
  const deadline = Date.now() + 5_000;
  while (answering && Date.now() < deadline) {
    answering = await getJson(address, "/api/health").then(
      () => true,
      () => false,
    );
    if (answering) await wait(200);
  }
  // The processes under npm can end a moment after npm does.
  let left = below.filter(isAlive);
  const gone = Date.now() + 5_000;
  while (left.length > 0 && Date.now() < gone) {
    await wait(200);
    left = left.filter(isAlive);
  }
  if (code !== null && !answering && left.length === 0) {
    if (onWindows) {
      pass(
        `It was ended with the ${below.length} processes under ${start.label}, and nothing answers at its address`,
      );
    } else {
      const ended = typeof code === "number" ? `exit code ${code}` : code;
      pass(`It stopped on Ctrl+C, and ${start.label} ended with ${ended}`);
    }
  } else if (answering || left.length > 0) {
    fail(`The app went on running ${how}: process ${left.join(", ") || "unknown"}`);
  }
  for (const pid of left) signal(pid, "SIGKILL");
}

/** Stops whatever is still running, each process by its own ID, and removes the folders. */
async function cleanUp() {
  if (started.mcp) {
    const below = await descendantsOf(started.mcp.pid);
    for (const pid of [started.mcp.pid, ...below]) signal(pid, "SIGKILL");
    started.mcp = null;
  }
  if (started.npm) {
    const below = await descendantsOf(started.npm.pid);
    for (const pid of [started.npm.pid, ...below]) signal(pid, "SIGKILL");
    started.npm = null;
  }
  for (const standIn of started.standIns) {
    signal(standIn.pid, "SIGTERM");
    await exitOf(standIn, 2_000);
  }
  started.standIns = [];
  // On Windows a file a process has only just let go of can be busy for a moment.
  if (started.dir) {
    await rm(started.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  started.dir = null;
}

async function main() {
  if (start === null) {
    console.error(
      "--command needs the command to start, such as --command npx --yes=false agent-lookout.",
    );
    return 2;
  }
  if (start.label === "npm start" && !existsSync(path.join(root, "dist", "index.html"))) {
    console.error("The dashboard has not been built yet. Run `npm run build`, then this again.");
    return 2;
  }

  const asked = process.argv.indexOf("--dir");
  const named = asked === -1 ? os.tmpdir() : process.argv[asked + 1];
  if (!named || !existsSync(named)) {
    console.error("--dir names a folder that is not there. Make it first, or leave --dir out.");
    return 2;
  }
  started.dir = await mkdtemp(path.join(path.resolve(named), "agent-lookout-start-check-"));
  // Each stand-in waits for ten minutes, unless it is stopped first.
  for (let i = 0; i < 2; i += 1) {
    const waits = "setTimeout(() => {}, 600_000)";
    started.standIns.push(
      await startProcess(process.execPath, ["-e", waits], { stdio: "ignore", windowsHide: true }),
    );
  }
  const [waitingStandIn, leftoverStandIn] = started.standIns;
  const folders = await makeFolders(started.dir, waitingStandIn.pid, leftoverStandIn.pid);

  const env = appEnv(folders);
  let app;
  try {
    app = await startApp(env);
  } catch (error) {
    console.error(error.message);
    return 2;
  }

  const health = await getJson(app.address, "/api/health").catch(() => null);
  if (health?.json?.ok === true) {
    pass(`${start.label} answers at ${app.address}, version ${health.json.version}`);
  } else {
    fail(`${start.label} does not answer /api/health at ${app.address}`);
  }

  await checkPage(app.address);

  const snapshot = await readSessions(app.address);
  if (snapshot === null) fail(`${start.label} did not answer /api/sessions`);
  else check(snapshot, folders.procStart);

  await checkMcp(app.address, env);

  await stopApp(app.address);

  if (failures > 0) {
    console.log(`\nThe start check failed on ${process.platform}. ${start.label} printed:\n`);
    console.log(app.printed());
    return 1;
  }
  console.log(`\nThe start check passed on ${process.platform}.`);
  return 0;
}

for (const name of ["SIGINT", "SIGTERM"]) {
  process.once(name, () => {
    cleanUp().finally(() => process.exit(130));
  });
}

let code = 2;
try {
  code = await main();
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  await cleanUp();
}
process.exit(code);
