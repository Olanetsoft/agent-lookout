import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { EmailStatusResponse, HistoryResponse, WebhookStatusResponse } from "@core/api";
import { SettingsView } from "@dashboard/components/settings/SettingsView";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import { setNotificationHost } from "@dashboard/lib/notifications/notificationHost";
import {
  NOTIFICATION_EVENTS_STORAGE_KEY,
  NOTIFICATIONS_STORAGE_KEY,
  resetNotificationSettingForTests,
} from "@dashboard/lib/notifications/notificationSetting";
import { resetThemeForTests, THEME_STORAGE_KEY } from "@dashboard/lib/shell/theme";
import { pointAway, startAtTop } from "@tests/support/browser/browser";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";
import { preferColorScheme } from "@tests/support/browser/media";
import { fakeNotificationHost, type FakeNotificationHost } from "@tests/support/notifications";

/**
 * The notification system is a stand-in in every test here, so nothing asks
 * this browser for permission. It starts as a browser that has not been asked,
 * and whose person would say yes.
 */
let host: FakeNotificationHost;

/** What the app says about email, as `/api/email` would. Off unless a test says otherwise. */
const EMAIL_OFF: EmailStatusResponse = {
  on: false,
  to: null,
  events: null,
  afterMs: null,
  asking: null,
  problem: null,
  last: null,
  limitedUntil: null,
};
let email: EmailStatusResponse | null;
/** What the app says about the webhook, as `/api/webhook` would. Off unless a test says otherwise. */
const WEBHOOK_OFF: WebhookStatusResponse = {
  on: false,
  host: null,
  events: null,
  afterMs: null,
  asking: null,
  problem: null,
  last: null,
  limitedUntil: null,
};
let webhook: WebhookStatusResponse | null;
/** The paths the view asked the app for. */
let asked: string[];

beforeEach(() => {
  host = fakeNotificationHost();
  setNotificationHost(host);
  email = EMAIL_OFF;
  webhook = WEBHOOK_OFF;
  asked = [];
  setApiHost(async (path) => {
    asked.push(path);
    const answer = path === "/api/webhook" ? webhook : email;
    if (answer === null) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(answer), {
      headers: { "Content-Type": "application/json" },
    });
  });
});

afterEach(() => {
  localStorage.clear();
  resetThemeForTests();
  resetNotificationSettingForTests();
  setNotificationHost();
  setApiHost();
  document.documentElement.removeAttribute("data-theme");
});

test("the theme offers Night, Day and System, named for assistive technology, with Night the default", async () => {
  const screen = await render(<SettingsView />);
  const theme = screen.getByRole("radiogroup", { name: "Theme" });

  await expect.element(screen.getByRole("region", { name: "Theme" })).toBeVisible();
  expect(
    [...theme.element().querySelectorAll('[role="radio"]')].map((radio) => [
      radio.textContent,
      radio.getAttribute("aria-label"),
    ]),
  ).toEqual([
    ["Night", "Dark theme"],
    ["Day", "Light theme"],
    ["System", "Follow the computer's setting"],
  ]);
  await expect.element(screen.getByRole("radio", { name: "Dark theme" })).toBeChecked();
});

test("a theme chosen here is applied and remembered", async () => {
  const screen = await render(<SettingsView />);

  await screen.getByRole("radio", { name: "Light theme" }).click();
  expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  expect(getComputedStyle(document.documentElement).backgroundColor).toBe("rgb(212, 208, 202)");
  await expect.element(screen.getByRole("radio", { name: "Light theme" })).toBeChecked();

  // Remembered: the page is drawn afresh and the choice is still there.
  await screen.unmount();
  resetThemeForTests();
  const again = await render(<SettingsView />);
  await expect.element(again.getByRole("radio", { name: "Light theme" })).toBeChecked();
});

test("System follows the computer's setting, and changes when it does", async () => {
  await preferColorScheme("light");
  const screen = await render(<SettingsView />);

  await screen.getByRole("radio", { name: "Follow the computer's setting" }).click();
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  expect(document.documentElement.getAttribute("data-theme")).toBe("light");

  await preferColorScheme("dark");
  await vi.waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("dark"));
  expect(getComputedStyle(document.documentElement).backgroundColor).toBe("rgb(9, 9, 8)");
  // The choice is still System: only what it resolves to has changed.
  await expect
    .element(screen.getByRole("radio", { name: "Follow the computer's setting" }))
    .toBeChecked();
});

test("the facts about this copy say its version and that Agent Lookout sends its data nowhere", async () => {
  const screen = await render(<SettingsView />);
  const copy = screen.getByRole("region", { name: "This copy" });

  const rows = [...copy.element().querySelectorAll('[data-slot="fact-row"]')].map((row) => [
    row.querySelector("dt")?.textContent,
    row.querySelector("dd")?.textContent,
  ]);
  expect(rows).toEqual([
    ["Version", `v${__APP_VERSION__}`],
    ["Your data", "Agent Lookout sends it nowhere"],
  ]);
  expect(__APP_VERSION__).toMatch(/^\d+\.\d+\.\d+/);
});

test("in a browser there is no Updates card, and nothing asks about updates", async () => {
  const screen = await render(<SettingsView />);
  await expect.element(screen.getByRole("region", { name: "This copy" })).toBeVisible();
  expect(screen.getByRole("region", { name: "Updates" }).elements()).toHaveLength(0);
  expect(asked.some((path) => path.startsWith("/api/app/"))).toBe(false);
});

test("in the Mac app, Updates follows History, among the settings the page changes", async () => {
  const screen = await render(<SettingsView inApp />);
  await expect.element(screen.getByRole("region", { name: "Updates" })).toBeVisible();
  const titles = [...screen.container.querySelectorAll('[data-slot="section-card"] h2')].map(
    (title) => title.textContent,
  );
  expect(titles).toEqual([
    "Theme",
    "Notifications",
    "History",
    "Updates",
    "Email",
    "Webhook",
    "This copy",
  ]);
  // In the left column, with Theme, Notifications and History.
  const notifications = screen.getByRole("region", { name: "Notifications" }).element();
  const updates = screen.getByRole("region", { name: "Updates" }).element();
  expect(updates.parentElement).toBe(notifications.parentElement);
  expect(asked).toContain("/api/app/update");
});

