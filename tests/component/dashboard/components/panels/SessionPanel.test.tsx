import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type {
  HistoryPoint,
  Session,
  SessionEvent,
  SessionStatus,
  SourceHealth,
} from "@core/sessions/session";
import { SessionPanel } from "@dashboard/components/panels/SessionPanel";
import type { CollectorState } from "@dashboard/lib/api/collectorStore";
import { makeSession } from "@tests/fixtures/session";
import { pointAway } from "@tests/support/browser/browser";
import { rgbOf, warmElements, warmPaint } from "@tests/support/browser/colours";

const NOW = new Date(2026, 9, 6, 14, 32, 30).getTime();
const MINUTE = 60_000;
const ago = (minutes: number) => NOW - minutes * MINUTE;

const CLAUDE_ID = "claude-code:00000000-0000-4000-8000-000000000001";
const CODEX_ID = "codex:00000000-0000-4000-8000-000000000002";
const FILE_ID = "status-files:billing-webhooks.json";
const LINK = "vscode://anthropic.claude-code/open?session=00000000-0000-4000-8000-000000000001";

const SOURCES: SourceHealth[] = [
  { id: "claude-code", label: "Claude Code", state: "ok", checkedAt: NOW },
  { id: "codex", label: "Codex", state: "ok", checkedAt: NOW },
  { id: "status-files", label: "Status files", state: "ok", checkedAt: NOW },
];

/**
 * A Claude Code session waiting for permission in VS Code, a Codex session
 * working and quiet for a while, and an idle session from a status file.
 */
function sessions(): Session[] {
  return [
    makeSession({
      id: CLAUDE_ID,
      name: "checkout-flow",
      surface: "vscode",
      status: "needs-you",
      waitingReason: "permission",
      waitingDetail: "Bash(npm run deploy)",
      cwd: "/Users/example/code/storefront",
      project: "storefront",
      git: { branch: "checkout-flow", repository: { id: "9aaa5f0ab35a5f84", name: "storefront" } },
      startedAt: ago(40),
      statusSince: ago(4),
      pid: 4242,
      alive: true,
      links: { open: LINK },
    }),
    makeSession({
      id: CODEX_ID,
      source: "codex",
      name: "api-rate-limits",
      surface: "terminal",
      status: "working",
      cwd: "/Users/example/code/payments",
      project: "payments",
      git: { commit: "3f9a2c1" },
      startedAt: null,
      statusSince: ago(30),
      lastWriteAt: ago(12),
    }),
    makeSession({
      id: FILE_ID,
      source: "status-files",
      agent: "night-shift",
      name: "billing-webhooks",
      surface: "unknown",
      status: "idle",
      cwd: null,
      project: null,
      startedAt: null,
      statusSince: ago(20),
    }),
  ];
}

let serial = 0;
function changed(
  id: string,
  name: string,
  at: number,
  kind: SessionEvent["kind"],
  from?: SessionStatus,
  to?: SessionStatus,
): SessionEvent {
  serial += 1;
  return {
    id: `event-${serial}`,
    at,
    sessionId: id,
    sessionName: name,
    kind,
    ...(from && { from }),
    ...(to && { to }),
    severity: "advisory",
  };
}

/** Newest first: checkout-flow waited twice, 2 minutes and then 4 so far; api-rate-limits appeared. */
function events(): SessionEvent[] {
  return [
    changed(CLAUDE_ID, "checkout-flow", ago(4), "status-changed", "working", "needs-you"),
    changed(CLAUDE_ID, "checkout-flow", ago(18), "status-changed", "needs-you", "working"),
    changed(CLAUDE_ID, "checkout-flow", ago(20), "status-changed", "working", "needs-you"),
    changed(CODEX_ID, "api-rate-limits", ago(30), "appeared", undefined, "working"),
    changed(CLAUDE_ID, "checkout-flow", ago(40), "appeared", undefined, "working"),
  ];
}

/** Polls every two seconds since the collector began, 45 minutes ago. */
function history() {
  const points: HistoryPoint[] = [];
  for (let at = ago(45); at <= NOW; at += 2_000) {
    points.push({ at, needsYou: 1, working: 1, idle: 1, total: 3 });
  }
  return { startedAt: ago(45), points };
}

