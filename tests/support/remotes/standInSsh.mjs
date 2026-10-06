// A stand-in for ssh, for the tests of the tunnels to other machines. It never
// connects anywhere and reads no ssh config, key or agent. Given what Agent
// Lookout gives ssh, `-N ... -L 127.0.0.1:<local>:127.0.0.1:<remote> --
// <target>`, it listens on 127.0.0.1:<local> and passes each connection on to
// 127.0.0.1:<remote> on this same machine, where a test runs a stand-in Agent
// Lookout. It is plain JavaScript, run by Node through a small script that
// `standIns.ts` writes.
//
// What it does is chosen by the target, as a real machine would choose:
//
//   a target with "refuse" in it   says "Permission denied (publickey)." and ends with 255
//   any other                      forwards, as ssh does once it has signed in
//
// With STAND_IN_SSH_LOG naming a file, each run adds a line to it: its process
// ID and its arguments, as JSON. With STAND_IN_SSH_DELAY_MS, it waits that long
// before it listens, as ssh does while it signs in. A connection whose far end
// is not listening is closed with no answer, and the line ssh writes for it.
// SIGHUP stands in for the other machine closing the connection: it says so
// and ends with 255. SIGTERM ends it as it ends ssh, unless
// STAND_IN_SSH_IGNORE_TERM is set, when it stands in for an ssh that does not
// end on SIGTERM and only SIGKILL ends it.

import { appendFileSync } from "node:fs";
import { connect, createServer } from "node:net";

const args = process.argv.slice(2);
const log = process.env.STAND_IN_SSH_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ pid: process.pid, args })}\n`);

const separator = args.indexOf("--");
const target = separator >= 0 ? args[separator + 1] : undefined;
const forward = args[args.indexOf("-L") + 1] ?? "";
const [, localPort, , remotePort] = forward.split(":");

function end(line, code) {
  if (line) process.stderr.write(`${line}\n`);
  process.exit(code);
}

if (!target || !localPort || !remotePort) end("usage: ssh -L ... -- destination", 255);
if (target.includes("refuse")) end(`${target}: Permission denied (publickey).`, 255);

process.on("SIGTERM", () => {
  if (!process.env.STAND_IN_SSH_IGNORE_TERM) end("Killed by signal 15.", 255);
});
process.on("SIGHUP", () =>
  end(`Connection to ${target.split("@").pop()} closed by remote host.`, 255),
);

const server = createServer((client) => {
  const far = connect(Number(remotePort), "127.0.0.1");
  far.once("error", () => {
    process.stderr.write("channel 2: open failed: connect failed: Connection refused\n");
    client.destroy();
  });
  client.once("error", () => far.destroy());
  client.pipe(far).pipe(client);
});
server.once("error", () => {
  end(
    `bind [127.0.0.1]:${localPort}: Address already in use\nCould not request local forwarding.`,
    255,
  );
});

const delay = Number(process.env.STAND_IN_SSH_DELAY_MS ?? 0);
setTimeout(() => server.listen(Number(localPort), "127.0.0.1"), delay);
