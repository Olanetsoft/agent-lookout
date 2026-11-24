// A stand-in for ssh, for the tests of the tunnels to other machines. It never
// connects anywhere and reads no ssh config, key or agent. Given what Agent
// Lookout gives ssh, `-W 127.0.0.1:<port there> ... -- <target>`, it joins its
// input and output to 127.0.0.1:<port there> on this same machine, where a test
// runs a stand-in Agent Lookout. It is plain JavaScript, run by Node through a
// small script that `standIns.ts` writes.
//
// What it does is chosen by the target, as a real machine would choose:
//
//   a target with "refuse" in it   says "Permission denied (publickey)." and ends with 255
//   any other                      connects, as ssh does once it has signed in
//
// With STAND_IN_SSH_LOG naming a file, each run adds a line to it: its process
// ID and its arguments, as JSON, written once its signal handlers are set, so a
// test that has read the line can signal it. With STAND_IN_SSH_DELAY_MS, it
// waits that long before it connects, as ssh does while it signs in. With
// nothing listening there it writes the lines ssh writes for that, and ends with
// 255. Once the connection there ends, it ends with 0.
// SIGHUP stands in for the other machine closing the connection: it says so
// and ends with 255. SIGTERM ends it as it ends ssh, unless
// STAND_IN_SSH_IGNORE_TERM is set, when it stands in for an ssh that does not
// end on SIGTERM and only SIGKILL ends it. With STAND_IN_SSH_SIGNALS naming a
// file, each SIGTERM or SIGHUP it is sent adds a line to it: its process ID and
// the signal, as JSON. SIGKILL cannot be caught, so it is never written down.
//
// With STAND_IN_SSH_PROXY naming a file, it first starts a program that never
// ends and holds its error output, as a ProxyCommand that hangs, and adds its
// process ID to the file. With STAND_IN_SSH_PROXY_APART set, that program is in a
// process group of its own, so a signal to ssh's group does not reach it, and
// with STAND_IN_SSH_PROXY_IGNORE_TERM set it does not end on SIGTERM.

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args[0] === "proxy") {
  if (process.env.STAND_IN_SSH_PROXY_IGNORE_TERM) process.on("SIGTERM", () => {});
  await new Promise(() => setInterval(() => {}, 1_000));
}
const separator = args.indexOf("--");
const target = separator >= 0 ? args[separator + 1] : undefined;
const [host, port] = (args[args.indexOf("-W") + 1] ?? "").split(":");

function end(line, code) {
  if (line) process.stderr.write(`${line}\n`);
  process.exit(code);
}

function noted(signal) {
  const signals = process.env.STAND_IN_SSH_SIGNALS;
  if (signals) appendFileSync(signals, `${JSON.stringify({ pid: process.pid, signal })}\n`);
}

process.on("SIGTERM", () => {
  noted("SIGTERM");
  if (!process.env.STAND_IN_SSH_IGNORE_TERM) end("Killed by signal 15.", 255);
});
process.on("SIGHUP", () => {
  noted("SIGHUP");
  end(`Connection to ${(target ?? "").split("@").pop()} closed by remote host.`, 255);
});

const proxies = process.env.STAND_IN_SSH_PROXY;
if (proxies) {
  const proxy = spawn(process.execPath, [fileURLToPath(import.meta.url), "proxy"], {
    stdio: ["ignore", "ignore", "inherit"],
    detached: process.env.STAND_IN_SSH_PROXY_APART !== undefined,
  });
  appendFileSync(proxies, `${proxy.pid}\n`);
}

// The run is written down only now, with both handlers set: a test signals
// the stand-in as soon as it reads the run, and a signal sent any sooner
// would end it with nothing written down.
const log = process.env.STAND_IN_SSH_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ pid: process.pid, args })}\n`);

if (!target || host !== "127.0.0.1" || !port) end("usage: ssh -W ... -- destination", 255);
if (target.includes("refuse")) end(`${target}: Permission denied (publickey).`, 255);

const delay = Number(process.env.STAND_IN_SSH_DELAY_MS ?? 0);
setTimeout(() => {
  const far = connect(Number(port), host);
  let open = false;
  far.once("connect", () => (open = true));
  far.once("error", () => {
    const why = "channel 0: open failed: connect failed: Connection refused";
    if (!open) end(`${why}\nstdio forwarding failed`, 255);
  });
  far.once("close", () => process.stdout.write("", () => end("", 0)));
  process.stdin.pipe(far).pipe(process.stdout);
}, delay);
