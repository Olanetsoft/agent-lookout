import { describe, expect, test } from "vitest";

import { OPENCODE_CAPABILITIES } from "@collector/adapters/opencode/index";
import { createEventStore } from "@collector/eventStore";
import { createHistoryStore } from "@collector/historyStore";
import { createPoller, POLL_DEADLINE_MS, POLL_INTERVAL_MS } from "@collector/poller";
import {
  BASIS,
  createRemoteAdapter,
  READING_KEPT_MS,
  STILL_CONNECTING_MS,
} from "@collector/remotes/remoteAdapter";
import type { RemoteReading } from "@collector/remotes/remoteReader";
import type { Remote } from "@collector/remotes/remoteSettings";
import { sshArguments } from "@collector/remotes/sshProgram";
import type { TunnelEnd, TunnelState } from "@collector/remotes/tunnel";
import { EMPTY_CHANGE_MEMORY, sessionChanges } from "@core/notices/sessionChanges";
import type {
  SessionEvent,
  SessionsSnapshot,
  SessionStatus,
  SourceHealth,
  SourceId,
} from "@core/sessions/session";
import {
  CRUSH_PROJECTS_THERE,
  crushSessionThere,
  everySourceThere,
  NOW,
  REMOTE_VERSION,
  snapshotThere,
  workingThere,
} from "@tests/fixtures/remote";

const REMOTE: Remote = { name: "devbox", target: "dev@devbox.local", port: 4777 };

