import { createServer } from "node:net";

import { describe, expect, onTestFinished, test, vi } from "vitest";

import { readRemote } from "@collector/remotes/remoteReader";
import type { Remote } from "@collector/remotes/remoteSettings";
import { SSH_BIN_ENV, sshArguments } from "@collector/remotes/sshProgram";
import {
  createTunnel,
  type Tunnel,
  type TunnelOptions,
  type TunnelState,
} from "@collector/remotes/tunnel";
import { snapshotThere } from "@tests/fixtures/remote";
import { isRunning, makeStandInSsh, startStandInLookout } from "@tests/support/remotes/standIns";

// The stand-in ssh is a POSIX sh script, and a drop is made with SIGHUP and an
// end with SIGTERM, POSIX signals: Windows has none of them.
const posixTest = test.skipIf(process.platform === "win32");

const WAIT = { timeout: 8_000, interval: 20 };

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
    "runs the named ssh with exactly its arguments, and forwards to Agent Lookout there",
    async () => {
      const lookout = await startStandInLookout(snapshotThere());
      const ssh = await makeStandInSsh();
      const remote: Remote = { name: "devbox", target: "dev@devbox.local", port: lookout.port };
      const tunnel = tunnelFor(remote, ssh.env);
      expect(tunnel.state()).toEqual({ kind: "off" });
      tunnel.start();

      const state = await running(tunnel, 1);
      const args = sshArguments({
        localPort: state.port,
        remotePort: lookout.port,
        target: "dev@devbox.local",
      });
      expect(state.command).toEqual([ssh.bin, ...args]);
      await vi.waitFor(async () => expect(await ssh.runs()).toHaveLength(1), WAIT);
      expect((await ssh.runs())[0]?.args).toEqual([
        "-N",
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-L",
        `127.0.0.1:${state.port}:127.0.0.1:${lookout.port}`,
        "--",
        "dev@devbox.local",
      ]);

      const reading = await vi.waitFor(async () => {
        const read = await readRemote(state.port);
        if (read.kind !== "read") throw new Error(read.kind);
        return read;
      }, WAIT);
      expect(reading.version).toBe("0.2.3");
      // Only the two routes, on the loopback's own name, with no Origin and nothing about the page.
      expect(lookout.requests.slice(-2)).toEqual([
        {
          method: "GET",
          path: "/api/health",
          host: `127.0.0.1:${state.port}`,
          origin: undefined,
          notifications: undefined,
        },
        {
          method: "GET",
          path: "/api/sessions",
          host: `127.0.0.1:${state.port}`,
          origin: undefined,
          notifications: undefined,
        },
      ]);
    },
  );

  posixTest("finds ssh on PATH when no program is named", async () => {
    const ssh = await makeStandInSsh();
    const env: NodeJS.ProcessEnv = { ...ssh.env, PATH: ssh.dir };
    delete env[SSH_BIN_ENV];
    const tunnel = tunnelFor({ name: "devbox", target: "devbox", port: 4777 }, env);
    tunnel.start();
    expect((await running(tunnel)).command[0]).toBe(ssh.bin);
  });

  test("with no ssh to run, says where it looked, and looks again", async () => {
    const tunnel = tunnelFor(
      { name: "devbox", target: "devbox", port: 4777 },
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
    "a drop is told apart, and ssh is started again on a new port after the shortest wait",
    async () => {
      const lookout = await startStandInLookout(snapshotThere());
      const ssh = await makeStandInSsh();
      const tunnel = tunnelFor(
        { name: "devbox", target: "dev@devbox.local", port: lookout.port },
        ssh.env,
      );
      tunnel.start();
      const first = await running(tunnel, 1);
      await vi.waitFor(async () => expect((await readRemote(first.port)).kind).toBe("read"), WAIT);
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

      const second = await running(tunnel, 2);
      await vi.waitFor(async () => expect(await ssh.runs()).toHaveLength(2), WAIT);
      await vi.waitFor(async () => expect((await readRemote(second.port)).kind).toBe("read"), WAIT);
    },
  );

  posixTest("a machine that turns ssh away is tried again after waits that grow", async () => {
    const ssh = await makeStandInSsh();
    const tunnel = tunnelFor({ name: "devbox", target: "dev@refuse.example", port: 4777 }, ssh.env);
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
  });

  posixTest("a port taken on this computer ends ssh, which says why", async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>((resolve) => taken.close(() => resolve())));
    const port = (taken.address() as { port: number }).port;
    const ssh = await makeStandInSsh();
    const tunnel = tunnelFor({ name: "devbox", target: "devbox", port: 4777 }, ssh.env, {
      freePort: async () => port,
    });
    tunnel.start();
    expect((await ended(tunnel, 1)).end.said).toBe("Could not request local forwarding.");
  });

  posixTest("stop ends ssh with SIGTERM and starts it no more", async () => {
    const ssh = await makeStandInSsh();
    const tunnel = tunnelFor({ name: "devbox", target: "devbox", port: 4777 }, ssh.env);
    tunnel.start();
    await running(tunnel, 1);
    await vi.waitFor(async () => expect(await ssh.runs()).toHaveLength(1), WAIT);
    const [run] = await ssh.runs();
    expect(isRunning(run?.pid as number)).toBe(true);

    await tunnel.stop();
    expect(tunnel.state()).toEqual({ kind: "off" } satisfies TunnelState);
    expect(isRunning(run?.pid as number)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await ssh.runs()).toHaveLength(1);
    expect(tunnel.state().kind).toBe("off");
  });

  posixTest(
    "an ssh that SIGTERM does not end is ended with SIGKILL, and a later start runs ssh again",
    async () => {
      const ssh = await makeStandInSsh({ STAND_IN_SSH_IGNORE_TERM: "1" });
      const tunnel = tunnelFor({ name: "devbox", target: "devbox", port: 4777 }, ssh.env);
      tunnel.start();
      await running(tunnel, 1);
      await vi.waitFor(async () => expect(await ssh.runs()).toHaveLength(1), WAIT);
      const [run] = await ssh.runs();

      await tunnel.stop();
      expect(tunnel.state()).toEqual({ kind: "off" } satisfies TunnelState);
      expect(isRunning(run?.pid as number)).toBe(false);

      tunnel.start();
      await running(tunnel, 2);
      await vi.waitFor(async () => expect(await ssh.runs()).toHaveLength(2), WAIT);
    },
    15_000,
  );

  posixTest(
    "started again while the last ssh is still ending, it runs ssh once that one has gone",
    async () => {
      const ssh = await makeStandInSsh({ STAND_IN_SSH_IGNORE_TERM: "1" });
      const tunnel = tunnelFor({ name: "devbox", target: "devbox", port: 4777 }, ssh.env);
      tunnel.start();
      await running(tunnel, 1);
      await vi.waitFor(async () => expect(await ssh.runs()).toHaveLength(1), WAIT);
      const [run] = await ssh.runs();

      const stopping = tunnel.stop();
      tunnel.start();
      await stopping;
      expect(isRunning(run?.pid as number)).toBe(false);
      const second = await running(tunnel, 2);
      await vi.waitFor(async () => expect(await ssh.runs()).toHaveLength(2), WAIT);
      expect(second.port).toBeGreaterThan(0);
    },
    15_000,
  );
});
