// Starts the built app the way a person starts it, with `npm start`, and checks
// that it finds a session of each kind. CI runs it on Linux. To run it by hand:
//
//   npm run build
//   npm run start:check
//
// It reads none of this machine's own agents. It makes folders of its own, in
// the system's temporary folder or, with `-- --dir <folder>`, in that folder: a
// Claude Code folder whose registry names a `sleep` this script starts, a copy
// of tests/fixtures/codex-home, and a folder with one status file. It starts
// the app on a port the system picks, with the claude command, tmux and
// Terminal left alone, and asks only `/api/health` and `/api/sessions`. Then it
// stops the app, and every process it started, each by its own process ID, and
// removes the folders.
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

/** What this script started, so that everything is stopped whatever happens. */
const started = { sleeps: [], npm: null, dir: null };
let failures = 0;

function pass(line) {
  console.log(`ok    ${line}`);
}

function fail(line) {
  failures += 1;
  console.log(`FAIL  ${line}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs a program directly, with no shell, and resolves with what it printed, whatever its exit code. */
function run(file, args, env) {
  return new Promise((resolve) => {
    execFile(file, args, { env, encoding: "utf8", timeout: 5_000 }, (_error, stdout) =>
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

/** One GET to the app, as JSON. Rejects when nothing answers or the answer is not JSON. */
function getJson(base, route) {
  return new Promise((resolve, reject) => {
    const request = get(`${base}${route}`, { timeout: 2_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode, json: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("no answer in time")));
    request.on("error", reject);
  });
}

/** Every process below this one, from one run of `ps`, by walking down from it. */
async function descendantsOf(pid) {
  const printed = await run("ps", ["-A", "-o", "pid=,ppid="], {
    PATH: "/usr/bin:/bin",
    LC_ALL: "C",
  });
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
  const work = path.join(dir, "work");
  await mkdir(path.join(claudeHome, "sessions"), { recursive: true });
  await mkdir(statusDir, { recursive: true });
  await mkdir(path.join(work, "checkout-flow"), { recursive: true });
  await mkdir(path.join(work, "docs-refresh"), { recursive: true });

  // What Claude Code records as `procStart`, asked of `ps` the way it asks.
  const procStart = (
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

  return { claudeHome, codexHome, statusDir, procStart };
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
    AGENT_LOOKOUT_TMUX: "off",
    AGENT_LOOKOUT_TERMINAL_JUMP: "off",
    npm_config_update_notifier: "false",
  };
}

/** Starts `npm start` and resolves with the address it prints, or rejects with what it printed. */
async function startApp(env) {
  const npm = await startProcess("npm", ["start"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
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
  throw new Error(`npm start did not say where it is running. It printed:\n${printed}`);
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

  if (byId(`claude-code:${LEFTOVER_ID}`) === undefined) {
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

/**
 * Stops `npm start` as Ctrl+C in its terminal does, by sending SIGINT to npm
 * and to every process under it at once, each by its own ID, and checks that
 * the app stopped with it.
 */
async function stopApp(address) {
  const npm = started.npm;
  const below = await descendantsOf(npm.pid);
  for (const pid of [npm.pid, ...below]) signal(pid, "SIGINT");
  const code = await exitOf(npm, STOP_TIMEOUT_MS);
  started.npm = null;
  if (code === null) {
    fail("npm start did not stop on Ctrl+C");
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
    const ended = typeof code === "number" ? `exit code ${code}` : code;
    pass(`It stopped on Ctrl+C, and npm start ended with ${ended}`);
  } else if (answering || left.length > 0) {
    fail(`The app went on running after Ctrl+C: process ${left.join(", ") || "unknown"}`);
  }
  for (const pid of left) signal(pid, "SIGKILL");
}

/** Stops whatever is still running, each process by its own ID, and removes the folders. */
async function cleanUp() {
  if (started.npm) {
    const below = await descendantsOf(started.npm.pid);
    for (const pid of [started.npm.pid, ...below]) signal(pid, "SIGKILL");
    started.npm = null;
  }
  for (const sleep of started.sleeps) {
    signal(sleep.pid, "SIGTERM");
    await exitOf(sleep, 2_000);
  }
  started.sleeps = [];
  if (started.dir) await rm(started.dir, { recursive: true, force: true });
  started.dir = null;
}

async function main() {
  if (!existsSync(path.join(root, "dist", "index.html"))) {
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
  for (let i = 0; i < 2; i += 1) {
    started.sleeps.push(await startProcess("sleep", ["600"], { stdio: "ignore" }));
  }
  const [waitingSleep, leftoverSleep] = started.sleeps;
  const folders = await makeFolders(started.dir, waitingSleep.pid, leftoverSleep.pid);

  let app;
  try {
    app = await startApp(appEnv(folders));
  } catch (error) {
    console.error(error.message);
    return 2;
  }

  const health = await getJson(app.address, "/api/health").catch(() => null);
  if (health?.json?.ok === true) {
    pass(`npm start answers at ${app.address}, version ${health.json.version}`);
  } else {
    fail(`npm start does not answer /api/health at ${app.address}`);
  }

  const snapshot = await readSessions(app.address);
  if (snapshot === null) fail("npm start did not answer /api/sessions");
  else check(snapshot, folders.procStart);

  await stopApp(app.address);

  if (failures > 0) {
    console.log(`\nThe start check failed on ${process.platform}. npm start printed:\n`);
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