test.each(["dark", "light"] as const)(
  "in the %s theme the view is glass cards, with no warm colour",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(<SettingsView />);

    const cards = screen.container.querySelectorAll('[data-slot="section-card"]');
    expect(cards).toHaveLength(6);
    for (const card of cards) {
      expect(getComputedStyle(card).backgroundColor).toBe(rgbOf("var(--glass-card)"));
      expect(getComputedStyle(card).borderRadius).toBe("24px");
      expect(getComputedStyle(card).backdropFilter).toBe("none");
    }
    // The choice of theme is the recessed well with its thumb.
    const well = screen.getByRole("radiogroup").element();
    expect(getComputedStyle(well).backgroundColor).toBe(rgbOf("var(--well)"));
    expect(well.querySelector('[data-part="thumb"]')).not.toBeNull();
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

const notifications = (screen: Awaited<ReturnType<typeof render>>) =>
  screen.getByRole("region", { name: "Notifications" });

/** The line that says whether email is set up. */
const emailState = (screen: Awaited<ReturnType<typeof render>>) =>
  screen
    .getByRole("region", { name: "Email" })
    .element()
    .querySelector('[data-part="state"]') as HTMLElement;

/** The line that says whether the webhook is set up. */
const webhookState = (screen: Awaited<ReturnType<typeof render>>) =>
  screen
    .getByRole("region", { name: "Webhook" })
    .element()
    .querySelector('[data-part="state"]') as HTMLElement;

/** The words that say whether notifications are on. */
const stateOf = (screen: Awaited<ReturnType<typeof render>>) =>
  notifications(screen).element().querySelector('[data-part="state"]') as HTMLElement;

test("notifications are off by default, said in words beside one button that turns them on", async () => {
  const screen = await render(<SettingsView />);
  const card = notifications(screen);

  await expect.element(card).toBeVisible();
  expect(stateOf(screen).textContent).toBe("Notifications are off.");
  // The state is said again to a screen reader when it changes.
  expect(stateOf(screen).getAttribute("aria-live")).toBe("polite");
  const buttons = card.getByRole("button").elements();
  expect(buttons.map((button) => button.textContent)).toEqual(["Turn on notifications"]);
  // Nothing is wrong, so there is no note.
  expect(card.element().querySelector('[data-slot="callout"]')).toBeNull();
  expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBeNull();
});

test("drawing the view never asks the browser for permission, whatever was chosen before", async () => {
  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "on");

  const screen = await render(<SettingsView />);
  await expect.element(notifications(screen)).toBeVisible();
  await screen.rerender(<SettingsView />);

  expect(host.asked).toBe(0);
  expect(host.shown).toEqual([]);
  // Chosen before, but the browser has not allowed it, so they are not on.
  expect(stateOf(screen).textContent).toBe("Notifications are off.");
});

test("pressing the button asks the browser, and once allowed they are on, the button turns them off, and the choice is remembered", async () => {
  const screen = await render(<SettingsView />);
  const card = notifications(screen);

  await card.getByRole("button", { name: "Turn on notifications" }).click();

  await expect.element(card.getByRole("button", { name: "Turn off notifications" })).toBeVisible();
  expect(host.asked).toBe(1);
  expect(stateOf(screen).textContent).toBe("Notifications are on.");
  expect(card.getByRole("button").elements()).toHaveLength(1);
  expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe("on");
  // Turning them on shows nothing by itself.
  expect(host.shown).toEqual([]);

  // Remembered: the page is drawn afresh and they are still on, without asking again.
  await screen.unmount();
  resetNotificationSettingForTests();
  const again = await render(<SettingsView />);
  expect(stateOf(again).textContent).toBe("Notifications are on.");
  expect(host.asked).toBe(1);

  await notifications(again).getByRole("button", { name: "Turn off notifications" }).click();
  await expect
    .element(notifications(again).getByRole("button", { name: "Turn on notifications" }))
    .toBeVisible();
  expect(stateOf(again).textContent).toBe("Notifications are off.");
  expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe("off");
});

test("the button keeps the keyboard's focus as it changes from on to off", async () => {
  const screen = await render(<SettingsView />);
  const button = notifications(screen).getByRole("button").element() as HTMLButtonElement;
  button.focus();

  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(button.textContent).toBe("Turn off notifications"));
  expect(document.activeElement).toBe(button);

  await userEvent.keyboard(" ");
  await vi.waitFor(() => expect(button.textContent).toBe("Turn on notifications"));
  expect(document.activeElement).toBe(button);
});

test("when the browser refuses, they stay off and a note says they are blocked and what to do", async () => {
  host.answer = "denied";
  const screen = await render(<SettingsView />);
  const card = notifications(screen);

  await card.getByRole("button", { name: "Turn on notifications" }).click();

  const note = card.getByRole("status");
  await expect.element(note).toBeVisible();
  expect(note.element().getAttribute("data-tone")).toBe("info");
  expect(note.element().textContent).toBe(
    "Notifications are blocked" +
      "Your browser is blocking notifications from this address. Allow them for this address in the browser's site settings, then turn them on here.",
  );
  expect(stateOf(screen).textContent).toBe("Notifications are off.");
  // The button stays, for when the browser has been told to allow them.
  await expect.element(card.getByRole("button", { name: "Turn on notifications" })).toBeVisible();
  expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBeNull();

  // Blocked is the browser's last word: pressing again does not ask again.
  await card.getByRole("button", { name: "Turn on notifications" }).click();
  expect(host.asked).toBe(1);
});

test("once the browser allows them again, the note goes when the person comes back, and the button turns them on", async () => {
  host.state = "denied";
  const screen = await render(<SettingsView />);
  const card = notifications(screen);
  await expect.element(card.getByRole("status")).toBeVisible();

  // Allowed in the browser's own settings, then back to this page.
  host.state = "granted";
  window.dispatchEvent(new Event("focus"));

  await expect.element(card.getByRole("status")).not.toBeInTheDocument();
  expect(stateOf(screen).textContent).toBe("Notifications are off.");
  await card.getByRole("button", { name: "Turn on notifications" }).click();
  await expect.element(card.getByRole("button", { name: "Turn off notifications" })).toBeVisible();
  expect(host.asked).toBe(0);
});

