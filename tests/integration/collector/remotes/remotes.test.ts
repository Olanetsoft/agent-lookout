import { describe, expect, onTestFinished, test, vi } from "vitest";

import { createRemotes, REMOTES_SETTING_SOURCE_ID } from "@collector/remotes/remotes";
import { REMOTES_ENV } from "@collector/remotes/remoteSettings";
import { snapshotThere } from "@tests/fixtures/remote";
import { isRunning, makeStandInSsh, startStandInLookout } from "@tests/support/remotes/standIns";

const WAIT = { timeout: 8_000, interval: 50 };

describe("createRemotes", () => {
  test("with no machine named, there is nothing to poll and no ssh is looked for", async () => {
    const ssh = await makeStandInSsh();
    const remotes = createRemotes({ env: ssh.env, version: "0.2.3" });
    expect(remotes.remotes).toEqual([]);
    expect(remotes.adapters).toEqual([]);
    expect(remotes.problem).toBeNull();
    remotes.start();
    await remotes.stop();
    expect(await ssh.runs()).toEqual([]);
  });

  test("a setting that cannot be read starts nothing, and says why", async () => {
    const ssh = await makeStandInSsh();
    const remotes = createRemotes({
      env: { ...ssh.env, [REMOTES_ENV]: "devbox=-oProxyCommand=sh" },
      version: "0.2.3",
    });
    expect(remotes.remotes).toEqual([]);
    expect(remotes.problem).toContain(
      "gives devbox a target that Agent Lookout does not hand to ssh",
    );
    remotes.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await ssh.runs()).toEqual([]);

    // One card says why, in Sources, for someone who never sees the console.
    expect(remotes.adapters.map((adapter) => [adapter.id, adapter.label])).toEqual([
      [REMOTES_SETTING_SOURCE_ID, "Other machines"],
    ]);
    const [card] = remotes.adapters;
    const result = await card?.poll();
    expect(result?.sessions).toEqual([]);
    expect(result?.health).toMatchObject({
      id: "remote:",
      label: "Other machines",
      state: "not-set-up",
      detail: remotes.problem,
      advice:
        "Correct AGENT_LOOKOUT_REMOTES, or unset it, and start Agent Lookout again. Until then no other machine is read and ssh is never run.",
    });
    expect(result?.health).not.toHaveProperty("machine");
    expect(result?.health.detail).not.toContain("ProxyCommand");
  });

  test("with what a session asks turned off here, a waiting session there shows its reason alone", async () => {
    const devbox = await startStandInLookout(snapshotThere());
    const ssh = await makeStandInSsh();
    const remotes = createRemotes({
      env: {
        ...ssh.env,
        [REMOTES_ENV]: `devbox=dev@devbox.local:${devbox.port}`,
        AGENT_LOOKOUT_WAITING_TEXT: "off",
      },
      version: "0.2.3",
    });
    onTestFinished(() => remotes.stop());
    remotes.start();
    const [adapter] = remotes.adapters;
    const result = await vi.waitFor(async () => {
      const polled = await adapter?.poll();
      if (polled?.health.state !== "ok") throw new Error(polled?.health.state);
      return polled;
    }, WAIT);
    const waiting = result.sessions.find((session) => session.status === "needs-you");
    expect(waiting?.waitingReason).toBe("permission");
    expect(waiting).not.toHaveProperty("waitingText");
  });

  test("a source for each machine, connected through its own ssh, and every ssh ended on stop", async () => {
    const devbox = await startStandInLookout(snapshotThere());
    const gpu = await startStandInLookout(snapshotThere([]));
    const ssh = await makeStandInSsh();
    const remotes = createRemotes({
      env: {
        ...ssh.env,
        [REMOTES_ENV]: `devbox=dev@devbox.local:${devbox.port},gpu=gpu-vm:${gpu.port}`,
      },
      version: "0.2.3",
    });
    onTestFinished(() => remotes.stop());
    expect(remotes.adapters.map((adapter) => [adapter.id, adapter.label])).toEqual([
      ["remote:devbox", "devbox"],
      ["remote:gpu", "gpu"],
    ]);

    remotes.start();
    const [first, second] = await vi.waitFor(async () => {
      const results = await Promise.all(remotes.adapters.map((adapter) => adapter.poll()));
      for (const result of results)
        if (result.health.state !== "ok") throw new Error(result.health.state);
      return results;
    }, WAIT);
    expect(first?.sessions.map((session) => session.machine)).toEqual(["devbox", "devbox"]);
    expect(second?.sessions).toEqual([]);

    const runs = await ssh.runs();
    // Each its own, started side by side, the target last after --.
    expect(runs.map((run) => run.args.slice(-2).join(" ")).sort()).toEqual([
      "-- dev@devbox.local",
      "-- gpu-vm",
    ]);
    await remotes.stop();
    for (const run of runs) expect(isRunning(run.pid)).toBe(false);
  });
});
