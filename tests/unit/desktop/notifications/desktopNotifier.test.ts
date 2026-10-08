import { afterEach, describe, expect, test, vi } from "vitest";

import type { PermissionAsk, Session } from "@core/sessions/session";
import type { AnswerPress } from "@desktop/answers/desktopAnswers";
import {
  createDesktopNotifier,
  TEST_ANSWER_MS,
  TEST_NOTICE,
  type NoticeAnswers,
} from "@desktop/notifications/desktopNotifier";
import { fakeNotifications } from "@tests/support/desktop/electronStandIns";

const NOW = 1_700_000_600_000;
const ID = "claude-code:00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "0123456789abcdef0123456789abcdef";
const WAIT = { title: "checkout-flow", body: "Waiting for permission: Run: npm test" };

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
  } = {},
) {
  let now = NOW;
  const notifications = fakeNotifications(options.supported ?? true);
  const pressed: AnswerPress[] = [];
  const answers: NoticeAnswers = {
    heldFor: vi.fn(async () => {
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
    notifier.show(WAIT, { sessionId: ID });
    const notification = await shown();
    expect(notification?.options).toEqual(WAIT);
    expect(notification?.buttons).toEqual([]);
    notification?.click();
    expect(onClick).toHaveBeenCalledWith(ID);
  });

  test("of a request that fits whole has the command as its text, and Deny then Allow", async () => {
    const { notifier, shown } = setUp({ held: { ask: ask("npm test && npm run build") } });
    notifier.show(WAIT, { sessionId: ID });
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
    notifier.show(WAIT, { sessionId: ID });
    const notification = await shown();
    expect(notification?.buttons).toEqual(["Deny"]);
    expect(notification?.options.body).toMatch(/^To allow it, open Agent Lookout/);
  });

  test("a press goes to the answers, with the session, the request and the later of when it was shown and macOS said so", async () => {
    const { notifier, pressed, tick, shown } = setUp({ held: { ask: ask("npm test") } });
    notifier.show(WAIT, { sessionId: ID });
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
    notifier.show(WAIT, { sessionId: ID });
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
    notifier.show(WAIT, { sessionId: ID });
    const notification = await shown();
    expect(() => notification?.press("Allow")).toThrow();
    expect(pressed).toEqual([]);
  });

  test("is taken down once its request is no longer held, and kept while it is", async () => {
    const { notifier, shown } = setUp({ held: { ask: ask("npm test") } });
    notifier.show(WAIT, { sessionId: ID });
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
    notifier.show(WAIT, { sessionId: ID });
    await vi.waitFor(() => expect(made).toHaveLength(1));
    notifier.show(
      { title: "checkout-flow", body: "Has waited 10 minutes for permission" },
      { sessionId: ID, waitedMs: 10 * 60_000 },
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
    without.notifier.show(WAIT, { sessionId: ID });
    expect(without.made[0]?.buttons).toEqual([]);

    const failing = setUp({ heldFails: true });
    failing.notifier.show(WAIT, { sessionId: ID });
    expect((await failing.shown())?.options).toEqual(WAIT);
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