test("when the browser's permission is taken away while they are on, the card says off and blocked once the person comes back", async () => {
  host.state = "granted";
  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "on");
  const screen = await render(<SettingsView />);
  const card = notifications(screen);
  expect(stateOf(screen).textContent).toBe("Notifications are on.");

  // Blocked in the browser's own settings, then back to this page.
  host.state = "denied";
  document.dispatchEvent(new Event("visibilitychange"));

  await expect.element(card.getByRole("status")).toBeVisible();
  expect(card.getByRole("status").element().textContent).toContain("Notifications are blocked");
  expect(stateOf(screen).textContent).toBe("Notifications are off.");
  expect(
    card
      .getByRole("button")
      .elements()
      .map((button) => button.textContent),
  ).toEqual(["Turn on notifications"]);
  // The choice is the person's, and is kept for when the browser allows them again.
  expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe("on");
  expect(host.asked).toBe(0);
});

test("a choice made in another tab at this address shows here without a reload", async () => {
  host.state = "granted";
  const screen = await render(<SettingsView />);
  const card = notifications(screen);
  expect(stateOf(screen).textContent).toBe("Notifications are off.");

  // The other tab turns them on. This one hears it as a storage event.
  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "on");
  window.dispatchEvent(new StorageEvent("storage", { key: NOTIFICATIONS_STORAGE_KEY }));

  await expect.element(card.getByRole("button", { name: "Turn off notifications" })).toBeVisible();
  expect(stateOf(screen).textContent).toBe("Notifications are on.");
  expect(host.asked).toBe(0);
});

test("a browser that cannot show notifications says so, and offers no button", async () => {
  host.state = "unsupported";
  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "on");
  const screen = await render(<SettingsView />);
  const card = notifications(screen);

  const note = card.getByRole("status");
  await expect.element(note).toBeVisible();
  expect(note.element().textContent).toBe(
    "This browser cannot show notifications" +
      "Open Agent Lookout in a browser that can, then turn them on here.",
  );
  expect(stateOf(screen).textContent).toBe("Notifications are off.");
  expect(card.getByRole("button").elements()).toEqual([]);
  expect(host.asked).toBe(0);
});

test.each(["denied", "unsupported"] as const)(
  "when the browser's answer is %s, nothing under the note says the browser can show a notification",
  async (state) => {
    host.state = state;
    const screen = await render(<SettingsView />);
    const card = notifications(screen);
    await expect.element(card.getByRole("status")).toBeVisible();

    const words = card.element().textContent ?? "";
    expect(words).not.toMatch(/browser can\b/i);
    // What turning them on does is still said, as what happens once they are on.
    expect(words).toContain(
      "With Needs you on, a notification appears each time a session starts waiting for you.",
    );
  },
);

test("the card says what a notification holds, that on a Mac they arrive with no tab open while the app keeps running, and which sessions can be seen waiting", async () => {
  const screen = await render(<SettingsView />);
  const words = notifications(screen).element().textContent ?? "";

  expect(words).toContain(
    "With Needs you on, a notification appears each time a session starts waiting for you. It names the session and the reason, and is cleared when the session moves on.",
  );
  expect(words).toContain(
    "On a Mac they also arrive when no dashboard tab is open, for as long as Agent Lookout keeps running, and those stay until you clear them. What each agent can report, under Sources, says which agents can be seen waiting.",
  );
  // Sources is named as a link to it.
  expect(
    notifications(screen).getByRole("link", { name: "Sources" }).element().getAttribute("href"),
  ).toBe("#sources");
  // One switch covers the page's notifications and the app's own.
  expect(notifications(screen).getByRole("button").elements()).toHaveLength(1);
});

/**
 * Notifications on, as when the person turned them on here before and the
 * browser allows them. Read afresh, as a page that has just loaded reads it: a
 * view from the test before can draw once more after the store was reset.
 */
function notificationsOn() {
  host.state = "granted";
  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "on");
  resetNotificationSettingForTests();
}

/** The list of events, or null while it is not shown. */
const eventList = (screen: Awaited<ReturnType<typeof render>>) =>
  notifications(screen).element().querySelector('[data-part="events"]');

/** Each event's name and whether its switch is on, as the person reads them. */
const switches = (screen: Awaited<ReturnType<typeof render>>) =>
  [...(eventList(screen)?.querySelectorAll('[role="radiogroup"]') ?? [])].map((group) => [
    group.getAttribute("aria-label"),
    group.querySelector('[role="radio"][aria-checked="true"]')?.textContent,
  ]);

test("while notifications are off the events are not listed, and nothing says they can be switched yet", async () => {
  const screen = await render(<SettingsView />);
  await expect.element(notifications(screen)).toBeVisible();

  expect(eventList(screen)).toBeNull();
  expect(notifications(screen).getByRole("radiogroup").elements()).toEqual([]);
  expect(notifications(screen).element().textContent).toContain(
    "Once they are on, you can also be told when a session finishes or fails, or ends without saying whether it finished, as when its process stops. Those name the session and what happened, and stay until you clear them.",
  );
});

test.each(["denied", "unsupported"] as const)(
  "when the browser's answer is %s the events are not listed",
  async (state) => {
    host.state = state;
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "on");
    const screen = await render(<SettingsView />);
    await expect.element(notifications(screen).getByRole("status")).toBeVisible();
    expect(eventList(screen)).toBeNull();
  },
);

test("once notifications are on, the four events are listed under the button, a wait alone switched on", async () => {
  const screen = await render(<SettingsView />);
  await notifications(screen).getByRole("button", { name: "Turn on notifications" }).click();
  await expect
    .element(notifications(screen).getByRole("radiogroup", { name: "Ended" }))
    .toBeVisible();

  const list = eventList(screen) as HTMLElement;
  expect(list.getAttribute("aria-label")).toBe("What sends a notification");
  expect([...list.querySelectorAll("li")].map((row) => row.textContent)).toEqual([
    "Needs youOffOn",
    "FinishedOffOn",
    "FailedOffOn",
    "EndedOffOn",
  ]);
  expect(switches(screen)).toEqual([
    ["Needs you", "On"],
    ["Finished", "Off"],
    ["Failed", "Off"],
    ["Ended", "Off"],
  ]);
  // Showing them stores nothing.
  expect(localStorage.getItem(NOTIFICATION_EVENTS_STORAGE_KEY)).toBeNull();
  // The switches say what the sentence about them said while they were off, so it has gone.
  expect(notifications(screen).element().textContent).not.toContain("Once they are on");

  // Turning notifications off takes the list away again.
  await notifications(screen).getByRole("button", { name: "Turn off notifications" }).click();
  await expect.element(notifications(screen).getByRole("radiogroup")).not.toBeInTheDocument();
});

