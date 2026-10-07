import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ACTION_HEADER } from "@core/api";
import { DEFAULT_TIME_RULES, type TimeRules } from "@core/time-rules/timeRules";
import { TimeRulesCard } from "@dashboard/components/settings/TimeRulesCard";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import { LEAVE_OUT, REMIND_AGAIN } from "@dashboard/lib/time-rules/timeRulesFields";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";

/** The rules as the app holds them, which a change it takes replaces. */
let held: TimeRules;
/** What `GET /api/settings` says of the file. */
let problem: string | null;
/** Each change the card asked for: its action and its body. */
let changes: { action: string | null; body: TimeRules }[];
/** Whether the app answers at all, and whether it takes a change. */
let answering: boolean;
let refusing: string | null;

beforeEach(() => {
  held = DEFAULT_TIME_RULES;
  problem = null;
  changes = [];
  answering = true;
  refusing = null;
  setApiHost(async (path, init) => {
    if (!answering) throw new TypeError("Failed to fetch");
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (path === "/api/settings/time-rules") {
      const body = JSON.parse(init?.body as string) as TimeRules;
      changes.push({ action: new Headers(init?.headers).get(ACTION_HEADER), body });
      if (refusing !== null) return json({ error: refusing, reason: "not-saved" }, 500);
      held = body;
      return json({ ok: true, timeRules: held });
    }
    return json({ timeRules: held, file: "~/.agent-lookout/settings.json", problem });
  });
});

afterEach(() => {
  setApiHost();
  document.documentElement.removeAttribute("data-theme");
});

const card = () => page.getByRole("region", { name: "Time rules" });
const field = (name: string) => page.getByRole("textbox", { name });
const lastChange = () => changes.at(-1)?.body;

/** Every rule on, with the days of the week ticked, as the fullest the card gets. */
const ALL_ON: TimeRules = {
  longWait: { on: true, minutes: 10 },
  idle: { on: true, hours: 48 },
  quietHours: { ...DEFAULT_TIME_RULES.quietHours, on: true },
};

/** Types in a field, replacing what it holds, and leaves it with Enter. */
async function type(name: string, text: string) {
  await userEvent.clear(field(name));
  await userEvent.type(field(name), `${text}{Enter}`);
}

test("lists the three rules, each with its Off and On, all off until the person turns one on", async () => {
  await render(<TimeRulesCard />);
  for (const name of ["Remind me of a long wait", "Mark idle sessions stale", "Quiet hours"]) {
    const control = card().getByRole("radiogroup", { name });
    await expect.element(control).toBeVisible();
    await expect.element(control.getByRole("radio", { name: "Off" })).toBeChecked();
  }
  // While a rule is off, what it would be set to is not drawn.
  expect(card().getByRole("textbox").elements()).toHaveLength(0);
  expect(card().element().textContent).toContain(
    "checkout-flow has waited 10 minutes for permission",
  );
  // The file is named in the face for literal text.
  const facts = [...card().element().querySelectorAll('[data-slot="fact"]')].map(
    (fact) => fact.textContent,
  );
  expect(facts).toContain("~/.agent-lookout/settings.json");
  expect(changes).toEqual([]);
});

test("turning the reminder on sends the three rules, whole, and shows what it is set to", async () => {
  const told = vi.fn();
  await render(<TimeRulesCard onChanged={told} />);
  const reminder = card().getByRole("radiogroup", { name: "Remind me of a long wait" });
  await reminder.getByRole("radio", { name: "On" }).click();

  await expect.element(reminder.getByRole("radio", { name: "On" })).toBeChecked();
  expect(changes).toEqual([
    {
      action: "time-rules",
      body: { ...DEFAULT_TIME_RULES, longWait: { on: true, minutes: 10 } },
    },
  ]);
  await expect.element(field("Minutes of waiting before the reminder")).toHaveValue("10");
  expect(card().element().textContent).toContain("Afterminutes of waiting");
  expect(told).toHaveBeenCalledOnce();
});

