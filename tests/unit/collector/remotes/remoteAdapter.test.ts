import { describe, expect, test } from "vitest";

import { BASIS, createRemoteAdapter, STILL_CONNECTING_MS } from "@collector/remotes/remoteAdapter";
import type { RemoteReading } from "@collector/remotes/remoteReader";
import type { Remote } from "@collector/remotes/remoteSettings";
import type { TunnelEnd, TunnelState } from "@collector/remotes/tunnel";
import { NOW, REMOTE_VERSION, snapshotThere } from "@tests/fixtures/remote";

const REMOTE: Remote = { name: "devbox", target: "dev@devbox.local", port: 4777 };

const RUNNING: TunnelState = {
  kind: "running",
  run: 1,
  port: 53211,
  since: NOW,
  command: [
    "/usr/bin/ssh",
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
  ],
};

function ended(end: Partial<TunnelEnd>, retryInMs = 5_000): TunnelState {
  return {
    kind: "ended",
    run: 1,
    end: { at: NOW, connected: false, code: 255, said: null, ...end },
    retryAt: NOW + retryInMs,
  };
}

/** A tunnel in whatever state the test sets, and a reading the test sets, through it. */
function setUp(
  reading: RemoteReading = { kind: "read", version: REMOTE_VERSION, snapshot: snapshotThere() },
) {
  let state: TunnelState = RUNNING;
  const connected: number[] = [];
  const reads: number[] = [];
  let next = reading;
  const adapter = createRemoteAdapter({
    remote: REMOTE,
    version: "0.2.3",
    tunnel: { state: () => state, connected: (run) => connected.push(run) },
    read: async (port) => {
      reads.push(port);
      return next;
    },
    now: () => NOW,
    answerWaitMs: 50,
  });
  return {
    adapter,
    connected,
    reads,
    set(to: TunnelState) {
      state = to;
    },
    answer(to: RemoteReading) {
      next = to;
    },
  };
}

