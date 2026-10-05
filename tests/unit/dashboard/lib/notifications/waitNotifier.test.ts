import { describe, expect, test } from "vitest";

import type { Session, SessionsSnapshot, SourceState } from "@core/sessions/session";
import type { NoticeEvent } from "@core/sessions/waitChanges";
import { createWaitNotifier } from "@dashboard/lib/notifications/waitNotifier";
import { makeSession } from "@tests/fixtures/session";
import { fakeNotificationHost } from "@tests/support/notifications";

const T0 = 1_700_000_000_000;

function id(n: number): string {
  return `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function session(n: number, overrides: Partial<Session> = {}): Session {
  return makeSession({ id: id(n), name: `demo-project-${n}`, ...overrides });
}

function waiting(n: number, overrides: Partial<Session> = {}): Session {
  return session(n, { status: "needs-you", waitingReason: "permission", ...overrides });
}

function snapshot(sessions: Session[], state: SourceState = "ok"): SessionsSnapshot {
  return {
    generatedAt: T0,
    sources: [{ id: "claude-code", label: "Claude Code", state, checkedAt: T0 }],
    sessions,
  };
}

/** A notifier over a fake host, with a switch the test can turn. */
function setUp(on = true) {
  const host = fakeNotificationHost({ permission: "granted" });
  const setting = { on };
  const notifier = createWaitNotifier({ host, isOn: () => setting.on });
  return { host, setting, notifier };
}

test("a session that starts waiting is shown once, by its name, with a tag of its own", () => {
  const { host, notifier } = setUp();
  notifier.handle(snapshot([session(1, { name: "demo-project", status: "working" })]));
  expect(host.shown).toEqual([]);

  notifier.handle(snapshot([waiting(1, { name: "demo-project" })]));
  // The same answer again, twice more, with the wait still open.
  notifier.handle(snapshot([waiting(1, { name: "demo-project" })]));
  notifier.handle(snapshot([waiting(1, { name: "demo-project" })]));

  expect(host.shown).toHaveLength(1);
  expect(host.shown[0]).toMatchObject({
    title: "demo-project",
    body: "Waiting for permission",
    tag: `agent-lookout:${id(1)}`,
    open: true,
    closes: 0,
  });
});

// The collector reads every two seconds. A session that is answered, works for
// less than that and asks again is waiting in one answer and waiting in the
// next, with a later status time and nothing else to tell the two waits apart.
test("a session that is answered and waits again before the next answer is announced again, in place of the first", () => {
  const { host, notifier } = setUp();
  notifier.handle(snapshot([session(1, { status: "working" })]));
  notifier.handle(snapshot([waiting(1, { statusSince: T0 + 2_000 })]));

  notifier.handle(snapshot([waiting(1, { waitingReason: "question", statusSince: T0 + 3_400 })]));
  // The second wait goes on.
  notifier.handle(snapshot([waiting(1, { waitingReason: "question", statusSince: T0 + 3_400 })]));

  expect(host.shown.map((shown) => [shown.body, shown.open, shown.closes])).toEqual([
    ["Waiting for permission", false, 1],
    ["Asked you a question", true, 0],
  ]);

  notifier.handle(snapshot([session(1, { status: "working" })]));
  expect(host.open()).toEqual([]);
});

test("it is announced again when the person had dismissed the first notification before answering", () => {
  const { host, notifier } = setUp();
  notifier.handle(snapshot([session(1, { status: "working" })]));
  notifier.handle(snapshot([waiting(1, { statusSince: T0 + 2_000 })]));
  host.shown[0]?.dismiss();

  notifier.handle(snapshot([waiting(1, { statusSince: T0 + 3_400 })]));

  expect(host.shown.map((shown) => [shown.open, shown.closes])).toEqual([
    [false, 0],
    [true, 0],
  ]);
});

test.each([
  ["permission", "Waiting for permission"],
  ["question", "Asked you a question"],
  ["other", "Waiting for you"],
  [undefined, "Waiting for you"],
] as const)("the body for the reason %s is the panel's own words", (waitingReason, body) => {
  const { host, notifier } = setUp();
  notifier.handle(snapshot([session(1, { status: "working" })]));

  notifier.handle(snapshot([waiting(1, { waitingReason })]));

  expect(host.shown.map((shown) => shown.body)).toEqual([body]);
});

test("the vendor's own wording is not put in the notification", () => {
  const { host, notifier } = setUp();
  notifier.handle(snapshot([]));

  notifier.handle(snapshot([waiting(1, { waitingDetail: "approve the demo command" })]));

  expect(JSON.stringify(host.shown)).not.toContain("approve the demo command");
});

test("a session already waiting in the first snapshot is not announced", () => {
  const { host, notifier } = setUp();

  notifier.handle(snapshot([waiting(1)]));
  notifier.handle(snapshot([waiting(1)]));

  expect(host.shown).toEqual([]);
});

test("a null snapshot, from before the first answer, is ignored", () => {
  const { host, notifier } = setUp();

  notifier.handle(null);
  notifier.handle(snapshot([session(1, { status: "working" })]));
  notifier.handle(null);
  notifier.handle(snapshot([waiting(1)]));

  expect(host.shown).toHaveLength(1);
});

test("while notifications are off nothing is shown", () => {
  const { host, notifier } = setUp(false);
  notifier.handle(snapshot([session(1, { status: "working" })]));

  notifier.handle(snapshot([waiting(1)]));

  expect(host.shown).toEqual([]);
});

test("turning them on in the middle of a wait says nothing of that wait, and the next one is shown", () => {
  const { host, setting, notifier } = setUp(false);
  notifier.handle(snapshot([session(1, { status: "working" }), session(2, { status: "idle" })]));
  notifier.handle(snapshot([waiting(1), session(2, { status: "idle" })]));

  setting.on = true;
  notifier.handle(snapshot([waiting(1), session(2, { status: "idle" })]));
  expect(host.shown).toEqual([]);

  // Another session starts waiting, and the first is answered and waits again.
  notifier.handle(snapshot([session(1, { status: "working" }), waiting(2)]));
  notifier.handle(snapshot([waiting(1, { waitingReason: "question" }), waiting(2)]));

  expect(host.shown.map((shown) => [shown.tag, shown.body])).toEqual([
    [`agent-lookout:${id(2)}`, "Waiting for permission"],
    [`agent-lookout:${id(1)}`, "Asked you a question"],
  ]);
});

test.each(["working", "idle", "finished", "failed", "unknown"] as const)(
  "when the session goes to %s its notification is closed, once",
  (status) => {
    const { host, notifier } = setUp();
    notifier.handle(snapshot([session(1, { status: "working" })]));
    notifier.handle(snapshot([waiting(1)]));

    notifier.handle(snapshot([session(1, { status })]));
    notifier.handle(snapshot([session(1, { status })]));

    expect(host.shown[0]).toMatchObject({ open: false, closes: 1 });
  },
);

test("when the session leaves the list its notification is closed", () => {
  const { host, notifier } = setUp();
  notifier.handle(snapshot([session(1, { status: "working" }), session(2)]));
  notifier.handle(snapshot([waiting(1), session(2)]));

  notifier.handle(snapshot([session(2)]));

  expect(host.shown[0]).toMatchObject({ open: false, closes: 1 });
});

test("only the session that moved on has its notification closed", () => {
  const { host, notifier } = setUp();
  notifier.handle(snapshot([session(1), session(2)]));
  notifier.handle(snapshot([waiting(1), waiting(2)]));

  notifier.handle(snapshot([session(1, { status: "working" }), waiting(2)]));

  expect(host.shown.map((shown) => [shown.tag, shown.open])).toEqual([
    [`agent-lookout:${id(1)}`, false],
    [`agent-lookout:${id(2)}`, true],
  ]);
});

test.each(["error", "searching", "unavailable"] as const)(
  "while the source is %s a notification stays, and is closed once the source answers without the wait",
  (state) => {
    const { host, notifier } = setUp();
    notifier.handle(snapshot([session(1, { status: "working" })]));
    notifier.handle(snapshot([waiting(1)]));

    // The source could not be read, so its sessions are not in the answer.
    notifier.handle(snapshot([], state));
    expect(host.shown[0]).toMatchObject({ open: true, closes: 0 });

    // It answers again and the wait goes on: nothing new, nothing closed.
    notifier.handle(snapshot([waiting(1)]));
    expect(host.shown).toHaveLength(1);
    expect(host.shown[0]?.open).toBe(true);

    notifier.handle(snapshot([session(1, { status: "working" })]));
    expect(host.shown[0]).toMatchObject({ open: false, closes: 1 });
  },
);

test("closeAll closes every notification on show, and a later stop does not close one again", () => {
  const { host, notifier } = setUp();
  notifier.handle(snapshot([session(1), session(2)]));
  notifier.handle(snapshot([waiting(1), waiting(2)]));

  notifier.closeAll();
  expect(host.open()).toEqual([]);
  expect(host.shown.map((shown) => shown.closes)).toEqual([1, 1]);

  notifier.closeAll();
  notifier.handle(snapshot([session(1, { status: "working" }), session(2, { status: "idle" })]));
  expect(host.shown.map((shown) => shown.closes)).toEqual([1, 1]);
});

test("after closeAll a wait that goes on is not shown again, and a new one is", () => {
  const { host, notifier } = setUp();
  notifier.handle(snapshot([session(1), session(2)]));
  notifier.handle(snapshot([waiting(1), session(2)]));
  notifier.closeAll();

  notifier.handle(snapshot([waiting(1), session(2)]));
  expect(host.shown).toHaveLength(1);

  notifier.handle(snapshot([waiting(1), waiting(2)]));
  expect(host.shown.map((shown) => shown.tag)).toEqual([
    `agent-lookout:${id(1)}`,
    `agent-lookout:${id(2)}`,
  ]);
});

test("a notification the person dismissed is forgotten, and is not closed when the wait ends", () => {
  const { host, notifier } = setUp();
  notifier.handle(snapshot([session(1, { status: "working" })]));
  notifier.handle(snapshot([waiting(1)]));

  host.shown[0]?.dismiss();
  notifier.handle(snapshot([waiting(1)]));
  // Still the same wait, so it is not shown a second time.
  expect(host.shown).toHaveLength(1);

  notifier.handle(snapshot([session(1, { status: "working" })]));
  notifier.closeAll();
  expect(host.shown[0]?.closes).toBe(0);
});

test.each(["refuse", "throw"] as const)(
  "a host that will not show one (%s) does not stop the next notification",
  (outcome) => {
    const { host, notifier } = setUp();
    notifier.handle(snapshot([session(1), session(2)]));

    host.next = outcome;
    expect(() => notifier.handle(snapshot([waiting(1), session(2)]))).not.toThrow();
    expect(host.shown).toEqual([]);

    notifier.handle(snapshot([waiting(1), waiting(2)]));
    expect(host.shown.map((shown) => shown.tag)).toEqual([`agent-lookout:${id(2)}`]);

    // The wait that was never shown ends like any other, with nothing to close.
    expect(() => notifier.handle(snapshot([session(1), waiting(2)]))).not.toThrow();
    expect(host.open()).toHaveLength(1);
  },
);

test("a host whose close throws does not stop the others being closed", () => {
  const closed: string[] = [];
  const notifier = createWaitNotifier({
    isOn: () => true,
    host: {
      show: ({ tag }) => ({
        close() {
          closed.push(tag);
          throw new Error("The host was told to throw.");
        },
        onClosed() {},
      }),
    },
  });
  notifier.handle(snapshot([session(1), session(2), session(3)]));
  notifier.handle(snapshot([waiting(1), waiting(2), waiting(3)]));

  expect(() => notifier.handle(snapshot([session(1), waiting(2), waiting(3)]))).not.toThrow();
  expect(() => notifier.closeAll()).not.toThrow();

  expect(closed).toEqual([
    `agent-lookout:${id(1)}`,
    `agent-lookout:${id(2)}`,
    `agent-lookout:${id(3)}`,
  ]);
});

test("whether notifications are on is asked when a wait starts, not before", () => {
  const host = fakeNotificationHost({ permission: "granted" });
  let asked = 0;
  const notifier = createWaitNotifier({
    host,
    isOn: () => {
      asked += 1;
      return true;
    },
  });

  notifier.handle(snapshot([session(1, { status: "working" })]));
  notifier.handle(snapshot([session(1, { status: "idle" })]));
  expect(asked).toBe(0);

  notifier.handle(snapshot([waiting(1)]));
  expect(asked).toBe(1);
});

test("a wait that begins on the first answer after they are turned on is shown", () => {
  const { host, setting, notifier } = setUp(false);
  notifier.handle(snapshot([session(1, { status: "working" })]));

  setting.on = true;
  notifier.handle(snapshot([waiting(1)]));

  expect(host.shown.map((shown) => shown.tag)).toEqual([`agent-lookout:${id(1)}`]);
});

test("a notification on show is closed when its wait ends, even if they were turned off meanwhile", () => {
  const { host, setting, notifier } = setUp();
  notifier.handle(snapshot([session(1, { status: "working" })]));
  notifier.handle(snapshot([waiting(1)]));

  // As when the browser's permission is taken away and the page is not told.
  setting.on = false;
  notifier.handle(snapshot([waiting(1)]));
  expect(host.shown[0]).toMatchObject({ open: true, closes: 0 });

  notifier.handle(snapshot([session(1, { status: "working" })]));
  expect(host.shown[0]).toMatchObject({ open: false, closes: 1 });
});

test("two sessions that start waiting in one answer are each shown, in the answer's order", () => {
  const { host, notifier } = setUp();
  notifier.handle(snapshot([session(1), session(2), session(3)]));

  notifier.handle(
    snapshot([
      waiting(3, { waitingReason: "question" }),
      session(2, { status: "working" }),
      waiting(1),
    ]),
  );

  expect(host.shown.map((shown) => [shown.title, shown.body, shown.tag])).toEqual([
    ["demo-project-3", "Asked you a question", `agent-lookout:${id(3)}`],
    ["demo-project-1", "Waiting for permission", `agent-lookout:${id(1)}`],
  ]);
  expect(host.open()).toHaveLength(2);
});

test("a name is passed through as it is, however long or oddly written", () => {
  const { host, notifier } = setUp();
  const name = `  <b>demo</b> & "project" ${"long-name-".repeat(40)}‮`;
  notifier.handle(snapshot([session(1, { name, status: "working" })]));

  notifier.handle(snapshot([waiting(1, { name })]));

  expect(host.shown[0]?.title).toBe(name);
});

/**
 * A host that tells of a close when the test says so, and not when `close` is
 * called. A browser tells of it later, in an event, and the fake in
 * `tests/support` tells of it at once, which hides what happens in between.
 */
function lateHost() {
  const shown: { tag: string; closes: number; closeArrives(): void }[] = [];
  const notifier = createWaitNotifier({
    isOn: () => true,
    host: {
      show({ tag }) {
        const listeners: (() => void)[] = [];
        const one = {
          tag,
          closes: 0,
          closeArrives: () => {
            for (const listener of listeners) listener();
          },
        };
        shown.push(one);
        return {
          close() {
            one.closes += 1;
          },
          onClosed(listener) {
            listeners.push(listener);
          },
        };
      },
    },
  });
  return { shown, notifier };
}

test("a notification is closed once, whether or not the host has told of the close yet", () => {
  const { shown, notifier } = lateHost();
  notifier.handle(snapshot([session(1), session(2)]));
  notifier.handle(snapshot([waiting(1), waiting(2)]));

  // The first wait ends, then everything is taken down, twice, then the second ends.
  notifier.handle(snapshot([session(1, { status: "working" }), waiting(2)]));
  expect(shown.map((one) => one.closes)).toEqual([1, 0]);
  notifier.closeAll();
  notifier.closeAll();
  notifier.handle(snapshot([session(1, { status: "working" }), session(2, { status: "idle" })]));
  expect(shown.map((one) => one.closes)).toEqual([1, 1]);

  // The host tells of both at last, and nothing more is closed.
  for (const one of shown) one.closeArrives();
  notifier.closeAll();
  expect(shown.map((one) => one.closes)).toEqual([1, 1]);
});

test("a close told of late does not forget the notification the session has by then", () => {
  const { shown, notifier } = lateHost();
  notifier.handle(snapshot([session(1, { status: "working" })]));
  notifier.handle(snapshot([waiting(1)]));
  // The wait ends and its notification is taken down. The host has not told of it yet.
  notifier.handle(snapshot([session(1, { status: "working" })]));
  // The session waits again, and has a second notification.
  notifier.handle(snapshot([waiting(1)]));
  expect(shown.map((one) => one.closes)).toEqual([1, 0]);

  // Now the first one's close arrives. It is not the one on show.
  shown[0]?.closeArrives();

  notifier.handle(snapshot([session(1, { status: "working" })]));
  expect(shown.map((one) => one.closes)).toEqual([1, 1]);
});

// No real id belongs to two sources: an id begins with its source's name. The
// second source here stands for any way one session could start waiting twice
// with no stop in between, and no Codex session is reported as waiting today.
test("a session never has two notifications on show at once", () => {
  const { host, notifier } = setUp();
  const sources = (claudeCode: SourceState): SessionsSnapshot["sources"] => [
    { id: "claude-code", label: "Claude Code", state: claudeCode, checkedAt: T0 },
    { id: "codex", label: "Codex", state: "ok", checkedAt: T0 },
  ];
  notifier.handle({ generatedAt: T0, sources: sources("ok"), sessions: [session(1)] });
  notifier.handle({ generatedAt: T0, sources: sources("ok"), sessions: [waiting(1)] });
  expect(host.open()).toHaveLength(1);

  // The first source cannot be read, so its wait is not known to have ended,
  // and the other source reports the same id as waiting.
  notifier.handle({
    generatedAt: T0,
    sources: sources("error"),
    sessions: [waiting(1, { source: "codex", waitingReason: "question" })],
  });

  expect(host.shown.map((shown) => [shown.body, shown.open])).toEqual([
    ["Waiting for permission", false],
    ["Asked you a question", true],
  ]);
});

/** When the collector began, and when the one that took its place did. */
const BEGAN = T0 - 600_000;
const BEGAN_AGAIN = T0 - 1_000;

test("a session already waiting when a new collector starts is not announced, and the next wait to begin is", () => {
  const { host, notifier } = setUp();
  notifier.handle(snapshot([session(1, { status: "working" }), session(2)]), BEGAN);

  // The app was stopped, the session started waiting, and the app was started again.
  notifier.handle(snapshot([waiting(1), session(2)]), BEGAN_AGAIN);
  notifier.handle(snapshot([waiting(1), session(2)]), BEGAN_AGAIN);
  expect(host.shown).toEqual([]);

  notifier.handle(snapshot([waiting(1), waiting(2)]), BEGAN_AGAIN);
  expect(host.shown.map((shown) => shown.tag)).toEqual([`agent-lookout:${id(2)}`]);

  // The first is answered and waits again, under the same collector.
  notifier.handle(snapshot([session(1, { status: "working" }), waiting(2)]), BEGAN_AGAIN);
  notifier.handle(snapshot([waiting(1), waiting(2)]), BEGAN_AGAIN);
  expect(host.shown.map((shown) => shown.tag)).toEqual([
    `agent-lookout:${id(2)}`,
    `agent-lookout:${id(1)}`,
  ]);
});

test.each(["searching", "error", "unavailable"] as const)(
  "a new collector whose source is %s at first announces nothing when that source answers",
  (state) => {
    const { host, notifier } = setUp();
    notifier.handle(snapshot([session(1, { status: "working" })]), BEGAN);

    notifier.handle(snapshot([], state), BEGAN_AGAIN);
    notifier.handle(snapshot([waiting(1)]), BEGAN_AGAIN);

    expect(host.shown).toEqual([]);
  },
);

test("when a new collector starts, a notification whose session has moved on is closed, and one whose session still waits stays until it does", () => {
  const { host, notifier } = setUp();
  notifier.handle(snapshot([session(1), session(2), session(3)]), BEGAN);
  notifier.handle(snapshot([waiting(1), waiting(2), waiting(3)]), BEGAN);
  expect(host.open()).toHaveLength(3);

  // The first went back to work and the third left the list while the app was stopped.
  notifier.handle(snapshot([session(1, { status: "working" }), waiting(2)]), BEGAN_AGAIN);

  expect(host.shown.map((shown) => [shown.open, shown.closes])).toEqual([
    [false, 1],
    [true, 0],
    [false, 1],
  ]);

  notifier.handle(snapshot([session(1, { status: "working" }), session(2, { status: "idle" })]));
  expect(host.shown).toHaveLength(3);
  expect(host.shown[1]).toMatchObject({ open: false, closes: 1 });
});

test.each(["searching", "error", "unavailable"] as const)(
  "a notification from before a new collector stays while its source is %s, and goes when the source answers without the wait",
  (state) => {
    const { host, notifier } = setUp();
    notifier.handle(snapshot([session(1), session(2)]), BEGAN);
    notifier.handle(snapshot([waiting(1), waiting(2)]), BEGAN);

    // Nobody knows yet whether either still waits.
    notifier.handle(snapshot([], state), BEGAN_AGAIN);
    expect(host.open()).toHaveLength(2);

    // The source answers: the first still waits, the second does not.
    notifier.handle(snapshot([waiting(1), session(2, { status: "working" })]), BEGAN_AGAIN);
    expect(host.shown).toHaveLength(2);
    expect(host.shown.map((shown) => [shown.open, shown.closes])).toEqual([
      [true, 0],
      [false, 1],
    ]);
  },
);

test("the same collector, answer after answer, is not a new one, and nor is one whose start is learned late or not said", () => {
  const { host, notifier } = setUp();
  // The history had not been answered yet.
  notifier.handle(snapshot([session(1, { status: "working" })]));
  notifier.handle(snapshot([session(1, { status: "working" })]), null);
  notifier.handle(snapshot([session(1, { status: "working" })]), BEGAN);

  notifier.handle(snapshot([waiting(1)]), BEGAN);
  expect(host.shown).toHaveLength(1);

  // One answer without it, then the same start again.
  notifier.handle(snapshot([session(1, { status: "working" })]), null);
  notifier.handle(snapshot([waiting(1)]), BEGAN);
  expect(host.shown).toHaveLength(2);
  expect(host.shown.map((shown) => shown.open)).toEqual([false, true]);
});

test("closeAll says which sessions' notifications it took down", () => {
  const { host, notifier } = setUp();
  notifier.handle(snapshot([session(1), session(2), session(3)]));
  notifier.handle(snapshot([waiting(1), waiting(2), waiting(3)]));
  // The person dismisses one, and one wait ends.
  host.shown[1]?.dismiss();
  notifier.handle(snapshot([session(1, { status: "working" }), waiting(2), waiting(3)]));

  expect(notifier.closeAll()).toEqual([id(3)]);
  expect(notifier.closeAll()).toEqual([]);
});

test("a notification another page took down is shown again for a session still waiting, and closed when its wait ends", () => {
  const { host, notifier } = setUp();
  notifier.handle(snapshot([session(1, { name: "demo-project", status: "working" })]));
  notifier.handle(snapshot([waiting(1, { name: "demo-project", waitingReason: "question" })]));
  // The other page's notification took the place of this one, as a browser has it.
  host.shown[0]?.dismiss();

  notifier.showAgain([id(1)]);

  expect(host.shown).toHaveLength(2);
  expect(host.shown[1]).toMatchObject({
    title: "demo-project",
    body: "Asked you a question",
    tag: `agent-lookout:${id(1)}`,
    open: true,
  });

  notifier.handle(snapshot([session(1, { name: "demo-project", status: "working" })]));
  expect(host.shown[1]).toMatchObject({ open: false, closes: 1 });
});

test("one is shown again for a wait that was already open when this page began", () => {
  const { host, notifier } = setUp();
  // Already waiting in the first answer, so this page never announced it. The other page had.
  notifier.handle(snapshot([waiting(1), session(2)]));
  expect(host.shown).toEqual([]);

  notifier.showAgain([id(1)]);
  expect(host.shown.map((shown) => [shown.tag, shown.open])).toEqual([
    [`agent-lookout:${id(1)}`, true],
  ]);

  notifier.handle(snapshot([session(1, { status: "idle" }), session(2)]));
  expect(host.shown[0]).toMatchObject({ open: false, closes: 1 });
});

test("nothing is shown again for a session that has moved on, one never seen, or before the first answer", () => {
  const { host, notifier } = setUp();
  notifier.showAgain([id(1)]);
  expect(host.shown).toEqual([]);

  notifier.handle(snapshot([session(1, { status: "working" }), waiting(2)]));
  notifier.showAgain([id(1), id(9), "not-a-session"]);
  notifier.showAgain([]);

  expect(host.shown).toEqual([]);
});

test("nothing is shown again while notifications are off", () => {
  const { host, setting, notifier } = setUp(false);
  notifier.handle(snapshot([waiting(1)]));

  notifier.showAgain([id(1)]);
  expect(host.shown).toEqual([]);

  setting.on = true;
  notifier.showAgain([id(1)]);
  expect(host.shown).toHaveLength(1);
});

test("nothing is shown again for a session whose source has not answered since a new collector began", () => {
  const { host, notifier } = setUp();
  notifier.handle(snapshot([session(1)]), BEGAN);
  notifier.handle(snapshot([waiting(1)]), BEGAN);
  notifier.closeAll();

  // The new collector's source has not been read yet, and it lists the session all the same.
  notifier.handle(snapshot([waiting(1)], "searching"), BEGAN_AGAIN);
  notifier.showAgain([id(1)]);

  expect(host.shown).toHaveLength(1);
});

test("a session shown again has one notification, in place of the one this page still had", () => {
  const { host, notifier } = setUp();
  notifier.handle(snapshot([session(1), session(2)]));
  notifier.handle(snapshot([waiting(1), waiting(2)]));

  // Named twice, and this page's own notification for it is still on show.
  notifier.showAgain([id(1), id(1)]);

  expect(host.shown.map((shown) => [shown.tag, shown.open])).toEqual([
    [`agent-lookout:${id(1)}`, false],
    [`agent-lookout:${id(2)}`, true],
    [`agent-lookout:${id(1)}`, true],
  ]);
  expect(notifier.closeAll().sort()).toEqual([id(1), id(2)]);
});

describe("finished, failed and ended", () => {
  /** A notifier with the events the test chooses on, over a fake host. */
  function choosing(...events: NoticeEvent[]) {
    const host = fakeNotificationHost({ permission: "granted" });
    const chosen = new Set<NoticeEvent>(events);
    const notifier = createWaitNotifier({ host, isOn: (event) => chosen.has(event) });
    return { host, chosen, notifier };
  }

  test.each([
    ["finished", "Finished"],
    ["failed", "Failed"],
  ] as const)(
    "a session that becomes %s is shown once, by its name, with what happened and its tag",
    (status, body) => {
      const { host, notifier } = choosing("finished", "failed");
      notifier.handle(snapshot([session(1, { name: "billing-webhooks", status: "working" })]));
      notifier.handle(snapshot([session(1, { name: "billing-webhooks", status })]));
      notifier.handle(snapshot([session(1, { name: "billing-webhooks", status })]));

      expect(host.shown).toHaveLength(1);
      expect(host.shown[0]).toMatchObject({
        title: "billing-webhooks",
        body,
        tag: `agent-lookout:${id(1)}`,
        open: true,
      });
    },
  );

  test("a session that leaves the list is shown as ended, by the name it last had", () => {
    const { host, notifier } = choosing("ended");
    notifier.handle(snapshot([session(1, { name: "search-indexing", status: "idle" })]));
    notifier.handle(snapshot([]));

    expect(host.shown.map(({ title, body }) => [title, body])).toEqual([
      ["search-indexing", "Ended"],
    ]);
  });

  test("they stay on show until the person clears them: nothing the session does later closes them", () => {
    const { host, notifier } = choosing("finished");
    notifier.handle(snapshot([session(1, { status: "working" })]));
    notifier.handle(snapshot([session(1, { status: "finished" })]));
    notifier.handle(snapshot([]));
    notifier.handle(snapshot([], "error"));

    expect(host.shown.map(({ body, open, closes }) => [body, open, closes])).toEqual([
      ["Finished", true, 0],
    ]);
  });

  test("closeAll and the page leaving take down a wait's notification, and leave these to the person", () => {
    const { host, notifier } = choosing("needs-you", "finished");
    notifier.handle(
      snapshot([session(1, { status: "working" }), session(2, { status: "working" })]),
    );
    notifier.handle(snapshot([session(1, { status: "finished" }), waiting(2)]));

    expect(notifier.closeAll()).toEqual([id(2)]);
    expect(host.shown.map(({ body, open }) => [body, open])).toEqual([
      ["Finished", true],
      ["Waiting for permission", false],
    ]);
  });

  test("a session that waits and then finishes has its wait's notification closed, and the finish takes its place", () => {
    const { host, notifier } = choosing("needs-you", "finished");
    notifier.handle(snapshot([session(1, { status: "working" })]));
    notifier.handle(snapshot([waiting(1)]));
    notifier.handle(snapshot([session(1, { status: "finished" })]));

    expect(host.shown.map(({ body, open, closes, tag }) => [body, open, closes, tag])).toEqual([
      ["Waiting for permission", false, 1, `agent-lookout:${id(1)}`],
      ["Finished", true, 0, `agent-lookout:${id(1)}`],
    ]);
  });

  test("a later event for the same session takes the place of the earlier one", () => {
    const { host, notifier } = choosing("needs-you", "finished", "failed");
    notifier.handle(snapshot([session(1, { status: "working" })]));
    notifier.handle(snapshot([session(1, { status: "finished" })]));
    notifier.handle(snapshot([session(1, { status: "working" })]));
    notifier.handle(snapshot([session(1, { status: "failed" })]));

    // One tag for the session, so the browser keeps the last.
    expect(host.open().map(({ body }) => body)).toEqual(["Failed"]);
    expect(host.shown.map(({ body }) => body)).toEqual(["Finished", "Failed"]);
  });

  // A browser that puts a notification in the place of another with the same
  // tag does it silently. Taken down first, the next is a new one, and alerts.
  test("a later notification for a session takes down the one still on show first, so it is not shown in its place silently", () => {
    const { host, notifier } = choosing("needs-you", "finished");
    notifier.handle(snapshot([session(1, { status: "working" })]));
    notifier.handle(snapshot([waiting(1)]));
    notifier.handle(snapshot([session(1, { status: "finished" })]));
    notifier.handle(snapshot([session(1, { status: "working" })]));
    expect(host.shown.map(({ body, open, closes }) => [body, open, closes])).toEqual([
      ["Waiting for permission", false, 1],
      ["Finished", true, 0],
    ]);

    // The session is resumed and asks again while Finished is still on show.
    notifier.handle(snapshot([waiting(1, { statusSince: T0 + 9_000 })]));
    expect(host.shown.map(({ body, open, closes }) => [body, open, closes])).toEqual([
      ["Waiting for permission", false, 1],
      ["Finished", false, 1],
      ["Waiting for permission", true, 0],
    ]);
  });

  test("a notification the person cleared is not taken down again by the next", () => {
    const { host, notifier } = choosing("finished", "failed");
    notifier.handle(snapshot([session(1, { status: "working" })]));
    notifier.handle(snapshot([session(1, { status: "finished" })]));
    host.shown[0]?.dismiss();
    notifier.handle(snapshot([session(1, { status: "working" })]));
    notifier.handle(snapshot([session(1, { status: "failed" })]));

    expect(host.shown.map(({ body, open, closes }) => [body, open, closes])).toEqual([
      ["Finished", false, 0],
      ["Failed", true, 0],
    ]);
  });

  test("only the events chosen are shown, each asked at the moment it happens", () => {
    const { host, chosen, notifier } = choosing("finished");
    notifier.handle(
      snapshot([
        session(1, { status: "working" }),
        session(2, { status: "working" }),
        session(3, { status: "working" }),
        session(4, { status: "working" }),
      ]),
    );
    notifier.handle(
      snapshot([
        waiting(1),
        session(2, { status: "finished" }),
        session(3, { status: "failed" }),
        session(4, { status: "working" }),
      ]),
    );
    expect(host.shown.map(({ title, body }) => [title, body])).toEqual([
      ["demo-project-2", "Finished"],
    ]);

    chosen.add("ended");
    // The third had failed, so its leaving is not an end. The fourth had not.
    notifier.handle(snapshot([waiting(1), session(2, { status: "finished" })]));
    expect(host.shown.map(({ title, body }) => [title, body])).toEqual([
      ["demo-project-2", "Finished"],
      ["demo-project-4", "Ended"],
    ]);
  });

  test("with a wait alone chosen, as by default, a session that finishes sends nothing", () => {
    const { host, notifier } = choosing("needs-you");
    notifier.handle(
      snapshot([session(1, { status: "working" }), session(2, { status: "working" })]),
    );
    notifier.handle(snapshot([session(1, { status: "finished" })]));
    expect(host.shown).toEqual([]);
  });

  test("nothing is said of what was already over when the page began, or when a new collector began", () => {
    const { host, notifier } = choosing("finished", "failed", "ended");
    notifier.handle(
      snapshot([session(1, { status: "finished" }), session(2, { status: "failed" })]),
      T0,
    );
    // Those two leave the list having said what happened, and a third appears.
    notifier.handle(snapshot([session(3, { status: "working" })]), T0);
    expect(host.shown).toEqual([]);

    // A new collector: its first answer is a baseline, whatever has gone from it.
    notifier.handle(snapshot([session(4, { status: "finished" })]), T0 + 60_000);
    expect(host.shown).toEqual([]);
    notifier.handle(snapshot([session(4, { status: "finished" })]), T0 + 60_000);
    expect(host.shown).toEqual([]);
  });

  test("a session of a source that stops answering has not ended", () => {
    const { host, notifier } = choosing("ended");
    notifier.handle(snapshot([session(1, { status: "working" })]));
    notifier.handle(snapshot([], "error"));
    notifier.handle(snapshot([], "unavailable"));
    expect(host.shown).toEqual([]);
  });
});