test("minutes typed are sent once the field is left, and what cannot be taken is never sent", async () => {
  held = ALL_ON;
  await render(<TimeRulesCard />);
  const minutes = "Minutes of waiting before the reminder";
  await expect.element(field(minutes)).toHaveValue("10");

  await type(minutes, "15");
  await vi.waitFor(() => expect(lastChange()?.longWait).toEqual({ on: true, minutes: 15 }));
  await expect.element(field(minutes)).toHaveValue("15");

  await type(minutes, "0");
  await expect
    .element(card().getByText("Type a whole number of minutes from 1 to 1440."))
    .toBeVisible();
  await expect.element(field(minutes)).toHaveValue("15");
  expect(changes).toHaveLength(1);

  // Escape puts back what the app holds, and sends nothing.
  await userEvent.clear(field(minutes));
  await userEvent.type(field(minutes), "99{Escape}");
  await expect.element(field(minutes)).toHaveValue("15");
  await userEvent.tab();
  expect(changes).toHaveLength(1);
});

/** The long wait reminder with its repeat on, every 30 minutes. */
const REPEATING = { on: true, minutes: 10, repeat: { on: true, minutes: 30 } };

test("the repeat is off until it is turned on, under the reminder's line, and on it sends the rule with it", async () => {
  held = ALL_ON;
  await render(<TimeRulesCard />);
  const again = card().getByRole("radiogroup", { name: REMIND_AGAIN });
  await expect.element(again.getByRole("radio", { name: "Off" })).toBeChecked();
  // Under the line of the reminder's minutes, and with no field while it is off.
  const minutesLine = field("Minutes of waiting before the reminder").element().parentElement;
  expect(again.element().getBoundingClientRect().top).toBeGreaterThan(
    minutesLine?.getBoundingClientRect().bottom ?? Infinity,
  );
  expect(field("Minutes between reminders").elements()).toHaveLength(0);

  await again.getByRole("radio", { name: "On" }).click();
  await expect.element(again.getByRole("radio", { name: "On" })).toBeChecked();
  expect(changes.map((one) => one.body)).toEqual([{ ...ALL_ON, longWait: REPEATING }]);
  await expect.element(field("Minutes between reminders")).toHaveValue("30");
  const line = field("Minutes between reminders").element().closest("[data-part='set-to'] > div");
  expect(line?.textContent).toBe("Everyminutes");
  // Under the switch, 8px down, as each line of what a rule is set to is.
  const gap =
    field("Minutes between reminders").element().getBoundingClientRect().top -
    again.element().getBoundingClientRect().bottom;
  expect(gap).toBeGreaterThanOrEqual(8);
  expect(gap).toBeLessThan(12);
  expect(card().element().textContent).toContain(
    "and with Remind again on, again every so many minutes while the session still waits",
  );
});

test("the repeat's minutes are sent once the field is left, what cannot be taken is said under its own line, and off it keeps them", async () => {
  held = { ...ALL_ON, longWait: REPEATING };
  await render(<TimeRulesCard />);
  const every = "Minutes between reminders";
  await expect.element(field(every)).toHaveValue("30");

  await type(every, "45");
  await vi.waitFor(() =>
    expect(lastChange()?.longWait).toEqual({ ...REPEATING, repeat: { on: true, minutes: 45 } }),
  );

  await type(every, "4");
  const take = card().getByText("Type a whole number of minutes from 5 to 1440.");
  await expect.element(take).toBeVisible();
  await expect.element(field(every)).toHaveValue("45");
  expect(changes).toHaveLength(1);
  // 4px under the repeat's own line, not under the reminder's.
  const line = field(every).element().parentElement?.parentElement as HTMLElement;
  expect(take.element().getBoundingClientRect().top - line.getBoundingClientRect().bottom).toBe(4);
  expect(
    card().getByText("Type a whole number of minutes from 1 to 1440.").elements(),
  ).toHaveLength(0);

  // Switching it off is a change to the reminder: it puts the line away and keeps the minutes.
  await card()
    .getByRole("radiogroup", { name: REMIND_AGAIN })
    .getByRole("radio", { name: "Off" })
    .click();
  await vi.waitFor(() =>
    expect(lastChange()?.longWait).toEqual({ ...REPEATING, repeat: { on: false, minutes: 45 } }),
  );
  await expect.element(take).not.toBeInTheDocument();
  await expect.element(field(every)).not.toBeInTheDocument();
});