function state(overrides: Partial<CollectorState> = {}): CollectorState {
  return {
    phase: "live",
    snapshot: { generatedAt: NOW, sources: SOURCES, sessions: sessions() },
    events: events(),
    history: history(),
    lastOkAt: NOW,
    problem: null,
    problemKind: null,
    ...overrides,
  };
}

function renderPanel(
  sessionId: string | null,
  value: CollectorState = state(),
  onClose = vi.fn(),
  now = NOW,
) {
  return render(<SessionPanel sessionId={sessionId} onClose={onClose} state={value} now={now} />);
}

const dialog = (name: string | RegExp) => page.getByRole("dialog", { name });

/** The value of each fact, by its label, as the page reads it. */
function facts(root: Element): Record<string, string> {
  const found: Record<string, string> = {};
  for (const row of root.querySelectorAll('[data-slot="fact-row"]')) {
    const label = row.querySelector("dt")?.textContent ?? "";
    found[label] = [...row.querySelectorAll("dd")].map((dd) => dd.textContent?.trim()).join(" | ");
  }
  return found;
}

/** Warm paint that is not one of the needs-you signals the rest of the page has too. */
function warmBeyondTheSignals(root: Element): Element[] {
  return warmElements(root).filter(
    (element) =>
      element.closest('[data-slot="status-mark"][data-kind="needs-you"]') === null &&
      element.closest('[data-part="jump"]') === null &&
      element.closest('[data-part="segment"][data-open="true"]') === null,
  );
}