const RUNNING: TunnelState = {
  kind: "running",
  run: 1,
  read: async () => ({ kind: "closed" }),
  since: NOW,
  command: ["/usr/bin/ssh", ...sshArguments(REMOTE)],
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
  let reads = 0;
  let next = reading;
  const adapter = createRemoteAdapter({
    remote: REMOTE,
    version: "0.2.3",
    tunnel: { state: () => state, connected: (run) => connected.push(run) },
    read: async () => {
      reads += 1;
      return next;
    },
    now: () => NOW,
    answerWaitMs: 50,
  });
  return {
    adapter,
    connected,
    reads: () => reads,
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
    expect(reads()).toBe(1);
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
          "/usr/bin/ssh -W 127.0.0.1:4777 -o BatchMode=yes -o ClearAllForwardings=yes -o PermitLocalCommand=no -o LogLevel=INFO -o ServerAliveInterval=15 -o ControlMaster=no -o ControlPath=none -- dev@devbox.local",
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
    const { adapter, connected } = setUp({ kind: "closed" });
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
      read: () => new Promise(() => {}),
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
        "Nothing has come back through ssh yet. If this goes on, check that ssh dev@devbox.local connects from a terminal on this computer, and that devbox is switched on and reachable.",
    });
    expect(still.sessions).toEqual([]);
  });

  test("the ten seconds are counted afresh after the clock is set back", async () => {
    let clock = NOW;
    const adapter = createRemoteAdapter({
      remote: REMOTE,
      version: "0.2.3",
      tunnel: { state: () => RUNNING, connected: () => {} },
      read: () => new Promise(() => {}),
      now: () => clock,
      answerWaitMs: 10,
    });
    expect((await adapter.poll()).health.state).toBe("searching");
    clock = NOW - 60 * 60_000;
    expect((await adapter.poll()).health.state).toBe("searching");
    clock += STILL_CONNECTING_MS;
    expect((await adapter.poll()).health.state).toBe("unavailable");
  });

  test("before the tunnel has started, it is connecting", async () => {
    const { adapter, set, reads } = setUp();
    set({ kind: "off" });
    expect((await adapter.poll()).health.state).toBe("searching");
    expect(reads()).toBe(0);
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
    set(ended({ said: "Nothing came back within 180 seconds.", code: null }, 1_000));
    expect((await adapter.poll()).health.detail).toBe(
      "ssh could not connect to dev@devbox.local: Nothing came back within 180 seconds. Trying again in 1 second.",
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

    set({ ...RUNNING, run: 2 } as TunnelState);
    answer({ kind: "closed" });
    expect((await adapter.poll()).health).toMatchObject({
      state: "unavailable",
      detail:
        "The SSH connection to devbox dropped: Connection to devbox.local closed by remote host. Connecting again.",
    });

    answer({ kind: "read", version: REMOTE_VERSION, snapshot: snapshotThere() });
    expect((await adapter.poll()).health.state).toBe("ok");
  });

  test.each([
    [
      "nothing listens there",
      { said: "channel 0: open failed: connect failed: Connection refused" },
    ],
    ["nothing listens there, and ssh says little", { said: "stdio forwarding failed" }],
    ["what listens there closed the connection", { code: 0 }],
    [
      "what listens there never answered",
      { code: 0, said: "Nothing came back within 180 seconds." },
    ],
  ])("no Agent Lookout answering there, as %s: says to start it there", async (_, end) => {
    const { adapter, set } = setUp();
    set(ended(end));
    expect((await adapter.poll()).health).toMatchObject({
      state: "unavailable",
      detail:
        "ssh is connected to devbox, but no Agent Lookout answers on its port 4777. Trying again in 5 seconds.",
      advice:
        "Start it there with npx agent-lookout, and leave it running. If it listens on another port, give it as devbox=dev@devbox.local:<port>.",
    });
  });

  test("its connection closed, as when this computer slept: says so, and that none answers there only once a new run finds none", async () => {
    const { adapter, set, answer } = setUp();
    await adapter.poll();
    set(ended({ code: 0, connected: true }, 1_000));
    expect((await adapter.poll()).health).toMatchObject({
      state: "unavailable",
      detail: "The connection to Agent Lookout on devbox closed. Trying again in 1 second.",
      advice:
        "It is made again on its own. It can close when Agent Lookout there stops or this computer sleeps.",
    });
    set({ ...RUNNING, run: 2 } as TunnelState);
    answer({ kind: "closed" });
    expect((await adapter.poll()).health.detail).toBe(
      "The connection to Agent Lookout on devbox closed. Connecting again.",
    );
    const said = "channel 0: open failed: connect failed: Connection refused";
    set({ ...ended({ said }), run: 2 } as TunnelState);
    expect((await adapter.poll()).health.detail).toContain("no Agent Lookout answers on its port");
  });

  test("an ssh server that lets ssh reach no port there: says so, and what to check", async () => {
    const { adapter, set } = setUp();
    set(ended({ said: "channel 0: open failed: administratively prohibited: open failed" }));
    expect((await adapter.poll()).health).toMatchObject({
      state: "unavailable",
      detail:
        "The ssh server on devbox did not let ssh reach its port 4777: channel 0: open failed: administratively prohibited: open failed. Trying again in 5 seconds.",
      advice:
        "Check that it allows TCP forwarding: AllowTcpForwarding and PermitOpen in its sshd_config.",
    });
  });

  test("something else answers there: it is not read as Agent Lookout, nor once that has ended ssh", async () => {
    const { adapter, set, connected } = setUp({
      kind: "unreadable",
      why: "answered /api/health with status 404",
    });
    const detail =
      "What listens on port 4777 of devbox answered /api/health with status 404, so it is not read as Agent Lookout.";
    expect((await adapter.poll()).health).toMatchObject({ state: "unavailable", detail });
    // Its wait before ssh is started again goes on growing.
    expect(connected).toEqual([]);
    set(ended({ code: 0 }));
    for (const _ of [1, 2]) {
      const { health } = await adapter.poll();
      expect(health.detail).toBe(`${detail} Trying again in 5 seconds.`);
    }
    set(RUNNING);
    set({ ...ended({ said: "Connection closed by devbox.local." }), run: 2 } as TunnelState);
    expect((await adapter.poll()).health.detail).toContain("turned the SSH connection away");
  });

  test("a connection that has gone leaves the last reading until the tunnel says why", async () => {
    const { adapter, set, answer, connected } = setUp();
    await adapter.poll();
    answer({ kind: "closed" });
    expect((await adapter.poll()).health).toMatchObject({ state: "ok", checkedAt: NOW });
    expect(connected).toEqual([1]);
    set(ended({ connected: true, said: "Timeout, server devbox.local not responding." }));
    expect((await adapter.poll()).health.detail).toContain(
      "The SSH connection to devbox dropped: Timeout, server devbox.local not responding.",
    );
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
    const { adapter, connected } = setUp({ kind: "timeout" });
    expect((await adapter.poll()).health).toMatchObject({
      state: "unavailable",
      detail: "devbox did not answer within 6 seconds.",
      advice: "It keeps trying, and after a minute with no answer it connects again.",
    });
    expect(connected).toEqual([]);
  });

  test("a reading slower than the wait is used by the next poll, and no second one is started meanwhile", async () => {
    let release: (reading: RemoteReading) => void = () => {};
    let reads = 0;
    const adapter = createRemoteAdapter({
      remote: REMOTE,
      version: "0.2.3",
      tunnel: { state: () => RUNNING, connected: () => {} },
      read: () => {
        reads += 1;
        return new Promise((resolve) => (release = resolve));
      },
      now: () => NOW,
      answerWaitMs: 10,
    });
    expect((await adapter.poll()).health.state).toBe("searching");
    expect((await adapter.poll()).health.state).toBe("searching");
    expect(reads).toBe(1);
    release({ kind: "read", version: REMOTE_VERSION, snapshot: snapshotThere() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await adapter.poll()).health.state).toBe("ok");
  });
});

