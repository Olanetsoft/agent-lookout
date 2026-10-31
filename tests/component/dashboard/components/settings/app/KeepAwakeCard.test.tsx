import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ACTION_HEADER } from "@core/api";
import type { Session, SourceHealth } from "@core/sessions/session";
import { KeepAwakeCard, NAMED_SESSIONS } from "@dashboard/components/settings/app/KeepAwakeCard";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import { assistivePress } from "@tests/support/browser/browser";
import { warmPaint } from "@tests/support/browser/colours";
import { makeSession } from "@tests/fixtures/session";

const READ = "/api/app/keep-awake";
const SETTING = "/api/app/keep-awake/setting";

/** Whether the switch is on, as `GET /api/app/keep-awake` would say. Off on first launch. */
let on: boolean;
/** Whether the app says it holds the Mac awake, or could not, while the switch is on. */
let holding: boolean;
let failed: boolean;
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
/** When set, the answer to a turn of the switch waits for it, as a slow app's does. */
let settingHeld: Promise<void> | null;

const json = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** What the app says, from where the switch stands and what it holds. */
const status = () => ({ on, holding: on && holding, failed: on && failed });

beforeEach(() => {
  on = false;
  holding = false;
  failed = false;
  asked = [];
  answering = true;
  readAnswer = undefined;
  settingAnswer = undefined;
  settingHeld = null;
  setApiHost(async (path, init) => {
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : null;
    asked.push({ path, method: init?.method ?? "GET", action: headers.get(ACTION_HEADER), body });
    if (!answering) throw new TypeError("Failed to fetch");
    if (path === READ && readAnswer !== undefined) {
      return json(readAnswer.status, readAnswer.body);
    }
    if (path === SETTING) {
      if (settingHeld !== null) await settingHeld;
      if (settingAnswer === "unreachable") throw new TypeError("Failed to fetch");
      if (settingAnswer !== undefined) return json(settingAnswer.status, settingAnswer.body);
      on = (JSON.parse(body ?? "{}") as { on: boolean }).on;
    }
    return json(200, status());
  });
});

afterEach(() => {
  setApiHost();
});

type Screen = Awaited<ReturnType<typeof render>>;

const card = (screen: Screen) => screen.getByRole("region", { name: "Keep awake" });

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
  expect(posts()).toEqual([
    { path: SETTING, method: "POST", action: "keep-awake-setting", body: '{"on":true}' },
  ]);

  asked = [];
  await screen.getByRole("radio", { name: "Off" }).click();
  await expect.element(screen.getByRole("radio", { name: "Off" })).toBeChecked();
  expect(on).toBe(false);
  expect(posts()).toEqual([
    { path: SETTING, method: "POST", action: "keep-awake-setting", body: '{"on":false}' },
  ]);
});

test.each<[string, (screen: Screen) => Promise<unknown>]>([
  ["A tap, a click with no hold,", (screen) => screen.getByRole("radio", { name: "On" }).click()],
  [
    "A click held for a moment",
    (screen) => screen.getByRole("radio", { name: "On" }).click({ delay: 150 }),
  ],
  [
    "An arrow key still held when focus lands",
    async (screen) => {
      (screen.getByRole("radio", { name: "Off" }).element() as HTMLElement).focus();
      await userEvent.keyboard("{ArrowRight>}");
      await expect.element(screen.getByRole("radio", { name: "On" })).toHaveFocus();
      await userEvent.keyboard("{/ArrowRight}");
    },
  ],
  [
    "A press from VoiceOver, Voice Control or Switch Control",
    async (screen) =>
      assistivePress(screen.getByRole("radio", { name: "On" }).element() as HTMLElement),
  ],
])("%s sends On to the app once while its answer is still out", async (_press, press) => {
  let answer = () => {};
  settingHeld = new Promise((resolve) => {
    answer = resolve;
  });
  const screen = await render(<KeepAwakeCard />);
  await expect.element(screen.getByRole("radio", { name: "Off" })).toBeChecked();

  await press(screen);
  await vi.waitFor(() => expect(posts()).toHaveLength(1));
  // Time for a second request to go out, were one coming.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(posts()).toEqual([
    { path: SETTING, method: "POST", action: "keep-awake-setting", body: '{"on":true}' },
  ]);
  // Until the app answers, the switch shows where it stood.
  await expect.element(screen.getByRole("radio", { name: "Off" })).toBeChecked();

  answer();
  await expect.element(screen.getByRole("radio", { name: "On" })).toBeChecked();
  expect(on).toBe(true);
  expect(posts()).toHaveLength(1);
});