beforeEach(async () => {
  await page.viewport(1440, 900);
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

test("nothing is open without a session's address", async () => {
  await renderPanel(null);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("a Claude Code session waiting in VS Code: its name, the lamp's Jump, every fact, its events newest first and its row of the Timeline", async () => {
  await renderPanel(CLAUDE_ID);
  const panel = dialog("checkout-flow");
  await expect.element(panel).toBeVisible();
  const root = panel.element();
  // It is a dialog named for the session, and focus starts on its title, so a
  // key held down from opening it presses nothing.
  expect(root.getAttribute("data-slot")).toBe("details-modal");
  expect(document.activeElement?.tagName).toBe("H2");
  expect(document.activeElement?.textContent).toBe("checkout-flow");

  // Jump in the head, the lamp's solid one, since the session needs the person now.
  const jump = page.getByRole("link", { name: "Jump to checkout-flow in VS Code" });
  await expect.element(jump).toHaveAttribute("href", LINK);
  expect(jump.element().getAttribute("data-variant")).toBe("needs-you");
  expect(root.querySelector("header")?.contains(jump.element())).toBe(true);

  expect(facts(root)).toEqual({
    Status:
      "Needs you for 4 minutes4m 00sWaiting for permission, since 14:28:30 | Bash(npm run deploy)",
    Agent: "Claude Code",
    App: "VS Code",
    Folder: "/Users/example/code/storefront",
    Repository: "storefront",
    Branch: "checkout-flow",
    Started: "13:52:30",
    Process: "4242",
    Waits: "2 times, 6m 00s in allsince 13:47",
  });
  // The folder is the whole path in the mono, and can be selected to copy.
  const folder = root.querySelector('[data-part="folder"]') as HTMLElement;
  expect(getComputedStyle(folder.closest("dd") as Element).fontFamily).toMatch(/Mono/);
  expect(getComputedStyle(folder).userSelect).not.toBe("none");

  // Its own events, newest first, in the log's rows, and the open wait lit.
  const own = page.getByRole("list", { name: "Its events, newest first" });
  const rows = [...own.element().querySelectorAll('[data-slot="event-row"]')];
  expect(rows.map((row) => row.textContent)).toEqual([
    "14:28:30Started waiting",
    "14:14:30Stopped waiting after 2m 00s",
    "14:12:30Started waiting",
    "13:52:30Appeared",
  ]);
  // Each with the mark of what it moved to, read out: the lamp only for the wait still open.
  expect(
    rows.map((row) => row.querySelector('[data-slot="status-mark"]')?.getAttribute("aria-label")),
  ).toEqual(["Needs you", "Working", "Needed you, answered", "Working"]);
  expect(rows[0]?.getAttribute("data-lit")).toBe("true");
  expect(rows.slice(1).every((row) => !row.hasAttribute("data-lit"))).toBe(true);

  // Its row of the Timeline, alone and unnamed, across the whole width.
  const timeline = root.querySelector('[data-part="timeline"]') as HTMLElement;
  const track = page.getByRole("group", { name: /^checkout-flow: status over time/ });
  await expect.element(track).toBeVisible();
  expect(timeline.querySelectorAll('[data-slot="timeline-row"]')).toHaveLength(1);
  expect(timeline.querySelector('[data-part="name"]')).toBeNull();
  const trackBox = track.element().getBoundingClientRect();
  const partBox = timeline.getBoundingClientRect();
  expect(trackBox.left).toBe(partBox.left);
  expect(trackBox.right).toBe(partBox.right);
  expect(timeline.querySelector('[data-part="segment"][data-open="true"]')).not.toBeNull();
});

test("an event from an earlier day sits under that day's heading, as in the Events log, with the thread running past it", async () => {
  // checkout-flow appeared late last night, before the collector's last start of today.
  const lastNight = new Date(2026, 9, 5, 23, 10, 5).getTime();
  const value = state({
    events: [
      ...events().filter((event) => event.kind !== "appeared"),
      changed(CLAUDE_ID, "checkout-flow", lastNight, "appeared", undefined, "working"),
    ],
    history: { ...history(), startedAt: lastNight - MINUTE },
  });
  await renderPanel(CLAUDE_ID, value);
  await expect.element(dialog("checkout-flow")).toBeVisible();

  const own = page.getByRole("list", { name: "Its events, newest first" }).element();
  expect(
    [...own.children].map((item) => `${item.getAttribute("data-slot")} ${item.textContent}`),
  ).toEqual([
    "event-row 14:28:30Started waiting",
    "event-row 14:14:30Stopped waiting after 2m 00s",
    "event-row 14:12:30Started waiting",
    "event-day Oct 5",
    "event-row 23:10:05Appeared",
  ]);
  // The heading lines up with the times under it, and the thread runs on past it.
  const heading = own.querySelector('[data-slot="event-day"]') as HTMLElement;
  const time = own.querySelector("time") as HTMLElement;
  expect(heading.getBoundingClientRect().left).toBe(time.getBoundingClientRect().left);
  expect(
    [...heading.querySelectorAll('[data-part="thread"]')].map((part) =>
      part.getAttribute("data-kind"),
    ),
  ).toEqual(["line", "line"]);
});

test("a Codex session working and quiet: its commit in the mono, how long it has been quiet, and no Jump", async () => {
  await renderPanel(CODEX_ID);
  const panel = dialog("api-rate-limits");
  await expect.element(panel).toBeVisible();
  const root = panel.element();

  expect(facts(root)).toEqual({
    Status: "Working for 30 minutes30m 00ssince 14:02:30, quiet for 12m",
    Agent: "Codex",
    App: "Terminal",
    Folder: "/Users/example/code/payments",
    Commit: "3f9a2c1",
    Started: "Not reported",
    Waits: "Nonesince 13:47",
  });
  const commit = [...root.querySelectorAll("dt")].find((dt) => dt.textContent === "Commit");
  expect(getComputedStyle(commit?.nextElementSibling as Element).fontFamily).toMatch(/Mono/);
  // Codex documents no way to open its sessions, so there is no Jump.
  expect(root.querySelector('[data-part="jump"]')).toBeNull();
  expect(root.querySelectorAll('[data-slot="event-row"]')).toHaveLength(1);
  // Nothing about it is warm.
  expect(warmPaint(root)).toEqual([]);
});

test("a session from a status file: its own agent, no app, no folder known, and a calm line where it has no events", async () => {
  await renderPanel(FILE_ID);
  const panel = dialog("billing-webhooks");
  await expect.element(panel).toBeVisible();
  const root = panel.element();

  expect(facts(root)).toEqual({
    Status: "Idle for 20 minutes20m 00ssince 14:12:30",
    Agent: "night-shift",
    Folder: "Not known",
    Started: "Not reported",
    Waits: "Nonesince 13:47",
  });
  // An app that is not known is left out, and so is a branch it does not have.
  expect(Object.keys(facts(root))).not.toContain("App");
  expect(root.querySelector('[data-part="events"]')?.textContent).toContain(
    "Nothing has happened to this session since 13:47.",
  );
  expect(root.querySelector('[data-part="jump"]')).toBeNull();
  expect(warmPaint(root)).toEqual([]);
});

test("a session that leaves the list while open says so in one calm line, keeps what was last known with its timers stopped, and has no Jump or lamp", async () => {
  const screen = await renderPanel(CLAUDE_ID);
  const panel = dialog("checkout-flow");
  await expect.element(panel).toBeVisible();

  const left = state({
    snapshot: {
      generatedAt: NOW + MINUTE,
      sources: SOURCES,
      sessions: sessions().filter((session) => session.id !== CLAUDE_ID),
    },
    events: [changed(CLAUDE_ID, "checkout-flow", NOW + MINUTE, "ended", "needs-you"), ...events()],
    lastOkAt: NOW + MINUTE,
  });
  await screen.rerender(
    <SessionPanel sessionId={CLAUDE_ID} onClose={vi.fn()} state={left} now={NOW + 2 * MINUTE} />,
  );

  const root = panel.element();
  await expect
    .element(page.getByText("This session has left the list. Here is what was last known of it."))
    .toBeVisible();
  // Still the session it was, with the time it had when it was last listed.
  expect(facts(root).Status).toMatch(/^Needs you for 4 minutes4m 00s/);
  expect(facts(root).Folder).toBe("/Users/example/code/storefront");
  // No way to reach it, and nothing warm: its wait is over.
  expect(root.querySelector('[data-part="jump"]')).toBeNull();
  expect(warmPaint(root)).toEqual([]);
  expect(root.querySelector('[data-slot="event-row"]')?.textContent).toMatch(/Ended$/);
});

test("an address that names no session says so and offers the Overview, and before the first answer it is reading", async () => {
  const onClose = vi.fn();
  const screen = await renderPanel("claude-code:no-such-session", state(), onClose);
  const panel = dialog("No such session");
  await expect.element(panel).toBeVisible();
  await expect
    .element(panel)
    .toHaveTextContent("Agent Lookout is not watching a session at this address.");
  // The small dialog: a sentence and a button.
  expect(panel.element().getBoundingClientRect().width).toBe(440);
  await page.getByRole("button", { name: "Go to the Overview" }).click();
  expect(onClose).toHaveBeenCalledTimes(1);
  await screen.unmount();

  await renderPanel("claude-code:no-such-session", state({ phase: "connecting", snapshot: null }));
  await expect.element(dialog("Session")).toBeVisible();
  await expect.element(page.getByRole("status")).toHaveTextContent("Reading sessions");
});

test("Escape and the close button ask to close it, and closing gives focus back to the session's row", async () => {
  const onClose = vi.fn();
  const row = document.createElement("table");
  row.innerHTML = `<tbody><tr data-slot="session-row" data-session="${CLAUDE_ID}"><td><a data-part="name" href="#">checkout-flow</a></td></tr></tbody>`;
  document.body.append(row);
  const screen = await renderPanel(CLAUDE_ID, state(), onClose);
  await expect.element(dialog("checkout-flow")).toBeVisible();

  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  await page.getByRole("button", { name: "Close" }).click();
  expect(onClose).toHaveBeenCalledTimes(2);

  // The address closes it: focus goes to the row's name, whatever had it before.
  await screen.rerender(
    <SessionPanel sessionId={null} onClose={onClose} state={state()} now={NOW} />,
  );
  await expect.element(dialog("checkout-flow")).not.toBeInTheDocument();
  expect(document.activeElement).toBe(row.querySelector("a"));
  row.remove();
});

test.each([
  ["dark", 1440],
  ["dark", 375],
  ["light", 1440],
  ["light", 375],
] as const)(
  "in the %s theme at %i pixels it is floating glass that fits the window, and only the needs-you signals are warm",
  async (theme, width) => {
    document.documentElement.setAttribute("data-theme", theme);
    await page.viewport(width, 900);
    await renderPanel(CLAUDE_ID);
    const panel = dialog("checkout-flow");
    await expect.element(panel).toBeVisible();
    await pointAway();
    const root = panel.element();

    // The history dialog's size: 760px, or the window less 16px each side.
    expect(root.getBoundingClientRect().width).toBe(Math.min(760, width - 32));
    expect(getComputedStyle(root).backgroundColor).toBe(rgbOf("var(--glass-float)"));
    expect(getComputedStyle(root).backdropFilter).toMatch(/^blur\(30px\)/);
    // Nothing runs off its side or the window's.
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    for (const value of root.querySelectorAll("dd")) {
      expect(value.getBoundingClientRect().right).toBeLessThanOrEqual(
        root.getBoundingClientRect().right,
      );
    }
    // Jump and the close button share the head's line, beside the title.
    const jump = root.querySelector('[data-part="jump"]') as HTMLElement;
    const close = page.getByRole("button", { name: "Close" }).element();
    expect(Math.round(jump.getBoundingClientRect().top)).toBe(
      Math.round(close.getBoundingClientRect().top),
    );

    // Warm: the lamp of its status and of the event that began the open wait,
    // the open block on its track, and the lamp's Jump. Nothing else.
    expect(warmBeyondTheSignals(root)).toEqual([]);
    expect(getComputedStyle(jump).backgroundColor).toBe(rgbOf("var(--status-needs-you)"));
    const reason = root.querySelector('[data-part="since"]') as HTMLElement;
    expect(getComputedStyle(reason).color).toBe(rgbOf("var(--ink-secondary)"));
  },
);

/** The Claude Code session, asking to run a command. */
function asking(text = "Run: npm run deploy -- --env staging"): CollectorState {
  return state({
    snapshot: {
      generatedAt: NOW,
      sources: SOURCES,
      sessions: sessions().map((session) =>
        session.id === CLAUDE_ID ? { ...session, waitingText: text } : session,
      ),
    },
  });
}

test("what a waiting session is asking is the first line under its status, before the agent's own words, and nothing in it is warm", async () => {
  await renderPanel(CLAUDE_ID, asking());
  const panel = dialog("checkout-flow");
  await expect.element(panel).toBeVisible();
  const root = panel.element();

  const line = root.querySelector('[data-part="asking"]') as HTMLElement;
  expect(line.textContent).toBe("Run: npm run deploy -- --env staging");
  expect(line.closest('[data-part="note"]')).not.toBeNull();
  expect(facts(root).Status).toBe(
    "Needs you for 4 minutes4m 00sWaiting for permission, since 14:28:30 | Run: npm run deploy -- --env stagingBash(npm run deploy)",
  );
  const style = getComputedStyle(line);
  expect(style.fontSize).toBe("12px");
  expect(style.color).toBe(rgbOf("var(--ink-secondary)"));
  expect(style.webkitLineClamp).toBe("2");
  expect(warmBeyondTheSignals(root)).toEqual([]);
});

test("on a phone a long request is cut at two lines in the details, and whole one hover away", async () => {
  await page.viewport(375, 800);
  // As long as the collector lets it be.
  const long = `Run: ${"npm run build && npm run test -- --coverage && ".repeat(3)}echo done`;
  expect(long.length).toBeLessThanOrEqual(200);
  await renderPanel(CLAUDE_ID, asking(long));
  const panel = dialog("checkout-flow");
  await expect.element(panel).toBeVisible();
  const line = panel.element().querySelector('[data-part="asking"]') as HTMLElement;
  const lineHeight = Number.parseFloat(getComputedStyle(line).lineHeight);
  expect(line.getBoundingClientRect().height).toBeLessThanOrEqual(2 * lineHeight + 1);
  await vi.waitFor(() => expect(line.dataset.cut).toBe("true"));
  await userEvent.hover(line);
  await expect.element(page.getByRole("tooltip")).toHaveTextContent(long);
  await pointAway();
});

test("a session that leaves the list while it waits no longer says what it was asking", async () => {
  const screen = await renderPanel(CLAUDE_ID, asking());
  const panel = dialog("checkout-flow");
  await expect.element(panel).toBeVisible();
  expect(panel.element().querySelector('[data-part="asking"]')).not.toBeNull();

  const left = state({
    snapshot: {
      generatedAt: NOW + MINUTE,
      sources: SOURCES,
      sessions: sessions().filter((session) => session.id !== CLAUDE_ID),
    },
    lastOkAt: NOW + MINUTE,
  });
  await screen.rerender(
    <SessionPanel sessionId={CLAUDE_ID} onClose={vi.fn()} state={left} now={NOW + 2 * MINUTE} />,
  );
  await expect
    .element(page.getByText("This session has left the list. Here is what was last known of it."))
    .toBeVisible();
  expect(panel.element().querySelector('[data-part="asking"]')).toBeNull();
  expect(panel.element().textContent).not.toContain("npm run deploy -- --env staging");
});
