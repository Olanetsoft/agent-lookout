import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { NotificationTestOutcome } from "@core/notices/appNotifications";
import { NotificationPrompt } from "@dashboard/components/dashboard/NotificationPrompt";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import { setNotificationHost } from "@dashboard/lib/notifications/notificationHost";
import {
  NOTIFICATIONS_STORAGE_KEY,
  resetNotificationSettingForTests,
} from "@dashboard/lib/notifications/notificationSetting";
import { pointAway, startAtTop } from "@tests/support/browser/browser";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";
import { fakeNotificationHost, type FakeNotificationHost } from "@tests/support/notifications";

/**
 * The page's notifications are a stand-in, granted as the app's window grants
 * them whatever macOS decides, so nothing asks this browser for permission.
 * The test notification is a stand-in too, and so is the app: no request
 * leaves the page.
 */
let host: FakeNotificationHost;
let sendTest: ReturnType<typeof vi.fn<() => Promise<NotificationTestOutcome | null>>>;
let asked: string[];

const QUESTION = "Get a notification when a session needs you?";

beforeEach(() => {
  host = fakeNotificationHost({ permission: "granted" });
  setNotificationHost(host);
  sendTest = vi.fn(async () => ({ outcome: "shown" }) as const);
  asked = [];
  setApiHost(async (path) => {
    asked.push(path);
    throw new TypeError("Failed to fetch");
  });
});

afterEach(() => {
  localStorage.clear();
  resetNotificationSettingForTests();
  setNotificationHost();
  setApiHost();
});

/** The prompt as the Overview draws it in the app's window, inside the view. */
function inTheApp() {
  return render(
    <main tabIndex={-1} aria-label='Overview'>
      <NotificationPrompt inApp sendTest={sendTest} />
    </main>,
  );
}

type Screen = Awaited<ReturnType<typeof render>>;

/** The polite line a screen reader is told what Turn on came to in. */
const saidIn = (screen: Screen) =>
  screen.container.querySelector('[data-part="prompt-said"]') as HTMLElement | null;

/** The note or the question, or null while neither is drawn. */
const calloutIn = (screen: Screen) =>
  screen.container.querySelector<HTMLElement>('[data-slot="callout"]');

/** A test that macOS answers only when the test lets it. */
function heldTest(outcome: NotificationTestOutcome | null) {
  let release = () => {};
  sendTest = vi.fn(
    () =>
      new Promise<NotificationTestOutcome | null>((resolve) => {
        release = () => resolve(outcome);
      }),
  );
  return () => release();
}

const REFUSED: NotificationTestOutcome = {
  outcome: "refused",
  reason: "Notifications are not allowed for this application",
};

test("in the app, with no choice ever stored, it asks once whether to turn notifications on", async () => {
  const screen = await inTheApp();
  await expect.element(screen.getByText(QUESTION)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Turn on" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Not now" })).toBeVisible();
  expect(screen.container.textContent).toContain(
    "macOS shows one from Agent Lookout each time a session starts waiting for you, with this window open or closed. You can change this in Settings.",
  );
  // Drawing it changes nothing and sends nothing.
  expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBeNull();
  expect(sendTest).not.toHaveBeenCalled();
  expect(host.shown).toEqual([]);
});

test("Turn on stores on, sends the test so macOS asks then, and the question goes", async () => {
  const screen = await inTheApp();
  await screen.getByRole("button", { name: "Turn on" }).click();

  expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe("on");
  await vi.waitFor(() => expect(sendTest).toHaveBeenCalledOnce());
  await expect.element(screen.getByText(QUESTION)).not.toBeInTheDocument();
  // The page asked the browser nothing: the app's window has already allowed it.
  expect(host.asked).toBe(0);
});

test("its two buttons are a group named by the question, and keep their words", async () => {
  const screen = await inTheApp();
  const group = screen.getByRole("group", { name: QUESTION });
  await expect.element(group).toBeVisible();
  expect(
    [...group.element().querySelectorAll("button")].map((button) => button.textContent),
  ).toEqual(["Turn on", "Not now"]);
  const title = document.getElementById(group.element().getAttribute("aria-labelledby") ?? "");
  expect(title?.textContent).toBe(QUESTION);
  expect(calloutIn(screen)?.contains(title)).toBe(true);
});