test("focus moving onto On, as a screen reader's cursor can carry it, tells the app nothing", async () => {
  const screen = await render(<KeepAwakeCard />);
  await expect.element(screen.getByRole("radio", { name: "Off" })).toBeChecked();

  (screen.getByRole("radio", { name: "On" }).element() as HTMLElement).focus();
  await expect.element(screen.getByRole("radio", { name: "On" })).toHaveFocus();
  // Time for a request to go out, were one coming.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(posts()).toEqual([]);
  await expect.element(screen.getByRole("radio", { name: "Off" })).toBeChecked();
});

test("the switch follows what the app answers, not what was pressed", async () => {
  settingAnswer = { status: 200, body: { on: false, holding: false, failed: false } };
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
    return json(200, status());
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
  expect(text).toContain("A working Claude Code session counts while its process runs");
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

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const MINUTE = 60_000;

/** A source that has been read, so the page's snapshot has counted its sessions. */
const READ_SOURCE: SourceHealth = {
  id: "claude-code",
  label: "Claude Code",
  state: "ok",
  checkedAt: NOW,
};

/** A snapshot of the page's, made at `generatedAt`, from sources that have been read. */
const snapshotOf = (sessions: Session[], generatedAt = NOW, sources = [READ_SOURCE]) => ({
  generatedAt,
  sessions,
  sources,
});

/** Sessions the app's rule counts, and some it does not, here and on another machine. */
const SESSIONS: Session[] = [
  makeSession({ id: "claude-code:a", name: "checkout-flow", status: "needs-you" }),
  makeSession({ id: "claude-code:b", name: "nightly-report", status: "idle" }),
  makeSession({
    id: "gemini-cli:c",
    source: "gemini-cli",
    name: "docs-site",
    status: "working",
    lastWriteAt: NOW - 5 * MINUTE,
  }),
  // Quiet for more than 30 minutes, so it no longer counts.
  makeSession({
    id: "gemini-cli:d",
    source: "gemini-cli",
    name: "old-migration",
    status: "working",
    lastWriteAt: NOW - 45 * MINUTE,
  }),
  makeSession({
    id: "remote:devbox:claude-code:e",
    source: "remote:devbox",
    machine: "devbox",
    name: "api-tests",
    status: "needs-you",
  }),
];

const nowLine = (screen: Screen) =>
  card(screen).element().querySelector<HTMLElement>('[data-part="now"]');

test("with the switch on and the Mac kept awake, it says so and names the sessions that count, here and on another machine", async () => {
  on = true;
  holding = true;
  const screen = await render(<KeepAwakeCard snapshot={snapshotOf(SESSIONS)} />);
  await expect.element(screen.getByRole("radio", { name: "On" })).toBeChecked();
  await vi.waitFor(() =>
    expect(nowLine(screen)?.textContent).toBe(
      "The Mac is being kept awake now, by checkout-flow, docs-site and api-tests on devbox.",
    ),
  );
  // Under the switch, before what it does.
  const row = card(screen).element().querySelector('[data-part="row"]') as HTMLElement;
  expect(row.nextElementSibling).toBe(nowLine(screen));
});

test(`it names the first ${NAMED_SESSIONS} sessions that count, and counts the rest`, async () => {
  on = true;
  holding = true;
  const many = ["one", "two", "three", "four", "five"].map((name) =>
    makeSession({ id: `claude-code:${name}`, name, status: "needs-you" }),
  );
  const screen = await render(<KeepAwakeCard snapshot={snapshotOf(many)} />);
  await vi.waitFor(() =>
    expect(nowLine(screen)?.textContent).toBe(
      "The Mac is being kept awake now, by one, two, three and 2 more.",
    ),
  );
});

test("with the switch on and no session that counts, it says the Mac can sleep as usual", async () => {
  on = true;
  const screen = await render(
    <KeepAwakeCard snapshot={snapshotOf([makeSession({ status: "idle" })])} />,
  );
  await vi.waitFor(() =>
    expect(nowLine(screen)?.textContent).toBe(
      "No session keeps the Mac awake now, so it can go to sleep as usual.",
    ),
  );
});

test("when the app could not keep the Mac awake, it says so rather than look as if it works", async () => {
  on = true;
  failed = true;
  const screen = await render(<KeepAwakeCard snapshot={snapshotOf(SESSIONS)} />);
  await vi.waitFor(() =>
    expect(nowLine(screen)?.textContent).toBe(
      "The Mac could not be kept awake, so it can go to sleep as usual. Agent Lookout tries again every few seconds.",
    ),
  );
  expect(nowLine(screen)?.textContent).not.toContain("checkout-flow");
});

test("while the app holds the Mac awake for a newer snapshot than the page's, which names none, it says so without names", async () => {
  on = true;
  holding = true;
  const screen = await render(
    <KeepAwakeCard snapshot={snapshotOf([makeSession({ status: "idle" })])} />,
  );
  await vi.waitFor(() =>
    expect(nowLine(screen)?.textContent).toBe("The Mac is being kept awake now."),
  );
});

test("with the switch off, it says nothing of now", async () => {
  holding = true;
  const screen = await render(<KeepAwakeCard snapshot={snapshotOf(SESSIONS)} />);
  await expect.element(screen.getByRole("radio", { name: "Off" })).toBeChecked();
  expect(nowLine(screen)).toBeNull();
});

test("asks the app again with each new snapshot, so the line follows a session that starts or stops counting", async () => {
  on = true;
  const screen = await render(<KeepAwakeCard snapshot={snapshotOf([])} />);
  await vi.waitFor(() => expect(nowLine(screen)?.textContent).toContain("No session"));
  const reads = () => asked.filter((request) => request.path === READ).length;
  expect(reads()).toBe(1);

  holding = true;
  await screen.rerender(<KeepAwakeCard snapshot={snapshotOf(SESSIONS, NOW + 2_000)} />);
  await vi.waitFor(() =>
    expect(nowLine(screen)?.textContent).toBe(
      "The Mac is being kept awake now, by checkout-flow, docs-site and api-tests on devbox.",
    ),
  );
  expect(reads()).toBe(2);

  holding = false;
  await screen.rerender(<KeepAwakeCard snapshot={snapshotOf([], NOW + 4_000)} />);
  await vi.waitFor(() => expect(nowLine(screen)?.textContent).toContain("No session"));
  expect(reads()).toBe(3);

  // The same snapshot drawn again asks nothing more.
  await screen.rerender(<KeepAwakeCard snapshot={snapshotOf([], NOW + 4_000)} />);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(reads()).toBe(3);
});

test("a read again that cannot be read leaves the switch and the line as they were", async () => {
  on = true;
  holding = true;
  const screen = await render(<KeepAwakeCard snapshot={snapshotOf(SESSIONS)} />);
  await vi.waitFor(() => expect(nowLine(screen)?.textContent).toContain("checkout-flow"));

  answering = false;
  await screen.rerender(<KeepAwakeCard snapshot={snapshotOf(SESSIONS, NOW + 2_000)} />);
  await vi.waitFor(() => expect(asked.filter((request) => request.path === READ)).toHaveLength(2));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await expect.element(screen.getByRole("radio", { name: "On" })).toBeChecked();
  expect(nowLine(screen)?.textContent).toContain("checkout-flow");
  expect(card(screen).element().querySelector('[data-part="state"]')).toBeNull();
});

test("an answer that comes after a newer one, from a slower read, is left out", async () => {
  on = true;
  const held: (() => void)[] = [];
  let reads = 0;
  setApiHost(async (path) => {
    if (path !== READ) return json(200, status());
    reads += 1;
    // The second read is slow, and says what was so when it was asked.
    if (reads === 2) {
      const then = status();
      await new Promise<void>((resolve) => held.push(resolve));
      return json(200, then);
    }
    return json(200, status());
  });
  const screen = await render(<KeepAwakeCard snapshot={snapshotOf([])} />);
  await vi.waitFor(() => expect(nowLine(screen)?.textContent).toContain("No session"));

  await screen.rerender(<KeepAwakeCard snapshot={snapshotOf([], NOW + 2_000)} />);
  await vi.waitFor(() => expect(held).toHaveLength(1));
  holding = true;
  await screen.rerender(<KeepAwakeCard snapshot={snapshotOf(SESSIONS, NOW + 4_000)} />);
  await vi.waitFor(() => expect(nowLine(screen)?.textContent).toContain("checkout-flow"));

  held[0]?.();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(nowLine(screen)?.textContent).toContain("checkout-flow");
});

test("a working session past its 30 minutes, which the list still shows as Working, does not count, and the line says only that no session keeps the Mac awake", async () => {
  on = true;
  const quietTooLong = SESSIONS.filter((session) => session.name === "old-migration");
  const screen = await render(<KeepAwakeCard snapshot={snapshotOf(quietTooLong)} />);
  await vi.waitFor(() =>
    expect(nowLine(screen)?.textContent).toBe(
      "No session keeps the Mac awake now, so it can go to sleep as usual.",
    ),
  );
  expect(nowLine(screen)?.textContent).not.toMatch(/working/i);
});

test.each<[string, ReturnType<typeof snapshotOf> | null]>([
  ["before the page has a snapshot", null],
  [
    "while every source is still being read",
    snapshotOf([], NOW, [{ ...READ_SOURCE, state: "searching" }]),
  ],
])(
  "%s, it says the sessions have not been read yet, not that none counts",
  async (_when, snapshot) => {
    on = true;
    const screen = await render(<KeepAwakeCard snapshot={snapshot} />);
    await vi.waitFor(() =>
      expect(nowLine(screen)?.textContent).toBe("Agent Lookout has not read your sessions yet."),
    );
  },
);