test("the repeat is not drawn while the reminder itself is off", async () => {
  held = { ...ALL_ON, longWait: { ...REPEATING, on: false } };
  await render(<TimeRulesCard />);
  await expect.element(field("Quiet from")).toBeVisible();
  expect(card().getByRole("radiogroup", { name: REMIND_AGAIN }).elements()).toHaveLength(0);
  expect(field("Minutes between reminders").elements()).toHaveLength(0);
});

test.each([375, 1280])(
  "at %i pixels, the repeat's switch sits at the right of its name, and its minutes stay beside their word",
  async (width) => {
    await page.viewport(width, 900);
    onTestFinished(() => page.viewport(1280, 900));
    held = { ...ALL_ON, longWait: REPEATING };
    await render(
      <div style={{ width: width === 375 ? 283 : 820 }}>
        <TimeRulesCard />
      </div>,
    );
    await expect.element(field("Minutes between reminders")).toBeVisible();
    const box = card().element();
    const right = box.getBoundingClientRect().right - 24;
    const again = card().getByRole("radiogroup", { name: REMIND_AGAIN }).element();
    const name = card().getByText(REMIND_AGAIN, { exact: true }).element();
    expect(again.getBoundingClientRect().right).toBeCloseTo(right, 0);
    expect(name.getBoundingClientRect().right).toBeLessThan(again.getBoundingClientRect().left);
    expect(name.getBoundingClientRect().top).toBeLessThan(again.getBoundingClientRect().bottom);
    // "Every", the field and "minutes" on one line, at either width.
    const input = field("Minutes between reminders").element().getBoundingClientRect();
    const words = card().getByText("minutes", { exact: true }).element().getBoundingClientRect();
    const every = card().getByText("Every", { exact: true }).element().getBoundingClientRect();
    expect(Math.abs(words.top + words.height / 2 - (input.top + input.height / 2))).toBeLessThan(2);
    expect(Math.abs(every.top + every.height / 2 - (input.top + input.height / 2))).toBeLessThan(2);
    expect(input.width).toBe(64);
    expect(words.right).toBeLessThanOrEqual(right + 0.5);
  },
);

test("the idle rule is shown in days while they are whole, and can be set in hours", async () => {
  held = ALL_ON;
  await render(<TimeRulesCard />);
  const unit = card().getByRole("radiogroup", { name: "Idle for" });
  await expect.element(field("Days idle before stale")).toHaveValue("2");
  await expect.element(unit.getByRole("radio", { name: "days" })).toBeChecked();
  // The line finishes its sentence.
  const line = field("Days idle before stale").element().closest("[data-part='set-to'] > div");
  expect(line?.textContent).toBe("Afterhoursdaysidle");

  // The same two days, in hours: nothing to send.
  await unit.getByRole("radio", { name: "hours" }).click();
  await expect.element(field("Hours idle before stale")).toHaveValue("48");
  expect(changes).toEqual([]);

  await type("Hours idle before stale", "6");
  await vi.waitFor(() => expect(lastChange()?.idle).toEqual({ on: true, hours: 6 }));
  await type("Hours idle before stale", "721");
  await expect
    .element(
      card().getByText(/^Type a whole number of hours from 1 to 720, or of days from 1 to 30\.$/),
    )
    .toBeVisible();
  expect(changes).toHaveLength(1);

  // Six hours are not whole days: the unit stays, the card says why, and nothing is rounded or sent.
  await unit.getByRole("radio", { name: "days" }).click();
  await expect.element(card().getByText("6 hours is not a whole number of days.")).toBeVisible();
  await expect.element(unit.getByRole("radio", { name: "hours" })).toBeChecked();
  await expect.element(field("Hours idle before stale")).toHaveValue("6");
  expect(changes).toHaveLength(1);

  // In days, what is typed is whole days.
  await type("Hours idle before stale", "72");
  await vi.waitFor(() => expect(lastChange()?.idle).toEqual({ on: true, hours: 72 }));
  await unit.getByRole("radio", { name: "days" }).click();
  await expect.element(field("Days idle before stale")).toHaveValue("3");
  expect(changes).toHaveLength(2);
});

