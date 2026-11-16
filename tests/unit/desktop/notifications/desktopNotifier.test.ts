import { afterEach, describe, expect, test, vi } from "vitest";

import { createServerNotifications } from "@collector/notifications/serverNotifications";
import type { NoticeEvent } from "@core/notices/sessionChanges";
import type { PermissionAsk, Session } from "@core/sessions/session";
import type { AnswerPress } from "@desktop/answers/desktopAnswers";
import {
  createDesktopNotifier,
  TEST_ANSWER_MS,
  TEST_NOTICE,
  type NoticeAnswers,
} from "@desktop/notifications/desktopNotifier";
import { makeSession } from "@tests/fixtures/session";
import { fakeNotifications } from "@tests/support/desktop/electronStandIns";

const NOW = 1_700_000_600_000;
const ID = "claude-code:00000000-0000-4000-8000-000000000001";
const OTHER = "claude-code:00000000-0000-4000-8000-000000000002";
const REQUEST_ID = "0123456789abcdef0123456789abcdef";
const WAIT = { title: "checkout-flow", body: "Waiting for permission: Run: npm test" };
const REMINDER = { title: "checkout-flow", body: "Has waited 10 minutes for permission" };
const FINISHED = { title: "checkout-flow", body: "Finished" };

/** Lets every answer already given be heard. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function ask(command: string, more: Partial<PermissionAsk> = {}): PermissionAsk {
  return { requestId: REQUEST_ID, tool: "Bash", command, allow: true, until: NOW, ...more };
}

/** The notifier over a stand-in for Electron's notifications and the app's answers. */
function setUp(
  options: {
    held?: Pick<Session, "ask">;
    answers?: false;
    supported?: boolean;
    heldFails?: boolean;
    /** Held back until it settles: the request is read meanwhile. */
    gate?: Promise<void>;
  } = {},
) {
  let now = NOW;
  const notifications = fakeNotifications(options.supported ?? true);
  const pressed: AnswerPress[] = [];
  const answers: NoticeAnswers = {
    heldFor: vi.fn(async () => {
      await options.gate;
      if (options.heldFails) throw new Error("no collector");
      return options.held;
    }),
    press: async (press) => void pressed.push(press),
  };
  const onClick = vi.fn<(sessionId?: string) => void>();
  const warn = vi.fn<(line: string) => void>();
  const notifier = createDesktopNotifier({
    notifications,
    onClick,
    ...(options.answers !== false && { answers }),
    now: () => now,
    warn,
  });
  return {
    notifier,
    made: notifications.made,
    pressed,
    onClick,
    warn,
    answers,
    tick: (ms: number) => {
      now += ms;
    },
    /** The notification made last, once it has been. */
    shown: async () => {
      await vi.waitFor(() => expect(notifications.made.length).toBeGreaterThan(0));
      return notifications.made.at(-1);
    },
  };
}

describe("a notification of no wait", () => {
  test("is shown as it was, on one line, and a click opens the window", () => {
    const { notifier, made, onClick } = setUp();
    notifier.show({ title: "billing\nwebhooks", body: "Finished" });
    expect(made).toHaveLength(1);
    expect(made[0]?.options).toEqual({ title: "billing webhooks", body: "Finished" });
    expect(made[0]?.shown).toBe(true);
    made[0]?.click();
    expect(onClick).toHaveBeenCalledWith(undefined);
  });

  test("is not made where notifications are not supported, and a refusal is said once", () => {
    const off = setUp({ supported: false });
    off.notifier.show(WAIT);
    expect(off.made).toEqual([]);

    const { notifier, made, warn } = setUp();
    notifier.show(WAIT);
    notifier.show(WAIT);
    made[0]?.fail("not allowed");
    made[1]?.fail("not allowed");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "macOS did not show a notification from Agent Lookout: not allowed",
    );
  });
});

