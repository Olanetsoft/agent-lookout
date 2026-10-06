import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { CleanUpEntry, CleanUpOutcome } from "@core/api";
import type { Session } from "@core/sessions/session";
import { LeftRunning } from "@dashboard/components/stop/LeftRunning";
import { HIDDEN_SESSIONS_STORAGE_KEY } from "@dashboard/lib/stop/hiddenSessions";
import type { CleanUpAnswer } from "@dashboard/lib/stop/stopRequest";
import { makeSession } from "@tests/fixtures/session";
import { warmPaint } from "@tests/support/browser/colours";

const HOUR = 60 * 60 * 1000;
const NOW = new Date(2026, 9, 6, 14, 30, 0).getTime();

beforeEach(() => {
  localStorage.removeItem(HIDDEN_SESSIONS_STORAGE_KEY);
});

afterEach(() => {
  localStorage.removeItem(HIDDEN_SESSIONS_STORAGE_KEY);
  document.documentElement.removeAttribute("data-theme");
});

/** A session idle so many hours, still running, in VS Code, that the collector can stop. */
function idle(n: number, hours: number, overrides: Partial<Session> = {}): Session {
  return makeSession({
    id: `claude-code:00000000-0000-4000-8000-00000000000${n}`,
    name: `demo-${n}`,
    project: `project-${n}`,
    status: "idle",
    statusSince: NOW - hours * HOUR,
    stale: hours >= 24,
    pid: 4240 + n,
    alive: true,
    surface: "vscode",
    stop: { how: "signal" },
    ...overrides,
  });
}

const SESSIONS = [
  idle(1, 30),
  idle(2, 72, { name: "a-session-with-a-name-long-enough-to-be-cut-on-a-phone" }),
  idle(3, 2),
  idle(4, 50, { surface: "desktop", stop: undefined }),
  idle(5, 40, { status: "working", stale: false }),
];

/** A clean-up that answers when the test says. */
function heldEnd() {
  let answer: (value: CleanUpAnswer) => void = () => {};
  const end = vi.fn(
    (_entries: readonly CleanUpEntry[], _timeoutMs: number) =>
      new Promise<CleanUpAnswer>((resolve) => {
        answer = resolve;
      }),
  );
  return { end, answer: (value: CleanUpAnswer) => answer(value) };
}

const CARD_WIDTH = { 375: 283, 1280: 700 } as const;

async function renderAt(
  width: 375 | 1280,
  sessions: Session[] = SESSIONS,
  end = heldEnd().end,
  onEnded?: () => void,
  onGone?: () => void,
) {
  await page.viewport(width, 900);
  return render(
    <div style={{ width: CARD_WIDTH[width] }} className='glass-card'>
      <LeftRunning sessions={sessions} now={NOW} end={end} onEnded={onEnded} onGone={onGone} />
    </div>,
  );
}

const group = () => document.querySelector('[data-slot="left-running"]') as HTMLElement | null;
const rows = () =>
  [...document.querySelectorAll('[data-slot="left-running-row"]')] as HTMLElement[];
const names = () => rows().map((row) => row.querySelector('[data-part="name"]')?.textContent);
const reviewButton = () => page.getByRole("button", { name: "Review…" });

/** Opens the band, as Review… does. */
async function review() {
  await userEvent.click(reviewButton());
}

