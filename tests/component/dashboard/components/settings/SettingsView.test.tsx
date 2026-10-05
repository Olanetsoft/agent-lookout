import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { EmailStatusResponse } from "@core/api";
import { SettingsView } from "@dashboard/components/settings/SettingsView";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import { setNotificationHost } from "@dashboard/lib/notifications/notificationHost";
import {
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
  afterMs: null,
  problem: null,
  last: null,
  limitedUntil: null,
};
let email: EmailStatusResponse | null;
/** The paths the view asked the app for. */
let asked: string[];

beforeEach(() => {
  host = fakeNotificationHost();
  setNotificationHost(host);
  email = EMAIL_OFF;
  asked = [];
  setApiHost(async (path) => {
    asked.push(path);
    if (email === null) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(email), { headers: { "Content-Type": "application/json" } });
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

test("the facts about this copy say its version and that its data stays on this computer", async () => {
  const screen = await render(<SettingsView />);
  const copy = screen.getByRole("region", { name: "This copy" });

  const rows = [...copy.element().querySelectorAll('[data-slot="fact-row"]')].map((row) => [
    row.querySelector("dt")?.textContent,
    row.querySelector("dd")?.textContent,
  ]);
  expect(rows).toEqual([
    ["Version", `v${__APP_VERSION__}`],
    ["Your data", "Stays on this computer"],
  ]);
  expect(__APP_VERSION__).toMatch(/^\d+\.\d+\.\d+/);
});

test.each(["dark", "light"] as const)(
  "in the %s theme the view is glass cards, with no warm colour",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(<SettingsView />);

    const cards = screen.container.querySelectorAll('[data-slot="section-card"]');
    expect(cards).toHaveLength(4);
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
      "When notifications are on, one appears each time a session starts waiting for you.",
    );
  },
);

test("the card says what a notification holds, that on a Mac they arrive with no tab open while the app keeps running, and that only Claude Code sessions can be seen waiting", async () => {
  const screen = await render(<SettingsView />);
  const words = notifications(screen).element().textContent ?? "";

  expect(words).toContain(
    "When notifications are on, one appears each time a session starts waiting for you. It names the session and the reason, and is cleared when the session moves on.",
  );
  expect(words).toContain(
    "On a Mac they also arrive when no dashboard tab is open, for as long as Agent Lookout keeps running, and those stay until you clear them. Only Claude Code sessions can be seen waiting, so a Codex session never sends one.",
  );
  // One switch covers the page's notifications and the app's own.
  expect(notifications(screen).getByRole("button").elements()).toHaveLength(1);
});

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
  expect(card.element().querySelectorAll(":scope > div > p")).toHaveLength(2);

  // The note is the quiet one, not the error.
  const note = card.getByRole("status").element();
  expect(getComputedStyle(note).backgroundColor).toBe(rgbOf("var(--fill-quiet)"));
  expect(getComputedStyle(note).borderRadius).toBe("14px");
});

test("the theme, notifications and email share the wide column, with the facts beside them, and the gaps are the one gap", async () => {
  await page.viewport(1440, 900);
  onTestFinished(() => page.viewport(1280, 900));
  const screen = await render(<SettingsView />);
  await expect.element(emailState(screen)).toHaveTextContent("Email is off.");
  const box = (name: string) =>
    screen.getByRole("region", { name }).element().getBoundingClientRect();
  const [theme, notes, mail, copy] = [
    box("Theme"),
    box("Notifications"),
    box("Email"),
    box("This copy"),
  ];

  expect(notes.left).toBe(theme.left);
  expect(notes.width).toBe(theme.width);
  expect(notes.top - theme.bottom).toBe(16);
  expect(mail.left).toBe(theme.left);
  expect(mail.width).toBe(theme.width);
  expect(mail.top - notes.bottom).toBe(16);
  expect(copy.top).toBe(theme.top);
  expect(copy.left - theme.right).toBe(16);
});

