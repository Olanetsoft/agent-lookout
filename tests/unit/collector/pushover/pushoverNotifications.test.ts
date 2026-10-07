import { describe, expect, test } from "vitest";

import type { SendOutcome } from "@collector/outbound/outboundChannel";
import type { PhoneMessage } from "@collector/outbound/phoneMessage";
import {
  createPushoverNotifications,
  pushoverOffStatus,
} from "@collector/pushover/pushoverNotifications";
import type { PushoverSettings } from "@collector/pushover/pushoverSettings";
import type { Session, SessionsSnapshot } from "@core/sessions/session";
import { DEFAULT_TIME_RULES } from "@core/time-rules/timeRules";
import { makeSession } from "@tests/fixtures/session";

const T0 = 1_700_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const SETTINGS: PushoverSettings = {
  token: "atest0000000000000000000000000",
  user: "utest0000000000000000000000000",
  events: ["needs-you"],
  afterMs: 0,
  asking: false,
};

const id = (n: number) => `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const working = (n: number, name: string): Session =>
  makeSession({ id: id(n), name, status: "working", statusSince: null });
const waiting = (n: number, name: string, since: number): Session =>
  makeSession({
    id: id(n),
    name,
    project: name,
    surface: "vscode",
    status: "needs-you",
    waitingReason: "permission",
    statusSince: since,
  });

/** With the long wait reminder after ten minutes, and again every thirty. */
function snapshot(sessions: Session[], at: number): SessionsSnapshot {
  return {
    generatedAt: at,
    sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: at }],
    sessions,
    timeRules: {
      ...DEFAULT_TIME_RULES,
      longWait: { on: true, minutes: 10, repeat: { on: true, minutes: 30 } },
    },
    quiet: false,
  };
}

function setUp(settings: Partial<PushoverSettings> = {}) {
  const clock = { now: T0 };
  const pushed: PhoneMessage[] = [];
  const pushover = createPushoverNotifications({
    settings: { ...SETTINGS, ...settings },
    sender: {
      send(message): Promise<SendOutcome> {
        pushed.push(message);
        return Promise.resolve({ sent: true });
      },
    },
    now: () => clock.now,
  });
  return {
    pushover,
    pushed,
    async poll(at: number, sessions: Session[]) {
      clock.now = at;
      pushover.handle(snapshot(sessions, at));
      await pushover.settled();
    },
  };
}

describe("createPushoverNotifications", () => {
  test("pushes a wait, its reminder and each repeat, and nothing once it is answered", async () => {
    const { pushed, poll } = setUp();
    const begun = T0 + 2 * SECOND;
    await poll(T0, [working(1, "checkout-flow")]);
    for (const minutes of [0, 1, 10, 11, 40, 70]) {
      await poll(begun + minutes * MINUTE, [waiting(1, "checkout-flow", begun)]);
    }
    await poll(begun + 75 * MINUTE, [working(1, "checkout-flow")]);
    await poll(begun + 100 * MINUTE, [working(1, "checkout-flow")]);
    expect(pushed.map((message) => [message.kind, message.title])).toEqual([
      ["needs-you", "checkout-flow is waiting for permission"],
      ["reminder", "checkout-flow has waited 10 minutes for permission"],
      ["reminder", "checkout-flow has waited 40 minutes for permission"],
      ["reminder", "checkout-flow has waited 1 hour 10 minutes for permission"],
    ]);
  });

  test("the status holds neither the token nor the key", () => {
    const { pushover } = setUp({ afterMs: 30 * SECOND, asking: true });
    expect(pushover.status()).toEqual({
      on: true,
      events: ["needs-you"],
      afterMs: 30_000,
      asking: true,
      problem: null,
      last: null,
      limitedUntil: null,
    });
    const said = JSON.stringify(pushover.status());
    expect(said).not.toContain(SETTINGS.token);
    expect(said).not.toContain(SETTINGS.user);
  });

  test("a test push says only that it is a test", async () => {
    const { pushover, pushed } = setUp();
    expect(await pushover.test()).toMatchObject({ tried: true, outcome: { sent: true } });
    expect(pushed).toEqual([
      {
        kind: "test",
        title: "Agent Lookout test",
        message: "Pushes from Agent Lookout reach this device.",
      },
    ]);
    expect(pushover.status()).toMatchObject({ last: null, limitedUntil: null });
  });

  test("while Pushover is off the status says so, with the problem when there is one", () => {
    expect(pushoverOffStatus("AGENT_LOOKOUT_PUSHOVER_USER is not set.")).toEqual({
      on: false,
      events: null,
      afterMs: null,
      asking: null,
      problem: "AGENT_LOOKOUT_PUSHOVER_USER is not set.",
      last: null,
      limitedUntil: null,
    });
  });
});