test("what a field takes is said under that field's line, and goes with the next change to its rule", async () => {
  held = ALL_ON;
  await render(<TimeRulesCard />);
  await type("Quiet from", "25:00");
  const take = card().getByText("Type a time on the 24-hour clock, such as 22:00.");
  await expect.element(take).toBeVisible();
  // 4px under the line of the times, and above the days.
  const times = field("Quiet from").element().parentElement as HTMLElement;
  const gap = take.element().getBoundingClientRect().top - times.getBoundingClientRect().bottom;
  expect(gap).toBe(4);
  const days = card().getByRole("group", { name: "Beginning on" }).element();
  expect(take.element().getBoundingClientRect().bottom).toBeLessThan(
    days.getBoundingClientRect().top,
  );

  // A change to another rule leaves it; a tick of its own rule puts it away.
  await card()
    .getByRole("radiogroup", { name: "Remind me of a long wait" })
    .getByRole("radio", { name: "Off" })
    .click();
  await expect.element(take).toBeVisible();
  await card().getByRole("checkbox", { name: "Sunday" }).click();
  await expect.element(take).not.toBeInTheDocument();
});

test("while the app says quiet hours hold, a line under the times says so, until when", async () => {
  held = ALL_ON;
  const at = Date.now() + 60_000;
  const screen = await render(
    <TimeRulesCard snapshot={{ generatedAt: at, timeRules: ALL_ON, quiet: true }} />,
  );
  const line = card().getByText(
    "Quiet now, until 08:00. Notifications, emails, posts and pushes are held.",
  );
  await expect.element(line).toBeVisible();
  expect(line.element().getAttribute("role")).toBe("status");
  expect(getComputedStyle(line.element()).color).toBe(rgbOf("var(--ink-secondary)"));

  await screen.rerender(
    <TimeRulesCard snapshot={{ generatedAt: at + 2_000, timeRules: ALL_ON, quiet: false }} />,
  );
  await expect.element(line).not.toBeInTheDocument();
});

test("rules changed elsewhere, as in another tab, are taken from a later snapshot, and the next change is made of them", async () => {
  const screen = await render(<TimeRulesCard snapshot={null} />);
  const reminder = card().getByRole("radiogroup", { name: "Remind me of a long wait" });
  await expect.element(reminder.getByRole("radio", { name: "Off" })).toBeChecked();

  const elsewhere: TimeRules = { ...DEFAULT_TIME_RULES, longWait: { on: true, minutes: 25 } };
  // A snapshot made before the card read the rules may hold older ones, and is passed over.
  await screen.rerender(<TimeRulesCard snapshot={{ generatedAt: 1, timeRules: elsewhere }} />);
  await expect.element(reminder.getByRole("radio", { name: "Off" })).toBeChecked();
  await screen.rerender(
    <TimeRulesCard snapshot={{ generatedAt: Date.now() + 60_000, timeRules: elsewhere }} />,
  );
  await expect.element(field("Minutes of waiting before the reminder")).toHaveValue("25");
  await expect.element(reminder.getByRole("radio", { name: "On" })).toBeChecked();

  await card()
    .getByRole("radiogroup", { name: "Mark idle sessions stale" })
    .getByRole("radio", { name: "On" })
    .click();
  await vi.waitFor(() =>
    expect(lastChange()).toEqual({ ...elsewhere, idle: { on: true, hours: 48 } }),
  );
});

