import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, onTestFinished, test, vi } from "vitest";

import type { Remote } from "@collector/remotes/remoteSettings";
import { SSH_BIN_ENV, sshArguments } from "@collector/remotes/sshProgram";
import {
  createTunnel,
  STOP_WAIT_MS,
  type Tunnel,
  type TunnelOptions,
  type TunnelState,
} from "@collector/remotes/tunnel";
import { snapshotThere } from "@tests/fixtures/remote";
import { closedPort } from "@tests/support/node/http";
import { tempDir } from "@tests/support/node/tempFiles";
import { isRunning, makeStandInSsh, startStandInLookout } from "@tests/support/remotes/standIns";

// The stand-in ssh is a POSIX sh script, and a drop is made with SIGHUP and an
// end with SIGTERM, POSIX signals: Windows has none of them.
const posixTest = test.skipIf(process.platform === "win32");

// The stand-in ssh is a Node program: on a heavily loaded machine its first
// start alone can take seconds, so this waits well past that.
const WAIT = { timeout: 20_000, interval: 20 };

// Each test writes a stand-in ssh of its own, and on a busy Mac one written
// moments ago can take seconds to start the first time, while macOS checks it.
// A test that starts it is given this long. None of them is about this timeout.
const STAND_IN_TIMEOUT_MS = 30_000;

/** A port nothing listens on, for a run that never comes to connect to it. */
const NOWHERE = await closedPort();

/** Settings of a stand-in ssh that signs in for as long as it runs. */
const SIGNING_IN = { STAND_IN_SSH_DELAY_MS: "600000" };

/** A tunnel that is stopped when the test finishes, however it ends. */
function tunnelFor(
  remote: Remote,
  env: NodeJS.ProcessEnv,
  options: Partial<TunnelOptions> = {},
): Tunnel {
  const tunnel = createTunnel({ remote, env, restartDelaysMs: [100, 300, 1_000], ...options });
  onTestFinished(() => tunnel.stop());
  return tunnel;
}

async function running(tunnel: Tunnel, run?: number) {
  return vi.waitFor(() => {
    const state = tunnel.state();
    if (state.kind !== "running" || (run !== undefined && state.run !== run)) {
      throw new Error(`still ${state.kind}`);
    }
    return state;
  }, WAIT);
}

async function ended(tunnel: Tunnel, run: number) {
  return vi.waitFor(() => {
    const state = tunnel.state();
    if (state.kind !== "ended" || state.run !== run) throw new Error(`still ${state.kind}`);
    return state;
  }, WAIT);
}