describe("the last reading, while the next one is under way", () => {
  /** A machine read once, at NOW, whose next answer does not come until it is released. */
  async function readOnce() {
    let clock = NOW;
    let release: (reading: RemoteReading) => void = () => {};
    let held = false;
    const reading: RemoteReading = {
      kind: "read",
      version: REMOTE_VERSION,
      snapshot: snapshotThere(),
    };
    const adapter = createRemoteAdapter({
      remote: REMOTE,
      version: "0.2.3",
      tunnel: { state: () => RUNNING, connected: () => {} },
      read: () => (held ? new Promise((resolve) => (release = resolve)) : Promise.resolve(reading)),
      now: () => clock,
      answerWaitMs: 10,
    });
    expect((await adapter.poll()).health.state).toBe("ok");
    held = true;
    return {
      /** Polls with the clock this long after that reading. */
      pollAt(ms: number) {
        clock = NOW + ms;
        return adapter.poll();
      },
      async answer() {
        release(reading);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    };
  }

  test("is used for as long as one can take, and at the poll after one held up to its deadline", async () => {
    const machine = await readOnce();
    const slowPoll = POLL_DEADLINE_MS + POLL_INTERVAL_MS + 2_000;
    for (const ms of [2_000, 14_000, slowPoll, READING_KEPT_MS]) {
      const { health, sessions } = await machine.pollAt(ms);
      expect(health).toMatchObject({ state: "ok", checkedAt: NOW });
      expect(sessions).toHaveLength(2);
    }
  });

  test.each([
    ["older, as after this computer slept", 11 * 60 * 60_000],
    ["just older", READING_KEPT_MS + 1],
    ["half a minute old", 30_000],
    ["dated later than now, by a clock set back", -1],
  ])("is not used once it is %s: the machine is not connected until the next", async (_, ms) => {
    const machine = await readOnce();
    const woken = await machine.pollAt(ms);
    expect(woken.health).toMatchObject({
      state: "unavailable",
      detail:
        "The last answer from devbox is not recent enough to show, as after this computer slept. Connecting again.",
      checkedAt: NOW + ms,
    });
    expect(woken.sessions).toEqual([]);
    expect((await machine.pollAt(ms + 2_000)).health).toEqual({
      ...woken.health,
      checkedAt: NOW + ms + 2_000,
    });
    await machine.answer();
    expect((await machine.pollAt(ms + 2_500)).health).toMatchObject({
      state: "ok",
      checkedAt: NOW + ms + 2_000,
    });
  });

  test("so a wait answered while this computer slept is not told on waking, and one still open is", async () => {
    for (const answered of [true, false]) {
      let clock = NOW;
      let snapshot = snapshotThere([]);
      let held = false;
      let release: () => void = () => {};
      const adapter = createRemoteAdapter({
        remote: REMOTE,
        version: "0.2.3",
        tunnel: { state: () => RUNNING, connected: () => {} },
        read: async () => {
          if (held) await new Promise<void>((resolve) => (release = resolve));
          return { kind: "read", version: REMOTE_VERSION, snapshot };
        },
        now: () => clock,
        answerWaitMs: 10,
      });
      const poller = createPoller({
        adapters: [adapter],
        events: createEventStore(),
        history: createHistoryStore(),
        now: () => clock,
      });
      const told = async () => (await poller.pollOnce()).sessions.map((session) => session.status);
      await told();
      snapshot = snapshotThere();
      clock += 2_000;
      expect(await told()).toEqual(["needs-you", "working"]);

      held = true;
      clock += 8 * 60 * 60_000;
      if (answered) snapshot = snapshotThere([]);
      expect(await told()).toEqual([]);
      release();
      held = false;
      clock += 2_000;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(await told()).toEqual(answered ? [] : ["needs-you", "working"]);
    }
  });
});

describe("the way a machine is read", () => {
  /** One of the other machine's sources, read the way it says. */
  const sourceThere = (id: string, label: string, basis: string): SourceHealth => ({
    id: id as SourceId,
    label,
    state: "ok",
    basis,
    capabilities: OPENCODE_CAPABILITIES,
    checkedAt: NOW,
  });

  /** One of the other machine's sessions, of that source there. */
  const sessionThere = (source: string, id: string, status: SessionStatus) =>
    workingThere({ id: `${source}:${id}`, source: source as SourceId, name: id, status });

  /** What the other machine sends: OpenCode there, read the way it says, with these sessions. */
  function opencodeThere(basis: string, statuses: [string, SessionStatus][]): SessionsSnapshot {
    return {
      generatedAt: NOW,
      sources: [sourceThere("opencode", "OpenCode", basis)],
      sessions: statuses.map(([id, status]) => sessionThere("opencode", id, status)),
    };
  }

  /**
   * The real poller and the real comparison that notices are made from, on a
   * machine that sends what `there` holds, and what each poll told and logged.
   */
  function watched(first: SessionsSnapshot) {
    let clock = NOW;
    let snapshot = first;
    const adapter = createRemoteAdapter({
      remote: REMOTE,
      version: "0.2.3",
      tunnel: { state: () => RUNNING, connected: () => {} },
      read: async () => ({ kind: "read", version: REMOTE_VERSION, snapshot }),
      now: () => clock,
      answerWaitMs: 50,
    });
    const events = createEventStore();
    const poller = createPoller({
      adapters: [adapter],
      events,
      history: createHistoryStore(),
      now: () => clock,
    });
    let memory = EMPTY_CHANGE_MEMORY;
    const notices: string[] = [];
    return {
      notices,
      /** The status changes the event log holds, as `<id> <from>-><to>`. */
      changes: () =>
        events
          .list()
          .map((event) =>
            event.kind === "status-changed"
              ? `${event.sessionId} ${event.from}->${event.to}`
              : event.kind,
          ),
      async poll(next: SessionsSnapshot = snapshot) {
        snapshot = next;
        clock += 2_000;
        const changes = sessionChanges(memory, await poller.pollOnce());
        memory = changes.memory;
        notices.push(...changes.changes.map((change) => `${change.event} ${change.session.id}`));
      },
    };
  }

  test("is api, and its card gives the way that machine read each of its sources, by the start of their sessions' ids here", async () => {
    const { adapter, answer } = setUp();
    const first = await adapter.poll();
    expect(first.basis).toBe(BASIS);
    expect(first.health).not.toHaveProperty("parts");
    answer({
      kind: "read",
      version: REMOTE_VERSION,
      snapshot: opencodeThere("database-closed", [["ses_a", "finished"]]),
    });
    const closed = await adapter.poll();
    expect(closed.basis).toBe(BASIS);
    expect(closed.health.parts).toEqual({ "remote:devbox:opencode:": "database-closed" });
  });

  test("so OpenCode quitting there sends no notice for each of its sessions, as it sends none there", async () => {
    const machine = watched(
      opencodeThere("database", [
        ["ses_a", "idle"],
        ["ses_b", "working"],
      ]),
    );
    await machine.poll();
    await machine.poll();
    // OpenCode quits there, which finishes every session at once, then opens again.
    await machine.poll(
      opencodeThere("database-closed", [
        ["ses_a", "finished"],
        ["ses_b", "finished"],
      ]),
    );
    await machine.poll(
      opencodeThere("database", [
        ["ses_a", "idle"],
        ["ses_b", "working"],
      ]),
    );
    // Nothing finished, and nothing started again.
    expect(machine.notices).toEqual([]);
    expect(machine.changes()).toEqual([]);
  });

  test("each source there is compared apart, so one that switches there does not hide another's finish", async () => {
    /** Codex and OpenCode there, each read the way it says. */
    const there = (
      codex: SessionStatus,
      opencode: string,
      ses: SessionStatus,
    ): SessionsSnapshot => ({
      generatedAt: NOW,
      sources: [
        sourceThere("codex", "Codex", "files"),
        sourceThere("opencode", "OpenCode", opencode),
      ],
      sessions: [sessionThere("codex", "job", codex), sessionThere("opencode", "ses_a", ses)],
    });
    const machine = watched(there("working", "database", "idle"));
    await machine.poll();
    await machine.poll();
    // A Codex job there finishes in the same answer as OpenCode quits there.
    await machine.poll(there("finished", "database-closed", "finished"));
    await machine.poll();
    await machine.poll(there("finished", "database", "idle"));
    expect(machine.notices).toEqual(["finished remote:devbox:codex:job"]);
    expect(machine.changes()).toEqual(["remote:devbox:codex:job working->finished"]);
  });

  test("a source there that falls back for one answer does not hide another's failure", async () => {
    const there = (claude: string, codex: SessionStatus): SessionsSnapshot => ({
      generatedAt: NOW,
      sources: [
        sourceThere("claude-code", "Claude Code", claude),
        sourceThere("codex", "Codex", "files"),
      ],
      sessions: [sessionThere("claude-code", "chat", "idle"), sessionThere("codex", "job", codex)],
    });
    const machine = watched(there("registry+feed", "working"));
    await machine.poll();
    await machine.poll();
    // Claude Code there reads its command alone for one answer, while a Codex job fails.
    await machine.poll(there("feed", "failed"));
    await machine.poll(there("registry+feed", "failed"));
    expect(machine.notices).toEqual(["failed remote:devbox:codex:job"]);
    expect(machine.changes()).toEqual(["remote:devbox:codex:job working->failed"]);
  });

  test("a Crush project that fails there, with every source there naming all it can, ends none of its sessions here", async () => {
    const sessions = CRUSH_PROJECTS_THERE.map(crushSessionThere);
    const machine = watched(everySourceThere(CRUSH_PROJECTS_THERE, sessions));
    await machine.poll();
    await machine.poll();
    await machine.poll(everySourceThere(CRUSH_PROJECTS_THERE.slice(1), sessions.slice(1)));
    await machine.poll(everySourceThere(CRUSH_PROJECTS_THERE, sessions));
    expect(machine.notices).toEqual([]);
    expect(machine.changes()).toEqual([]);
  });

  describe("an agent this version does not know there", () => {
    /** An agent there of a newer version, in the state given, with these sessions once it is read. */
    function newerThere(
      source: Partial<SourceHealth>,
      statuses: [string, SessionStatus][],
    ): SessionsSnapshot {
      return {
        generatedAt: NOW,
        sources: [{ ...sourceThere("next-agent", "Next Agent", "files"), ...source }],
        sessions: statuses.map(([id, status]) => sessionThere("next-agent", id, status)),
      };
    }
    const both: [string, SessionStatus][] = [
      ["waiting", "needs-you"],
      ["busy", "working"],
    ];
    const ok = newerThere({}, both);

    test.each(["error", "searching", "unavailable"] as const)(
      "that is %s there for a while sends nothing for its sessions, nor again for a wait",
      async (state) => {
        const machine = watched(ok);
        await machine.poll();
        await machine.poll();
        await machine.poll(newerThere({ state }, []));
        await machine.poll();
        await machine.poll(ok);
        await machine.poll(newerThere({ state }, []));
        await machine.poll(ok);
        expect(machine.notices).toEqual([]);
        expect(machine.changes()).toEqual([]);
      },
    );

    test("tells once it is read what changed meanwhile: a finish, an end, a wait", async () => {
      const machine = watched(ok);
      await machine.poll();
      await machine.poll();
      await machine.poll(newerThere({ state: "error" }, []));
      await machine.poll();
      await machine.poll(
        newerThere({}, [
          ["busy", "finished"],
          ["new", "needs-you"],
        ]),
      );
      expect(machine.notices).toEqual([
        "needs-you remote:devbox:next-agent:new",
        "finished remote:devbox:next-agent:busy",
        "ended remote:devbox:next-agent:waiting",
      ]);
      expect(machine.changes().toSorted()).toEqual([
        "appeared",
        "ended",
        "remote:devbox:next-agent:busy working->finished",
      ]);
    });

    test("that is read in parts ends none of a part it names as not read", async () => {
      const parted = (read: string[]) =>
        newerThere(
          {
            notRead: ["a/", "b/"]
              .filter((part) => !read.includes(part))
              .map((p) => `next-agent:${p}`),
          },
          read.map((part) => [`${part}waiting`, "needs-you"]),
        );
      const machine = watched(parted(["a/", "b/"]));
      await machine.poll();
      await machine.poll();
      await machine.poll(parted(["a/"]));
      await machine.poll(parted(["b/"]));
      await machine.poll(parted(["a/", "b/"]));
      expect(machine.notices).toEqual([]);
      expect(machine.changes()).toEqual([]);
      // Read, and gone.
      await machine.poll(newerThere({}, [["a/waiting", "needs-you"]]));
      expect(machine.notices).toEqual(["ended remote:devbox:next-agent:b/waiting"]);
    });
  });

  test("a way this version does not name for a source there is left out, and that source is compared under api", async () => {
    for (const basis of ["database closed\n", "Database-Closed", "files"]) {
      const odd = opencodeThere(basis, [["ses_a", "idle"]]);
      const { adapter } = setUp({ kind: "read", version: REMOTE_VERSION, snapshot: odd });
      const polled = await adapter.poll();
      expect(polled.basis, basis).toBe(BASIS);
      expect(polled.health, basis).not.toHaveProperty("parts");
    }
  });
});

describe("the first poll after Agent Lookout restarts here", () => {
  const DEFAULT_ID = "hermes-agent:default/20261001_110000_0000a1";
  const CODER_ID = "hermes-agent:coder/20261001_110000_0000b1";
  /** A session of the default profile there that ended while Agent Lookout here was stopped. */
  const GONE_ID = "hermes-agent:default/20261001_110000_0000c1";
  const CODEX_ID = "codex:job";

  /** Hermes Agent there with its default profile read, and Codex there in the state given. */
  function there(hermes: Partial<SourceHealth>, codex: SourceHealth["state"]): SessionsSnapshot {
    return {
      generatedAt: NOW,
      sources: [
        {
          id: "hermes-agent",
          label: "Hermes Agent",
          state: "ok",
          basis: "database",
          parts: { "hermes-agent:default/": "database" },
          checkedAt: NOW,
          ...hermes,
        },
        { id: "codex", label: "Codex", state: codex, checkedAt: NOW },
      ],
      sessions: [
        workingThere({ id: DEFAULT_ID, source: "hermes-agent" as SourceId, status: "idle" }),
      ],
    };
  }

  /**
   * What the event log holds after the first poll, from a history that kept
   * each session idle, and a poll for each answer after it.
   */
  async function firstPoll(snapshot: SessionsSnapshot, ...later: SessionsSnapshot[]) {
    let clock = NOW;
    let answer = snapshot;
    const adapter = createRemoteAdapter({
      remote: REMOTE,
      version: "0.2.3",
      tunnel: { state: () => RUNNING, connected: () => {} },
      read: async () => ({ kind: "read", version: REMOTE_VERSION, snapshot: answer }),
      now: () => clock,
      answerWaitMs: 50,
    });
    const events = createEventStore();
    const poller = createPoller({
      adapters: [adapter],
      events,
      history: createHistoryStore(),
      now: () => clock,
    });
    const at = NOW - 60_000;
    poller.resume(
      [DEFAULT_ID, CODER_ID, GONE_ID, CODEX_ID].map((id): SessionEvent => ({
        id: `remote:devbox:${id}@${at}`,
        at,
        sessionId: `remote:devbox:${id}`,
        sessionName: id,
        kind: "appeared",
        to: "idle",
        severity: "advisory",
      })),
    );
    const polled = await poller.pollOnce();
    const logged = () => events.list().map(({ kind, sessionId }) => `${kind} ${sessionId}`);
    const first = logged();
    for (const next of later) {
      answer = next;
      clock += 2_000;
      await poller.pollOnce();
    }
    return { health: polled.sources[0], logged: first, after: logged() };
  }

  test("sends no ended for a profile not read there, nor for a source there that did not answer, and compares the rest", async () => {
    const { health, logged } = await firstPoll(
      there({ notRead: ["hermes-agent:coder/"] }, "error"),
    );
    expect(health?.notRead).toEqual(["remote:devbox:hermes-agent:coder/", "remote:devbox:codex:"]);
    expect(logged).toEqual([`ended remote:devbox:${GONE_ID}`]);
  });

  test("compares them with the history once that machine reads them", async () => {
    const coder = workingThere({
      id: CODER_ID,
      source: "hermes-agent" as SourceId,
      status: "working",
    });
    const read = there(
      { parts: { "hermes-agent:default/": "database", "hermes-agent:coder/": "database" } },
      "ok",
    );
    const { after } = await firstPoll(
      there({ notRead: ["hermes-agent:coder/"] }, "error"),
      { ...read, sessions: [...read.sessions, coder] },
      { ...read, sessions: [...read.sessions, coder] },
    );
    // Newest first: the profile and Codex there at their first reads, the other at the first poll.
    expect(after).toEqual([
      `ended remote:devbox:${CODEX_ID}`,
      `status-changed remote:devbox:${CODER_ID}`,
      `ended remote:devbox:${GONE_ID}`,
    ]);
  });

  test("ends them when that machine read them, and they had gone", async () => {
    const { health, logged } = await firstPoll(there({}, "ok"));
    expect(health).not.toHaveProperty("notRead");
    expect(logged.toSorted()).toEqual([
      `ended remote:devbox:${CODEX_ID}`,
      `ended remote:devbox:${CODER_ID}`,
      `ended remote:devbox:${GONE_ID}`,
    ]);
  });
});