test("a change asked for while one the app refuses is on its way is made of what the app holds", async () => {
  let release = () => {};
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bodies: TimeRules[] = [];
  setApiHost(async (path, init) => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (path !== "/api/settings/time-rules") {
      return json({ timeRules: held, file: "~/.agent-lookout/settings.json", problem: null });
    }
    const body = JSON.parse(init?.body as string) as TimeRules;
    bodies.push(body);
    if (bodies.length === 1) {
      await first;
      return json({ error: "It could not be saved.", reason: "not-saved" }, 500);
    }
    held = body;
    return json({ ok: true, timeRules: held });
  });
  await render(<TimeRulesCard />);
  await card()
    .getByRole("radiogroup", { name: "Quiet hours" })
    .getByRole("radio", { name: "On" })
    .click();
  await card()
    .getByRole("radiogroup", { name: "Mark idle sessions stale" })
    .getByRole("radio", { name: "On" })
    .click();
  release();
  await vi.waitFor(() => expect(bodies).toHaveLength(2));
  // Quiet hours, refused, are not sent again with the change after them.
  expect(bodies[1]).toEqual({ ...DEFAULT_TIME_RULES, idle: { on: true, hours: 48 } });
});

test("quiet hours take their times as typed on the 24-hour clock, and refuse the same time at both ends", async () => {
  held = ALL_ON;
  await render(<TimeRulesCard />);
  await expect.element(field("Quiet from")).toHaveValue("22:00");
  await expect.element(field("Quiet until")).toHaveValue("08:00");

  await type("Quiet until", "7");
  await vi.waitFor(() => expect(lastChange()?.quietHours.to).toBe("07:00"));
  await expect.element(field("Quiet until")).toHaveValue("07:00");

  await type("Quiet from", "7:00");
  await expect
    .element(card().getByText("Quiet hours must begin and end at different times."))
    .toBeVisible();
  await expect.element(field("Quiet from")).toHaveValue("22:00");

  await type("Quiet from", "9pm");
  await expect
    .element(card().getByText("Type a time on the 24-hour clock, such as 22:00."))
    .toBeVisible();
  expect(changes).toHaveLength(1);
});

test("the days quiet hours begin on are ticked one by one, and with none ticked the card says they never begin", async () => {
  held = ALL_ON;
  await render(<TimeRulesCard />);
  const days = card().getByRole("group", { name: "Beginning on" });
  await expect.element(days.getByRole("checkbox", { name: "Sunday" })).toBeChecked();

  await days.getByRole("checkbox", { name: "Sunday" }).click();
  await vi.waitFor(() =>
    expect(lastChange()?.quietHours.days).toEqual(["mon", "tue", "wed", "thu", "fri", "sat"]),
  );
  // The short name beside a tick ticks it too.
  await days.getByText("Sat").click();
  await vi.waitFor(() =>
    expect(lastChange()?.quietHours.days).toEqual(["mon", "tue", "wed", "thu", "fri"]),
  );

  held = { ...ALL_ON, quietHours: { ...ALL_ON.quietHours, days: [] } };
  const screen = await render(<TimeRulesCard />);
  await expect
    .element(screen.getByText("No day is ticked, so quiet hours never begin."))
    .toBeVisible();
});

test("the summary can leave out the waits that were answered", async () => {
  held = ALL_ON;
  await render(<TimeRulesCard />);
  const leaveOut = card().getByRole("radiogroup", {
    name: "Leave answered waits out of the summary",
  });
  await leaveOut.getByRole("radio", { name: "On" }).click();
  await vi.waitFor(() => expect(lastChange()?.quietHours.leaveOutAnswered).toBe(true));
  await expect.element(leaveOut.getByRole("radio", { name: "On" })).toBeChecked();
});

test("a change the app does not take leaves the switch as it was, and a note says why", async () => {
  refusing = "~/.agent-lookout/settings.json could not be written, so the change was not saved.";
  await render(<TimeRulesCard />);
  const quiet = card().getByRole("radiogroup", { name: "Quiet hours" });
  await quiet.getByRole("radio", { name: "On" }).click();

  const note = card().getByRole("status").filter({ hasText: "could not be changed" });
  await expect.element(note).toBeVisible();
  expect(note.element().textContent).toContain(refusing);
  await expect.element(quiet.getByRole("radio", { name: "Off" })).toBeChecked();
  // The next change is made of what the app holds, not of what it refused.
  refusing = null;
  await card()
    .getByRole("radiogroup", { name: "Mark idle sessions stale" })
    .getByRole("radio", { name: "On" })
    .click();
  await vi.waitFor(() =>
    expect(lastChange()).toEqual({ ...DEFAULT_TIME_RULES, idle: { on: true, hours: 48 } }),
  );
  await expect.element(note).not.toBeInTheDocument();
});

