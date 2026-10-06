import { describe, expect, test } from "vitest";

import { findSsh, SSH_BIN_ENV, SSH_LOCATIONS, sshArguments } from "@collector/remotes/sshProgram";

describe("sshArguments", () => {
  test("forwards a free port on this machine's loopback to Agent Lookout's there, and asks nothing", () => {
    expect(
      sshArguments({ localPort: 53211, remotePort: 4777, target: "dev@devbox.local" }),
    ).toEqual([
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
      "127.0.0.1:53211:127.0.0.1:4777",
      "--",
      "dev@devbox.local",
    ]);
  });

  test("every run is a connection of its own, never one shared through the person's ssh config", () => {
    const args = sshArguments({ localPort: 1, remotePort: 4777, target: "devbox" });
    const forward = args.indexOf("-L");
    // Given before the forward, and on the command line, so they come before ~/.ssh/config.
    expect(args.slice(0, forward)).toEqual(
      expect.arrayContaining(["ControlMaster=no", "ControlPath=none"]),
    );
    expect(args[args.indexOf("ControlMaster=no") - 1]).toBe("-o");
    expect(args[args.indexOf("ControlPath=none") - 1]).toBe("-o");
  });

  test("the target comes last, after --, as one argument", () => {
    const args = sshArguments({ localPort: 1, remotePort: 4800, target: "gpu-vm" });
    expect(args.slice(-2)).toEqual(["--", "gpu-vm"]);
    expect(args).toContain("127.0.0.1:1:127.0.0.1:4800");
  });
});

describe("findSsh", () => {
  const runnable = (paths: string[]) => async (candidate: string) => paths.includes(candidate);

  test("takes the first ssh on PATH", async () => {
    const env = { PATH: "/opt/tools/bin:/usr/bin" };
    expect(await findSsh(env, runnable(["/opt/tools/bin/ssh", "/usr/bin/ssh"]))).toEqual({
      found: true,
      path: "/opt/tools/bin/ssh",
    });
  });

  test("looks in the fixed places when PATH has none, as for an app started from the Dock", async () => {
    expect(SSH_LOCATIONS[0]).toBe("/usr/bin/ssh");
    expect(await findSsh({ PATH: "/nowhere" }, runnable(["/opt/homebrew/bin/ssh"]))).toEqual({
      found: true,
      path: "/opt/homebrew/bin/ssh",
    });
  });

  test("a relative entry on PATH is never searched", async () => {
    expect(await findSsh({ PATH: "bin:." }, runnable(["bin/ssh", "ssh"]))).toEqual({
      found: false,
      looked:
        "The ssh command was not found on PATH or in /usr/bin, /opt/homebrew/bin, /usr/local/bin",
    });
  });

  test("the program the variable names is the only one looked at", async () => {
    const env = { [SSH_BIN_ENV]: "/opt/stand-in/ssh", PATH: "/usr/bin" };
    expect(await findSsh(env, runnable(["/opt/stand-in/ssh", "/usr/bin/ssh"]))).toEqual({
      found: true,
      path: "/opt/stand-in/ssh",
    });
    expect(await findSsh(env, runnable(["/usr/bin/ssh"]))).toEqual({
      found: false,
      looked: `${SSH_BIN_ENV} is set to /opt/stand-in/ssh, which is not a program this user can run`,
      named: true,
    });
  });
});