describe("a notification of a wait", () => {
  test("with no request held has no buttons, and a click opens the session's details", async () => {
    const { notifier, onClick, shown } = setUp({ held: {} });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    const notification = await shown();
    expect(notification?.options).toEqual(WAIT);
    expect(notification?.buttons).toEqual([]);
    notification?.click();
    expect(onClick).toHaveBeenCalledWith(ID);
  });

  test("of a request that fits whole has the command as its text, and Deny then Allow", async () => {
    const { notifier, shown } = setUp({ held: { ask: ask("npm test && npm run build") } });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    const notification = await shown();
    expect(notification?.options).toEqual({
      title: "checkout-flow",
      subtitle: "Asks to run",
      body: "npm test && npm run build",
      actions: [
        { type: "button", text: "Deny" },
        { type: "button", text: "Allow" },
      ],
    });
  });

  test("of a request that does not fit has Deny alone, and says to open Agent Lookout", async () => {
    const { notifier, shown } = setUp({ held: { ask: ask("npm test\nnpm run build") } });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    const notification = await shown();
    expect(notification?.buttons).toEqual(["Deny"]);
    expect(notification?.options.body).toMatch(/^To allow it, open Agent Lookout/);
  });

  test("a press goes to the answers, with the session, the request and the later of when it was shown and macOS said so", async () => {
    const { notifier, pressed, tick, shown } = setUp({ held: { ask: ask("npm test") } });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    const notification = await shown();
    tick(400);
    notification?.appear();
    tick(2_000);
    notification?.press("Allow");
    expect(pressed).toEqual([
      {
        sessionId: ID,
        name: "checkout-flow",
        requestId: REQUEST_ID,
        decision: "allow",
        shownAt: NOW + 400,
        from: "notification",
      },
    ]);
  });

  test("a press takes the notification down at once, whatever it comes to, and Deny answers Deny", async () => {
    const { notifier, pressed, made, shown } = setUp({ held: { ask: ask("npm test") } });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    const notification = await shown();
    expect(notification?.closed).toBe(false);
    notification?.press("Deny");
    expect(notification?.closed).toBe(true);
    expect(pressed).toEqual([expect.objectContaining({ decision: "deny", requestId: REQUEST_ID })]);
    // Nothing is left to take down once its request goes.
    notifier.observe({ sessions: [] });
    expect(made).toHaveLength(1);
  });

  test("a press whose button it does not have answers nothing", async () => {
    const { notifier, pressed, shown } = setUp({ held: { ask: ask("npm test\nls") } });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    const notification = await shown();
    expect(() => notification?.press("Allow")).toThrow();
    expect(pressed).toEqual([]);
  });

  test("is taken down once its request is no longer held, and kept while it is", async () => {
    const { notifier, shown } = setUp({ held: { ask: ask("npm test") } });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    const notification = await shown();
    notifier.observe({ sessions: [{ id: ID, ask: ask("npm test") } as Session] });
    expect(notification?.closed).toBe(false);
    notifier.observe({
      sessions: [{ id: ID, ask: ask("npm test", { requestId: "f".repeat(32) }) } as Session],
    });
    expect(notification?.closed).toBe(true);
  });

  test("a reminder of the same request takes the place of the first, so one set of buttons stands for it", async () => {
    const { notifier, made } = setUp({ held: { ask: ask("npm test") } });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    await vi.waitFor(() => expect(made).toHaveLength(1));
    notifier.show(
      { title: "checkout-flow", body: "Has waited 10 minutes for permission" },
      { kind: "wait", sessionId: ID, waitedMs: 10 * 60_000 },
    );
    await vi.waitFor(() => expect(made).toHaveLength(2));
    expect(made[0]?.closed).toBe(true);
    expect(made[1]?.buttons).toEqual(["Deny", "Allow"]);
    // So it can be told from the first, it says how long the session has waited.
    expect(made[1]?.options).toMatchObject({
      subtitle: "Has waited 10 minutes. Asks to run",
      body: "npm test",
    });
  });

  test("has no buttons when the app gives no answers, or the request cannot be read", async () => {
    const without = setUp({ held: { ask: ask("npm test") }, answers: false });
    without.notifier.show(WAIT, { kind: "wait", sessionId: ID });
    expect(without.made[0]?.buttons).toEqual([]);

    const failing = setUp({ heldFails: true });
    failing.notifier.show(WAIT, { kind: "wait", sessionId: ID });
    expect((await failing.shown())?.options).toEqual(WAIT);
  });
});

