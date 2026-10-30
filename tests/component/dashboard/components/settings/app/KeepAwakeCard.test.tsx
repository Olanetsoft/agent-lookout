import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ACTION_HEADER } from "@core/api";
import { KeepAwakeCard } from "@dashboard/components/settings/app/KeepAwakeCard";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import { warmPaint } from "@tests/support/browser/colours";

const READ = "/api/app/keep-awake";
const SETTING = "/api/app/keep-awake/setting";

/** Whether the switch is on, as `GET /api/app/keep-awake` would say. Off on first launch. */
let on: boolean;
/** Each request the card made: its path, method, action and body. */
let asked: { path: string; method: string; action: string | null; body: string | null }[];
/** Whether the app answers at all. */
let answering: boolean;
/**
 * What the app answers to a read or to a turn of the switch, in place of where
 * the switch stands: a refusal, an answer that cannot be read, or another
 * stand. Undefined answers as the app does.
 */
let readAnswer: { status: number; body: unknown } | undefined;
let settingAnswer: { status: number; body: unknown } | "unreachable" | undefined;

const json = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  on = false;
  asked = [];
  answering = true;
  readAnswer = undefined;
  settingAnswer = undefined;
  setApiHost(async (path, init) => {
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : null;
    asked.push({ path, method: init?.method ?? "GET", action: headers.get(ACTION_HEADER), body });
    if (!answering) throw new TypeError("Failed to fetch");
    if (path === READ && readAnswer !== undefined) {
      return json(readAnswer.status, readAnswer.body);
    }
    if (path === SETTING) {
      if (settingAnswer === "unreachable") throw new TypeError("Failed to fetch");
      if (settingAnswer !== undefined) return json(settingAnswer.status, settingAnswer.body);
      on = (JSON.parse(body ?? "{}") as { on: boolean }).on;
    }
    return json(200, { on });
  });
});

afterEach(() => {
  setApiHost();
});

const card = (screen: Awaited<ReturnType<typeof render>>) =>
  screen.getByRole("region", { name: "Keep awake" });

const posts = () => asked.filter((request) => request.path === SETTING);

/** Lets a refused or unreadable answer come back, and the card draw what it makes of it. */
async function settled() {
  await vi.waitFor(() => expect(posts().length).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 50));
}

test("on first launch the switch Keep the Mac awake reads Off, as the app says, and only a read is asked", async () => {
  const screen = await render(<KeepAwakeCard />);
  await expect
    .element(card(screen).getByRole("radiogroup", { name: "Keep the Mac awake" }))
    .toBeVisible();
  await expect.element(screen.getByRole("radio", { name: "Off" })).toBeChecked();
  await expect.element(screen.getByRole("radio", { name: "On" })).not.toBeChecked();
  expect(asked).toEqual([{ path: READ, method: "GET", action: null, body: null }]);
});

test("a switch turned on before reads On", async () => {
  on = true;
  const screen = await render(<KeepAwakeCard />);
  await expect.element(screen.getByRole("radio", { name: "On" })).toBeChecked();
});

test("choosing On tells the app with its own action, and the switch shows the app's answer; Off turns it off again", async () => {
  const screen = await render(<KeepAwakeCard />);
  await expect.element(screen.getByRole("radio", { name: "Off" })).toBeChecked();

  await screen.getByRole("radio", { name: "On" }).click();
  await expect.element(screen.getByRole("radio", { name: "On" })).toBeChecked();
  expect(on).toBe(true);
  expect(posts().length).toBeGreaterThan(0);
  for (const post of posts()) {
    expect(post).toEqual({
      path: SETTING,
      method: "POST",
      action: "keep-awake-setting",
      body: '{"on":true}',
    });
  }

  asked = [];
  await screen.getByRole("radio", { name: "Off" }).click();
  await expect.element(screen.getByRole("radio", { name: "Off" })).toBeChecked();
  expect(on).toBe(false);
  expect(posts()).toContainEqual({
    path: SETTING,
    method: "POST",
    action: "keep-awake-setting",
    body: '{"on":false}',
  });
});

test("the switch follows what the app answers, not what was pressed", async () => {
  settingAnswer = { status: 200, body: { on: false } };
  const screen = await render(<KeepAwakeCard />);
  await expect.element(screen.getByRole("radio", { name: "Off" })).toBeChecked();
  await screen.getByRole("radio", { name: "On" }).click();
  await settled();
  await expect.element(screen.getByRole("radio", { name: "Off" })).toBeChecked();
});