test("an event switched here is kept, and is there when the page is drawn again", async () => {
  notificationsOn();
  const screen = await render(<SettingsView />);
  const card = notifications(screen);

  await card
    .getByRole("radiogroup", { name: "Finished" })
    .getByRole("radio", { name: "On" })
    .click();
  await card
    .getByRole("radiogroup", { name: "Needs you" })
    .getByRole("radio", { name: "Off" })
    .click();

  expect(switches(screen)).toEqual([
    ["Needs you", "Off"],
    ["Finished", "On"],
    ["Failed", "Off"],
    ["Ended", "Off"],
  ]);
  expect(localStorage.getItem(NOTIFICATION_EVENTS_STORAGE_KEY)).toBe("finished");
  expect(host.asked).toBe(0);

  await screen.unmount();
  resetNotificationSettingForTests();
  const again = await render(<SettingsView />);
  await expect
    .element(notifications(again).getByRole("radiogroup", { name: "Ended" }))
    .toBeVisible();
  expect(switches(again)).toEqual([
    ["Needs you", "Off"],
    ["Finished", "On"],
    ["Failed", "Off"],
    ["Ended", "Off"],
  ]);
});

test("with every event switched off, the card says that none is sent, and says nothing of it otherwise", async () => {
  notificationsOn();
  const screen = await render(<SettingsView />);
  const card = notifications(screen);
  const none = "No event is switched on, so none is sent.";
  await expect.element(card.getByRole("radiogroup", { name: "Ended" })).toBeVisible();
  expect(card.element().textContent).not.toContain(none);

  await card
    .getByRole("radiogroup", { name: "Needs you" })
    .getByRole("radio", { name: "Off" })
    .click();
  await expect.element(card.getByText(none)).toBeVisible();
  expect(localStorage.getItem(NOTIFICATION_EVENTS_STORAGE_KEY)).toBe("");

  await card.getByRole("radiogroup", { name: "Failed" }).getByRole("radio", { name: "On" }).click();
  await expect.element(card.getByText(none)).not.toBeInTheDocument();

  // Nor while notifications are off, when the events are not listed.
  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "off");
  localStorage.setItem(NOTIFICATION_EVENTS_STORAGE_KEY, "");
  await screen.unmount();
  resetNotificationSettingForTests();
  const off = await render(<SettingsView />);
  await expect.element(notifications(off).getByRole("button")).toBeVisible();
  expect(notifications(off).element().textContent).not.toContain(none);
});

test("the events are kept while notifications are off, and come back as they were", async () => {
  notificationsOn();
  localStorage.setItem(NOTIFICATION_EVENTS_STORAGE_KEY, "failed,ended");
  const screen = await render(<SettingsView />);
  const card = notifications(screen);

  await card.getByRole("button", { name: "Turn off notifications" }).click();
  await expect.element(card.getByRole("radiogroup")).not.toBeInTheDocument();
  await card.getByRole("button", { name: "Turn on notifications" }).click();
  await expect.element(card.getByRole("radiogroup", { name: "Ended" })).toBeVisible();

  expect(switches(screen)).toEqual([
    ["Needs you", "Off"],
    ["Finished", "Off"],
    ["Failed", "On"],
    ["Ended", "On"],
  ]);
});

test("events switched in another tab at this address show here without a reload", async () => {
  notificationsOn();
  const screen = await render(<SettingsView />);
  await expect
    .element(notifications(screen).getByRole("radiogroup", { name: "Ended" }))
    .toBeVisible();

  localStorage.setItem(NOTIFICATION_EVENTS_STORAGE_KEY, "needs-you,ended");
  window.dispatchEvent(new StorageEvent("storage", { key: NOTIFICATION_EVENTS_STORAGE_KEY }));

  await vi.waitFor(() =>
    expect(switches(screen)).toEqual([
      ["Needs you", "On"],
      ["Finished", "Off"],
      ["Failed", "Off"],
      ["Ended", "On"],
    ]),
  );
});

test("each switch is one Tab stop after the button, and the arrow keys switch it", async () => {
  notificationsOn();
  const screen = await render(<SettingsView />);
  const button = notifications(screen).getByRole("button").element();
  await expect
    .element(notifications(screen).getByRole("radiogroup", { name: "Ended" }))
    .toBeVisible();

  startAtTop();
  const stops: Element[] = [];
  for (let presses = 0; presses < 6; presses += 1) {
    await userEvent.tab();
    if (document.activeElement) stops.push(document.activeElement);
  }
  // The theme, the button, then the switch of each event in turn, on its chosen option.
  expect(stops[1]).toBe(button);
  expect(
    stops.slice(2).map((stop) => stop.closest('[role="radiogroup"]')?.getAttribute("aria-label")),
  ).toEqual(["Needs you", "Finished", "Failed", "Ended"]);
  expect(stops[3]?.textContent).toBe("Off");

  // Focus is on Finished's Off. The right arrow switches it on.
  (stops[3] as HTMLElement).focus();
  await userEvent.keyboard("{ArrowRight}");
  await vi.waitFor(() =>
    expect(localStorage.getItem(NOTIFICATION_EVENTS_STORAGE_KEY)).toBe("needs-you,finished"),
  );
});