describe("a wait's notification and the end of its wait", () => {
  test("with no request held, is taken down once its wait ends", async () => {
    const { notifier, shown } = setUp({ held: {} });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    const notification = await shown();
    expect(notification?.closed).toBe(false);
    notifier.waitEnded(ID);
    expect(notification?.closed).toBe(true);
  });

  test("with no answers given, is taken down once its wait ends", () => {
    const { notifier, made } = setUp({ answers: false });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    notifier.waitEnded(ID);
    expect(made[0]?.closed).toBe(true);
  });

  test("with Deny and Allow, is taken down once its wait ends, and a later poll does not take it down again", async () => {
    const { notifier, shown } = setUp({ held: { ask: ask("npm test") } });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    const notification = await shown();
    expect(notification?.buttons).toEqual(["Deny", "Allow"]);
    notifier.waitEnded(ID);
    expect(notification?.closed).toBe(true);
    notifier.observe({ sessions: [] });
    notifier.waitEnded(ID);
    expect(notification?.closes).toBe(1);
  });

  test("a reminder takes the place of the wait's notification when no request is held too, and is the one its wait ending takes down", async () => {
    const { notifier, made } = setUp({ held: {} });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    await vi.waitFor(() => expect(made).toHaveLength(1));
    notifier.show(REMINDER, { kind: "wait", sessionId: ID, waitedMs: 10 * 60_000 });
    await vi.waitFor(() => expect(made).toHaveLength(2));
    // The first says it closed as it is taken down, which must not let go of the reminder.
    expect(made[0]?.closed).toBe(true);
    expect(made[1]?.closed).toBe(false);
    notifier.waitEnded(ID);
    expect(made[1]?.closed).toBe(true);
  });

  test("a reminder with Deny and Allow that takes the place of the first is the one a poll takes down once its request goes", async () => {
    const { notifier, made } = setUp({ held: { ask: ask("npm test") } });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    await vi.waitFor(() => expect(made).toHaveLength(1));
    notifier.show(REMINDER, { kind: "wait", sessionId: ID, waitedMs: 10 * 60_000 });
    await vi.waitFor(() => expect(made).toHaveLength(2));
    notifier.observe({ sessions: [{ id: ID } as Session] });
    expect(made[1]?.closed).toBe(true);
  });

  test("with no buttons, is left by a poll that finds a request held after it was made, or none, and so is a reminder's, while the session still waits", async () => {
    const { notifier, made } = setUp({ held: {} });
    const late = { sessions: [{ id: ID, ask: ask("npm test") } as Session] };
    const none = { sessions: [{ id: ID } as Session] };
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    await vi.waitFor(() => expect(made).toHaveLength(1));
    expect(made[0]?.buttons).toEqual([]);
    notifier.observe(late);
    notifier.observe(none);
    expect(made[0]?.closed).toBe(false);

    notifier.show(REMINDER, { kind: "wait", sessionId: ID, waitedMs: 10 * 60_000 });
    await vi.waitFor(() => expect(made).toHaveLength(2));
    expect(made[1]?.buttons).toEqual([]);
    notifier.observe(late);
    notifier.observe(none);
    expect(made[1]?.closed).toBe(false);
    // Its wait ending is what takes it down.
    notifier.waitEnded(ID);
    expect(made[1]?.closed).toBe(true);
  });

  test("a wait that ends while its request is being read is never shown", async () => {
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { notifier, made } = setUp({ held: { ask: ask("npm test") }, gate });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    notifier.waitEnded(ID);
    open();
    await settle();
    expect(made).toEqual([]);
  });

  test("a wait whose request is being read when a later one of its session comes is not shown, and the later one is", async () => {
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { notifier, made } = setUp({ held: {}, gate });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    notifier.show(FINISHED, { kind: "over", sessionId: ID });
    open();
    await settle();
    expect(made.map((notification) => notification.options.body)).toEqual(["Finished"]);
  });

  test("the end of another session's wait, or of a wait never shown, takes nothing down", async () => {
    const { notifier, shown } = setUp({ held: {} });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    const notification = await shown();
    notifier.waitEnded(OTHER);
    expect(notification?.closed).toBe(false);
    expect(() => setUp().notifier.waitEnded(ID)).not.toThrow();
  });

  test("a finish, and a line the app tells about the session, are not taken down when its wait ends", () => {
    const { notifier, made } = setUp();
    notifier.show(FINISHED, { kind: "over", sessionId: ID });
    notifier.tell({ title: "checkout-flow", body: "That request is no longer held." }, ID);
    notifier.waitEnded(ID);
    expect(made.map((notification) => notification.closed)).toEqual([false, false]);
  });

  test("one with buttons the person cleared is let go, so its wait ending takes nothing down", async () => {
    const { notifier, shown } = setUp({ held: { ask: ask("npm test") } });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    const notification = await shown();
    notification?.dismiss();
    notifier.waitEnded(ID);
    expect(notification?.closes).toBe(0);
  });

  test("one with no buttons the person cleared is not heard to go, and its wait ending closes it again, which does nothing", async () => {
    const { notifier, shown } = setUp({ held: {} });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    const notification = await shown();
    notification?.dismiss();
    expect(() => notifier.waitEnded(ID)).not.toThrow();
    expect(notification?.closes).toBe(1);
  });
});