describe("the tunnel to another machine", () => {
  posixTest(
    "runs the named ssh with exactly its arguments, and reads Agent Lookout there through it",
    async () => {
      const lookout = await startStandInLookout(snapshotThere());
      const ssh = await makeStandInSsh();
      const remote: Remote = { name: "devbox", target: "dev@devbox.local", port: lookout.port };
      const tunnel = tunnelFor(remote, ssh.env);
      expect(tunnel.state()).toEqual({ kind: "off" });
      tunnel.start();

      const state = await running(tunnel, 1);
      expect(state.command).toEqual([ssh.bin, ...sshArguments(remote)]);
      const reading = await state.read();
      expect((await ssh.runs())[0]?.args).toEqual([
        "-W",
        `127.0.0.1:${lookout.port}`,
        "-o",
        "BatchMode=yes",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "PermitLocalCommand=no",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "--",
        "dev@devbox.local",
      ]);
      expect(reading).toMatchObject({ kind: "read", version: "0.2.3" });
      // Only the two routes, on the loopback's own name, with no Origin and nothing about the page.
      const asked = {
        method: "GET",
        host: `127.0.0.1:${lookout.port}`,
        origin: undefined,
        notifications: undefined,
      };
      expect(lookout.requests).toEqual([
        { ...asked, path: "/api/health" },
        { ...asked, path: "/api/sessions" },
      ]);
    },
    STAND_IN_TIMEOUT_MS,
  );

  posixTest(
    "a target a shell would split or run reaches ssh as it is",
    async () => {
      const mark = path.join(await tempDir(), "ran");
      // Through a shell, this would be two words, and the touch would run.
      const target = `dev@devbox $(touch ${mark})`;
      const ssh = await makeStandInSsh(SIGNING_IN);
      const tunnel = tunnelFor({ name: "devbox", target, port: NOWHERE }, ssh.env);
      tunnel.start();

      await running(tunnel, 1);
      await vi.waitFor(async () => expect(await ssh.runs()).toHaveLength(1), WAIT);
      expect((await ssh.runs())[0]?.args).toEqual(sshArguments({ port: NOWHERE, target }));
      expect(existsSync(mark)).toBe(false);
    },
    STAND_IN_TIMEOUT_MS,
  );

  posixTest(
    "finds ssh on PATH when no program is named",
    async () => {
      const ssh = await makeStandInSsh(SIGNING_IN);
      const env: NodeJS.ProcessEnv = { ...ssh.env, PATH: ssh.dir };
      delete env[SSH_BIN_ENV];
      const tunnel = tunnelFor({ name: "devbox", target: "devbox", port: NOWHERE }, env);
      tunnel.start();
      expect((await running(tunnel)).command[0]).toBe(ssh.bin);
    },
    STAND_IN_TIMEOUT_MS,
  );

  test("with no ssh to run, says where it looked, and looks again", async () => {
    const tunnel = tunnelFor(
      { name: "devbox", target: "devbox", port: NOWHERE },
      { [SSH_BIN_ENV]: "/nonexistent/agent-lookout-test/ssh" },
    );
    tunnel.start();
    const state = await vi.waitFor(() => {
      const current = tunnel.state();
      if (current.kind !== "no-ssh") throw new Error(current.kind);
      return current;
    }, WAIT);
    expect(state.looked).toBe(
      `${SSH_BIN_ENV} is set to /nonexistent/agent-lookout-test/ssh, which is not a program this user can run`,
    );
    expect(state.named).toBe(true);
    expect(state.retryAt).toBeGreaterThan(Date.now() - 1_000);
  });

  posixTest(
    "a drop is told apart, and ssh is started again after the shortest wait",
    async () => {
      const lookout = await startStandInLookout(snapshotThere());
      const ssh = await makeStandInSsh();
      const tunnel = tunnelFor(
        { name: "devbox", target: "dev@devbox.local", port: lookout.port },
        ssh.env,
      );
      tunnel.start();
      const first = await running(tunnel, 1);
      expect((await first.read()).kind).toBe("read");
      tunnel.connected(1);

      // The other machine closes the connection.
      const [run] = await ssh.runs();
      process.kill(run?.pid as number, "SIGHUP");
      const dropped = await ended(tunnel, 1);
      expect(dropped.end).toMatchObject({
        connected: true,
        code: 255,
        said: "Connection to devbox.local closed by remote host.",
      });
      expect(dropped.retryAt - dropped.end.at).toBe(100);

      expect(await first.read()).toEqual({ kind: "closed" });
      const second = await running(tunnel, 2);
      expect((await second.read()).kind).toBe("read");
      expect(await ssh.runs()).toHaveLength(2);
    },
    STAND_IN_TIMEOUT_MS,
  );

  posixTest(
    "a machine that turns ssh away is tried again after waits that grow",
    async () => {
      const ssh = await makeStandInSsh();
      const tunnel = tunnelFor(
        { name: "devbox", target: "dev@refuse.example", port: NOWHERE },
        ssh.env,
      );
      tunnel.start();
      const waits: number[] = [];
      let said: string | null = null;
      for (const run of [1, 2, 3, 4]) {
        const state = await ended(tunnel, run);
        waits.push(state.retryAt - state.end.at);
        said = state.end.said;
        expect(state.end.connected).toBe(false);
      }
      expect(said).toBe("dev@refuse.example: Permission denied (publickey).");
      expect(waits).toEqual([100, 300, 1_000, 1_000]);
    },
    STAND_IN_TIMEOUT_MS,
  );

  posixTest(
    "an ssh that hangs while it signs in is ended, with the ProxyCommand it hangs in, and started again",
    async () => {
      const ssh = await makeStandInSsh(SIGNING_IN);
      const tunnel = tunnelFor(
        { name: "devbox", target: "devbox", port: NOWHERE },
        { ...ssh.env, STAND_IN_SSH_PROXY: ssh.proxyLog },
        { firstReadingMs: 2_000 },
      );
      tunnel.start();
      expect((await ended(tunnel, 1)).end).toMatchObject({
        connected: false,
        said: "Nothing came back within 2 seconds.",
      });
      const [proxy] = await vi.waitFor(async () => {
        const started = await ssh.proxies();
        if (started.length === 0) throw new Error("no ProxyCommand yet");
        return started;
      }, WAIT);
      await vi.waitFor(() => expect(isRunning(proxy as number)).toBe(false), WAIT);
      await running(tunnel, 2);
    },
    STAND_IN_TIMEOUT_MS,
  );

  posixTest(
    "a run through which a reading has come back is not ended for its time",
    async () => {
      const ssh = await makeStandInSsh(SIGNING_IN);
      const tunnel = tunnelFor({ name: "devbox", target: "devbox", port: NOWHERE }, ssh.env, {
        firstReadingMs: 1_500,
      });
      tunnel.start();
      await running(tunnel, 1);
      tunnel.connected(1);
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(tunnel.state()).toMatchObject({ kind: "running", run: 1 });
      expect(await ssh.signals()).toEqual([]);
    },
    STAND_IN_TIMEOUT_MS,
  );

  posixTest(
    "a program ssh started that outlives it does not hold up the next run",
    async () => {
      const ssh = await makeStandInSsh({ STAND_IN_SSH_PROXY_APART: "1" });
      const tunnel = tunnelFor(
        { name: "devbox", target: "dev@refuse.example", port: NOWHERE },
        { ...ssh.env, STAND_IN_SSH_PROXY: ssh.proxyLog },
      );
      tunnel.start();
      expect((await ended(tunnel, 1)).end.said).toBe(
        "dev@refuse.example: Permission denied (publickey).",
      );
      const [proxy] = await ssh.proxies();
      expect(isRunning(proxy as number)).toBe(true);
      await running(tunnel, 2);
    },
    STAND_IN_TIMEOUT_MS,
  );

  posixTest(
    "with no Agent Lookout there the run ends, and says why the connection to it failed",
    async () => {
      const ssh = await makeStandInSsh();
      const tunnel = tunnelFor({ name: "devbox", target: "devbox", port: NOWHERE }, ssh.env);
      tunnel.start();
      const { read } = await running(tunnel, 1);
      expect(await read()).toEqual({ kind: "closed" });
      expect((await ended(tunnel, 1)).end).toMatchObject({
        connected: false,
        code: 255,
        said: "channel 0: open failed: connect failed: Connection refused",
      });
    },
    STAND_IN_TIMEOUT_MS,
  );

  posixTest(
    "the first reading waits while ssh signs in, and Agent Lookout there stopping ends the run",
    async () => {
      const lookout = await startStandInLookout(snapshotThere());
      const ssh = await makeStandInSsh({ STAND_IN_SSH_DELAY_MS: "500" });
      const tunnel = tunnelFor({ name: "devbox", target: "devbox", port: lookout.port }, ssh.env);
      tunnel.start();
      const { read } = await running(tunnel, 1);
      for (const _ of [1, 2, 3]) expect((await read()).kind).toBe("read");
      expect(lookout.connections()).toBe(1);
      tunnel.connected(1);
      await lookout.close();
      expect((await ended(tunnel, 1)).end).toMatchObject({ connected: true, code: 0, said: null });
    },
    STAND_IN_TIMEOUT_MS,
  );

  posixTest(
    "an ssh that goes on once its output has ended is ended",
    async () => {
      // A program that answers once, closes its output and goes on.
      const script = `printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\n{}'; exec sleep 600 >&-`;
      const tunnel = tunnelFor(
        { name: "devbox", target: "devbox", port: NOWHERE },
        { [SSH_BIN_ENV]: "/bin/sh" },
        { spawnSsh: (sh, _, env) => spawn(sh, ["-c", script], { env, detached: true }) },
      );
      tunnel.start();
      const { read } = await running(tunnel, 1);
      expect((await read()).kind).toBe("unreadable");
      expect((await ended(tunnel, 1)).end.connected).toBe(false);
    },
    STAND_IN_TIMEOUT_MS,
  );

  posixTest(
    "stop ends ssh with SIGTERM and starts it no more",
    async () => {
      const ssh = await makeStandInSsh(SIGNING_IN);
      const tunnel = tunnelFor({ name: "devbox", target: "devbox", port: NOWHERE }, ssh.env);
      tunnel.start();
      await running(tunnel, 1);
      await vi.waitFor(async () => expect(await ssh.runs()).toHaveLength(1), WAIT);
      const [run] = await ssh.runs();
      expect(isRunning(run?.pid as number)).toBe(true);

      await tunnel.stop();
      expect(tunnel.state()).toEqual({ kind: "off" } satisfies TunnelState);
      expect(isRunning(run?.pid as number)).toBe(false);
      // SIGTERM ended it, not SIGKILL, which it could not have written down.
      expect(await ssh.signals()).toEqual([{ pid: run?.pid, signal: "SIGTERM" }]);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await ssh.runs()).toHaveLength(1);
      expect(tunnel.state().kind).toBe("off");
    },
    STAND_IN_TIMEOUT_MS,
  );

  posixTest(
    "an ssh that SIGTERM does not end is ended with SIGKILL, and a later start runs ssh again",
    async () => {
      const ssh = await makeStandInSsh({ ...SIGNING_IN, STAND_IN_SSH_IGNORE_TERM: "1" });
      const tunnel = tunnelFor({ name: "devbox", target: "devbox", port: NOWHERE }, ssh.env);
      tunnel.start();
      await running(tunnel, 1);
      await vi.waitFor(async () => expect(await ssh.runs()).toHaveLength(1), WAIT);
      const [run] = await ssh.runs();

      const asked = Date.now();
      await tunnel.stop();
      expect(tunnel.state()).toEqual({ kind: "off" } satisfies TunnelState);
      expect(isRunning(run?.pid as number)).toBe(false);
      // It was sent SIGTERM first, and SIGKILL only once the wait was over. A
      // timer can fire a moment early, so the wait is allowed 100 ms less.
      expect(await ssh.signals()).toEqual([{ pid: run?.pid, signal: "SIGTERM" }]);
      expect(Date.now() - asked).toBeGreaterThanOrEqual(STOP_WAIT_MS - 100);

      tunnel.start();
      await running(tunnel, 2);
      await vi.waitFor(async () => expect(await ssh.runs()).toHaveLength(2), WAIT);
    },
    STAND_IN_TIMEOUT_MS,
  );

  posixTest(
    "started again while the last ssh is still ending, it runs ssh once that one has gone",
    async () => {
      const ssh = await makeStandInSsh({ ...SIGNING_IN, STAND_IN_SSH_IGNORE_TERM: "1" });
      const tunnel = tunnelFor({ name: "devbox", target: "devbox", port: NOWHERE }, ssh.env);
      tunnel.start();
      await running(tunnel, 1);
      await vi.waitFor(async () => expect(await ssh.runs()).toHaveLength(1), WAIT);
      const [run] = await ssh.runs();

      const stopping = tunnel.stop();
      tunnel.start();
      await stopping;
      expect(isRunning(run?.pid as number)).toBe(false);
      await running(tunnel, 2);
      await vi.waitFor(async () => expect(await ssh.runs()).toHaveLength(2), WAIT);
    },
    STAND_IN_TIMEOUT_MS,
  );
});