test.each(["dark", "light"] as const)(
  "in the %s theme the events are rows of body words in ink, each with the theme's switch, a hairline between them, and nothing warm",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    notificationsOn();
    const screen = await render(<SettingsView />);
    await expect
      .element(notifications(screen).getByRole("radiogroup", { name: "Ended" }))
      .toBeVisible();
    await pointAway();

    const rows = [...(eventList(screen)?.querySelectorAll("li") ?? [])];
    expect(rows).toHaveLength(4);
    for (const [index, row] of rows.entries()) {
      const name = row.querySelector("span") as HTMLElement;
      expect(getComputedStyle(name).fontSize).toBe("13px");
      expect(getComputedStyle(name).color).toBe(rgbOf("var(--ink)"));
      const well = row.querySelector('[data-slot="segmented-control"]') as HTMLElement;
      expect(getComputedStyle(well).backgroundColor).toBe(rgbOf("var(--well)"));
      expect(well.querySelector('[data-part="thumb"]')).not.toBeNull();
      // Name and switch on one line, the switch at the right.
      expect(name.getBoundingClientRect().left).toBe(row.getBoundingClientRect().left);
      expect(Math.round(well.getBoundingClientRect().right)).toBe(
        Math.round(row.getBoundingClientRect().right),
      );
      const rule = getComputedStyle(row).borderBottomWidth;
      expect(rule).toBe(index === rows.length - 1 ? "0px" : "1px");
      if (index < rows.length - 1) {
        expect(getComputedStyle(row).borderBottomColor).toBe(rgbOf("var(--hairline)"));
      }
    }
    // The list sits 12px under the button's row, and the words 12px under the list.
    const list = eventList(screen) as HTMLElement;
    const row = stateOf(screen).parentElement as HTMLElement;
    expect(list.getBoundingClientRect().top - row.getBoundingClientRect().bottom).toBe(12);
    const words = list.nextElementSibling as HTMLElement;
    expect(words.tagName).toBe("P");
    expect(words.getBoundingClientRect().top - list.getBoundingClientRect().bottom).toBe(12);
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("the notifications button is reached by Tab after the theme, and shows the focus ring", async () => {
  const screen = await render(<SettingsView />);
  const button = notifications(screen).getByRole("button").element();
  await pointAway();

  startAtTop();
  const stops: Element[] = [];
  for (let presses = 0; presses < 10 && document.activeElement !== button; presses += 1) {
    await userEvent.tab();
    if (document.activeElement) stops.push(document.activeElement);
  }

  expect(document.activeElement).toBe(button);
  // The theme's choice is one stop, and the button is the next.
  expect(stops.map((stop) => stop.getAttribute("role") ?? stop.tagName)).toEqual([
    "radio",
    "BUTTON",
  ]);
  const style = getComputedStyle(button);
  expect(style.outlineStyle).toBe("solid");
  expect(style.outlineWidth).toBe("2px");
  expect(style.outlineColor).toBe(rgbOf("var(--focus)"));
});

test("the notifications card is built from the same parts as the rest: a quiet button, body words and an info note", async () => {
  host.state = "denied";
  const screen = await render(<SettingsView />);
  const card = notifications(screen);
  await pointAway();

  const button = card.getByRole("button").element();
  expect(button.getAttribute("data-variant")).toBe("quiet");
  expect(getComputedStyle(button).height).toBe("28px");
  expect(getComputedStyle(button).backgroundColor).toBe(rgbOf("var(--fill-quiet)"));
  expect(getComputedStyle(button).color).toBe(rgbOf("var(--ink-secondary)"));

  const state = stateOf(screen);
  expect(getComputedStyle(state).fontSize).toBe("13px");
  expect(getComputedStyle(state).fontWeight).toBe("500");
  expect(getComputedStyle(state).color).toBe(rgbOf("var(--ink)"));

  for (const sentence of card.element().querySelectorAll(":scope > div > p")) {
    expect(getComputedStyle(sentence).fontSize).toBe("13px");
    expect(getComputedStyle(sentence).color).toBe(rgbOf("var(--ink-secondary)"));
    expect(getComputedStyle(sentence).fontFamily).toMatch(/^"?Atkinson Hyperlegible Next/);
  }
  expect(card.element().querySelectorAll(":scope > div > p")).toHaveLength(3);

  // The note is the quiet one, not the error.
  const note = card.getByRole("status").element();
  expect(getComputedStyle(note).backgroundColor).toBe(rgbOf("var(--fill-quiet)"));
  expect(getComputedStyle(note).borderRadius).toBe("14px");
});

test("the theme, notifications and the history share the wide column, with email, the webhook and the facts beside them, and the gaps are the one gap", async () => {
  await page.viewport(1440, 900);
  onTestFinished(() => page.viewport(1280, 900));
  const screen = await render(<SettingsView />);
  await expect.element(emailState(screen)).toHaveTextContent("Email is off.");
  const box = (name: string) =>
    screen.getByRole("region", { name }).element().getBoundingClientRect();
  await expect.element(webhookState(screen)).toHaveTextContent("The webhook is off.");
  const [theme, notes, kept, mail, hook, copy] = [
    box("Theme"),
    box("Notifications"),
    box("History"),
    box("Email"),
    box("Webhook"),
    box("This copy"),
  ];

  expect(notes.left).toBe(theme.left);
  expect(notes.width).toBe(theme.width);
  expect(notes.top - theme.bottom).toBe(16);
  expect(kept.left).toBe(theme.left);
  expect(kept.width).toBe(theme.width);
  expect(kept.top - notes.bottom).toBe(16);
  expect(mail.top).toBe(theme.top);
  expect(mail.left - theme.right).toBe(16);
  expect(hook.left).toBe(mail.left);
  expect(hook.width).toBe(mail.width);
  expect(hook.top - mail.bottom).toBe(16);
  expect(copy.left).toBe(mail.left);
  expect(copy.width).toBe(mail.width);
  expect(copy.top - hook.bottom).toBe(16);
});

/** The history as `/api/history` gives it while another copy writes the files. */
const KEPT_ELSEWHERE: Pick<HistoryResponse, "startedAt" | "since" | "kept"> = {
  startedAt: Date.now() - 60_000,
  since: { at: Date.now() - 3 * 24 * 60 * 60 * 1000, by: "started" },
  kept: {
    where: "disk",
    folder: "~/.agent-lookout/history",
    bytes: 3 * 1024 * 1024,
    maxBytes: 20 * 1024 * 1024,
    maxAgeMs: 8 * 24 * 60 * 60 * 1000,
    canClear: false,
    problem:
      "Another copy of Agent Lookout on this computer is writing the history. This one keeps what it sees in memory, and takes over when that one stops.",
  },
};

test.each([1000, 375])(
  "at %i pixels the cards stack as Theme, Notifications, History, Email, Webhook, This copy, and nothing runs off the side",
  async (width) => {
    await page.viewport(width, 900);
    onTestFinished(() => page.viewport(1280, 900));
    // The fullest the cards get: notifications blocked, with its note, and
    // the history kept on disk by another copy, with its facts and its note.
    host.state = "denied";
    const screen = await render(<SettingsView history={KEPT_ELSEWHERE} now={Date.now()} />);
    await expect.element(notifications(screen).getByRole("status")).toBeVisible();

    const cards = [...screen.container.querySelectorAll<HTMLElement>('[data-slot="section-card"]')];
    expect(cards.map((card) => card.querySelector("h2")?.textContent)).toEqual([
      "Theme",
      "Notifications",
      "History",
      "Email",
      "Webhook",
      "This copy",
    ]);
    const boxes = cards.map((card) => card.getBoundingClientRect());
    for (const [index, box] of boxes.entries()) {
      expect(box.left).toBe(boxes[0]?.left);
      expect(box.width).toBe(boxes[0]?.width);
      if (index > 0) expect(box.top - (boxes[index - 1] as DOMRect).bottom).toBe(16);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    for (const card of cards) {
      expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
      for (const part of card.querySelectorAll<HTMLElement>("p, button, [data-slot='callout']")) {
        expect(part.getBoundingClientRect().right).toBeLessThanOrEqual(
          card.getBoundingClientRect().right - 24 + 0.5,
        );
      }
    }
  },
);

const NOTIFICATION_STATES = [
  ["off", "default", null],
  ["on", "granted", "on"],
  ["blocked", "denied", null],
  ["not possible", "unsupported", null],
] as const;

test.each(
  (["dark", "light"] as const).flatMap((theme) =>
    NOTIFICATION_STATES.map((state) => [theme, ...state] as const),
  ),
)(
  "in the %s theme, with notifications %s, nothing in the view is warm",
  async (theme, _state, permission, stored) => {
    document.documentElement.setAttribute("data-theme", theme);
    host.state = permission;
    if (stored) localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, stored);

    const screen = await render(<SettingsView />);
    await expect.element(notifications(screen)).toBeVisible();
    expect(stateOf(screen).textContent).toBe(
      stored ? "Notifications are on." : "Notifications are off.",
    );

    expect(warmPaint(screen.container)).toEqual([]);
    // Nor when the button is under the keyboard or the pointer.
    const button = notifications(screen).getByRole("button").elements()[0];
    if (button) {
      (button as HTMLElement).focus();
      expect(warmPaint(screen.container)).toEqual([]);
      await userEvent.hover(button);
      expect(warmPaint(screen.container)).toEqual([]);
      await pointAway();
    }
  },
);

/**
 * The lines of a card that says how sending goes, once the app has answered:
 * the state, while it is on whether what a waiting session is asking goes too,
 * and the line under those, or the title and the words of the note that says
 * what is wrong.
 */
const SENDING_LINES = ":scope > div > p, :scope > div > [data-slot='callout'] p";

/** The lines of the Email card, once the app has answered. */
async function emailLines(screen: Awaited<ReturnType<typeof render>>) {
  const card = screen.getByRole("region", { name: "Email" });
  await vi.waitFor(() => expect(emailState(screen).textContent).not.toBe(""));
  return [...card.element().querySelectorAll(SENDING_LINES)].map((line) => line.textContent);
}

/** Today at this time on the clock. */
const today = (hours: number, minutes: number) => {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
};

const EMAIL_ON: EmailStatusResponse = {
  on: true,
  to: "n…@example.com",
  events: ["needs-you"],
  afterMs: 60_000,
  asking: false,
  problem: null,
  last: null,
  limitedUntil: null,
};

test("with nothing set, the Email card says email is off and which two settings turn it on, and only reads", async () => {
  const screen = await render(<SettingsView />);

  expect(await emailLines(screen)).toEqual([
    "Email is off.",
    "Set AGENT_LOOKOUT_EMAIL_TO and AGENT_LOOKOUT_SMTP_URL to turn it on.",
  ]);
  const card = screen.getByRole("region", { name: "Email" }).element();
  // The settings are named in the face for literal text, as on the Sources view.
  expect([...card.querySelectorAll('[data-slot="fact"]')].map((fact) => fact.textContent)).toEqual([
    "AGENT_LOOKOUT_EMAIL_TO",
    "AGENT_LOOKOUT_SMTP_URL",
  ]);
  // Nothing on the page turns it on or off.
  expect(card.querySelectorAll("button, a, input")).toHaveLength(0);
  expect([...asked].sort()).toEqual(["/api/email", "/api/webhook"]);
  expect(emailState(screen).getAttribute("aria-live")).toBe("polite");
});

test("a setting that is wrong is named, with what to do", async () => {
  email = { ...EMAIL_OFF, problem: "AGENT_LOOKOUT_SMTP_URL must begin with smtps:// or smtp://." };
  const screen = await render(<SettingsView />);

  expect(await emailLines(screen)).toEqual([
    "Email is off.",
    "Email is not set up correctly",
    "AGENT_LOOKOUT_SMTP_URL must begin with smtps:// or smtp://. Correct it and start Agent Lookout again.",
  ]);
});

test("with email on, it says where emails go and after how long, and the facts say emails leave this computer", async () => {
  email = EMAIL_ON;
  const screen = await render(<SettingsView />);

  expect(await emailLines(screen)).toEqual([
    "Emails go to n…@example.com after a wait of 1 minute.",
    "Emails leave out what a waiting session is asking.",
  ]);
  const copy = screen.getByRole("region", { name: "This copy" }).element();
  expect(
    copy.querySelector('[data-slot="fact-row"] + [data-slot="fact-row"] dd')?.textContent,
  ).toBe("Sent only in the emails you set up");
});

test.each<[string, Partial<EmailStatusResponse>, string[]]>([
  ["sent", { last: { at: today(14, 2), sent: true } }, ["Last sent at 14:02."]],
  [
    "not sent",
    {
      last: { at: today(14, 2), sent: false, reason: "the mail server did not answer in time" },
    },
    ["The last email could not be sent", "The mail server did not answer in time."],
  ],
  [
    "held by the hourly limit",
    { last: { at: today(14, 2), sent: true }, limitedUntil: today(15, 2) },
    [
      "Emails are held back",
      "20 emails were tried in the last hour, the most it tries. The next can go at 15:02.",
    ],
  ],
  [
    "not sent, and the hourly limit is full",
    {
      last: {
        at: today(14, 2),
        sent: false,
        reason: "the mail server did not accept the user name and password",
      },
      limitedUntil: today(15, 2),
    },
    [
      "The last email could not be sent",
      "The mail server did not accept the user name and password. No more will be tried until 15:02, as 20 were tried in the last hour.",
    ],
  ],
])("when the last email was %s, the card says so", async (_, status, lines) => {
  email = { ...EMAIL_ON, ...status };
  const screen = await render(<SettingsView />);

  expect(await emailLines(screen)).toEqual([
    "Emails go to n…@example.com after a wait of 1 minute.",
    "Emails leave out what a waiting session is asking.",
    ...lines,
  ]);
  // What is wrong is the info note that says notifications are blocked; all being well is a plain line.
  const note = screen
    .getByRole("region", { name: "Email" })
    .element()
    .querySelector<HTMLElement>('[data-slot="callout"]');
  expect(note?.dataset.tone ?? null).toBe(lines.length === 2 ? "info" : null);
});

test("the Email card names every event it sends an email for", async () => {
  email = { ...EMAIL_ON, events: ["needs-you", "finished", "failed"] };
  const screen = await render(<SettingsView />);

  expect(await emailLines(screen)).toEqual([
    "Emails go to n…@example.com when a session has waited 1 minute, finishes or fails.",
    "Emails leave out what a waiting session is asking.",
  ]);
});

test("when the app does not answer, the card says it could not be read, and claims nothing", async () => {
  email = null;
  const screen = await render(<SettingsView />);

  expect(await emailLines(screen)).toEqual(["Whether email is set up could not be read."]);
  const copy = screen.getByRole("region", { name: "This copy" }).element();
  expect(copy.textContent).toContain("Agent Lookout sends it nowhere");
  expect(copy.textContent).not.toContain("emails");
});

test.each(["dark", "light"] as const)(
  "in the %s theme the Email card is built like the notifications card: the state in ink at 500, the line under it quieter, and nothing warm",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    email = { ...EMAIL_ON, last: { at: today(14, 2), sent: true } };
    const screen = await render(<SettingsView />);
    await emailLines(screen);

    const state = emailState(screen);
    expect(getComputedStyle(state).fontSize).toBe("13px");
    expect(getComputedStyle(state).fontWeight).toBe("500");
    expect(getComputedStyle(state).color).toBe(rgbOf("var(--ink)"));
    // Under the state, whether what a waiting session is asking goes, then when the last one did.
    const under = state.nextElementSibling as HTMLElement;
    expect(under.dataset.part).toBe("asking");
    const last = under.nextElementSibling as HTMLElement;
    for (const line of [under, last]) {
      expect(getComputedStyle(line).fontSize).toBe("13px");
      expect(getComputedStyle(line).fontWeight).toBe("400");
      expect(getComputedStyle(line).color).toBe(rgbOf("var(--ink-secondary)"));
    }
    expect(under.getBoundingClientRect().top - state.getBoundingClientRect().bottom).toBe(12);
    expect(last.getBoundingClientRect().top - under.getBoundingClientRect().bottom).toBe(12);
    expect(last.textContent).toBe("Last sent at 14:02.");
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("with AGENT_LOOKOUT_EMAIL_ASKING on, the card says a wait's email says what the session is asking, and still only reads", async () => {
  email = { ...EMAIL_ON, asking: true, last: { at: today(14, 2), sent: true } };
  const screen = await render(<SettingsView />);

  expect(await emailLines(screen)).toEqual([
    "Emails go to n…@example.com after a wait of 1 minute.",
    "Emails for a wait say what the session is asking.",
    "Last sent at 14:02.",
  ]);
  const card = screen.getByRole("region", { name: "Email" }).element();
  expect(card.querySelectorAll("button, a, input")).toHaveLength(0);
  // It is set when Agent Lookout starts, so it is not news while the page is open.
  expect(card.querySelector("[data-part='asking']")?.hasAttribute("aria-live")).toBe(false);
});

test("while email is off, or its answer cannot be read, the card says nothing of what a waiting session is asking", async () => {
  email = { ...EMAIL_OFF, asking: true };
  const off = await render(<SettingsView />);
  expect(await emailLines(off)).toEqual([
    "Email is off.",
    "Set AGENT_LOOKOUT_EMAIL_TO and AGENT_LOOKOUT_SMTP_URL to turn it on.",
  ]);
  await off.unmount();

  email = null;
  const unread = await render(<SettingsView />);
  expect(await emailLines(unread)).toEqual(["Whether email is set up could not be read."]);
  expect(unread.container.querySelector("[data-part='asking']")).toBeNull();
});

/** The two lines of the Webhook card, once the app has answered. */
async function webhookLines(screen: Awaited<ReturnType<typeof render>>) {
  const card = screen.getByRole("region", { name: "Webhook" });
  await vi.waitFor(() => expect(webhookState(screen).textContent).not.toBe(""));
  return [...card.element().querySelectorAll(SENDING_LINES)].map((line) => line.textContent);
}

const WEBHOOK_ON: WebhookStatusResponse = {
  on: true,
  host: "hooks.slack.com",
  events: ["needs-you"],
  afterMs: 60_000,
  asking: false,
  problem: null,
  last: null,
  limitedUntil: null,
};

/** What the facts about this copy say of the person's data. */
const yourData = (screen: Awaited<ReturnType<typeof render>>) =>
  screen
    .getByRole("region", { name: "This copy" })
    .element()
    .querySelector('[data-slot="fact-row"] + [data-slot="fact-row"] dd')?.textContent;

test("with nothing set, the Webhook card says it is off and which setting turns it on, and only reads", async () => {
  const screen = await render(<SettingsView />);

  expect(await webhookLines(screen)).toEqual([
    "The webhook is off.",
    "Set AGENT_LOOKOUT_WEBHOOK_URL to turn it on.",
  ]);
  const card = screen.getByRole("region", { name: "Webhook" }).element();
  expect([...card.querySelectorAll('[data-slot="fact"]')].map((fact) => fact.textContent)).toEqual([
    "AGENT_LOOKOUT_WEBHOOK_URL",
  ]);
  expect(card.querySelectorAll("button, a, input")).toHaveLength(0);
  expect(webhookState(screen).getAttribute("aria-live")).toBe("polite");
  expect(yourData(screen)).toBe("Agent Lookout sends it nowhere");
});

test("a webhook setting that is wrong is named, with what to do", async () => {
  webhook = {
    ...WEBHOOK_OFF,
    problem: "AGENT_LOOKOUT_WEBHOOK_URL must not hold a user name or a password.",
  };
  const screen = await render(<SettingsView />);

  expect(await webhookLines(screen)).toEqual([
    "The webhook is off.",
    "The webhook is not set up correctly",
    "AGENT_LOOKOUT_WEBHOOK_URL must not hold a user name or a password. Correct it and start Agent Lookout again.",
  ]);
});

test("with the webhook on, it names the host and when, and the facts say posts leave this computer", async () => {
  webhook = WEBHOOK_ON;
  const screen = await render(<SettingsView />);

  expect(await webhookLines(screen)).toEqual([
    "Posts go to hooks.slack.com after a wait of 1 minute.",
    "Posts leave out what a waiting session is asking.",
  ]);
  expect(yourData(screen)).toBe("Sent only in the webhook posts you set up");
});

test("with email and the webhook both on, the facts name both", async () => {
  email = EMAIL_ON;
  webhook = { ...WEBHOOK_ON, events: ["needs-you", "finished"], afterMs: 0 };
  const screen = await render(<SettingsView />);

  expect(await webhookLines(screen)).toEqual([
    "Posts go to hooks.slack.com when a session starts waiting or finishes.",
    "Posts leave out what a waiting session is asking.",
  ]);
  await emailLines(screen);
  expect(yourData(screen)).toBe("Sent only in the emails and posts you set up");
});

test.each<[string, Partial<WebhookStatusResponse>, string[]]>([
  ["posted", { last: { at: today(14, 2), sent: true } }, ["Last posted at 14:02."]],
  [
    "not posted",
    {
      last: { at: today(14, 2), sent: false, reason: "the address refused the post (status 403)" },
    },
    ["The last post failed", "The address refused the post (status 403)."],
  ],
  [
    "held by the hourly limit",
    { last: { at: today(14, 2), sent: true }, limitedUntil: today(15, 2) },
    [
      "Posts are held back",
      "20 posts were tried in the last hour, the most it tries. The next can go at 15:02.",
    ],
  ],
  [
    "not posted, and the hourly limit is full",
    {
      last: { at: today(14, 2), sent: false, reason: "the address did not answer in time" },
      limitedUntil: today(15, 2),
    },
    [
      "The last post failed",
      "The address did not answer in time. No more will be tried until 15:02, as 20 were tried in the last hour.",
    ],
  ],
])("when the last post was %s, the card says so", async (_, status, lines) => {
  webhook = { ...WEBHOOK_ON, ...status };
  const screen = await render(<SettingsView />);

  expect(await webhookLines(screen)).toEqual([
    "Posts go to hooks.slack.com after a wait of 1 minute.",
    "Posts leave out what a waiting session is asking.",
    ...lines,
  ]);
});

test("when the app does not answer about the webhook, the card says it could not be read, and claims nothing", async () => {
  webhook = null;
  const screen = await render(<SettingsView />);

  expect(await webhookLines(screen)).toEqual(["Whether the webhook is set up could not be read."]);
  expect(yourData(screen)).toBe("Agent Lookout sends it nowhere");
});

test.each(["dark", "light"] as const)(
  "in the %s theme the Webhook card is built like the Email card, and nothing is warm",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    webhook = { ...WEBHOOK_ON, last: { at: today(14, 2), sent: true } };
    const screen = await render(<SettingsView />);
    await webhookLines(screen);

    const state = webhookState(screen);
    expect(getComputedStyle(state).fontSize).toBe("13px");
    expect(getComputedStyle(state).fontWeight).toBe("500");
    expect(getComputedStyle(state).color).toBe(rgbOf("var(--ink)"));
    const under = state.nextElementSibling as HTMLElement;
    expect(under.dataset.part).toBe("asking");
    const last = under.nextElementSibling as HTMLElement;
    for (const line of [under, last]) {
      expect(getComputedStyle(line).color).toBe(rgbOf("var(--ink-secondary)"));
    }
    expect(under.getBoundingClientRect().top - state.getBoundingClientRect().bottom).toBe(12);
    expect(last.getBoundingClientRect().top - under.getBoundingClientRect().bottom).toBe(12);
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("with AGENT_LOOKOUT_WEBHOOK_ASKING on, the card says a wait's post says what the session is asking, and still only reads", async () => {
  webhook = { ...WEBHOOK_ON, asking: true };
  const screen = await render(<SettingsView />);

  expect(await webhookLines(screen)).toEqual([
    "Posts go to hooks.slack.com after a wait of 1 minute.",
    "Posts for a wait say what the session is asking.",
  ]);
  const card = screen.getByRole("region", { name: "Webhook" }).element();
  expect(card.querySelectorAll("button, a, input")).toHaveLength(0);
});

test("each card says it of its own channel: email can say it while posts leave it out", async () => {
  email = { ...EMAIL_ON, asking: true };
  webhook = WEBHOOK_ON;
  const screen = await render(<SettingsView />);

  expect((await emailLines(screen))[1]).toBe("Emails for a wait say what the session is asking.");
  expect((await webhookLines(screen))[1]).toBe("Posts leave out what a waiting session is asking.");
});

test("while the webhook is off, the card says nothing of what a waiting session is asking", async () => {
  webhook = { ...WEBHOOK_OFF, asking: true };
  const screen = await render(<SettingsView />);

  expect(await webhookLines(screen)).toEqual([
    "The webhook is off.",
    "Set AGENT_LOOKOUT_WEBHOOK_URL to turn it on.",
  ]);
});
