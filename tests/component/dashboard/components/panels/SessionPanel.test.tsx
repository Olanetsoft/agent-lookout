import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { LAST_MESSAGE_PATH, type LastMessageResponse } from "@core/api";
import type {
  HistoryPoint,
  PullRequest,
  Session,
  SessionEvent,
  SessionStatus,
  SourceHealth,
} from "@core/sessions/session";
import { SessionPanel } from "@dashboard/components/panels/SessionPanel";
import { setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";
import type { CollectorState } from "@dashboard/lib/api/collectorStore";
import { readSession } from "@dashboard/lib/api/readApi";
import {
  CLAUDE_CODE_CAPABILITIES,
  CODEX_CAPABILITIES,
  STATUS_FILE_CAPABILITIES,
} from "@site-tour/feed/sources";
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
  {
    id: "claude-code",
    label: "Claude Code",
    state: "ok",
    capabilities: CLAUDE_CODE_CAPABILITIES,
    checkedAt: NOW,
  },
  { id: "codex", label: "Codex", state: "ok", capabilities: CODEX_CAPABILITIES, checkedAt: NOW },
  {
    id: "status-files",
    label: "Status files",
    state: "ok",
    capabilities: STATUS_FILE_CAPABILITIES,
    checkedAt: NOW,
  },
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
      tokens: { input: 182_431, cached: 141_002, output: 9_120 },
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

/** An answer of the API. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const NOTHING_YET: LastMessageResponse = { message: null, reason: "nothing-yet" };

/** The page's own transport, which the tests that ask nothing else leave in place. */
const sameOrigin: ApiHost = (path, init) => fetch(path, init);

/**
 * A transport that answers what the open details ask of a session's last
 * message, with nothing said yet unless the test says otherwise, and passes
 * every other request on to `rest`.
 */
function lastMessageHost(
  answer: (path: string) => Response | Promise<Response> = () => json(NOTHING_YET),
  rest: ApiHost = sameOrigin,
): ApiHost {
  return (path, init) =>
    path.startsWith(`${LAST_MESSAGE_PATH}?`) ? Promise.resolve(answer(path)) : rest(path, init);
}

beforeEach(async () => {
  await page.viewport(1440, 900);
  // The details of a session here ask what it last said while they are open.
  setApiHost(lastMessageHost());
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  setApiHost();
  delete (document as { hidden?: boolean }).hidden;
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
    Tokens: "–Not recordedAgent Lookout does not read the token counts in its transcripts yet.",
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
    Tokens:
      "182,431 in, 9,120 out182,431 tokens in, 9,120 tokens outNewest reply · 141,002 of the input from a cache",
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

test("the token counts of the newest reply are a fact after the process and before the waits, and nothing about them is warm", async () => {
  const claude = await renderPanel(CLAUDE_ID);
  await expect.element(dialog("checkout-flow")).toBeVisible();
  expect(Object.keys(facts(dialog("checkout-flow").element()))).toEqual([
    "Status",
    "Agent",
    "App",
    "Folder",
    "Repository",
    "Branch",
    "Started",
    "Process",
    "Tokens",
    "Waits",
  ]);
  await claude.unmount();

  await renderPanel(CODEX_ID);
  const root = dialog("api-rate-limits").element();
  await expect.element(root).toBeVisible();
  const labels = Object.keys(facts(root));
  // With no process reported, it follows when the session started.
  expect(labels.slice(labels.indexOf("Started"))).toEqual(["Started", "Tokens", "Waits"]);
  const tokens = root.querySelector('[data-part="tokens"]') as HTMLElement;
  expect(tokens.closest('[data-slot="fact-row"]')?.querySelector("dt")?.textContent).toBe("Tokens");
  expect(root.querySelector('[data-part="tokens-note"]')?.textContent).toBe(
    "Newest reply · 141,002 of the input from a cache",
  );
  expect(warmPaint(tokens.closest('[data-slot="fact-row"]') as Element)).toEqual([]);
  // The counts are said once, in the details, and nowhere else in them.
  expect(root.textContent?.match(/182,431/g)).toHaveLength(2);
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
    Tokens: "–Not recordedA status file has no field for token counts.",
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
  // Focus moves once the dialog has closed, which can be a frame later on a slow machine.
  await expect.poll(() => document.activeElement).toBe(row.querySelector("a"));
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

/** The pull request of api-rate-limits' branch, open, with a check failing. */
const PULL_REQUEST: PullRequest = {
  number: 51,
  title: "Limit the rate of calls to the payments API",
  state: "open",
  checks: { state: "failing", passing: 4, failing: 2, pending: 1 },
  url: "https://github.com/example-org/payments/pull/51",
};

/** The Codex session on a branch, with the pull request given, as with pull requests on. */
function onPullRequest(pullRequest: PullRequest = PULL_REQUEST): CollectorState {
  return state({
    snapshot: {
      generatedAt: NOW,
      sources: SOURCES,
      sessions: sessions().map((session) =>
        session.id === CODEX_ID
          ? {
              ...session,
              git: {
                branch: "rate-limits",
                repository: { id: "4c1f9e2d7a3b5c60", name: "payments" },
                pullRequest,
              },
            }
          : session,
      ),
    },
  });
}

test.each([
  ["dark", 1280],
  ["dark", 375],
  ["light", 1280],
  ["light", 375],
] as const)(
  "in the %s theme at %i pixels, a branch's pull request is a fact: its number and title, a link to it on github.com, its state and its checks, and nothing of it is warm",
  async (theme, width) => {
    document.documentElement.setAttribute("data-theme", theme);
    await page.viewport(width, 900);
    await renderPanel(CODEX_ID, onPullRequest());
    const panel = dialog("api-rate-limits");
    await expect.element(panel).toBeVisible();
    await pointAway();
    const root = panel.element();

    // After the branch, before when it started.
    const labels = [...root.querySelectorAll('[data-slot="fact-row"] dt')].map(
      (label) => label.textContent,
    );
    expect(labels.slice(labels.indexOf("Branch"), labels.indexOf("Branch") + 3)).toEqual([
      "Branch",
      "Pull request",
      "Started",
    ]);
    expect(facts(root)["Pull request"]).toBe(
      "#51 Limit the rate of calls to the payments APIOpen, 2 checks failing, 1 pending, 4 passing",
    );

    // The link opens the pull request on github.com, in a tab of its own.
    const link = page.getByRole("link", {
      name: "#51 Limit the rate of calls to the payments API",
    });
    await expect.element(link).toHaveAttribute("href", PULL_REQUEST.url);
    await expect.element(link).toHaveAttribute("target", "_blank");
    expect(link.element().getAttribute("rel")?.split(" ").sort()).toEqual([
      "noopener",
      "noreferrer",
    ]);
    const style = getComputedStyle(link.element());
    expect(style.color).toBe(rgbOf("var(--ink)"));
    expect(style.textDecorationLine).toBe("underline");

    // Its state and its checks, under it, in the caption a fact's second line takes.
    const line = root.querySelector('[data-part="pull-request-state"]') as HTMLElement;
    expect(line.textContent).toBe("Open, 2 checks failing, 1 pending, 4 passing");
    expect(getComputedStyle(line).fontSize).toBe("12px");
    expect(getComputedStyle(line).color).toBe(rgbOf("var(--ink-secondary)"));

    // Nothing runs off the dialog's side or the window's, however long the title.
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    const value = link.element().closest("dd") as HTMLElement;
    expect(value.getBoundingClientRect().right).toBeLessThanOrEqual(
      root.getBoundingClientRect().right,
    );
    expect(warmBeyondTheSignals(root)).toEqual([]);

    // Tab reaches it, with the one focus ring.
    link.element().focus();
    expect(document.activeElement).toBe(link.element());
  },
);

test("a draft, a merged and a closed pull request say so, and one with no checks says that", async () => {
  const lines: string[] = [];
  for (const pullRequest of [
    {
      ...PULL_REQUEST,
      state: "draft",
      checks: { state: "none", passing: 0, failing: 0, pending: 0 },
    },
    {
      ...PULL_REQUEST,
      state: "merged",
      checks: { state: "passing", passing: 6, failing: 0, pending: 0 },
    },
    {
      ...PULL_REQUEST,
      state: "closed",
      checks: { state: "pending", passing: 2, failing: 0, pending: 1 },
    },
  ] as const) {
    const screen = await renderPanel(CODEX_ID, onPullRequest(pullRequest));
    await expect.element(dialog("api-rate-limits")).toBeVisible();
    lines.push(
      dialog("api-rate-limits").element().querySelector('[data-part="pull-request-state"]')
        ?.textContent ?? "",
    );
    await screen.unmount();
  }
  expect(lines).toEqual([
    "Draft, no checks",
    "Merged, 6 checks passing",
    "Closed, 1 check pending, 2 passing",
  ]);
});

test.each([1280, 375])(
  "at %i pixels a title as long as the collector lets one be takes two lines at most, and on a phone is whole one hover away on its link",
  async (width) => {
    await page.viewport(width, 800);
    const title = "Limit the rate of calls to the payments API, and retry the ones refused later "
      .repeat(3)
      .slice(0, 200)
      .trim();
    await renderPanel(CODEX_ID, onPullRequest({ ...PULL_REQUEST, title }));
    const panel = dialog("api-rate-limits");
    await expect.element(panel).toBeVisible();
    const root = panel.element();
    const link = root.querySelector('[data-part="pull-request"]') as HTMLAnchorElement;
    const lineHeight = Number.parseFloat(getComputedStyle(link).lineHeight);
    expect(link.getBoundingClientRect().height).toBeLessThanOrEqual(2 * lineHeight + 1);
    expect(getComputedStyle(link).webkitLineClamp).toBe("2");
    // Its state and checks still follow it, whole.
    const line = root.querySelector('[data-part="pull-request-state"]') as HTMLElement;
    expect(line.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      link.getBoundingClientRect().bottom - 1,
    );
    expect(line.textContent).toBe("Open, 2 checks failing, 1 pending, 4 passing");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

    if (width === 375) {
      // On a phone it is cut, and the whole of it is in the link's tooltip.
      await vi.waitFor(() => expect(link.dataset.cut).toBe("true"));
      await userEvent.hover(link);
      await expect.element(page.getByRole("tooltip")).toHaveTextContent(`#51 ${title}`);
      await pointAway();
    }
  },
);

test("a session whose branch has no pull request, as with pull requests off, has no such fact", async () => {
  await renderPanel(CLAUDE_ID);
  await expect.element(dialog("checkout-flow")).toBeVisible();
  expect(facts(dialog("checkout-flow").element())).not.toHaveProperty("Pull request");
});

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

test("a request held for the plugin is at the top of the details, whole, with Allow and Deny, in place of the line", async () => {
  const held = state({
    snapshot: {
      generatedAt: NOW,
      sources: SOURCES,
      sessions: sessions().map((session) =>
        session.id === CLAUDE_ID
          ? {
              ...session,
              waitingText: "Run: npm run deploy",
              ask: {
                requestId: "0123456789abcdef0123456789abcdef",
                tool: "Bash",
                command: "npm run deploy -- --env staging\nnpm run smoke",
                description: "Deploy to staging",
                allow: true,
                until: NOW + 300_000,
              },
            }
          : session,
      ),
    },
  });
  await renderPanel(CLAUDE_ID, held);
  const panel = dialog("checkout-flow");
  await expect.element(panel).toBeVisible();
  const root = panel.element();
  const answer = root.querySelector('[data-slot="answer"]') as HTMLElement;
  expect(answer.querySelector('[data-part="command"]')?.textContent).toBe(
    "npm run deploy -- --env staging\nnpm run smoke",
  );
  expect([...answer.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "Deny",
    "Allow",
  ]);
  // It comes before the facts, and the status's note no longer repeats it in a line.
  expect(answer.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    (root.querySelector('[data-slot="fact-list"], dl') as HTMLElement).getBoundingClientRect().top +
      0.5,
  );
  expect(root.querySelector('[data-part="asking"]')).toBeNull();
  expect(warmBeyondTheSignals(root)).toEqual([]);
  // Focus starts on the title, not on Allow.
  expect(document.activeElement?.textContent).not.toBe("Allow");
});

/** The listed sessions, with the Claude Code one changed as a test says. */
function withClaude(overrides: Partial<Session>): CollectorState {
  return state({
    snapshot: {
      generatedAt: NOW,
      sources: SOURCES,
      sessions: sessions().map((session) =>
        session.id === CLAUDE_ID ? { ...session, ...overrides } : session,
      ),
    },
  });
}

test("a session whose prompt was answered, while its file still says it waits, says Answered and when it asked, with nothing warm", async () => {
  await renderPanel(CLAUDE_ID, withClaude({ answered: true }));
  const panel = dialog("checkout-flow");
  await expect.element(panel).toBeVisible();
  const root = panel.element();

  // The answered mark and the word, with no length: when it was answered is not known here.
  expect(facts(root).Status).toBe("Answeredasked for permission at 14:28:30");
  const status = root.querySelector('[data-slot="fact-row"] [data-slot="status-mark"]');
  expect(status?.getAttribute("data-kind")).toBe("answered");
  // Its Jump is the quiet one, and its wait is over in its events and on its timeline.
  const jump = page.getByRole("link", { name: "Jump to checkout-flow in VS Code" });
  expect(jump.element().getAttribute("data-variant")).toBe("quiet");
  const own = page.getByRole("list", { name: "Its events, newest first" });
  const newest = own.element().querySelector('[data-slot="event-row"]');
  expect(newest?.querySelector('[data-slot="status-mark"]')?.getAttribute("aria-label")).toBe(
    "Needed you, answered",
  );
  expect(newest?.hasAttribute("data-lit")).toBe(false);
  expect(root.querySelector('[data-part="segment"][data-open="true"]')).toBeNull();
  expect(warmElements(root)).toEqual([]);
});

test.each([375, 1440])(
  "at %ipx, a session the collector can stop has Stop beside its Jump, which asks first at the top of the details",
  async (width) => {
    await page.viewport(width, 900);
    await renderPanel(CLAUDE_ID, withClaude({ stop: { how: "signal" } }));
    const panel = dialog("checkout-flow");
    await expect.element(panel).toBeVisible();
    const root = panel.element();
    const head = root.querySelector("header") as HTMLElement;

    const stop = page.getByRole("button", { name: "Stop checkout-flow" });
    expect(head.contains(stop.element())).toBe(true);
    // After the Jump, before the close button, and the quiet one, never warm.
    const order = [...head.querySelectorAll("a, button")].map(
      (control) => control.getAttribute("data-part") ?? control.getAttribute("aria-label"),
    );
    expect(order).toEqual(["jump", "stop", "Close"]);
    expect(stop.element().getAttribute("data-variant")).toBe("quiet");
    expect(warmPaint(stop.element())).toEqual([]);
    // The title still has room, and nothing runs past the dialog.
    expect(head.scrollWidth).toBeLessThanOrEqual(head.clientWidth);

    await userEvent.click(stop);
    const confirm = root.querySelector('[data-part="stop-confirm"]') as HTMLElement;
    expect(confirm.querySelector('[data-part="question"]')?.textContent).toBe(
      "Stop checkout-flow?",
    );
    expect(confirm.querySelector('[data-part="interrupts"]')?.textContent).toBe(
      "It is waiting for you. The question is left unanswered.",
    );
    // Above the facts, and focus on Cancel.
    expect(
      confirm.compareDocumentPosition(root.querySelector('[data-slot="fact-row"]') as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(confirm.scrollWidth).toBeLessThanOrEqual(confirm.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
);

test("Stop session asks the app to stop it, by its id alone, and the page reads the sessions again", async () => {
  const asked: [string, RequestInit | undefined][] = [];
  setApiHost(
    lastMessageHost(
      undefined,
      vi.fn<ApiHost>(async (path, init) => {
        asked.push([path, init]);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    ),
  );
  const stopped = vi.fn();
  await render(
    <SessionPanel
      sessionId={CLAUDE_ID}
      onClose={vi.fn()}
      state={withClaude({ stop: { how: "signal" } })}
      now={NOW}
      onStopped={stopped}
    />,
  );
  await userEvent.click(page.getByRole("button", { name: "Stop checkout-flow" }));
  await userEvent.click(page.getByRole("button", { name: "Stop session" }));

  await expect
    .element(page.getByRole("status").filter({ hasText: "Stopped." }))
    .toHaveTextContent("Stopped. Its process has ended, and its conversation is kept.");
  expect(asked.map(([path, init]) => [path, init?.method, init?.body])).toEqual([
    ["/api/sessions/stop", "POST", JSON.stringify({ sessionId: CLAUDE_ID })],
  ]);
  expect(stopped).toHaveBeenCalledOnce();
});

test("a session in the desktop app has no Stop, and its process says where to stop it", async () => {
  await renderPanel(CLAUDE_ID, withClaude({ surface: "desktop", links: {} }));
  const panel = dialog("checkout-flow");
  await expect.element(panel).toBeVisible();

  expect(panel.element().querySelector('[data-part="stop"]')).toBeNull();
  expect(facts(panel.element()).Process).toBe(
    "4242 | Stop it in the desktop app. Agent Lookout does not stop the desktop app's sessions, because that app looks after their processes.",
  );
});

test("a session that leaves the list has no Stop, though what Stop came to is still said", async () => {
  const screen = await renderPanel(CLAUDE_ID, withClaude({ stop: { how: "signal" } }));
  await expect.element(page.getByRole("button", { name: "Stop checkout-flow" })).toBeVisible();

  const left = state({
    snapshot: {
      generatedAt: NOW + MINUTE,
      sources: SOURCES,
      sessions: sessions().filter((session) => session.id !== CLAUDE_ID),
    },
  });
  await screen.rerender(
    <SessionPanel sessionId={CLAUDE_ID} onClose={vi.fn()} state={left} now={NOW + MINUTE} />,
  );
  expect(document.querySelector('[data-part="stop"]')).toBeNull();
});

const RESUME =
  "cd '/Users/example/code/storefront' && claude --resume 00000000-0000-4000-8000-000000000001";

/** The controls in the details' head, in order, by what each is. */
function headControls(root: Element): (string | null)[] {
  const head = root.querySelector("header") as HTMLElement;
  return [...head.querySelectorAll("a, button")].map(
    (control) => control.getAttribute("data-part") ?? control.getAttribute("aria-label"),
  );
}

/** A stand-in for the clipboard, so no test writes to the real one. */
function clipboard(): string[] {
  const written: string[] = [];
  const write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
    written.push(text);
  });
  onTestFinished(() => write.mockRestore());
  return written;
}

test.each([375, 1440])(
  "at %ipx, a background job that finished has Resume in its head, and the command it copies at the top of its details",
  async (width) => {
    await page.viewport(width, 900);
    const written = clipboard();
    await renderPanel(
      CLAUDE_ID,
      withClaude({
        status: "finished",
        waitingReason: undefined,
        waitingDetail: undefined,
        surface: "unknown",
        links: {},
        pid: undefined,
        alive: undefined,
      }),
    );
    const panel = dialog("checkout-flow");
    await expect.element(panel).toBeVisible();
    const root = panel.element();

    expect(headControls(root)).toEqual(["resume", "Close"]);
    const block = root.querySelector('[data-part="resume-block"]') as HTMLElement;
    expect(block.querySelector('[data-part="resume-command"]')?.textContent).toBe(RESUME);
    // Above the facts, and nothing runs past the dialog.
    expect(
      block.compareDocumentPosition(root.querySelector('[data-slot="fact-row"]') as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(block.scrollWidth).toBeLessThanOrEqual(block.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

    await userEvent.click(
      page.getByRole("button", { name: "Copy the command that resumes checkout-flow" }),
    );
    expect(written).toEqual([RESUME]);
    expect(warmBeyondTheSignals(root)).toEqual([]);
  },
);

test("a running session has no Resume", async () => {
  await renderPanel(CLAUDE_ID, withClaude({ stop: { how: "signal" } }));
  await expect.element(dialog("checkout-flow")).toBeVisible();
  expect(document.querySelector('[data-part="resume"]')).toBeNull();
  expect(document.querySelector('[data-part="resume-block"]')).toBeNull();
});

test("a finished Codex session has no Resume", async () => {
  const value = state({
    snapshot: {
      generatedAt: NOW,
      sources: SOURCES,
      sessions: sessions().map((session) =>
        session.id === CODEX_ID ? { ...session, status: "finished" as const } : session,
      ),
    },
  });
  await renderPanel(CODEX_ID, value);
  await expect.element(dialog("api-rate-limits")).toBeVisible();
  expect(document.querySelector('[data-part="resume"]')).toBeNull();
  expect(document.querySelector('[data-part="resume-block"]')).toBeNull();
});

test("a session Stop has ended is offered Resume at once, and keeps it once it has left the list", async () => {
  const written = clipboard();
  setApiHost(
    lastMessageHost(
      undefined,
      vi.fn<ApiHost>(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    ),
  );
  const listed = withClaude({ surface: "terminal", links: {}, stop: { how: "signal" } });
  const screen = await render(
    <SessionPanel sessionId={CLAUDE_ID} onClose={vi.fn()} state={listed} now={NOW} />,
  );
  expect(document.querySelector('[data-part="resume"]')).toBeNull();
  await userEvent.click(page.getByRole("button", { name: "Stop checkout-flow" }));
  await userEvent.click(page.getByRole("button", { name: "Stop session" }));
  await expect.element(page.getByRole("status").filter({ hasText: "Stopped." })).toBeVisible();
  const root = dialog("checkout-flow").element();
  expect(headControls(root)).toEqual(["stop", "resume", "Close"]);
  // What Stop came to, then the command, then the facts.
  const outcome = root.querySelector('[data-part="stop-outcome"]') as HTMLElement;
  const block = root.querySelector('[data-part="resume-block"]') as HTMLElement;
  expect(outcome.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(block.querySelector('[data-part="resume-command"]')?.textContent).toBe(RESUME);

  const left = state({
    snapshot: {
      generatedAt: NOW + MINUTE,
      sources: SOURCES,
      sessions: sessions().filter((session) => session.id !== CLAUDE_ID),
    },
  });
  await screen.rerender(
    <SessionPanel sessionId={CLAUDE_ID} onClose={vi.fn()} state={left} now={NOW + MINUTE} />,
  );
  await expect
    .element(page.getByText("This session has left the list.", { exact: false }))
    .toBeVisible();
  expect(headControls(root)).toEqual(["resume", "Close"]);
  await userEvent.click(
    page.getByRole("button", { name: "Copy the command that resumes checkout-flow" }),
  );
  expect(written).toEqual([RESUME]);
});

test("a session Stop has ended loses Resume once a list read after the stop has it running again", async () => {
  setApiHost(
    lastMessageHost(
      undefined,
      vi.fn<ApiHost>(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    ),
  );
  const job = {
    status: "idle" as const,
    waitingReason: undefined,
    surface: "unknown" as const,
    links: {},
    stop: { how: "background" as const },
  };
  const screen = await render(
    <SessionPanel sessionId={CLAUDE_ID} onClose={vi.fn()} state={withClaude(job)} now={NOW} />,
  );
  await userEvent.click(page.getByRole("button", { name: "Stop checkout-flow" }));
  await userEvent.click(page.getByRole("button", { name: "Stop session" }));
  await expect.element(page.getByRole("status").filter({ hasText: "Stopped." })).toBeVisible();
  // The list read before the stop still says it runs, and Resume is offered all the same.
  const root = dialog("checkout-flow").element();
  expect(root.querySelector('[data-part="resume"]')).not.toBeNull();

  // Opened again with `claude attach`, it is listed working, its process alive.
  const later = Date.now() + MINUTE;
  const again = state({
    snapshot: {
      generatedAt: later,
      sources: SOURCES,
      sessions: sessions().map((session) =>
        session.id === CLAUDE_ID
          ? { ...session, ...job, status: "working" as const, alive: true, pid: 4242 }
          : session,
      ),
    },
  });
  await screen.rerender(
    <SessionPanel sessionId={CLAUDE_ID} onClose={vi.fn()} state={again} now={NOW} />,
  );
  await expect.poll(() => root.querySelector('[data-part="resume"]')).toBeNull();
  expect(root.querySelector('[data-part="resume-block"]')).toBeNull();
  expect(root.textContent).not.toContain("Resume copies this command");
});

test("a session that leaves the list on its own is not offered Resume, since its process may still run", async () => {
  const screen = await renderPanel(
    CLAUDE_ID,
    withClaude({ status: "idle", waitingReason: undefined }),
  );
  await expect.element(dialog("checkout-flow")).toBeVisible();
  const left = state({
    snapshot: {
      generatedAt: NOW + MINUTE,
      sources: SOURCES,
      sessions: sessions().filter((session) => session.id !== CLAUDE_ID),
    },
  });
  await screen.rerender(
    <SessionPanel sessionId={CLAUDE_ID} onClose={vi.fn()} state={left} now={NOW + MINUTE} />,
  );
  await expect
    .element(page.getByText("This session has left the list.", { exact: false }))
    .toBeVisible();
  expect(document.querySelector('[data-part="resume"]')).toBeNull();
  expect(document.querySelector('[data-part="resume-block"]')).toBeNull();
});

test("a waiting session with no Jump still has the quiet Stop, alone before the close button", async () => {
  await renderPanel(
    CLAUDE_ID,
    withClaude({ surface: "terminal", links: {}, stop: { how: "signal" } }),
  );
  const panel = dialog("checkout-flow");
  await expect.element(panel).toBeVisible();
  const head = panel.element().querySelector("header") as HTMLElement;

  const order = [...head.querySelectorAll("a, button")].map(
    (control) => control.getAttribute("data-part") ?? control.getAttribute("aria-label"),
  );
  expect(order).toEqual(["stop", "Close"]);
  const stop = page.getByRole("button", { name: "Stop checkout-flow" }).element();
  expect(stop.getAttribute("data-variant")).toBe("quiet");
  expect(warmPaint(stop)).toEqual([]);
});

/** The details of the Claude Code session, open or closed, as the page's address says. */
function panelOf(open: boolean, value: CollectorState, onStopped?: () => void) {
  return (
    <SessionPanel
      sessionId={open ? CLAUDE_ID : null}
      onClose={vi.fn()}
      state={value}
      now={NOW}
      onStopped={onStopped}
    />
  );
}

test("closing the details puts Stop back, so opening them again asks nothing and says nothing old", async () => {
  const value = withClaude({ stop: { how: "signal" } });
  const screen = await render(panelOf(true, value));
  await userEvent.click(page.getByRole("button", { name: "Stop checkout-flow" }));
  expect(document.querySelector('[data-part="stop-confirm"]')).not.toBeNull();

  // Left with Escape, as the address closing.
  await screen.rerender(panelOf(false, value));
  await expect.element(dialog("checkout-flow")).not.toBeInTheDocument();
  await screen.rerender(panelOf(true, value));
  await expect.element(dialog("checkout-flow")).toBeVisible();

  expect(document.querySelector('[data-part="stop-confirm"]')).toBeNull();
  expect(document.querySelector('[data-part="stop-outcome"]')).toBeNull();
  // Focus is on the title, as whenever the details open.
  await expect.poll(() => document.activeElement?.closest('[role="dialog"]') !== null).toBe(true);
  expect(document.activeElement?.textContent).toBe("checkout-flow");
});

test("what Stop came to is not said again once the details have closed and opened", async () => {
  let answer: (response: Response) => void = () => {};
  setApiHost(
    lastMessageHost(
      undefined,
      vi.fn<ApiHost>(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      ),
    ),
  );
  const value = withClaude({ stop: { how: "signal" } });
  const stopped = vi.fn();
  const screen = await render(panelOf(true, value, stopped));
  await userEvent.click(page.getByRole("button", { name: "Stop checkout-flow" }));
  await userEvent.click(page.getByRole("button", { name: "Stop session" }));

  // Closed while the request is under way: it is left to finish.
  await screen.rerender(panelOf(false, value, stopped));
  await expect.element(dialog("checkout-flow")).not.toBeInTheDocument();
  answer(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  await expect.poll(() => stopped.mock.calls.length).toBe(1);

  await screen.rerender(panelOf(true, value, stopped));
  await expect.element(dialog("checkout-flow")).toBeVisible();
  expect(document.querySelector('[data-part="stop-outcome"]')).toBeNull();
  expect(document.querySelector('[data-part="stop-confirm"]')).toBeNull();
});

test("a session on another machine names the machine, says why it has no Jump, no Stop and no Allow or Deny, and has none", async () => {
  const id = "remote:devbox:claude-code:00000000-0000-4000-8000-0000000000aa";
  const there = makeSession({
    id,
    source: "remote:devbox",
    agent: "Claude Code",
    machine: "devbox",
    name: "demo-there",
    status: "working",
    statusSince: ago(3),
  });
  const devbox = {
    id: "remote:devbox",
    label: "devbox",
    machine: "devbox",
    state: "ok",
    checkedAt: NOW,
  } as const;
  await renderPanel(
    id,
    state({
      snapshot: {
        generatedAt: NOW,
        sources: [...SOURCES, devbox],
        sessions: [...sessions(), there],
      },
    }),
  );
  const panel = dialog("demo-there");
  await expect.element(panel).toBeVisible();
  const root = panel.element();
  // The machine, with why there is no Jump, no Stop and no Allow or Deny as its note.
  expect(facts(root)).toMatchObject({
    Agent: "Claude Code",
    Machine:
      "devbox | Read over SSH. Jump, Stop, Allow and Deny work on this computer only, so use that machine to go to it, stop it or answer it.",
  });
  const head = root.querySelector("header") as HTMLElement;
  expect(
    [...head.querySelectorAll("a, button")].map((control) => control.getAttribute("aria-label")),
  ).toEqual(["Close"]);
});

test("a session on another machine waiting for permission, as the page reads it, has no Allow, no Deny and no Stop, whatever was sent", async () => {
  const id = "remote:devbox:claude-code:00000000-0000-4000-8000-0000000000aa";
  // Sent with everything that acts, as only a session here may be.
  const there = readSession({
    ...makeSession({
      id,
      source: "remote:devbox",
      agent: "Claude Code",
      machine: "devbox",
      name: "demo-there",
      status: "needs-you",
      waitingReason: "permission",
      waitingText: "Run: npm test",
      statusSince: ago(2),
    }),
    jump: { kind: "tmux", place: "work:1.0" },
    stop: { how: "signal" },
    ask: {
      requestId: "0123456789abcdef0123456789abcdef",
      tool: "Bash",
      command: "npm test",
      allow: true,
      until: NOW + 300_000,
    },
  });
  if (!there) throw new Error("expected a session");
  const devbox = {
    id: "remote:devbox",
    label: "devbox",
    machine: "devbox",
    state: "ok",
    checkedAt: NOW,
  } as const;
  await renderPanel(
    id,
    state({
      snapshot: {
        generatedAt: NOW,
        sources: [...SOURCES, devbox],
        sessions: [...sessions(), there],
      },
    }),
  );
  const panel = dialog("demo-there");
  await expect.element(panel).toBeVisible();
  const root = panel.element();
  expect(root.querySelector('[data-slot="answer"]')).toBeNull();
  const buttons = [...root.querySelectorAll("button")].map((button) => button.textContent);
  expect(buttons).not.toContain("Allow");
  expect(buttons).not.toContain("Deny");
  const head = root.querySelector("header") as HTMLElement;
  expect(
    [...head.querySelectorAll("a, button")].map((control) => control.getAttribute("aria-label")),
  ).toEqual(["Close"]);
  // What it asks is still said, as the other machine sent it.
  await expect.element(panel).toHaveTextContent("Run: npm test");
});

/** Answers each ask of a last message with what `respond` gives, and keeps what was asked. */
function saying(respond: (path: string) => Response | Promise<Response>): string[] {
  const asked: string[] = [];
  setApiHost(
    lastMessageHost((path) => {
      asked.push(path);
      return respond(path);
    }),
  );
  return asked;
}

const said = (text: string, cut = false) => json({ message: { text, cut } });
const askFor = (id: string) => `${LAST_MESSAGE_PATH}?id=${encodeURIComponent(id)}`;
const lastMessage = () => page.getByRole("region", { name: "Last message" });
const messageText = () => document.querySelector('[data-part="last-message-text"]');
const stateLine = () => document.querySelector('[data-part="last-message-state"]')?.textContent;

/** The page goes out of sight, as far as it can tell, or comes back. */
function pageHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** A Claude Code session on devbox, read over SSH, listed beside the others. */
function onDevbox(): CollectorState {
  const there = makeSession({
    id: "remote:devbox:claude-code:00000000-0000-4000-8000-0000000000aa",
    source: "remote:devbox",
    agent: "Claude Code",
    machine: "devbox",
    name: "demo-there",
    status: "working",
    statusSince: ago(3),
  });
  const devbox = {
    id: "remote:devbox",
    label: "devbox",
    machine: "devbox",
    state: "ok",
    checkedAt: NOW,
  } as const;
  return state({
    snapshot: { generatedAt: NOW, sources: [...SOURCES, devbox], sessions: [...sessions(), there] },
  });
}

test("what a Claude Code session last said is a part of its own, between the facts and the Events, shown exactly as it was written", async () => {
  const written =
    "Both fixed: <b>x</b> stays as typed, and so does **x**.\n\nNext:\n- run `npm run build`\n- open https://example.com/demo";
  const asked = saying(() => said(written));
  await renderPanel(CLAUDE_ID);
  const root = dialog("checkout-flow").element();
  await expect.element(lastMessage()).toBeVisible();
  await expect.poll(() => messageText()?.textContent).toBe(written);

  // Asked for by the session's id, once, as the details opened.
  expect(asked).toEqual([askFor(CLAUDE_ID)]);
  const part = lastMessage().element();
  expect(part.querySelector("h3")?.textContent).toBe("Last message");
  // Under the facts and above the Events.
  const facts = root.querySelector('[data-slot="fact-list"]') as Element;
  const events = root.querySelector('[data-part="events"]') as Element;
  expect(facts.compareDocumentPosition(part) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(part.compareDocumentPosition(events) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  // Markup and Markdown are characters, nothing is a link, and every line is kept.
  expect(part.querySelector("b, strong, em, a, code, li")).toBeNull();
  expect((messageText() as HTMLElement).innerText.split("\n")).toEqual([
    "Both fixed: <b>x</b> stays as typed, and so does **x**.",
    "",
    "Next:",
    "- run `npm run build`",
    "- open https://example.com/demo",
  ]);
  expect(part.querySelector('[data-part="last-message-cut"]')).toBeNull();
});

test("a message whose start was left out says so", async () => {
  saying(() => said("the end of a long reply.", true));
  await renderPanel(CLAUDE_ID);
  await expect.poll(() => messageText()?.textContent).toBe("the end of a long reply.");
  expect(document.querySelector('[data-part="last-message-cut"]')?.textContent).toBe(
    "The start of a longer message is left out.",
  );
});

test.each([
  [
    () => json({ message: null, reason: "off", setting: "AGENT_LOOKOUT_LAST_MESSAGE" }),
    "Last messages are off: AGENT_LOOKOUT_LAST_MESSAGE is off.",
  ],
  [
    () => json({ message: null, reason: "off", setting: "AGENT_LOOKOUT_WAITING_TEXT" }),
    "Last messages are off: AGENT_LOOKOUT_WAITING_TEXT is off.",
  ],
  [() => json({ message: null, reason: "not-found" }), "Its transcript was not found."],
  [() => json({ message: null, reason: "unreadable" }), "Its transcript could not be read."],
  [() => json({ message: null, reason: "nothing-yet" }), "It has not said anything yet."],
  [
    () => json({ message: null, reason: "too-far-back" }),
    "Its last message is further back than the end of its transcript that Agent Lookout reads.",
  ],
  [
    () => json({ error: "Something went wrong." }, 500),
    "Its last message could not be read. The page asks again every two seconds.",
  ],
  [
    () => new Response("<!doctype html>", { status: 200 }),
    "Its last message could not be read. The page asks again every two seconds.",
  ],
])("with no message to show, one calm line says why: %#", async (respond, words) => {
  saying(respond);
  await renderPanel(CLAUDE_ID);
  await expect.element(lastMessage()).toBeVisible();
  await expect.poll(stateLine).toBe(words);
  expect(messageText()).toBeNull();
});

test("until the first answer, the part says it is reading", async () => {
  saying(() => new Promise<Response>(() => {}));
  await renderPanel(CLAUDE_ID);
  await expect.element(lastMessage()).toBeVisible();
  await expect
    .element(lastMessage().getByRole("status"))
    .toHaveTextContent("Reading its last message");
});

test.each([
  [CODEX_ID, "api-rate-limits", "Agent Lookout does not read what Codex sessions say."],
  [FILE_ID, "billing-webhooks", "Agent Lookout does not read what night-shift sessions say."],
])(
  "a session whose agent is not read is asked about once, and the answer names its agent",
  async (id, name, words) => {
    const asked = saying(() => json({ message: null, reason: "not-read" }));
    const screen = await renderPanel(id);
    await expect.element(dialog(name)).toBeVisible();
    await expect.poll(stateLine).toBe(words);
    expect(asked).toEqual([askFor(id)]);

    // Later reads of the sessions do not ask again.
    for (const at of [NOW + 2_000, NOW + 4_000]) {
      await screen.rerender(
        <SessionPanel sessionId={id} onClose={vi.fn()} state={state({ lastOkAt: at })} now={at} />,
      );
    }
    expect(asked).toHaveLength(1);
  },
);

test("a session on another machine is never asked about, and the part says why", async () => {
  const asked = saying(() => said("Never shown."));
  await renderPanel("remote:devbox:claude-code:00000000-0000-4000-8000-0000000000aa", onDevbox());
  await expect.element(dialog("demo-there")).toBeVisible();
  await expect.element(lastMessage()).toBeVisible();
  expect(stateLine()).toBe("Last messages are not read from another machine.");
  expect(asked).toEqual([]);
});

test("while the page is hidden nothing is asked, and once it is back in sight it is", async () => {
  pageHidden(true);
  const asked = saying(() => said("Back in sight."));
  const screen = await renderPanel(CLAUDE_ID);
  await expect.element(lastMessage()).toBeVisible();
  await screen.rerender(
    <SessionPanel
      sessionId={CLAUDE_ID}
      onClose={vi.fn()}
      state={state({ lastOkAt: NOW + 2_000 })}
      now={NOW + 2_000}
    />,
  );
  expect(asked).toEqual([]);
  expect(messageText()).toBeNull();

  pageHidden(false);
  await expect.poll(() => messageText()?.textContent).toBe("Back in sight.");
  expect(asked).toEqual([askFor(CLAUDE_ID)]);
});

test("each new read of the sessions asks once more, and the part shows the newest answer", async () => {
  let reply = "First.";
  const asked = saying(() => said(reply));
  const screen = await renderPanel(CLAUDE_ID);
  await expect.poll(() => messageText()?.textContent).toBe("First.");

  reply = "Second.";
  await screen.rerender(
    <SessionPanel
      sessionId={CLAUDE_ID}
      onClose={vi.fn()}
      state={state({ lastOkAt: NOW + 2_000 })}
      now={NOW + 2_000}
    />,
  );
  await expect.poll(() => messageText()?.textContent).toBe("Second.");
  expect(asked).toHaveLength(2);
});

test("closing the details lets go of the text at once and asks nothing more", async () => {
  const asked = saying(() => said("Kept only while open."));
  const screen = await renderPanel(CLAUDE_ID);
  await expect.poll(() => messageText()?.textContent).toBe("Kept only while open.");

  await screen.rerender(
    <SessionPanel sessionId={null} onClose={vi.fn()} state={state()} now={NOW} />,
  );
  expect(document.body.textContent).not.toContain("Kept only while open.");
  for (const at of [NOW + 2_000, NOW + 4_000]) {
    await screen.rerender(
      <SessionPanel sessionId={null} onClose={vi.fn()} state={state({ lastOkAt: at })} now={at} />,
    );
  }
  await expect.element(dialog("checkout-flow")).not.toBeInTheDocument();
  expect(asked).toHaveLength(1);
});

test("once the session has left the list, the part is gone with its text, and nothing more is asked", async () => {
  const asked = saying(() => said("Gone with it."));
  const screen = await renderPanel(CLAUDE_ID);
  await expect.poll(() => messageText()?.textContent).toBe("Gone with it.");

  for (const at of [NOW + MINUTE, NOW + MINUTE + 2_000]) {
    const left = state({
      snapshot: {
        generatedAt: at,
        sources: SOURCES,
        sessions: sessions().filter((session) => session.id !== CLAUDE_ID),
      },
      lastOkAt: at,
    });
    await screen.rerender(
      <SessionPanel sessionId={CLAUDE_ID} onClose={vi.fn()} state={left} now={at} />,
    );
  }
  await expect
    .element(page.getByText("This session has left the list.", { exact: false }))
    .toBeVisible();
  expect(document.querySelector('[data-part="last-message"]')).toBeNull();
  expect(document.body.textContent).not.toContain("Gone with it.");
  expect(asked).toHaveLength(1);
});

test("a short message is no Tab stop, a long one scrolls inside its block, which is, and nothing in the part is announced", async () => {
  let reply = "One short line.";
  saying(() => said(reply));
  const screen = await renderPanel(CLAUDE_ID);
  await expect.poll(() => messageText()?.textContent).toBe("One short line.");
  const part = lastMessage().element();
  const block = part.querySelector('[data-part="last-message-scroll"]') as HTMLElement;
  expect(block.hasAttribute("tabindex")).toBe(false);
  expect(block.hasAttribute("aria-label")).toBe(false);

  reply = Array.from({ length: 40 }, (_, index) => `Line ${index + 1} of the reply.`).join("\n");
  await screen.rerender(
    <SessionPanel
      sessionId={CLAUDE_ID}
      onClose={vi.fn()}
      state={state({ lastOkAt: NOW + 2_000 })}
      now={NOW + 2_000}
    />,
  );
  await expect.poll(() => block.getAttribute("tabindex")).toBe("0");
  expect(block.getAttribute("aria-label")).toBe("Its last message");
  expect(block.getBoundingClientRect().height).toBeLessThanOrEqual(240);
  expect(block.scrollHeight).toBeGreaterThan(block.clientHeight);
  // It never speaks up: the text is there to be read when the person looks.
  expect(part.hasAttribute("aria-live")).toBe(false);
  expect(
    part.querySelector('[aria-live], [role="status"], [role="alert"], [role="log"]'),
  ).toBeNull();
});

test.each([
  ["dark", 375],
  ["light", 375],
  ["dark", 1440],
] as const)(
  "in the %s theme at %i pixels a long message stays inside the dialog, and nothing of it is warm",
  async (theme, width) => {
    document.documentElement.setAttribute("data-theme", theme);
    await page.viewport(width, 900);
    const word = `${"a".repeat(40)}/${"b".repeat(80)}`;
    saying(() => said(`Read ${word} first.\n\n${"A long line of the reply, ".repeat(20)}`, true));
    await renderPanel(CLAUDE_ID);
    const root = dialog("checkout-flow").element();
    await expect.poll(() => messageText()?.textContent).toContain(word);
    await pointAway();

    const part = lastMessage().element();
    const block = part.querySelector('[data-part="last-message-scroll"]') as HTMLElement;
    expect(block.scrollWidth).toBeLessThanOrEqual(block.clientWidth);
    expect(part.getBoundingClientRect().right).toBeLessThanOrEqual(
      root.getBoundingClientRect().right,
    );
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    expect(warmPaint(part)).toEqual([]);
    expect(warmBeyondTheSignals(root)).toEqual([]);
  },
);