describe("a machine's card", () => {
  test("names the machine, and is another machine's source", async () => {
    const { adapter } = setUp();
    expect(adapter.id).toBe("remote:devbox");
    expect(adapter.label).toBe("devbox");
    expect(adapter.lookingIn).toBe("Connecting to devbox over SSH, as dev@devbox.local.");
    const { health } = await adapter.poll();
    expect(health).toMatchObject({ id: "remote:devbox", label: "devbox", machine: "devbox" });
  });

  test("connected: its sessions, the version there, each source there and what each agent can report", async () => {
    const { adapter, connected, reads } = setUp();
    const result = await adapter.poll();
    expect(reads).toEqual([53211]);
    expect(connected).toEqual([1]);
    expect(result.basis).toBe(BASIS);
    expect(result.health.state).toBe("ok");
    expect(result.health.checkedAt).toBe(NOW);
    expect(result.health.detail).toBe(
      "Sessions are read from Agent Lookout 0.2.3 on devbox, through ssh to dev@devbox.local. Jump, Stop, Allow and Deny act on this computer only.",
    );
    expect(result.health.watching).toEqual([
      { label: "Connects to", value: "dev@devbox.local" },
      {
        label: "Command",
        value:
          "/usr/bin/ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ControlMaster=no -o ControlPath=none -L 127.0.0.1:53211:127.0.0.1:4777 -- dev@devbox.local",
      },
      { label: "Asks for", value: "/api/health and /api/sessions" },
      { label: "Read", value: "every 2 seconds" },
      { label: "Agent Lookout there", value: "0.2.3" },
      { label: "Claude Code there", value: "Watching" },
      { label: "Codex there", value: "Not found" },
      { label: "Status files there", value: "Watching" },
    ]);
    expect(result.health.agents?.map((agent) => agent.label)).toEqual([
      "Claude Code",
      "Status files",
    ]);
    expect(result.health).not.toHaveProperty("capabilities");
    expect(result.sessions.map((session) => [session.id, session.machine, session.status])).toEqual(
      [
        ["remote:devbox:claude-code:00000000-0000-4000-8000-0000000000aa", "devbox", "needs-you"],
        ["remote:devbox:status-files:night-shift.json", "devbox", "working"],
      ],
    );
  });

  test("connecting: searching while ssh signs in the first time", async () => {
    const { adapter, connected } = setUp({ kind: "refused" });
    const result = await adapter.poll();
    expect(result.health).toMatchObject({
      state: "searching",
      detail: "Connecting to devbox over SSH, as dev@devbox.local.",
    });
    expect(result.sessions).toEqual([]);
    expect(connected).toEqual([]);
  });

  test("a first connection that takes more than ten seconds is still connecting, said as not connected", async () => {
    let clock = NOW;
    const adapter = createRemoteAdapter({
      remote: REMOTE,
      version: "0.2.3",
      tunnel: { state: () => RUNNING, connected: () => {} },
      read: async () => ({ kind: "refused" }),
      now: () => clock,
      answerWaitMs: 10,
    });
    expect((await adapter.poll()).health.state).toBe("searching");
    clock = NOW + STILL_CONNECTING_MS - 1;
    expect((await adapter.poll()).health.state).toBe("searching");
    clock = NOW + STILL_CONNECTING_MS;
    const still = await adapter.poll();
    expect(still.health).toMatchObject({
      state: "unavailable",
      detail: "Still connecting to devbox over SSH, as dev@devbox.local.",
      advice:
        "ssh has not connected yet. If this goes on, check that ssh dev@devbox.local connects from a terminal on this computer, and that devbox is switched on and reachable.",
    });
    expect(still.sessions).toEqual([]);
  });

  test("before the tunnel has started, it is connecting", async () => {
    const { adapter, set, reads } = setUp();
    set({ kind: "off" });
    expect((await adapter.poll()).health.state).toBe("searching");
    expect(reads).toEqual([]);
  });

  test("ssh not found: says where it looked, and how to give one", async () => {
    const { adapter, set } = setUp();
    set({
      kind: "no-ssh",
      looked:
        "The ssh command was not found on PATH or in /usr/bin, /opt/homebrew/bin, /usr/local/bin",
      retryAt: NOW + 2_000,
    });
    expect((await adapter.poll()).health).toMatchObject({
      state: "unavailable",
      detail:
        "The ssh command was not found on PATH or in /usr/bin, /opt/homebrew/bin, /usr/local/bin, so devbox cannot be reached. Looking again in 2 seconds.",
      advice: "Install OpenSSH, or name the ssh program with AGENT_LOOKOUT_SSH_BIN.",
    });
  });

  test("a named ssh that cannot be run: says to correct the setting, not to install OpenSSH", async () => {
    const { adapter, set } = setUp();
    set({
      kind: "no-ssh",
      looked:
        "AGENT_LOOKOUT_SSH_BIN is set to /opt/missing/ssh, which is not a program this user can run",
      named: true,
      retryAt: NOW + 2_000,
    });
    expect((await adapter.poll()).health).toMatchObject({
      state: "unavailable",
      advice: "Correct AGENT_LOOKOUT_SSH_BIN, or unset it to use the ssh on your PATH.",
    });
  });

  test("with what a session asks turned off here, a waiting session there shows its reason alone", async () => {
    const adapter = createRemoteAdapter({
      remote: REMOTE,
      version: "0.2.3",
      tunnel: { state: () => RUNNING, connected: () => {} },
      read: async () => ({ kind: "read", version: REMOTE_VERSION, snapshot: snapshotThere() }),
      now: () => NOW,
      answerWaitMs: 50,
      waitingText: false,
    });
    const [waiting] = (await adapter.poll()).sessions;
    expect(waiting).toMatchObject({ status: "needs-you", waitingReason: "permission" });
    expect(waiting).not.toHaveProperty("waitingText");
  });

  test("the other machine said no: what ssh said, and what to check", async () => {
    const { adapter, set } = setUp();
    set(ended({ said: "dev@devbox.local: Permission denied (publickey)." }));
    const result = await adapter.poll();
    expect(result.health).toMatchObject({
      state: "unavailable",
      detail:
        "devbox turned the SSH connection away: dev@devbox.local: Permission denied (publickey). Trying again in 5 seconds.",
      advice:
        "Check that ssh dev@devbox.local connects without asking for anything. Agent Lookout runs ssh with BatchMode, so it never types a password or answers a question.",
    });
    expect(result.sessions).toEqual([]);
  });

  test("ssh could not reach it at all: what ssh said", async () => {
    const { adapter, set } = setUp();
    set(
      ended(
        {
          said: "ssh: Could not resolve hostname devbox.local: nodename nor servname provided, or not known",
        },
        1_000,
      ),
    );
    expect((await adapter.poll()).health.detail).toBe(
      "ssh could not connect to dev@devbox.local: ssh: Could not resolve hostname devbox.local: nodename nor servname provided, or not known. Trying again in 1 second.",
    );
    set(ended({ said: null, code: 1 }));
    expect((await adapter.poll()).health.detail).toBe(
      "ssh could not connect to dev@devbox.local, and ended with code 1. Trying again in 5 seconds.",
    );
  });

  test("the tunnel dropped: says so, then keeps saying so while it connects again, until it answers", async () => {
    const { adapter, set, answer } = setUp();
    expect((await adapter.poll()).health.state).toBe("ok");

    set(
      ended({ connected: true, said: "Connection to devbox.local closed by remote host." }, 1_000),
    );
    const dropped = await adapter.poll();
    expect(dropped.health).toMatchObject({
      state: "unavailable",
      detail:
        "The SSH connection to devbox dropped: Connection to devbox.local closed by remote host. Trying again in 1 second.",
    });
    expect(dropped.sessions).toEqual([]);
    // What each agent there can report is still what was last read.
    expect(dropped.health.agents).toHaveLength(2);

    set({ ...RUNNING, run: 2, port: 53300 } as TunnelState);
    answer({ kind: "refused" });
    expect((await adapter.poll()).health).toMatchObject({
      state: "unavailable",
      detail:
        "The SSH connection to devbox dropped: Connection to devbox.local closed by remote host. Connecting again.",
    });

    answer({ kind: "read", version: REMOTE_VERSION, snapshot: snapshotThere() });
    expect((await adapter.poll()).health.state).toBe("ok");
  });

  test("no Agent Lookout answering there: says to start it there", async () => {
    const { adapter, connected } = setUp({ kind: "closed" });
    expect((await adapter.poll()).health).toMatchObject({
      state: "unavailable",
      detail: "ssh is connected to devbox, but no Agent Lookout answers on its port 4777.",
      advice:
        "Start it there with npx agent-lookout, and leave it running. If it listens on another port, give it as devbox=dev@devbox.local:<port>.",
    });
    // ssh had signed in, so the run counts as connected.
    expect(connected).toEqual([1]);
  });

  test("something else answers there: it is not read as Agent Lookout", async () => {
    const { adapter } = setUp({ kind: "unreadable", why: "answered /api/health with status 404" });
    expect((await adapter.poll()).health).toMatchObject({
      state: "unavailable",
      detail:
        "What listens on port 4777 of devbox answered /api/health with status 404, so it is not read as Agent Lookout.",
    });
  });

  test("its version: a list of sessions this version cannot read says which versions", async () => {
    const { adapter } = setUp({ kind: "read", version: "9.0.0", snapshot: { sessions: "none" } });
    const result = await adapter.poll();
    expect(result.health).toMatchObject({
      state: "unavailable",
      detail:
        "devbox runs Agent Lookout 9.0.0, and this computer's, 0.2.3, cannot read its list of sessions.",
      advice: "Run the same version of Agent Lookout on both machines.",
    });
    expect(result.health.watching).toContainEqual({ label: "Agent Lookout there", value: "9.0.0" });
  });

  test("no answer in time: says how long it waited", async () => {
    const { adapter } = setUp({ kind: "timeout" });
    expect((await adapter.poll()).health).toMatchObject({
      state: "unavailable",
      detail: "devbox did not answer within 6 seconds.",
    });
  });

  test("a reading slower than the wait is used by the next poll, and no second one is started meanwhile", async () => {
    let release: (reading: RemoteReading) => void = () => {};
    const reads: number[] = [];
    const adapter = createRemoteAdapter({
      remote: REMOTE,
      version: "0.2.3",
      tunnel: { state: () => RUNNING, connected: () => {} },
      read: (port) => {
        reads.push(port);
        return new Promise((resolve) => (release = resolve));
      },
      now: () => NOW,
      answerWaitMs: 10,
    });
    expect((await adapter.poll()).health.state).toBe("searching");
    expect((await adapter.poll()).health.state).toBe("searching");
    expect(reads).toHaveLength(1);
    release({ kind: "read", version: REMOTE_VERSION, snapshot: snapshotThere() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await adapter.poll()).health.state).toBe("ok");
  });
});