test.each([375, 1280] as const)(
  "at %ipx, the sessions left running are one band at first: the count, idle a day or more, and a quiet Review…",
  async (width) => {
    const screen = await renderAt(width);
    await expect.element(page.getByRole("heading", { name: "Left running 3" })).toBeVisible();

    const box = group() as HTMLElement;
    expect(box.querySelector('[data-part="note"]')?.textContent).toBe("idle a day or more");
    // No row, no Hide and no End all… until it is opened.
    expect(rows()).toEqual([]);
    expect(box.querySelectorAll("button").length).toBe(1);
    const button = reviewButton().element();
    expect(button.getAttribute("data-variant")).toBe("quiet");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    // One line on a laptop, two at most on a phone: never more than a table row or two.
    expect(box.getBoundingClientRect().height).toBeLessThanOrEqual(width === 375 ? 56 : 44);
    expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(
      box.getBoundingClientRect().right + 0.5,
    );
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("Review… opens the band in place and Close folds it again, with focus staying on the button", async () => {
  await renderAt(1280);
  await review();
  const button = page.getByRole("button", { name: "Close" });
  expect(button.element().getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(button.element().getAttribute("aria-controls") ?? "")).toBe(
    group()?.querySelector("ul"),
  );
  expect(document.activeElement).toBe(button.element());
  expect(rows()).toHaveLength(3);

  await userEvent.click(button);
  expect(rows()).toEqual([]);
  expect(document.activeElement).toBe(reviewButton().element());
});

test.each([375, 1280] as const)(
  "at %ipx, opened, the sessions left running are listed, each with its age, and nothing overflows",
  async (width) => {
    const screen = await renderAt(width);
    await review();

    // The live sessions idle a day or more, the longest idle first. Not the
    // one idle two hours, and not the one working.
    expect(names()).toEqual([
      "a-session-with-a-name-long-enough-to-be-cut-on-a-phone",
      "demo-4",
      "demo-1",
    ]);
    // Shown short, and read out in words.
    expect(rows().map((row) => row.querySelector('[data-part="place"]')?.textContent)).toEqual([
      "project-2 · VS Code · idle 3didle 3 days",
      "project-4 · Desktop app · idle 2didle 2 days",
      "project-1 · VS Code · idle 1didle 1 day",
    ]);
    // The one in the desktop app says only to stop it there: its details say why.
    expect(rows()[1]?.querySelector('[data-part="desktop"]')?.textContent).toBe(
      "Stop it in the desktop app.",
    );

    const box = group() as HTMLElement;
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
    for (const button of box.querySelectorAll("button")) {
      expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(
        box.getBoundingClientRect().right + 0.5,
      );
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("with nothing left running, there is no group", async () => {
  await renderAt(1280, [idle(3, 2), idle(5, 40, { status: "working", stale: false })]);
  expect(group()).toBeNull();
});

test("each name opens the session's details", async () => {
  await renderAt(1280);
  await review();
  const link = page.getByRole("link", { name: "demo-1, details" });
  await expect
    .element(link)
    .toHaveAttribute("href", "#overview/session/claude-code:00000000-0000-4000-8000-000000000001");
});

test.each([375, 1280] as const)(
  "at %ipx, Hide until it changes takes a session out of the group, kept across a reload, and it comes back once it changes",
  async (width) => {
    const screen = await renderAt(width);
    await review();
    await userEvent.click(page.getByRole("button", { name: "Hide demo-1 until it changes" }));

    expect(names()).not.toContain("demo-1");
    expect(localStorage.getItem(HIDDEN_SESSIONS_STORAGE_KEY)).toContain(
      "claude-code:00000000-0000-4000-8000-000000000001",
    );

    // Drawn again, as after a reload: still hidden.
    await screen.unmount();
    const again = await renderAt(width);
    await expect.element(page.getByRole("heading", { name: "Left running 2" })).toBeVisible();
    await review();
    expect(names()).not.toContain("demo-1");

    // It did something, and is idle again since a later moment: it is back.
    const changed = SESSIONS.map((session) =>
      session.name === "demo-1" ? { ...session, statusSince: NOW - 26 * HOUR } : session,
    );
    await again.rerender(
      <div style={{ width: CARD_WIDTH[width] }} className='glass-card'>
        <LeftRunning sessions={changed} now={NOW} end={heldEnd().end} />
      </div>,
    );
    expect(names()).toContain("demo-1");
  },
);

test("Hide puts focus on the next row's Hide, or the one before for the last row", async () => {
  await renderAt(1280);
  await review();
  await userEvent.click(page.getByRole("button", { name: /^Hide a-session/ }));
  expect(document.activeElement).toBe(
    page.getByRole("button", { name: "Hide demo-4 until it changes" }).element(),
  );

  await userEvent.click(page.getByRole("button", { name: "Hide demo-1 until it changes" }));
  // Only the desktop app's is left, which has no End all…, and its Hide has focus.
  expect(document.querySelector('[data-part="end-all"]')).toBeNull();
  expect(document.activeElement).toBe(
    page.getByRole("button", { name: "Hide demo-4 until it changes" }).element(),
  );
});

test("with every one hidden, the group goes, and focus goes where the card says", async () => {
  const gone = vi.fn();
  await renderAt(1280, [idle(1, 30)], heldEnd().end, undefined, gone);
  await review();
  await userEvent.click(page.getByRole("button", { name: "Hide demo-1 until it changes" }));
  expect(group()).toBeNull();
  expect(gone).toHaveBeenCalledOnce();
});

test.each([375, 1280] as const)(
  "at %ipx, End all… lists each one with a tick, says how many, and puts focus on Cancel",
  async (width) => {
    const { end } = heldEnd();
    const screen = await renderAt(width, SESSIONS, end);
    await review();
    await userEvent.click(page.getByRole("button", { name: "End all…" }));

    const confirm = document.querySelector('[data-part="end-confirm"]') as HTMLElement;
    expect(confirm.querySelector('[data-part="question"]')?.textContent).toBe(
      "End the sessions left running?",
    );
    expect(confirm.querySelector('[data-part="does"]')?.textContent).toBe(
      "Each chosen session's process ends now. Its conversation is kept, and claude --resume opens it again. A session that has done anything since this list was drawn is left running.",
    );
    // Every one is listed. Those that can be ended are ticked; the desktop app's has no tick.
    expect(names()).toEqual([
      "a-session-with-a-name-long-enough-to-be-cut-on-a-phone",
      "demo-4",
      "demo-1",
    ]);
    const ticks = rows().map((row) => row.querySelector('[data-slot="checkbox"]'));
    expect(ticks.map((tick) => tick?.getAttribute("aria-checked") ?? null)).toEqual([
      "true",
      null,
      "true",
    ]);
    expect(page.getByRole("button", { name: "End 2 sessions" }).element()).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(end).not.toHaveBeenCalled();

    const box = group() as HTMLElement;
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("unticking one leaves it out, and the button says so; with none ticked, End sends nothing", async () => {
  const { end } = heldEnd();
  await renderAt(1280, SESSIONS, end);
  await review();
  await userEvent.click(page.getByRole("button", { name: "End all…" }));
  await userEvent.click(page.getByRole("checkbox", { name: "End demo-1" }));

  const button = page.getByRole("button", { name: "End 1 session" });
  await expect.element(button).toBeVisible();
  await userEvent.click(page.getByRole("checkbox", { name: /^End a-session/ }));
  const none = page.getByRole("button", { name: "End 0 sessions" });
  expect(none.element().getAttribute("aria-disabled")).toBe("true");
  (none.element() as HTMLButtonElement).click();
  expect(end).not.toHaveBeenCalled();
});

test("Cancel puts the group back as it was, with focus on End all…", async () => {
  const { end } = heldEnd();
  await renderAt(1280, SESSIONS, end);
  await review();
  await userEvent.click(page.getByRole("button", { name: "End all…" }));
  await userEvent.keyboard("{Enter}");

  expect(document.querySelector('[data-part="end-confirm"]')).toBeNull();
  expect(document.activeElement?.textContent).toBe("End all…");
  expect(end).not.toHaveBeenCalled();
});

test("End sends each ticked session with the moment its idle began, then says what came of each", async () => {
  const { end, answer } = heldEnd();
  const ended = vi.fn();
  await renderAt(1280, SESSIONS, end, ended);
  await review();
  await userEvent.click(page.getByRole("button", { name: "End all…" }));
  await userEvent.click(page.getByRole("button", { name: "End 2 sessions" }));

  expect(end).toHaveBeenCalledOnce();
  expect(end.mock.calls[0]?.[0]).toEqual([
    { sessionId: "claude-code:00000000-0000-4000-8000-000000000002", statusSince: NOW - 72 * HOUR },
    { sessionId: "claude-code:00000000-0000-4000-8000-000000000001", statusSince: NOW - 30 * HOUR },
  ]);
  expect(document.querySelector('[data-part="question"]')?.textContent).toBe("Ending 2 sessions…");

  answer({
    ok: true,
    results: new Map<string, CleanUpOutcome>([
      ["claude-code:00000000-0000-4000-8000-000000000002", "ended"],
      ["claude-code:00000000-0000-4000-8000-000000000001", "became-active"],
    ]),
  });
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Ended 1. Left 1 running because it became active.");
  expect(document.activeElement?.getAttribute("data-part")).toBe("summary");
  expect(
    rows().map((row) => row.querySelector('[data-part="outcome"]')?.textContent ?? null),
  ).toEqual(["Ended", null, "Became active"]);
  // The one ended has Ended's mark. The one that became active no longer
  // says it has been idle, and the one not chosen is as it was.
  expect(rows()[0]?.querySelector('[data-slot="status-mark"]')?.getAttribute("data-kind")).toBe(
    "ended",
  );
  expect(rows().map((row) => row.querySelector('[data-part="place"]')?.textContent)).toEqual([
    "project-2 · VS Code · idle 3didle 3 days",
    "project-4 · Desktop app · idle 2didle 2 days",
    "project-1 · VS Code",
  ]);
  // Two are still left running.
  await expect.element(page.getByRole("heading", { name: "Left running 2" })).toBeVisible();
  expect(ended).toHaveBeenCalledOnce();

  await userEvent.click(page.getByRole("button", { name: "Done" }));
  expect(document.querySelector('[data-part="summary"]')).toBeNull();
});

/** So many sessions left running in VS Code, each a few minutes longer idle than the last. */
function many(count: number): Session[] {
  return Array.from({ length: count }, (_, index) =>
    makeSession({
      id: `claude-code:00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: `demo-${index + 1}`,
      project: "demo-project",
      status: "idle",
      statusSince: NOW - 25 * HOUR - index * 60_000,
      stale: true,
      pid: 5000 + index,
      alive: true,
      surface: "vscode",
      stop: { how: "signal" },
    }),
  );
}

test.each([375, 1280] as const)(
  "at %ipx, with more than 20 left running, End all… ticks 20, says so, and no more can be ticked",
  async (width) => {
    const { end } = heldEnd();
    await renderAt(width, many(25), end);
    await review();
    await userEvent.click(page.getByRole("button", { name: "End all…" }));

    const ticked = () =>
      rows().filter(
        (row) =>
          row.querySelector('[data-slot="checkbox"]')?.getAttribute("aria-checked") === "true",
      );
    // The 20 idle longest are ticked, and the button counts what is sent.
    expect(rows()).toHaveLength(25);
    expect(ticked()).toHaveLength(20);
    expect(ticked()[0]?.dataset.session).toBe(many(25)[24]?.id);
    await expect.element(page.getByRole("button", { name: "End 20 sessions" })).toBeVisible();
    expect(document.querySelector('[data-part="limit"]')?.textContent).toBe("Up to 20 at a time.");

    // A 21st cannot be ticked.
    const spare = page.getByRole("checkbox", { name: "End demo-5", exact: true });
    expect(spare.element().getAttribute("aria-checked")).toBe("false");
    expect((spare.element() as HTMLButtonElement).disabled).toBe(true);
    (spare.element() as HTMLButtonElement).click();
    expect(ticked()).toHaveLength(20);

    // Untick one and another can be.
    await userEvent.click(page.getByRole("checkbox", { name: "End demo-25", exact: true }));
    expect((spare.element() as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(spare);
    expect(ticked()).toHaveLength(20);

    await userEvent.click(page.getByRole("button", { name: "End 20 sessions" }));
    const sent = end.mock.calls[0]?.[0] ?? [];
    expect(sent).toHaveLength(20);
    expect(sent.map((entry) => entry.sessionId)).toContain(many(25)[4]?.id);
    expect(sent.map((entry) => entry.sessionId)).not.toContain(many(25)[24]?.id);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
);

test("a clean-up that could not be tried says why, and can be tried again", async () => {
  const { end, answer } = heldEnd();
  await renderAt(1280, SESSIONS, end);
  await review();
  await userEvent.click(page.getByRole("button", { name: "End all…" }));
  await userEvent.click(page.getByRole("button", { name: "End 2 sessions" }));
  answer({ ok: false, reason: "too-soon" });

  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Another session is being stopped. Try again in a moment.");
  expect(document.activeElement?.textContent).toBe("Cancel");
  expect(page.getByRole("button", { name: "End 2 sessions" }).element()).toBeTruthy();
});

test("only a session in the desktop app has no End all…", async () => {
  await renderAt(1280, [idle(4, 50, { surface: "desktop", stop: undefined })]);
  await expect.element(page.getByRole("heading", { name: "Left running 1" })).toBeVisible();
  await review();
  expect(rows()).toHaveLength(1);
  expect(document.querySelector('[data-part="end-all"]')).toBeNull();
});

test("with the idle rule on, the band says how long the rule says", async () => {
  await page.viewport(1280, 900);
  await render(
    <div style={{ width: CARD_WIDTH[1280] }} className='glass-card'>
      <LeftRunning sessions={SESSIONS} now={NOW} end={heldEnd().end} staleAfterMs={72 * HOUR} />
    </div>,
  );
  await expect.element(page.getByRole("heading", { name: "Left running 3" })).toBeVisible();
  expect(group()?.querySelector('[data-part="note"]')?.textContent).toBe("idle 3 days or more");
});