test.each([1000, 375])(
  "at %i pixels the cards stack as Theme, Notifications, Email, This copy, and nothing runs off the side",
  async (width) => {
    await page.viewport(width, 900);
    onTestFinished(() => page.viewport(1280, 900));
    // The fullest the card gets: blocked, with its note.
    host.state = "denied";
    const screen = await render(<SettingsView />);
    await expect.element(notifications(screen).getByRole("status")).toBeVisible();

    const cards = [...screen.container.querySelectorAll<HTMLElement>('[data-slot="section-card"]')];
    expect(cards.map((card) => card.querySelector("h2")?.textContent)).toEqual([
      "Theme",
      "Notifications",
      "Email",
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

/** The two lines of the Email card, once the app has answered: the state, and the line under it. */
async function emailLines(screen: Awaited<ReturnType<typeof render>>) {
  const card = screen.getByRole("region", { name: "Email" });
  await vi.waitFor(() => expect(emailState(screen).textContent).not.toBe(""));
  return [...card.element().querySelectorAll(":scope > div > p")].map((line) => line.textContent);
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
  afterMs: 60_000,
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
  expect(asked).toEqual(["/api/email"]);
  expect(emailState(screen).getAttribute("aria-live")).toBe("polite");
});

test("a setting that is wrong is named, with what to do", async () => {
  email = { ...EMAIL_OFF, problem: "AGENT_LOOKOUT_SMTP_URL must begin with smtps:// or smtp://." };
  const screen = await render(<SettingsView />);

  expect(await emailLines(screen)).toEqual([
    "Email is off.",
    "AGENT_LOOKOUT_SMTP_URL must begin with smtps:// or smtp://. Correct it and start Agent Lookout again.",
  ]);
});

test("with email on, it says where emails go and after how long, and the facts say emails leave this computer", async () => {
  email = EMAIL_ON;
  const screen = await render(<SettingsView />);

  expect(await emailLines(screen)).toEqual([
    "Emails go to n…@example.com after a wait of 1 minute.",
  ]);
  const copy = screen.getByRole("region", { name: "This copy" }).element();
  expect(
    copy.querySelector('[data-slot="fact-row"] + [data-slot="fact-row"] dd')?.textContent,
  ).toBe("Leaves only in the emails you set up");
});

test.each<[string, Partial<EmailStatusResponse>, string]>([
  ["sent", { last: { at: today(14, 2), sent: true } }, "Last sent at 14:02."],
  [
    "not sent",
    {
      last: { at: today(14, 2), sent: false, reason: "the mail server did not answer in time" },
    },
    "The last email could not be sent: the mail server did not answer in time.",
  ],
  [
    "held by the hourly limit",
    { last: { at: today(14, 2), sent: true }, limitedUntil: today(15, 2) },
    "20 emails were tried in the last hour, the most it tries. The next can go at 15:02.",
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
    "The last email could not be sent: the mail server did not accept the user name and password. No more will be tried until 15:02, as 20 were tried in the last hour.",
  ],
])("when the last email was %s, the line under says so", async (_, status, line) => {
  email = { ...EMAIL_ON, ...status };
  const screen = await render(<SettingsView />);

  expect(await emailLines(screen)).toEqual([
    "Emails go to n…@example.com after a wait of 1 minute.",
    line,
  ]);
});

test("when the app does not answer, the card says it could not be read, and claims nothing", async () => {
  email = null;
  const screen = await render(<SettingsView />);

  expect(await emailLines(screen)).toEqual(["Whether email is set up could not be read."]);
  const copy = screen.getByRole("region", { name: "This copy" }).element();
  expect(copy.textContent).toContain("Stays on this computer");
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
    const under = state.nextElementSibling as HTMLElement;
    expect(getComputedStyle(under).fontSize).toBe("13px");
    expect(getComputedStyle(under).color).toBe(rgbOf("var(--ink-secondary)"));
    expect(under.getBoundingClientRect().top - state.getBoundingClientRect().bottom).toBe(12);
    expect(warmPaint(screen.container)).toEqual([]);
  },
);