test.each<[string, typeof settingAnswer]>([
  ["refuses it", { status: 403, body: { error: "No." } }],
  ["answers with something it cannot read", { status: 200, body: { on: "yes" } }],
  ["answers with what is not JSON", { status: 200, body: "not json" }],
  ["cannot be reached", "unreachable"],
])("a change the app %s leaves the switch as it was", async (_what, answer) => {
  on = true;
  settingAnswer = answer;
  const screen = await render(<KeepAwakeCard />);
  await expect.element(screen.getByRole("radio", { name: "On" })).toBeChecked();
  await screen.getByRole("radio", { name: "Off" }).click();
  await settled();
  await expect.element(screen.getByRole("radio", { name: "On" })).toBeChecked();
  // Still the switch, never the line that says it could not be read.
  expect(card(screen).element().querySelector('[data-part="state"]')).toBeNull();
});

test.each<[string, () => void]>([
  [
    "does not answer",
    () => {
      answering = false;
    },
  ],
  [
    "answers 404, as a server that is not the app does",
    () => {
      readAnswer = { status: 404, body: { error: "There is nothing at that address." } };
    },
  ],
  [
    "answers with something it cannot read",
    () => {
      readAnswer = { status: 200, body: { show: true } };
    },
  ],
])("when the app %s, it says so and offers no switch", async (_what, arrange) => {
  arrange();
  const screen = await render(<KeepAwakeCard />);
  await expect
    .element(card(screen).getByText("Whether the Mac is kept awake could not be read."))
    .toBeVisible();
  expect(screen.getByRole("radiogroup").elements()).toHaveLength(0);
  expect(posts()).toEqual([]);
});

test("before the app has answered, the row is empty and keeps its height", async () => {
  let answer = () => {};
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  setApiHost(async () => {
    await held;
    return json(200, { on: false });
  });
  const screen = await render(<KeepAwakeCard />);
  const row = card(screen).element().querySelector('[data-part="row"]') as HTMLElement;
  const before = row.getBoundingClientRect().height;
  expect(row.textContent).toBe("");
  expect(screen.getByRole("radiogroup").elements()).toHaveLength(0);
  expect(before).toBeGreaterThan(0);

  answer();
  await expect
    .element(screen.getByRole("radiogroup", { name: "Keep the Mac awake" }))
    .toBeVisible();
  expect(row.getBoundingClientRect().height).toBe(before);
});

test("says what it does, which sessions count, that the display still sleeps, what still puts the Mac to sleep, and that npx agent-lookout cannot do it", async () => {
  const screen = await render(<KeepAwakeCard />);
  await expect.element(screen.getByRole("radio", { name: "Off" })).toBeChecked();
  const text = (card(screen).element().textContent ?? "").replace(/\s+/g, " ");

  expect(text).toContain("does not go to sleep on its own while a session is working or needs you");
  expect(text).toContain("on this Mac or on another machine Agent Lookout watches");
  expect(text).toContain("The display still turns off.");
  expect(text).toContain("A working Claude Code session counts for as long as it works");
  expect(text).toContain("stops counting 30 minutes after its newest update");
  expect(text).toContain("Closing the lid still puts the Mac to sleep");
  expect(text).toContain("unless it is plugged in with a display connected");
  expect(text).toContain("and so do Sleep in the Apple menu and a low battery");
  expect(text).toContain("cannot keep the Mac awake");

  // The command is set as a command, in the mono.
  const command = [...card(screen).element().querySelectorAll("code")].find(
    (code) => code.textContent === "npx agent-lookout",
  );
  expect(command).toBeDefined();
  expect(getComputedStyle(command as HTMLElement).fontFamily).toMatch(
    /^"?Atkinson Hyperlegible Mono/,
  );
});

test.each(["dark", "light"] as const)(
  "in the %s theme nothing in it is warm, On or Off",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      const screen = await render(<KeepAwakeCard />);
      await expect.element(screen.getByRole("radio", { name: "Off" })).toBeChecked();
      expect(warmPaint(screen.container)).toEqual([]);
      await screen.getByRole("radio", { name: "On" }).click();
      await expect.element(screen.getByRole("radio", { name: "On" })).toBeChecked();
      expect(warmPaint(screen.container)).toEqual([]);
    } finally {
      document.documentElement.removeAttribute("data-theme");
    }
  },
);
