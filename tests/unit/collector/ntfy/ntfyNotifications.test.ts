import { describe, expect, test } from "vitest";

import { createNtfyNotifications, ntfyOffStatus } from "@collector/ntfy/ntfyNotifications";
import type { NtfySettings } from "@collector/ntfy/ntfySettings";
import type { SendOutcome } from "@collector/outbound/outboundChannel";
import type { PhoneMessage } from "@collector/outbound/phoneMessage";
import { HOUR_MS } from "@collector/outbound/outboundTiming";
import { SENDS_PER_HOUR } from "@core/api";
import type { Session, SessionsSnapshot } from "@core/sessions/session";
import { makeSession } from "@tests/fixtures/session";

const T0 = 1_700_000_000_000;
const SECOND = 1_000;

const SETTINGS: NtfySettings = {
  server: new URL("https://ntfy.example.com/"),
  topic: "s3cret-topic-3f9c",
  token: "tk_s3cretaccesstoken000000000000",
  events: ["needs-you"],
  afterMs: 60 * SECOND,
  asking: false,
};

const id = (n: number) => `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const working = (n: number, name = `session-${n}`): Session =>
  makeSession({ id: id(n), name, status: "working", statusSince: null });
const waiting = (n: number, name = `session-${n}`, more: Partial<Session> = {}): Session =>
  makeSession({
    id: id(n),
    name,
    project: name,
    surface: "vscode",
    status: "needs-you",
    waitingReason: "permission",
    statusSince: null,
    ...more,
  });

function snapshot(sessions: Session[], quiet = false): SessionsSnapshot {
  return {
    generatedAt: T0,
    sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: T0 }],
    sessions,
    quiet,
  };
}

/** A sender that pushes nothing. It writes down each push and answers as the test says. */
function fakeSender() {
  const sender = {
    pushed: [] as PhoneMessage[],
    answer: { sent: true } as SendOutcome,
    send(message: PhoneMessage): Promise<SendOutcome> {
      sender.pushed.push(message);
      return Promise.resolve(sender.answer);
    },
  };
  return sender;
}

function setUp(settings: Partial<NtfySettings> = {}, sender = fakeSender()) {
  const clock = { now: T0 };
  const ntfy = createNtfyNotifications({
    settings: { ...SETTINGS, ...settings },
    sender,
    now: () => clock.now,
  });
  return {
    ntfy,
    sender,
    clock,
    async poll(atMs: number, sessions: Session[], quiet = false) {
      clock.now = T0 + atMs;
      ntfy.handle(snapshot(sessions, quiet));
      await ntfy.settled();
    },
  };
}

describe("createNtfyNotifications", () => {
  test("pushes a wait that lasts the delay, once, and nothing for one answered before it", async () => {
    const { ntfy, sender, poll } = setUp();
    await poll(0, [working(1, "checkout-flow"), working(2, "docs-site")]);
    await poll(2 * SECOND, [waiting(1, "checkout-flow"), waiting(2, "docs-site")]);
    await poll(40 * SECOND, [waiting(1, "checkout-flow"), working(2, "docs-site")]);
    await poll(62 * SECOND, [waiting(1, "checkout-flow"), working(2, "docs-site")]);
    await poll(HOUR_MS, [waiting(1, "checkout-flow"), working(2, "docs-site")]);

    expect(sender.pushed).toEqual([
      {
        kind: "needs-you",
        title: "checkout-flow is waiting for permission",
        message: "1m 00s · checkout-flow · VS Code · Claude Code",
      },
    ]);
    expect(ntfy.status().last).toEqual({ at: T0 + 62 * SECOND, sent: true });
  });

  test("in quiet hours nothing goes, and a wait answered in them is one item of the summary", async () => {
    const { sender, poll } = setUp({ afterMs: 0 });
    await poll(0, [working(1, "checkout-flow")], true);
    await poll(2 * SECOND, [waiting(1, "checkout-flow")], true);
    await poll(20 * 60 * SECOND, [working(1, "checkout-flow")], true);
    expect(sender.pushed).toEqual([]);
    await poll(30 * 60 * SECOND, [working(1, "checkout-flow")]);
    expect(sender.pushed).toEqual([
      { kind: "quiet-summary", title: "While quiet", message: "checkout-flow waited 19 minutes" },
    ]);
  });

  test("what a waiting session is asking goes only with the setting on, and never into the status", async () => {
    const off = setUp({ afterMs: 0 });
    await off.poll(0, [working(1, "checkout-flow")]);
    await off.poll(2 * SECOND, [waiting(1, "checkout-flow", { waitingText: "Run: npm test" })]);
    expect(JSON.stringify(off.sender.pushed)).not.toContain("npm test");

    const on = setUp({ afterMs: 0, asking: true });
    await on.poll(0, [working(1, "checkout-flow")]);
    await on.poll(2 * SECOND, [waiting(1, "checkout-flow", { waitingText: "Run: npm test" })]);
    expect(on.sender.pushed[0]?.message).toBe(
      "Asking: Run: npm test\n0s · checkout-flow · VS Code · Claude Code",
    );
    expect(JSON.stringify(on.ntfy.status())).not.toContain("npm test");
  });

  test("the status gives the host and whether a token is set, never the topic or the token", () => {
    const { ntfy } = setUp({ events: ["needs-you", "failed"] });
    expect(ntfy.status()).toEqual({
      on: true,
      host: "ntfy.example.com",
      tokenSet: true,
      events: ["needs-you", "failed"],
      afterMs: 60_000,
      asking: false,
      problem: null,
      last: null,
      limitedUntil: null,
    });
    const said = JSON.stringify(ntfy.status());
    for (const secret of ["s3cret", "tk_", "https://"]) expect(said).not.toContain(secret);
    expect(setUp({ token: null }).ntfy.status().tokenSet).toBe(false);
  });

  test("a test push says only that it is a test, counts against the hour, and is not the last push", async () => {
    const { ntfy, sender } = setUp();
    expect(await ntfy.test()).toEqual({ tried: true, at: T0, outcome: { sent: true } });
    expect(sender.pushed).toEqual([
      {
        kind: "test",
        title: "Agent Lookout test",
        message: "Pushes from Agent Lookout reach this device.",
      },
    ]);
    expect(ntfy.status().last).toBeNull();
    for (let n = 1; n < SENDS_PER_HOUR; n += 1) await ntfy.test();
    expect(await ntfy.test()).toEqual({ tried: false, limitedUntil: T0 + HOUR_MS });
    expect(ntfy.status().limitedUntil).toBe(T0 + HOUR_MS);
  });

  test("while ntfy is off the status says so, with the problem when there is one", () => {
    expect(ntfyOffStatus(null)).toEqual({
      on: false,
      host: null,
      tokenSet: null,
      events: null,
      afterMs: null,
      asking: null,
      problem: null,
      last: null,
      limitedUntil: null,
    });
    expect(ntfyOffStatus("AGENT_LOOKOUT_NTFY_ASKING must be on or off.").problem).toBe(
      "AGENT_LOOKOUT_NTFY_ASKING must be on or off.",
    );
  });
});