describe("one notification of a session at a time, as the page's tags keep", () => {
  test("a finish takes the place of the session's wait, and a later wait the place of the finish", async () => {
    const { notifier, made } = setUp({ held: {} });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    await vi.waitFor(() => expect(made).toHaveLength(1));
    notifier.show(FINISHED, { kind: "over", sessionId: ID });
    expect(made[0]?.closed).toBe(true);
    expect(made[1]?.closed).toBe(false);
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    await vi.waitFor(() => expect(made).toHaveLength(3));
    expect(made[1]?.closed).toBe(true);
    expect(made[2]?.closed).toBe(false);
  });

  test("a failure or an end takes the place of a finish, and a click on one opens the window on no session", () => {
    const { notifier, made, onClick } = setUp();
    notifier.show(FINISHED, { kind: "over", sessionId: ID });
    notifier.show({ title: "checkout-flow", body: "Ended" }, { kind: "over", sessionId: ID });
    expect(made.map((notification) => notification.closed)).toEqual([true, false]);
    made[1]?.click();
    expect(onClick).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  test("another session's notification takes nothing down", async () => {
    const { notifier, made } = setUp({ held: {} });
    notifier.show(FINISHED, { kind: "over", sessionId: ID });
    notifier.show(WAIT, { kind: "wait", sessionId: OTHER });
    await vi.waitFor(() => expect(made).toHaveLength(2));
    notifier.show({ title: "docs-site", body: "Failed" }, { kind: "over", sessionId: OTHER });
    expect(made.map((notification) => notification.closed)).toEqual([false, true, false]);
  });

  test("one the person cleared, with buttons, is let go, and a later one of its session takes nothing down", async () => {
    const { notifier, made } = setUp({ held: { ask: ask("npm test") } });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    await vi.waitFor(() => expect(made).toHaveLength(1));
    made[0]?.dismiss();
    notifier.show(FINISHED, { kind: "over", sessionId: ID });
    expect(made[0]?.closes).toBe(0);
  });

  test("past the last 20 finishes, the oldest is let go and left on show", () => {
    const { notifier, made } = setUp({ answers: false });
    const session = (n: number) =>
      `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    for (let n = 1; n <= 21; n += 1)
      notifier.show(FINISHED, { kind: "over", sessionId: session(n) });
    notifier.show(WAIT, { kind: "wait", sessionId: session(1) });
    notifier.show(WAIT, { kind: "wait", sessionId: session(2) });
    // Not taken down: it is no longer known. The second still is.
    expect(made[0]?.closes).toBe(0);
    expect(made[1]?.closed).toBe(true);
  });

  test("a summary of quiet hours takes the place of the last, and a click opens the window", () => {
    const { notifier, made, onClick } = setUp();
    notifier.show({ title: "While quiet", body: "checkout-flow finished" }, { kind: "summary" });
    notifier.show({ title: "While quiet", body: "docs-site failed" }, { kind: "summary" });
    expect(made.map((notification) => notification.closed)).toEqual([true, false]);
    made[1]?.click();
    expect(onClick).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  test("a line the app tells about a press is left beside a later notification of its session, and a click on it opens the session's details", async () => {
    const { notifier, made, onClick } = setUp({ held: {} });
    notifier.tell({ title: "checkout-flow", body: "That request is no longer held." }, ID);
    notifier.show(REMINDER, { kind: "wait", sessionId: ID, waitedMs: 10 * 60_000 });
    await vi.waitFor(() => expect(made).toHaveLength(2));
    notifier.show(FINISHED, { kind: "over", sessionId: ID });
    expect(made.map((notification) => notification.closed)).toEqual([false, true, false]);
    made[0]?.click();
    expect(onClick).toHaveBeenCalledExactlyOnceWith(ID);
  });

  test("a notification about nothing in particular takes nothing down", () => {
    const { notifier, made } = setUp();
    notifier.show({ title: "While quiet", body: "checkout-flow finished" }, { kind: "summary" });
    notifier.show(FINISHED, { kind: "over", sessionId: ID });
    notifier.show({ title: "checkout-flow", body: "Finished" });
    expect(made.map((notification) => notification.closed)).toEqual([false, false, false]);
  });
});

describe("waits switched off", () => {
  test("take down the notification of every wait, with buttons or none, and leave a finish and the summary", async () => {
    const { notifier, made } = setUp({ held: { ask: ask("npm test") } });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    await vi.waitFor(() => expect(made).toHaveLength(1));
    const plain = setUp({ answers: false });
    plain.notifier.show(WAIT, { kind: "wait", sessionId: ID });
    plain.notifier.show({ title: "docs-site", body: "Failed" }, { kind: "over", sessionId: OTHER });
    plain.notifier.show(
      { title: "While quiet", body: "checkout-flow finished" },
      { kind: "summary" },
    );

    notifier.waitsOff();
    plain.notifier.waitsOff();
    expect(made[0]?.closed).toBe(true);
    expect(plain.made.map((notification) => notification.closed)).toEqual([true, false, false]);
    // Nothing is left for its wait's end to take down.
    notifier.waitEnded(ID);
    expect(made[0]?.closes).toBe(1);
  });

  test("drop a wait whose request is being read, so it is never shown", async () => {
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { notifier, made } = setUp({ held: {}, gate });
    notifier.show(WAIT, { kind: "wait", sessionId: ID });
    notifier.waitsOff();
    open();
    await settle();
    expect(made).toEqual([]);
  });
});

describe("as the app wires it to the collector's notifications", () => {
  /** The collector's notifications over this notifier, built as `main.ts` builds them. */
  function wired(held: Pick<Session, "ask">) {
    const app = setUp({ held });
    let now = NOW;
    const notifications = createServerNotifications({
      notifier: app.notifier,
      onAtStart: false,
      now: () => now,
    });
    return {
      ...app,
      /** A poll this long after the start, with the session as it is. */
      poll(atMs: number, status: Session["status"]) {
        now = NOW + atMs;
        notifications.handle({
          generatedAt: now,
          sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: now }],
          sessions: [
            makeSession({
              id: ID,
              name: "checkout-flow",
              status,
              ...(status === "needs-you" && { waitingReason: "permission" as const }),
            }),
          ],
        });
      },
      /** The page in the window fetches the sessions, saying which events are on. */
      page(atMs: number, said: NoticeEvent[]) {
        now = NOW + atMs;
        notifications.pageSaid(said, true);
      },
    };
  }

  test("the page in the window shows none, so a wait is shown at once, and once, with Deny and Allow, though the page says on and fetches the sessions every 2 seconds", async () => {
    const app = wired({ ask: ask("npm test") });
    // The notifier says so itself, so the collector needs telling nothing more.
    expect(app.notifier.pagesNotify).toBe(false);
    app.page(0, ["needs-you"]);
    app.poll(0, "working");
    app.page(1_000, ["needs-you"]);
    app.poll(2_000, "needs-you");
    const notification = await app.shown();
    expect(notification?.buttons).toEqual(["Deny", "Allow"]);
    for (const at of [3_000, 5_000, 7_000]) {
      app.page(at, ["needs-you"]);
      app.poll(at + 1_000, "needs-you");
    }
    await settle();
    expect(app.made).toHaveLength(1);

    // The session moves on: the collector says its wait ended, and it is taken down.
    app.poll(10_000, "working");
    expect(notification?.closed).toBe(true);
  });

  test("Needs you switched off in the window takes down the notification of a wait, and leaves a finish", async () => {
    const app = wired({});
    app.page(0, ["needs-you", "finished"]);
    app.poll(0, "working");
    app.poll(2_000, "finished");
    app.poll(4_000, "working");
    app.poll(6_000, "needs-you");
    await vi.waitFor(() => expect(app.made).toHaveLength(2));
    // The wait took the place of the finish, as the page's tag does.
    expect(app.made[0]?.closed).toBe(true);

    app.page(7_000, ["finished"]);
    expect(app.made[1]?.closed).toBe(true);
  });
});

test("a line the app tells has no buttons, and a click opens the session it is about", () => {
  const { notifier, made, onClick } = setUp({ held: { ask: ask("npm test") } });
  notifier.tell(
    { title: "checkout-flow", body: "That request is no longer held, so nothing was sent." },
    ID,
  );
  expect(made[0]?.buttons).toEqual([]);
  expect(made[0]?.options.body).toBe("That request is no longer held, so nothing was sent.");
  made[0]?.click();
  expect(onClick).toHaveBeenCalledWith(ID);
});

describe("a test notification", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("says what it is and nothing of a session, and resolves shown once macOS shows it", async () => {
    const { notifier, made, onClick } = setUp();
    const answer = notifier.test();
    expect(made).toHaveLength(1);
    expect(made[0]?.options).toEqual({
      title: "Agent Lookout",
      body: "This is a test notification.",
    });
    expect(made[0]?.options).toEqual(TEST_NOTICE);
    expect(made[0]?.shown).toBe(true);
    made[0]?.appear();
    await expect(answer).resolves.toEqual({ outcome: "shown" });
    expect(notifier.lastRefusal()).toBeNull();
    // A click opens the window, on no session.
    made[0]?.click();
    expect(onClick).toHaveBeenCalledExactlyOnceWith();
  });

  test("resolves refused with macOS's reason, keeps the reason, and says it once", async () => {
    const { notifier, made, warn } = setUp();
    const answer = notifier.test();
    made[0]?.fail("Notifications are not allowed for this application");
    await expect(answer).resolves.toEqual({
      outcome: "refused",
      reason: "Notifications are not allowed for this application",
    });
    expect(notifier.lastRefusal()).toBe("Notifications are not allowed for this application");
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "macOS did not show a notification from Agent Lookout: Notifications are not allowed for this application",
    );

    // A second refusal is kept, and not said again.
    const again = notifier.test();
    made[1]?.fail("not allowed");
    await expect(again).resolves.toEqual({ outcome: "refused", reason: "not allowed" });
    expect(notifier.lastRefusal()).toBe("not allowed");
    expect(warn).toHaveBeenCalledOnce();
  });

  test("resolves unsupported, and makes nothing, where notifications are not supported", async () => {
    const { notifier, made } = setUp({ supported: false });
    await expect(notifier.test()).resolves.toEqual({ outcome: "unsupported" });
    expect(made).toEqual([]);
    expect(notifier.lastRefusal()).toBeNull();
  });

  test("resolves with no answer once the time is up when macOS says nothing, as while it asks the person", async () => {
    vi.useFakeTimers();
    const { notifier, made } = setUp();
    let answered: unknown = null;
    void notifier.test().then((outcome) => {
      answered = outcome;
    });
    await vi.advanceTimersByTimeAsync(TEST_ANSWER_MS - 1);
    expect(answered).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(answered).toEqual({ outcome: "no-answer" });
    // macOS answers later: the refusal is still kept for Settings to read.
    made[0]?.fail("not allowed");
    expect(answered).toEqual({ outcome: "no-answer" });
    expect(notifier.lastRefusal()).toBe("not allowed");
  });

  test("resolves unsupported, never rejects, when Electron throws making it, and keeps no refusal, since macOS gave none", async () => {
    const notifier = createDesktopNotifier({
      notifications: {
        isSupported: () => true,
        create: () => {
          throw new Error("no  notification\ncenter");
        },
      },
      onClick: () => {},
    });
    await expect(notifier.test()).resolves.toEqual({ outcome: "unsupported" });
    expect(notifier.lastRefusal()).toBeNull();
  });
});

describe("the last refusal", () => {
  test("is none until macOS refuses a notification, and is kept from any notification, not only a test", () => {
    const { notifier, made } = setUp();
    expect(notifier.lastRefusal()).toBeNull();
    notifier.show({ title: "billing-webhooks", body: "Finished" });
    made[0]?.fail("not allowed");
    expect(notifier.lastRefusal()).toBe("not allowed");
  });

  test("goes once macOS shows a notification again", () => {
    const { notifier, made } = setUp();
    notifier.show({ title: "billing-webhooks", body: "Finished" });
    made[0]?.fail("not allowed");
    notifier.show({ title: "billing-webhooks", body: "Failed" });
    made[1]?.appear();
    expect(notifier.lastRefusal()).toBeNull();
  });

  test("says that macOS gave no reason when it gave none", async () => {
    const { notifier, made } = setUp();
    const answer = notifier.test();
    made[0]?.fail("  ");
    await expect(answer).resolves.toEqual({ outcome: "refused", reason: "macOS gave no reason." });
    expect(notifier.lastRefusal()).toBe("macOS gave no reason.");
  });
});