test("a settings file that could not be read is said in a note, naming the file", async () => {
  problem =
    "~/.agent-lookout/settings.json is a link, which Agent Lookout does not follow, so the time rules and the permission rules are off.";
  await render(<TimeRulesCard />);
  const note = card()
    .getByRole("status")
    .filter({ hasText: "The settings file could not be read" });
  await expect.element(note).toBeVisible();
  expect(getComputedStyle(note.element()).backgroundColor).toBe(rgbOf("var(--fill-quiet)"));
});

test("before the app has answered the card says nothing, and when it cannot be read it says so and offers no switch", async () => {
  let answer = () => {};
  const waiting = new Promise<void>((resolve) => {
    answer = resolve;
  });
  setApiHost(async () => {
    await waiting;
    throw new TypeError("Failed to fetch");
  });
  await render(<TimeRulesCard />);
  const state = card().element().querySelector('[data-part="state"]') as HTMLElement;
  expect(state.textContent).toBe("");
  answer();
  await expect.element(card().getByText("The time rules could not be read.")).toBeVisible();
  expect(state.getAttribute("aria-live")).toBe("polite");
  expect(card().getByRole("radiogroup").elements()).toHaveLength(0);
});

test("the fields are the recessed well of the switches, in ink with numerals that keep their width", async () => {
  held = ALL_ON;
  await render(<TimeRulesCard />);
  const input = field("Quiet from");
  await expect.element(input).toBeVisible();
  const style = getComputedStyle(input.element());
  expect(style.backgroundColor).toBe(rgbOf("var(--well)"));
  expect(style.color).toBe(rgbOf("var(--ink)"));
  expect(style.fontSize).toBe("13px");
  expect(style.fontVariantNumeric).toBe("tabular-nums");
  expect(input.element().getBoundingClientRect().height).toBe(30);
});

test.each([375, 1280])(
  "at %i pixels, with every rule on, nothing runs off the side of the card",
  async (width) => {
    await page.viewport(width, 900);
    onTestFinished(() => page.viewport(1280, 900));
    held = { ...ALL_ON, longWait: REPEATING, idle: { on: true, hours: 36 } };
    const cardWidth = width === 375 ? 283 : 820;
    await render(
      <div style={{ width: cardWidth }}>
        <TimeRulesCard />
      </div>,
    );
    await expect.element(field("Quiet from")).toBeVisible();
    const box = card().element();
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
    const right = box.getBoundingClientRect().right - 24 + 0.5;
    for (const part of box.querySelectorAll<HTMLElement>(
      "p, input, label, [data-slot='segmented-control'], [data-part='rule'] span",
    )) {
      expect(part.getBoundingClientRect().right).toBeLessThanOrEqual(right);
    }
    // Each rule's switch sits at the right of its name, on the name's line.
    for (const rule of box.querySelectorAll<HTMLElement>("[data-part='rule']")) {
      const head = rule.firstElementChild as HTMLElement;
      const [name, control] = [...head.children] as HTMLElement[];
      expect(control?.getBoundingClientRect().right).toBeCloseTo(right - 0.5, 0);
      expect(name?.getBoundingClientRect().top).toBeLessThan(
        control?.getBoundingClientRect().bottom ?? 0,
      );
    }
    // Every Off and On is as wide as the others, however its name wraps beside it.
    const widths = [
      "Remind me of a long wait",
      REMIND_AGAIN,
      "Mark idle sessions stale",
      "Quiet hours",
      LEAVE_OUT,
    ].map(
      (name) => card().getByRole("radiogroup", { name }).element().getBoundingClientRect().width,
    );
    expect(new Set(widths).size).toBe(1);
  },
);

test.each(["dark", "light"] as const)("in the %s theme nothing in it is warm", async (theme) => {
  document.documentElement.setAttribute("data-theme", theme);
  held = ALL_ON;
  const screen = await render(<TimeRulesCard />);
  await expect.element(field("Quiet from")).toBeVisible();
  expect(warmPaint(screen.container)).toEqual([]);
});