test("while the test is out the question stays, with a line in place of its buttons; once macOS shows it the question goes, and a screen reader is told once", async () => {
  const release = heldTest({ outcome: "shown" });
  const screen = await inTheApp();
  const said = saidIn(screen);
  expect(said?.getAttribute("role")).toBe("status");
  expect(said?.textContent).toBe("");
  const before = calloutIn(screen)?.getBoundingClientRect().height;

  await screen.getByRole("button", { name: "Turn on" }).click();
  await vi.waitFor(() => expect(sendTest).toHaveBeenCalledOnce());
  await expect.element(screen.getByText(QUESTION)).toBeVisible();
  expect(screen.container.querySelectorAll("button")).toHaveLength(0);
  expect(screen.container.querySelector('[data-part="sending"]')?.textContent).toBe(
    "Sending a test…",
  );
  // The note keeps its height as the buttons go.
  expect(calloutIn(screen)?.getBoundingClientRect().height).toBe(before);
  expect(said?.textContent).toBe("Sending a test…");
  expect(document.activeElement).toBe(screen.getByRole("main").element());

  release();
  await expect.element(screen.getByText(QUESTION)).not.toBeInTheDocument();
  expect(screen.container.querySelector('[data-slot="notification-prompt"]')).toBeNull();
  // The same line, there from the start, says it once.
  expect(saidIn(screen)).toBe(said);
  expect(said?.textContent).toBe("Notifications are on in this app.");
  const changes: MutationRecord[] = [];
  const watcher = new MutationObserver((records) => changes.push(...records));
  watcher.observe(said as HTMLElement, { childList: true, characterData: true, subtree: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  watcher.disconnect();
  expect(changes).toEqual([]);
  // Out of the flow, so it adds no gap to the view.
  expect(getComputedStyle(said as HTMLElement).position).toBe("absolute");
});

/** Every live region in the prompt: what a screen reader is told of as it changes. */
const liveIn = (screen: Screen) => [
  ...screen.container.querySelectorAll('[role="status"], [role="alert"], [aria-live]'),
];

/** The live region a change was made in, or null when it was made in none. */
function liveRegionOf(change: MutationRecord): Element | null {
  const node = change.target;
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest('[role="status"], [role="alert"], [aria-live]') ?? null;
}

test("from Turn on to the note, only the line under it speaks, so each step is said once", async () => {
  const release = heldTest(REFUSED);
  const screen = await inTheApp();
  const said = saidIn(screen) as HTMLElement;
  expect(liveIn(screen)).toEqual([said]);
  const changes: MutationRecord[] = [];
  const watcher = new MutationObserver((records) => changes.push(...records));
  watcher.observe(screen.container, { childList: true, characterData: true, subtree: true });

  await screen.getByRole("button", { name: "Turn on" }).click();
  await vi.waitFor(() => expect(sendTest).toHaveBeenCalledOnce());
  expect(screen.container.querySelector('[data-part="sending"]')?.textContent).toBe(
    "Sending a test…",
  );
  expect(liveIn(screen)).toEqual([said]);

  release();
  await expect
    .element(screen.getByText("macOS did not show the test notification", { exact: true }))
    .toBeVisible();
  expect(liveIn(screen)).toEqual([said]);
  watcher.disconnect();

  // The question, its line and the note all changed, and none of that in a live region.
  expect(changes.length).toBeGreaterThan(0);
  expect(changes.map(liveRegionOf).filter((region) => region !== null && region !== said)).toEqual(
    [],
  );
  expect(said.textContent).toBe(
    "macOS did not show the test notification. Open Settings and send a test under Notifications to see why and what to do.",
  );
});

test.each<[string, NotificationTestOutcome]>([
  ["refused", REFUSED],
  ["could not be shown", { outcome: "unsupported" }],
])(
  "when the test is %s, a quiet note in the question's place says macOS did not show it and links to Settings",
  async (_what, outcome) => {
    sendTest = vi.fn(async () => outcome);
    const screen = await inTheApp();
    await screen.getByRole("button", { name: "Turn on" }).click();

    await expect
      .element(screen.getByText("macOS did not show the test notification", { exact: true }))
      .toBeVisible();
    const note = calloutIn(screen) as HTMLElement;
    expect(note.dataset.tone).toBe("info");
    // Not a live region: the line under it says the note, once.
    expect(note.getAttribute("role")).toBeNull();
    expect([...note.querySelectorAll("p")].map((line) => line.textContent)).toEqual([
      "macOS did not show the test notification",
      "Open Settings and send a test under Notifications to see why and what to do.",
    ]);
    const link = screen.getByRole("link", { name: "Settings" });
    expect(link.element().getAttribute("href")).toBe("#settings");
    expect(screen.container.textContent).not.toContain(QUESTION);
    // macOS's own words are for Settings, which says what to do with them.
    expect(screen.container.textContent).not.toContain("not allowed for this application");
    expect(saidIn(screen)?.textContent).toBe(
      "macOS did not show the test notification. Open Settings and send a test under Notifications to see why and what to do.",
    );
    // The choice stands: notifications are on, and Settings says why macOS does not show them.
    expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe("on");
    await pointAway();
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("when macOS has not answered yet, as while it asks, the note says to allow it, and is not an error", async () => {
  sendTest = vi.fn(async () => ({ outcome: "no-answer" }) as const);
  const screen = await inTheApp();
  await screen.getByRole("button", { name: "Turn on" }).click();

  await expect
    .element(screen.getByText("macOS has not answered yet", { exact: true }))
    .toBeVisible();
  const note = calloutIn(screen) as HTMLElement;
  expect(note.dataset.tone).toBe("info");
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  expect([...note.querySelectorAll("p")].map((line) => line.textContent)).toEqual([
    "macOS has not answered yet",
    "If macOS asks whether Agent Lookout may show notifications, allow them. Settings can send another test, under Notifications.",
  ]);
  expect(screen.getByRole("link", { name: "Settings" }).element().getAttribute("href")).toBe(
    "#settings",
  );
  expect(saidIn(screen)?.textContent).toBe(
    "macOS has not answered yet. If macOS asks whether Agent Lookout may show notifications, allow them. Settings can send another test, under Notifications.",
  );
});

test("when the app does not answer, the note says the test was not sent", async () => {
  sendTest = vi.fn(async () => null);
  const screen = await inTheApp();
  await screen.getByRole("button", { name: "Turn on" }).click();

  await expect.element(screen.getByText("The test was not sent", { exact: true })).toBeVisible();
  expect(
    [...(calloutIn(screen) as HTMLElement).querySelectorAll("p")].map((l) => l.textContent),
  ).toEqual([
    "The test was not sent",
    "Agent Lookout did not answer. Settings can send another test, under Notifications.",
  ]);
});

test("the note can be dismissed, focus stays in the view, and neither it nor the question comes back", async () => {
  sendTest = vi.fn(async () => REFUSED);
  const screen = await inTheApp();
  await screen.getByRole("button", { name: "Turn on" }).click();
  await expect
    .element(screen.getByText("macOS did not show the test notification", { exact: true }))
    .toBeVisible();

  await screen.getByRole("button", { name: "Dismiss" }).click();
  expect(calloutIn(screen)).toBeNull();
  expect(screen.container.querySelector('[data-slot="notification-prompt"]')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("main").element());
  expect(saidIn(screen)?.textContent).toBe("");

  // The setting read again, as when another window changes it, brings nothing back.
  window.dispatchEvent(new StorageEvent("storage", { key: NOTIFICATIONS_STORAGE_KEY }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(calloutIn(screen)).toBeNull();

  await screen.unmount();
  resetNotificationSettingForTests();
  const again = await inTheApp();
  expect(calloutIn(again)).toBeNull();
  expect(saidIn(again)).toBeNull();
});

test("a note left alone goes the next time the Overview is drawn", async () => {
  sendTest = vi.fn(async () => ({ outcome: "no-answer" }) as const);
  const first = await inTheApp();
  await first.getByRole("button", { name: "Turn on" }).click();
  await expect
    .element(first.getByText("macOS has not answered yet", { exact: true }))
    .toBeVisible();
  await first.unmount();

  resetNotificationSettingForTests();
  const again = await inTheApp();
  expect(again.container.textContent).toBe("");
  expect(calloutIn(again)).toBeNull();
});

test("when this window may not show notifications, Turn on stores nothing and sends no test, and the question stays", async () => {
  host.state = "denied";
  const screen = await inTheApp();
  await screen.getByRole("button", { name: "Turn on" }).click();
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(sendTest).not.toHaveBeenCalled();
  expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBeNull();
  await expect.element(screen.getByRole("group", { name: QUESTION })).toBeVisible();
  expect(saidIn(screen)?.textContent).toBe("");
});

test("Not now stores off, sends nothing, and the question goes", async () => {
  const screen = await inTheApp();
  await screen.getByRole("button", { name: "Not now" }).click();

  expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe("off");
  await expect.element(screen.getByText(QUESTION)).not.toBeInTheDocument();
  expect(sendTest).not.toHaveBeenCalled();
});

test.each(["Turn on", "Not now"])(
  "after %s it never shows again, when the page is drawn again",
  async (answer) => {
    const first = await inTheApp();
    await first.getByRole("button", { name: answer }).click();
    await expect.element(first.getByText(QUESTION)).not.toBeInTheDocument();
    await first.unmount();

    // As a page that has just loaded reads it.
    resetNotificationSettingForTests();
    const again = await inTheApp();
    expect(again.container.textContent).not.toContain(QUESTION);
    expect(again.container.querySelector('[data-slot="notification-prompt"]')).toBeNull();
  },
);

test.each(["on", "off"])("with %s already stored it is not shown", async (stored) => {
  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, stored);
  const screen = await inTheApp();
  expect(screen.container.textContent).not.toContain(QUESTION);
});

test("in a browser it is never shown, and nothing is sent or stored", async () => {
  const screen = await render(<NotificationPrompt inApp={false} sendTest={sendTest} />);
  expect(screen.container.innerHTML).toBe("");
  expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBeNull();
  expect(sendTest).not.toHaveBeenCalled();
  expect(asked).toEqual([]);
});

test("in a browser by default, as a page served over http is", async () => {
  const screen = await render(<NotificationPrompt />);
  expect(screen.container.innerHTML).toBe("");
  expect(asked).toEqual([]);
});

test("its two buttons are reached by Tab, show the focus ring, and Enter answers; focus stays in the view", async () => {
  const screen = await inTheApp();
  const turnOn = screen.getByRole("button", { name: "Turn on" }).element();
  const notNow = screen.getByRole("button", { name: "Not now" }).element();
  await pointAway();

  startAtTop();
  await userEvent.tab();
  expect(document.activeElement).toBe(turnOn);
  const style = getComputedStyle(turnOn);
  expect(style.outlineStyle).toBe("solid");
  expect(style.outlineWidth).toBe("2px");
  expect(style.outlineColor).toBe(rgbOf("var(--focus)"));
  await userEvent.tab();
  expect(document.activeElement).toBe(notNow);

  await userEvent.keyboard("{Enter}");
  expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe("off");
  await expect.element(screen.getByText(QUESTION)).not.toBeInTheDocument();
  // Not dropped to the top of the page: the view holds it.
  expect(document.activeElement).toBe(screen.getByRole("main").element());
});

test.each(["dark", "light"] as const)(
  "in the %s theme it is the quiet info note with two quiet buttons, and nothing warm",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      const screen = await inTheApp();
      await expect.element(screen.getByText(QUESTION)).toBeVisible();
      await pointAway();
      const callout = screen.container.querySelector('[data-slot="callout"]') as HTMLElement;
      expect(callout.dataset.tone).toBe("info");
      expect(getComputedStyle(callout).backgroundColor).toBe(rgbOf("var(--fill-quiet)"));
      for (const button of screen.container.querySelectorAll("button")) {
        expect(button.dataset.variant).toBe("quiet");
      }
      expect(warmPaint(screen.container)).toEqual([]);
    } finally {
      document.documentElement.removeAttribute("data-theme");
    }
  },
);

test("at 375 the words keep their width: the buttons sit under them and do not overflow", async () => {
  const screen = await render(
    <div style={{ width: "283px" }}>
      <NotificationPrompt inApp sendTest={sendTest} />
    </div>,
  );
  await expect.element(screen.getByText(QUESTION)).toBeVisible();
  const callout = screen.container.querySelector('[data-slot="callout"]') as HTMLElement;
  const words = screen.getByText(QUESTION).element();
  const buttons = [...callout.querySelectorAll("button")];
  for (const button of buttons) {
    expect(button.getBoundingClientRect().top).toBeGreaterThan(
      words.getBoundingClientRect().bottom,
    );
    expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(
      callout.getBoundingClientRect().right,
    );
  }
  expect(callout.scrollWidth).toBeLessThanOrEqual(callout.clientWidth);
});
