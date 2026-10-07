import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { Session, SourceHealth } from "@core/sessions/session";
import { SessionsCard } from "@dashboard/components/sessions/SessionsCard";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import { formatSince } from "@dashboard/lib/format";
import { sessionHref } from "@dashboard/lib/shell/sessionDetails";
import { SESSIONS_LAYOUT_STORAGE_KEY } from "@dashboard/lib/shell/sessionsLayout";
import { makeSession } from "@tests/fixtures/session";
import { pointAway, startAtTop } from "@tests/support/browser/browser";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";

const NOW = 1_700_000_600_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function session(n: number, overrides: Partial<Session>): Session {
  return makeSession({ id: `claude-code:${uuid(n)}`, ...overrides });
}

const SOURCE_OK: SourceHealth = {
  id: "claude-code",
  label: "Claude Code",
  state: "ok",
  checkedAt: NOW,
};

const jumpLink = (n: number) => `vscode://anthropic.claude-code/open?session=${uuid(n)}`;

const MIXED: Session[] = [
  session(1, { name: "idle-one", status: "idle", statusSince: NOW - 26 * MINUTE }),
  session(2, {
    name: "blocked-one",
    surface: "vscode",
    status: "needs-you",
    waitingReason: "permission",
    waitingDetail: "permission prompt",
    statusSince: NOW - (4 * MINUTE + 12_000),
    links: { open: jumpLink(2) },
  }),
  session(3, {
    name: "busy-one",
    surface: "desktop",
    status: "working",
    statusSince: NOW - 52_000,
  }),
  session(4, { name: "done-one", status: "finished", statusSince: NOW - 2 * HOUR, alive: false }),
  session(5, {
    name: "asked-one",
    status: "needs-you",
    waitingReason: "question",
    waitingDetail: "input needed",
    statusSince: NOW - 38_000,
  }),
  session(6, {
    name: "stale-one",
    surface: "vscode",
    status: "idle",
    statusSince: NOW - 150 * HOUR,
    stale: true,
    links: { open: jumpLink(6) },
  }),
  session(7, { name: "failed-one", status: "failed", statusSince: NOW - 41 * MINUTE }),
];

/** Every session of MIXED except the ones that need the person. */
const CALM = MIXED.filter((s) => s.status !== "needs-you");

function rowOf(container: HTMLElement, name: string): HTMLElement {
  const rows = [...container.querySelectorAll<HTMLElement>('[data-slot="session-row"]')];
  const row = rows.find((r) => r.querySelector('[data-part="name"]')?.textContent === name);
  if (!row) throw new Error(`No row named ${name}`);
  return row;
}

/**
 * The address of every link that is not a Jump. Each should be a session's
 * details, built here, so a link taken from a session's data cannot hide among them.
 */
function otherLinks(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('a:not([data-part="jump"])')].map((a) =>
    a.getAttribute("href"),
  );
}

function groupRows(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('[data-slot="group-row"]')].map((row) => row.textContent);
}

/** Buttons drawn solid: in the lamp's fill, as only the hero's Jump is. */
function solidButtons(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-slot="button"]')].filter(
    (button) => getComputedStyle(button).backgroundColor === rgbOf("var(--status-needs-you)"),
  );
}

beforeEach(async () => {
  // A desktop window, where every column is shown.
  await page.viewport(1280, 900);
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  setApiHost();
  localStorage.removeItem(SESSIONS_LAYOUT_STORAGE_KEY);
});

test("the sessions are a table with a head for each column, kept for assistive technology only", async () => {
  const screen = await render(<SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />);
  const table = screen.container.querySelector('table[data-slot="session-list"]') as HTMLElement;

  expect(table).not.toBeNull();
  const heads = [...table.querySelectorAll("thead th")];
  expect(heads.map((head) => head.textContent)).toEqual([
    "Session",
    "Folder",
    "App",
    "Status and time",
    "Jump or resume",
  ]);
  for (const head of heads) expect(head.getAttribute("scope")).toBe("col");
  // The heads are in the page and out of sight: the columns speak for themselves.
  const thead = table.querySelector("thead") as HTMLElement;
  expect(thead.classList.contains("sr-only")).toBe(true);
  expect(thead.getBoundingClientRect().width).toBeLessThanOrEqual(1);
  await expect.element(screen.getByRole("region", { name: "Sessions" })).toBeVisible();
});

test("the sessions that need the person are the hero's, not the table's, and the head still counts every session", async () => {
  const screen = await render(<SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />);

  expect(screen.container.querySelector('[data-group="needs-you"]')).toBeNull();
  expect(screen.container.textContent).not.toContain("blocked-one");
  expect(screen.container.textContent).not.toContain("asked-one");
  expect(screen.container.querySelectorAll('[data-slot="session-row"]')).toHaveLength(5);
  // The count beside the title is every session, the hero's included.
  const count = screen.container.querySelector('[data-part="head"] [data-part="count"]');
  expect(count?.textContent).toBe("7");
  expect(warmPaint(screen.container)).toEqual([]);
});

test.each([
  ["still being looked for", "searching"],
  ["not found", "unavailable"],
  ["unreadable", "error"],
] as const)(
  "while the only source is %s, the head gives no count: nothing was counted, which is not zero",
  async (_, state) => {
    const screen = await render(
      <SessionsCard sessions={[]} sources={[{ ...SOURCE_OK, state }]} now={NOW} />,
    );

    await expect.element(screen.getByRole("region", { name: "Sessions" })).toBeVisible();
    expect(screen.container.querySelector('[data-part="head"] [data-part="count"]')).toBeNull();
    const head = screen.container.querySelector('[data-part="head"]') as HTMLElement;
    expect(head.textContent).not.toMatch(/\d/);
  },
);

test("once a source is read the head counts, a zero included, and a found session is counted whatever its source", async () => {
  const screen = await render(<SessionsCard sessions={[]} sources={[SOURCE_OK]} now={NOW} />);
  const count = () =>
    screen.container.querySelector('[data-part="head"] [data-part="count"]')?.textContent;
  expect(count()).toBe("0");

  // A session was found, so there is a count, even with the source still settling.
  await screen.rerender(
    <SessionsCard sessions={CALM} sources={[{ ...SOURCE_OK, state: "searching" }]} now={NOW} />,
  );
  expect(count()).toBe(String(CALM.length));
});

test("when every session needs the person, the table says they are at the top of the page", async () => {
  const waiting = MIXED.filter((s) => s.status === "needs-you");
  const screen = await render(<SessionsCard sessions={waiting} sources={[SOURCE_OK]} now={NOW} />);

  expect(screen.container.querySelector("table")).toBeNull();
  expect(screen.container.querySelector('[data-part="all-waiting"]')?.textContent).toBe(
    "Every session needs you. They are at the top of the page, longest wait first.",
  );
  // Not the empty state: sessions are running.
  expect(screen.container.textContent).not.toContain("No agents are running");
  expect(
    screen.container.querySelector('[data-part="head"] [data-part="count"]')?.textContent,
  ).toBe("2");
});

test("sessions are grouped in order under a group head of words with its count", async () => {
  const screen = await render(<SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />);

  // One body per group, each starting with its row.
  const groups = [...screen.container.querySelectorAll('tbody[data-slot="session-group"]')];
  expect(groups.map((group) => group.getAttribute("data-group"))).toEqual([
    "working",
    "idle",
    "ended",
  ]);
  for (const group of groups) {
    expect(group.firstElementChild?.getAttribute("data-slot")).toBe("group-row");
  }
  // The idle group counts its stale sessions apart, as the counts row does: one
  // idle, one stale, over two rows.
  expect(groupRows(screen.container)).toEqual(["Working1", "Idle1Stale1", "Finished or failed2"]);

  const names = [...screen.container.querySelectorAll('[data-part="name"]')].map(
    (n) => n.textContent,
  );
  expect(names).toEqual(["busy-one", "idle-one", "stale-one", "failed-one", "done-one"]);

  // A group head is words on the glass: no band behind it, and no rule.
  const head = screen.container.querySelector('[data-slot="group-row"] th') as HTMLTableCellElement;
  expect(head.getAttribute("scope")).toBe("rowgroup");
  expect(head.getBoundingClientRect().height).toBe(40);
  expect(getComputedStyle(head).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(getComputedStyle(head).borderBottomWidth).toBe("0px");
  expect(getComputedStyle(head).fontSize).toBe("12px");
  expect(getComputedStyle(head).color).toBe(rgbOf("var(--ink-secondary)"));
  const count = head.querySelector('[data-part="count"]') as HTMLElement;
  expect(count.textContent).toBe("1");
  expect(getComputedStyle(count).fontVariantNumeric).toBe("tabular-nums");
  // It spans every column there is.
  expect(head.colSpan).toBe(5);
  const stale = screen.container.querySelector('[data-part="stale"]') as HTMLElement;
  expect(stale.textContent).toBe("Stale1");
});

test("an idle group of stale sessions alone says only how many are stale", async () => {
  const sessions = [
    session(1, { name: "stale-a", status: "idle", statusSince: NOW - 150 * HOUR, stale: true }),
    session(2, { name: "stale-b", status: "idle", statusSince: NOW - 160 * HOUR, stale: true }),
  ];
  const screen = await render(<SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />);

  expect(groupRows(screen.container)).toEqual(["Stale2"]);
  const stale = screen.container.querySelector('[data-part="stale"]') as HTMLElement;
  expect(stale.querySelector('[data-part="count"]')?.textContent).toBe("2");
});

test("each row shows its folder and its app as plain words, and its status and how long as one phrase", async () => {
  const screen = await render(<SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />);

  const busy = rowOf(screen.container, "busy-one");
  const app = busy.querySelector('[data-part="app"]') as HTMLElement;
  expect(app.textContent).toBe("Desktop app");
  expect(app.querySelector('[data-slot="badge"]')).toBeNull();
  expect(rowOf(screen.container, "stale-one").querySelector('[data-part="app"]')?.textContent).toBe(
    "VS Code",
  );
  expect(rowOf(screen.container, "idle-one").querySelector('[data-part="app"]')?.textContent).toBe(
    "Terminal",
  );

  // The folder is a word, not a machine fact: the sans, at the body size.
  const project = busy.querySelector('[data-part="project"]') as HTMLElement;
  expect(project.textContent).toBe("demo");
  expect(getComputedStyle(project).fontFamily).toMatch(/^"?Atkinson Hyperlegible Next/);
  expect(getComputedStyle(project).fontSize).toBe("13px");

  // "Working 52s": the status and its time in one cell, read as one phrase, the
  // time in the sans with figures that keep their width.
  const status = busy.querySelector('[data-part="status"]') as HTMLElement;
  const duration = busy.querySelector('[data-part="duration"]') as HTMLElement;
  expect(status.textContent).toBe("Working");
  expect(status.parentElement).toBe(duration.parentElement);
  expect(duration.querySelector("[aria-hidden]")?.textContent).toBe("52s");
  expect(duration.querySelector(".sr-only")?.textContent).toBe("for 52 seconds");
  expect(getComputedStyle(duration).fontFamily).toMatch(/^"?Atkinson Hyperlegible Next/);
  expect(getComputedStyle(duration).fontVariantNumeric).toContain("tabular-nums");

  // A name is 14px at 600, in full ink.
  const name = getComputedStyle(busy.querySelector('[data-part="name"]')!);
  expect(name.fontSize).toBe("14px");
  expect(name.fontWeight).toBe("600");
  expect(name.color).toBe(rgbOf("var(--ink)"));
});

test("the whole folder path is in a tooltip that opens on hover and on keyboard focus", async () => {
  const screen = await render(<SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />);
  const project = rowOf(screen.container, "busy-one").querySelector(
    '[data-part="project"]',
  ) as HTMLElement;

  // Nothing is left to the browser's own tooltip, which only a mouse can reach.
  expect(screen.container.querySelector("[title]")).toBeNull();

  await userEvent.hover(project);
  const tooltip = page.getByRole("tooltip");
  await expect.element(tooltip).toHaveTextContent("/Users/example/code/demo");
  const box = getComputedStyle(document.querySelector('[data-slot="tooltip"]') as HTMLElement);
  expect(box.fontFamily).toMatch(/^"?Atkinson Hyperlegible Mono/);
  // The one tooltip: floating glass, with the page blurred behind it.
  expect(box.backgroundColor).toBe(rgbOf("var(--glass-float)"));
  expect(box.backdropFilter).toMatch(/^blur\(/);

  await pointAway();
  await expect.element(tooltip).not.toBeInTheDocument();

  // Tab reaches the folder, and the same tooltip opens.
  expect(project.tabIndex).toBe(0);
  startAtTop();
  for (let presses = 0; presses < 20 && document.activeElement !== project; presses += 1) {
    await userEvent.tab();
  }
  expect(document.activeElement).toBe(project);
  await expect.element(page.getByRole("tooltip")).toHaveTextContent("/Users/example/code/demo");
});

test("a session with no folder has nothing to show and no stop for Tab", async () => {
  const sessions = [session(1, { name: "adrift", status: "idle", cwd: null, project: null })];
  const screen = await render(<SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />);

  const project = screen.container.querySelector('[data-part="project"]') as HTMLElement;
  expect(project.textContent).toBe("–");
  expect(project.hasAttribute("tabindex")).toBe(false);
});

test("an app that is not known is the folder's quiet dash, read as words, and its column stays in line", async () => {
  const sessions = [
    ...CALM,
    session(11, {
      name: "adrift",
      status: "working",
      surface: "unknown",
      cwd: null,
      project: null,
      statusSince: NOW - 3 * MINUTE,
    }),
  ];
  const screen = await render(
    <div style={{ width: 900 }}>
      <SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />
    </div>,
  );
  const row = rowOf(screen.container, "adrift");
  const app = row.querySelector('[data-part="app"]') as HTMLElement;
  const folder = row.querySelector('[data-part="project"]') as HTMLElement;

  // On screen the same dash as a missing folder, in the same ink.
  expect(app.querySelector('[aria-hidden="true"]')?.textContent).toBe("–");
  expect(folder.textContent).toBe("–");
  expect(getComputedStyle(app).color).toBe(getComputedStyle(folder).color);
  expect(getComputedStyle(app).color).toBe(rgbOf("var(--ink-secondary)"));
  // A screen reader hears words, not a dash.
  expect(app.querySelector(".sr-only")?.textContent).toBe("app not known");
  await expect
    .element(page.getByRole("cell", { name: "app not known", exact: true }))
    .toBeInTheDocument();
  expect(screen.container.textContent).not.toContain("Unknown app");

  // The column is kept, so every row's app and status start where the others' do.
  const heads = [...screen.container.querySelectorAll("thead th")].map((th) => th.textContent);
  expect(heads).toContain("App");
  const rows = [...screen.container.querySelectorAll<HTMLElement>('[data-slot="session-row"]')];
  const lefts = (selector: string) =>
    new Set(rows.map((r) => Math.round(r.querySelector(selector)!.getBoundingClientRect().left)));
  expect(lefts('[data-part="app"]').size).toBe(1);
  expect(lefts('[data-part="status"]').size).toBe(1);
  expect(new Set(rows.map((r) => r.getBoundingClientRect().height))).toEqual(new Set([44]));
});

/** Sessions in a worktree on a branch, in a repository at a commit, and in no repository. */
const IN_REPOSITORIES: Session[] = [
  session(1, {
    name: "checkout-flow",
    status: "working",
    statusSince: NOW - 12 * MINUTE,
    cwd: "/Users/example/code/storefront-checkout",
    project: "storefront-checkout",
    git: { branch: "checkout-flow" },
  }),
  session(2, {
    name: "docs-site",
    status: "idle",
    statusSince: NOW - 26 * MINUTE,
    cwd: "/Users/example/code/docs",
    project: "docs",
    git: { commit: "3f9a2c1" },
  }),
  session(3, {
    name: "mobile-onboarding",
    status: "idle",
    statusSince: NOW - 41 * MINUTE,
    cwd: "/Users/example/code/mobile-app",
    project: "mobile-app",
  }),
];

test.each(["dark", "light"] as const)(
  "in the %s theme a session in a git repository has its branch under its folder, or its commit with no branch checked out, and one in no repository neither",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(
      <SessionsCard sessions={IN_REPOSITORIES} sources={[SOURCE_OK]} now={NOW} />,
    );
    const checkout = rowOf(screen.container, "checkout-flow");
    const docs = rowOf(screen.container, "docs-site");
    const mobile = rowOf(screen.container, "mobile-onboarding");

    // Read as "storefront-checkout on branch checkout-flow".
    const folder = checkout.querySelector('[data-part="project"]') as HTMLElement;
    const git = checkout.querySelector('[data-part="git"]') as HTMLElement;
    expect(git.textContent).toBe("on branch checkout-flow");
    expect(git.closest("td")).toBe(folder.closest("td"));
    // A quiet second line under the folder's name, with its left edge.
    const branch = git.querySelector('[data-part="branch"]') as HTMLElement;
    expect(branch.textContent).toBe("checkout-flow");
    expect(branch.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      folder.getBoundingClientRect().bottom - 1,
    );
    expect(branch.getBoundingClientRect().left).toBe(folder.getBoundingClientRect().left);
    // The whole branch has the column's width: it is not cut.
    await vi.waitFor(() => expect(branch.dataset.cut).toBe("false"));
    const style = getComputedStyle(branch);
    expect(style.fontFamily).toMatch(/^"?Atkinson Hyperlegible Next/);
    expect(style.fontSize).toBe("13px");
    expect(style.color).toBe(rgbOf("var(--ink-muted)"));
    expect(getComputedStyle(folder).color).toBe(rgbOf("var(--ink-secondary)"));

    // With no branch checked out, the commit, in the mono beside 13px words.
    expect(docs.querySelector('[data-part="git"]')?.textContent).toBe("at commit 3f9a2c1");
    const commit = docs.querySelector('[data-part="commit"]') as HTMLElement;
    expect(getComputedStyle(commit).fontFamily).toMatch(/^"?Atkinson Hyperlegible Mono/);
    expect(getComputedStyle(commit).fontSize).toBe("12.5px");
    expect(getComputedStyle(commit).color).toBe(rgbOf("var(--ink-muted)"));

    // In no repository, the folder alone, as always.
    expect(mobile.querySelector('[data-part="git"]')).toBeNull();
    expect(mobile.querySelector('[data-part="project"]')?.textContent).toBe("mobile-app");

    // The two lines fit the row, so every row is still 44px, and none of it is warm.
    for (const row of [checkout, docs, mobile]) {
      expect(row.getBoundingClientRect().height).toBe(44);
    }
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("a branch too long for the Folder column is cut, and stays one hover or one Tab away", async () => {
  const long = `fix/${"rate-limits-".repeat(6)}end`;
  const sessions = [{ ...IN_REPOSITORIES[0]!, git: { branch: long } }];
  const screen = await render(<SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />);
  const branch = screen.container.querySelector('[data-part="branch"]') as HTMLElement;
  const cell = branch.closest("td") as HTMLElement;

  expect(branch.textContent).toBe(long);
  expect(getComputedStyle(branch).textOverflow).toBe("ellipsis");
  expect(branch.getBoundingClientRect().right).toBeLessThanOrEqual(
    cell.getBoundingClientRect().right,
  );
  await vi.waitFor(() => expect(branch.dataset.cut).toBe("true"));

  // Tab reaches the folder and then the branch, each with its whole text.
  const folder = screen.container.querySelector('[data-part="project"]') as HTMLElement;
  startAtTop();
  for (let presses = 0; presses < 20 && document.activeElement !== folder; presses += 1) {
    await userEvent.tab();
  }
  await userEvent.tab();
  expect(document.activeElement).toBe(branch);
  await expect.element(page.getByRole("tooltip")).toHaveTextContent(long);
});

test.each([
  [584, 112],
  [680, 160],
  [1100, 192],
])(
  "in a card %i pixels wide the Folder column takes half the room left over, up to 12rem, so a folder and its branch are cut only when the card is narrow",
  async (width, folderWidth) => {
    await page.viewport(1440, 900);
    const sessions = [
      { ...IN_REPOSITORIES[0]!, git: { branch: "feature/token-bucket" } },
      ...IN_REPOSITORIES.slice(1),
    ];
    const screen = await render(
      <div style={{ width }}>
        <SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />
      </div>,
    );
    const row = rowOf(screen.container, "checkout-flow");
    const folder = () =>
      row.querySelector('[data-part="project"]')!.closest("td")!.getBoundingClientRect().width;
    await vi.waitFor(() => expect(Math.round(folder())).toBe(folderWidth));
    // App gives way at the width it always did, and is here at each of these.
    expect(row.querySelector('[data-part="app"]')).not.toBeNull();
    const branch = row.querySelector<HTMLElement>('[data-part="branch"]')!;
    expect(branch.scrollWidth > branch.clientWidth).toBe(folderWidth === 112);
    // The Session column keeps at least its 200px.
    expect(row.querySelector("td")!.getBoundingClientRect().width).toBeGreaterThanOrEqual(200);
  },
);

test("a branch leaves with its Folder column, in a narrow window and in a narrow card", async () => {
  await page.viewport(375, 900);
  const narrow = await render(
    <div style={{ width: 279 }}>
      <SessionsCard sessions={IN_REPOSITORIES} sources={[SOURCE_OK]} now={NOW} />
    </div>,
  );
  const git = narrow.container.querySelector('[data-part="git"]') as HTMLElement;
  expect(getComputedStyle(git.closest("td") as HTMLElement).display).toBe("none");
  narrow.unmount();

  await page.viewport(1280, 900);
  const card = await render(
    <div style={{ width: 440 }}>
      <SessionsCard sessions={IN_REPOSITORIES} sources={[SOURCE_OK]} now={NOW} />
    </div>,
  );
  await vi.waitFor(() => expect(card.container.querySelector('[data-part="project"]')).toBeNull());
  expect(card.container.querySelector('[data-part="git"]')).toBeNull();
});

test("time in status says when it began, with the date once that is not today", async () => {
  const startedToday = new Date(2026, 9, 3, 9, 4, 7).getTime();
  const startedDaysAgo = new Date(2026, 8, 27, 14, 12, 7).getTime();
  const now = new Date(2026, 9, 3, 18, 0, 0).getTime();
  const sessions = [
    session(1, { name: "today", status: "working", statusSince: startedToday }),
    session(2, { name: "days", status: "idle", statusSince: startedDaysAgo }),
    session(3, { name: "untimed", status: "idle", statusSince: null }),
  ];
  const screen = await render(<SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={now} />);
  const duration = (name: string) =>
    rowOf(screen.container, name).querySelector('[data-part="duration"]') as HTMLElement;
  const tooltip = page.getByRole("tooltip");

  await userEvent.hover(duration("today"));
  await expect.element(tooltip).toHaveTextContent("Since 09:04:07");
  await pointAway();
  await expect.element(tooltip).not.toBeInTheDocument();

  // Six days in its status, in the table's short form: a clock time alone
  // would say nothing.
  expect(duration("days").querySelector("[aria-hidden]")?.textContent).toBe("6d");
  expect(duration("days").querySelector(".sr-only")?.textContent).toBe("for 6 days");
  await userEvent.hover(duration("days"));
  await expect.element(tooltip).toHaveTextContent(/^Since .*27.*2026.* 14:12:07$/);
  await pointAway();
  await expect.element(tooltip).not.toBeInTheDocument();

  await userEvent.hover(duration("untimed"));
  await expect.element(tooltip).toHaveTextContent("The source did not report a time");
  await pointAway();
});

test("durations move with the clock, without new data", async () => {
  const screen = await render(<SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />);
  await screen.rerender(<SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW + 3_000} />);

  const duration = rowOf(screen.container, "busy-one").querySelector('[data-part="duration"]');
  expect(duration?.querySelector("[aria-hidden]")?.textContent).toBe("55s");
});

test("a session with no reported status time shows a dash, not a guess", async () => {
  const sessions = [session(1, { name: "untimed", status: "working", statusSince: null })];
  const screen = await render(<SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />);

  const duration = rowOf(screen.container, "untimed").querySelector('[data-part="duration"]');
  expect(duration?.querySelector("[aria-hidden]")?.textContent).toBe("–");
  expect(duration?.querySelector(".sr-only")?.textContent).toBe("time not reported");
});

test("a session that claims to be running after its process has gone is marked, in the outline badge", async () => {
  const sessions = [
    session(1, { name: "orphan", status: "idle", alive: false }),
    session(2, { name: "running", status: "idle", alive: true }),
  ];
  const screen = await render(<SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />);

  const badge = rowOf(screen.container, "orphan").querySelector(
    '[data-slot="badge"]',
  ) as HTMLElement;
  expect(badge.textContent).toBe("Process ended");
  expect(badge.dataset.tone).toBe("outline");
  expect(rowOf(screen.container, "running").textContent).not.toContain("Process ended");
  // A row whose process has gone is quiet.
  const name = getComputedStyle(
    rowOf(screen.container, "orphan").querySelector('[data-part="name"]')!,
  );
  expect(name.fontWeight).toBe("500");
  expect(name.color).toBe(rgbOf("var(--ink-secondary)"));
});

test("stale rows and endings are said in words, with their own mark, and are quiet", async () => {
  const screen = await render(<SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />);
  const statusOf = (name: string) =>
    rowOf(screen.container, name).querySelector('[data-part="status"]')?.textContent;
  const timeOf = (name: string) =>
    rowOf(screen.container, name).querySelector('[data-part="duration"] [aria-hidden]')
      ?.textContent;
  const markOf = (name: string) =>
    rowOf(screen.container, name)
      .querySelector('[data-slot="status-mark"]')
      ?.getAttribute("data-kind");

  expect(statusOf("stale-one")).toBe("Stale");
  expect(markOf("stale-one")).toBe("stale");
  expect(statusOf("idle-one")).toBe("Idle");
  expect(markOf("idle-one")).toBe("idle");
  // An ending says how long ago it was.
  expect(statusOf("done-one")).toBe("Finished");
  expect(markOf("done-one")).toBe("finished");
  expect(timeOf("done-one")).toBe("2h 00m ago");
  expect(statusOf("failed-one")).toBe("Failed");
  expect(markOf("failed-one")).toBe("failed");
  // In the table's short form: minutes alone once past the first minute, and
  // what is read out is what is shown.
  expect(timeOf("failed-one")).toBe("41m ago");
  expect(
    rowOf(screen.container, "failed-one").querySelector('[data-part="duration"] .sr-only')
      ?.textContent,
  ).toBe("41 minutes ago");
  expect(timeOf("idle-one")).toBe("26m");
  expect(timeOf("stale-one")).toBe("6d");
  // A finished session is expected to have no process, so it is not marked twice.
  expect(rowOf(screen.container, "done-one").querySelector('[data-slot="badge"]')).toBeNull();

  // Stale and ended rows step back: secondary ink at 500. Live rows are full ink at 600.
  for (const name of ["stale-one", "done-one", "failed-one"]) {
    const style = getComputedStyle(
      rowOf(screen.container, name).querySelector('[data-part="name"]')!,
    );
    expect(style.fontWeight, name).toBe("500");
    expect(style.color, name).toBe(rgbOf("var(--ink-secondary)"));
  }
  for (const name of ["busy-one", "idle-one"]) {
    const style = getComputedStyle(
      rowOf(screen.container, name).querySelector('[data-part="name"]')!,
    );
    expect(style.fontWeight, name).toBe("600");
    expect(style.color, name).toBe(rgbOf("var(--ink)"));
  }
});

test("a session whose prompt was answered is listed with the working ones, as Answered with the answered mark and no time, and nothing warm", async () => {
  // Its file still says it waits, though Allow, Deny or a rule answered it a moment ago.
  const answered = session(8, {
    name: "answered-one",
    surface: "vscode",
    status: "needs-you",
    waitingReason: "permission",
    answered: true,
    statusSince: NOW - 3 * MINUTE,
    links: { open: jumpLink(8) },
  });
  const screen = await render(
    <SessionsCard sessions={[answered, ...MIXED]} sources={[SOURCE_OK]} now={NOW} />,
  );

  const row = rowOf(screen.container, "answered-one");
  expect(row.closest('[data-slot="session-group"]')?.getAttribute("data-group")).toBe("working");
  // At the head of the working group, its change the newest, and counted there.
  const working = screen.container.querySelector('[data-group="working"]') as HTMLElement;
  expect(
    [...working.querySelectorAll('[data-slot="session-row"] [data-part="name"]')].map(
      (name) => name.textContent,
    ),
  ).toEqual(["answered-one", "busy-one"]);
  expect(working.querySelector('[data-slot="group-row"]')?.textContent).toContain("2");
  expect(row.querySelector('[data-part="status"]')?.textContent).toBe("Answered");
  expect(row.querySelector('[data-slot="status-mark"]')?.getAttribute("data-kind")).toBe(
    "answered",
  );
  // When it was answered is not known here, and its wait's start is no time for its word.
  expect(row.querySelector('[data-part="duration"]')).toBeNull();
  // Live, so full ink at 600, with the quiet Jump.
  const name = getComputedStyle(row.querySelector('[data-part="name"]')!);
  expect(name.fontWeight).toBe("600");
  expect(name.color).toBe(rgbOf("var(--ink)"));
  expect(solidButtons(screen.container)).toEqual([]);
  expect(warmPaint(screen.container)).toEqual([]);
  // Still nothing of the two that need the person.
  expect(screen.container.textContent).not.toContain("blocked-one");
  expect(screen.container.textContent).not.toContain("asked-one");

  // On the board it is a card in Working, and Needs you holds the two that wait.
  await screen.getByRole("radio", { name: "Board" }).click();
  await expect.element(screen.getByRole("list", { name: "Needs you 2" })).toBeVisible();
  const column = screen.getByRole("list", { name: "Working 2" }).element();
  const card = column.querySelector(`[data-slot="board-card"][data-session="${answered.id}"]`);
  expect(card?.querySelector('[data-part="status"]')?.textContent).toBe("Answered");
  expect(card?.querySelector('[data-slot="status-mark"]')?.getAttribute("data-kind")).toBe(
    "answered",
  );
  expect(card?.querySelector('[data-part="duration"]')).toBeNull();
  expect(warmPaint(card as HTMLElement)).toEqual([]);
});

test("every row's status is in words in its own column, and the mark beside the name is not read twice", async () => {
  const screen = await render(<SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />);

  for (const [name, words] of [
    ["busy-one", "Working"],
    ["idle-one", "Idle"],
    ["stale-one", "Stale"],
    ["done-one", "Finished"],
    ["failed-one", "Failed"],
  ]) {
    const row = rowOf(screen.container, name as string);
    expect(row.querySelector('[data-part="status"]')?.textContent, name).toBe(words);
    expect(row.querySelector('[data-slot="status-mark"]')?.getAttribute("aria-hidden"), name).toBe(
      "true",
    );
  }
});

test("rows have no rules, and under the pointer a row lights as one rounded shape 10px inside the card", async () => {
  const screen = await render(
    <div style={{ width: 900 }}>
      <SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />
    </div>,
  );
  const row = rowOf(screen.container, "stale-one");
  const card = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;
  const shape = () => getComputedStyle(row.querySelector("td") as Element, "::before");
  await pointAway();

  // No rule under any row or cell.
  for (const cell of screen.container.querySelectorAll('[data-slot="session-row"] td')) {
    expect(getComputedStyle(cell).borderBottomWidth).toBe("0px");
    expect(getComputedStyle(cell).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  }
  expect(shape().backgroundColor).toBe("rgba(0, 0, 0, 0)");

  // Pointing anywhere on the row, not at a button.
  await userEvent.hover(row.querySelector('[data-part="status"]') as HTMLElement);
  await vi.waitFor(() => expect(shape().backgroundColor).toBe(rgbOf("var(--fill-hover)")));
  // One shape for the whole row, drawn from its first cell, 10px in from each
  // side of the card, with corners concentric with the card's.
  expect(shape().position).toBe("absolute");
  expect(shape().borderRadius).toBe("14px");
  const width = parseFloat(shape().width);
  expect(width).toBeCloseTo(card.getBoundingClientRect().width - 20, 0);
  expect(parseFloat(shape().left)).toBe(10);
  // It lies behind the row's words.
  expect(shape().zIndex).toBe("-10");

  await pointAway();
  await vi.waitFor(() => expect(shape().backgroundColor).toBe("rgba(0, 0, 0, 0)"));
});

test.each(["dark", "light"] as const)(
  "in the %s theme every Jump in the table is a quiet capsule, and none is solid",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(<SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />);

    const stale = screen.getByRole("link", { name: "Jump to stale-one in VS Code" });
    await expect.element(stale).toHaveAttribute("href", jumpLink(6));
    // The waiting session's Jump is in the hero, not here.
    expect(screen.container.querySelectorAll('a[data-part="jump"]')).toHaveLength(1);
    expect(solidButtons(screen.container)).toEqual([]);

    const quiet = getComputedStyle(stale.element());
    expect(stale.element().getAttribute("data-variant")).toBe("quiet");
    expect(quiet.backgroundColor).toBe(rgbOf("var(--fill-quiet)"));
    expect(quiet.boxShadow).toContain(`${rgbOf("var(--control-rim)")} 0px 0px 0px 1px inset`);
    expect(quiet.borderRadius).toBe("999px");
    expect(quiet.color).toBe(rgbOf("var(--ink-secondary)"));
    expect(warmPaint(stale.element())).toEqual([]);
  },
);

test("a quiet Jump comes up with its row under the pointer, and on its own with focus", async () => {
  const screen = await render(
    <div style={{ width: 900 }}>
      <SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />
    </div>,
  );
  const row = rowOf(screen.container, "stale-one");
  const jump = screen.getByRole("link", { name: "Jump to stale-one in VS Code" }).element();
  const fill = () => getComputedStyle(jump).backgroundColor;
  await pointAway();
  expect(fill()).toBe(rgbOf("var(--fill-quiet)"));

  // Pointing anywhere on the row, not at the button.
  await userEvent.hover(row.querySelector('[data-part="status"]') as HTMLElement);
  await vi.waitFor(() => expect(fill()).toBe(rgbOf("var(--fill-selected)")));
  await vi.waitFor(() => expect(getComputedStyle(jump).color).toBe(rgbOf("var(--ink)")));

  await pointAway();
  await vi.waitFor(() => expect(fill()).toBe(rgbOf("var(--fill-quiet)")));

  // By keyboard, the same, with the focus ring.
  startAtTop();
  for (let presses = 0; presses < 20 && document.activeElement !== jump; presses += 1) {
    await userEvent.tab();
  }
  expect(document.activeElement).toBe(jump);
  await vi.waitFor(() => expect(fill()).toBe(rgbOf("var(--fill-selected)")));
  expect(getComputedStyle(jump).outlineColor).toBe(rgbOf("var(--focus)"));
  expect(getComputedStyle(jump).outlineStyle).toBe("solid");
});

test.each(["dark", "light"] as const)(
  "in the %s theme, with sessions but none waiting, there is no needs-you group and nothing warm",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(<SessionsCard sessions={CALM} sources={[SOURCE_OK]} now={NOW} />);

    expect(groupRows(screen.container)).toEqual(["Working1", "Idle1Stale1", "Finished or failed2"]);
    expect(screen.container.textContent).not.toContain("Nothing needs you");
    expect(screen.container.querySelector("[data-lit]")).toBeNull();
    expect(solidButtons(screen.container)).toEqual([]);
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("a link that could run script is never rendered", async () => {
  const sessions = [
    session(1, { name: "hostile", status: "idle", links: { open: "javascript:alert(1)" } }),
  ];
  const screen = await render(<SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />);

  expect(screen.container.querySelector('a[data-part="jump"]')).toBeNull();
  // The one link left is the name's, to the session's details.
  expect(otherLinks(screen.container)).toEqual([sessionHref(sessions[0]!.id)]);
});

test("only the address this source builds becomes a Jump button", async () => {
  const elsewhere = [
    "https://evil.example/collect?leak=1",
    "http://169.254.169.254/latest/meta-data/",
    "file:///etc/passwd",
    "vscode://evil.publisher.ext/run?cmd=x",
    "vscode-insiders://anthropic.claude-code/open?session=abc",
    "ssh://evil.example",
    "tel:+10000000000",
    "blob:http://127.0.0.1:4777/abc",
  ];
  const sessions = [
    ...elsewhere.map((open, index) =>
      session(index + 10, { name: `elsewhere-${index}`, surface: "vscode", links: { open } }),
    ),
    session(2, { name: "honest", surface: "vscode", links: { open: jumpLink(2) } }),
  ];
  const screen = await render(<SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />);

  const links = [...screen.container.querySelectorAll('a[data-part="jump"]')];
  expect(links.map((a) => a.getAttribute("href"))).toEqual([jumpLink(2)]);
  expect(screen.container.querySelectorAll('[data-slot="session-row"]')).toHaveLength(
    elsewhere.length + 1,
  );
  expect(otherLinks(screen.container)).toHaveLength(elsewhere.length + 1);
  for (const href of otherLinks(screen.container)) expect(href).toMatch(/^#overview\/session\//);
});

test("a hostile link beside a real one gets no link of its own", async () => {
  const sessions = [
    session(1, { name: "hostile", status: "idle", links: { open: "javascript:alert(1)" } }),
    session(2, { name: "honest", status: "idle", links: { open: jumpLink(2) } }),
  ];
  const screen = await render(<SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />);

  const links = [...screen.container.querySelectorAll('a[data-part="jump"]')];
  expect(links.map((a) => a.getAttribute("href"))).toEqual([jumpLink(2)]);
  expect(rowOf(screen.container, "hostile").querySelector('a[data-part="jump"]')).toBeNull();
  expect(otherLinks(screen.container).sort()).toEqual(
    sessions.map((s) => sessionHref(s.id)).sort(),
  );
});

test("columns line up across every group, and every row of one line is 44px", async () => {
  const screen = await render(
    <div style={{ width: 900 }}>
      <SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />
    </div>,
  );
  const rows = [...screen.container.querySelectorAll<HTMLElement>('[data-slot="session-row"]')];
  const left = (selector: string) =>
    new Set(
      rows.map((row) => Math.round(row.querySelector(selector)!.getBoundingClientRect().left)),
    );
  const right = (selector: string) =>
    new Set(
      rows.map((row) => Math.round(row.querySelector(selector)!.getBoundingClientRect().right)),
    );

  // One left edge for names, folders and statuses, one right edge for durations.
  expect(left('[data-part="name"]').size).toBe(1);
  expect(left('[data-part="project"]').size).toBe(1);
  expect(left('[data-part="status"]').size).toBe(1);
  expect(right('[data-part="duration"]').size).toBe(1);

  const card = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;
  // The first column starts 24px in from the card's edge, as the head does.
  const name = rows[2]!.querySelector('[data-part="name"]')!.getBoundingClientRect().left;
  const mark = rows[2]!.querySelector('[data-slot="status-mark"]')!.getBoundingClientRect();
  const title = card.querySelector("h2") as HTMLElement;
  expect(mark.left - card.getBoundingClientRect().left).toBe(24);
  expect(mark.left).toBe(title.getBoundingClientRect().left);
  expect(name).toBeGreaterThan(mark.right);

  expect(new Set(rows.map((row) => row.getBoundingClientRect().height))).toEqual(new Set([44]));
});

test("without any link there is no Jump column, no empty head for it and no hint about it", async () => {
  const sessions = [session(1, { name: "plain", status: "idle", statusSince: NOW - MINUTE })];
  const screen = await render(
    <div style={{ width: 900 }}>
      <SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />
    </div>,
  );
  const card = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;
  const duration = screen.container.querySelector('[data-part="duration"]') as HTMLElement;

  expect(
    [...screen.container.querySelectorAll("thead th")].map((head) => head.textContent),
  ).toEqual(["Session", "Folder", "App", "Status and time"]);
  expect(screen.container.querySelector('[data-part="hint"]')).toBeNull();
  expect(
    (screen.container.querySelector('[data-slot="group-row"] th') as HTMLTableCellElement).colSpan,
  ).toBe(4);
  // The duration ends 18px in from the card's edge.
  expect(
    Math.round(card.getBoundingClientRect().right - duration.getBoundingClientRect().right),
  ).toBe(18);
});

test("a Claude Code session that finished or failed has Resume where a Jump would be, which copies the command that resumes it", async () => {
  const written: string[] = [];
  const write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
    written.push(text);
  });
  onTestFinished(() => write.mockRestore());
  const codexDone = makeSession({
    id: `codex:${uuid(23)}`,
    source: "codex",
    name: "codex-done",
    status: "finished",
    statusSince: NOW - HOUR,
  });
  const screen = await render(
    <SessionsCard sessions={[...MIXED, codexDone]} sources={[SOURCE_OK, CODEX_OK]} now={NOW} />,
  );

  const resumes = [...screen.container.querySelectorAll('[data-part="resume"]')].map(
    (button) => button.closest<HTMLElement>('[data-slot="session-row"]')?.dataset.session,
  );
  // Only the two that are over; never a running session, nor Codex's.
  expect(resumes.sort()).toEqual([`claude-code:${uuid(4)}`, `claude-code:${uuid(7)}`]);
  const done = rowOf(screen.container, "done-one");
  const button = done.querySelector('[data-part="resume"]') as HTMLElement;
  expect(button.closest("td")).toBe(done.lastElementChild);
  expect(button.getAttribute("aria-label")).toBe("Copy the command that resumes done-one");
  expect(button.dataset.variant).toBe("quiet");
  // As wide as the Jumps above it, and its right edge where theirs is.
  const jump = rowOf(screen.container, "stale-one").querySelector('[data-part="jump"]')!;
  expect(button.getBoundingClientRect().width).toBe(jump.getBoundingClientRect().width);
  expect(button.getBoundingClientRect().right).toBe(jump.getBoundingClientRect().right);
  expect(done.getBoundingClientRect().height).toBe(44);

  const before = location.hash;
  await userEvent.click(button);
  expect(written).toEqual([`cd '/Users/example/code/demo' && claude --resume ${uuid(4)}`]);
  // A press copies, and does not open the session's details.
  expect(location.hash).toBe(before);
  expect(warmPaint(done)).toEqual([]);
});

test("with no Jump on the card, Resume alone makes the column, and its head says Resume", async () => {
  const sessions = [
    session(1, { name: "plain", status: "idle", statusSince: NOW - MINUTE }),
    session(2, { name: "nightly-report", status: "finished", statusSince: NOW - HOUR }),
  ];
  const screen = await render(
    <div style={{ width: 900 }}>
      <SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />
    </div>,
  );
  expect(
    [...screen.container.querySelectorAll("thead th")].map((head) => head.textContent),
  ).toEqual(["Session", "Folder", "App", "Status and time", "Resume"]);
  // The hint is about Jump, so with no Jump there is none.
  expect(screen.container.querySelector('[data-part="hint"]')).toBeNull();
  expect(rowOf(screen.container, "plain").querySelector("button")).toBeNull();
  const card = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;
  const button = rowOf(screen.container, "nightly-report").querySelector(
    '[data-part="resume"]',
  ) as HTMLElement;
  expect(
    Math.round(card.getBoundingClientRect().right - button.getBoundingClientRect().right),
  ).toBe(18);
});

test("at the width of a phone a refused copy puts the command under the name, and nothing is cut or runs past the card", async () => {
  await page.viewport(375, 900);
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValue(new DOMException("Write permission denied.", "NotAllowedError"));
  onTestFinished(() => write.mockRestore());
  const sessions = [
    session(2, {
      name: "nightly-report",
      status: "finished",
      statusSince: NOW - HOUR,
      cwd: "/Users/example/code/a-folder-with-a-rather-long-name/storefront",
    }),
  ];
  const screen = await render(
    <div style={{ width: 279 }}>
      <SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />
    </div>,
  );
  const row = rowOf(screen.container, "nightly-report");
  const height = row.getBoundingClientRect().height;
  await userEvent.click(row.querySelector('[data-part="resume"]') as HTMLElement);

  await expect.poll(() => row.querySelector('[data-part="resume-line"]')).not.toBeNull();
  const line = row.querySelector('[data-part="resume-line"]') as HTMLElement;
  expect(line.textContent).toBe(
    `Not copied. Select the command to copy it: cd '/Users/example/code/a-folder-with-a-rather-long-name/storefront' && claude --resume ${uuid(2)}`,
  );
  // Under the name, above the status, and the row grows to hold it.
  const name = row.querySelector('[data-part="name"]') as HTMLElement;
  const status = row.querySelector('[data-part="status-under"]') as HTMLElement;
  expect(line.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    name.getBoundingClientRect().bottom - 1,
  );
  expect(line.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    status.getBoundingClientRect().top + 1,
  );
  expect(row.getBoundingClientRect().height).toBeGreaterThan(height);
  const card = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;
  expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
  expect(line.getBoundingClientRect().right).toBeLessThanOrEqual(
    card.getBoundingClientRect().right,
  );
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

  // A click on the command selects it, and does not open the session's details.
  const before = location.hash;
  await userEvent.click(line.querySelector('[data-part="resume-command"]') as HTMLElement);
  expect(location.hash).toBe(before);
});

test("with a Jump column the head says what Jump does", async () => {
  const screen = await render(<SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />);

  const hint = screen.container.querySelector('[data-part="hint"]') as HTMLElement;
  expect(hint.textContent).toBe("Jump opens the session where it runs");
  expect(getComputedStyle(hint).display).not.toBe("none");
});

test.each([
  [760, false],
  [620, false],
  [761, true],
  [1000, true],
])("at %i pixels wide the App and Folder columns are shown: %s", async (width, shown) => {
  await page.viewport(width, 900);
  const screen = await render(<SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />);
  const card = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;
  const heads = [...screen.container.querySelectorAll<HTMLElement>("thead th")];
  const visible = (element: Element) => getComputedStyle(element).display !== "none";

  expect(heads.map((head) => head.textContent)).toEqual(
    shown
      ? ["Session", "Folder", "App", "Status and time", "Jump or resume"]
      : ["Session", "Jump or resume"],
  );
  expect(visible(rowOf(screen.container, "busy-one").querySelector('[data-part="app"]')!)).toBe(
    shown,
  );
  expect(
    visible(
      rowOf(screen.container, "busy-one").querySelector('[data-part="project"]')!.closest("td")!,
    ),
  ).toBe(shown);
  // A group row spans only the columns there are, so the name keeps its room.
  // Narrow, those are the session and Jump: the status and its time are under the name.
  const span = (
    screen.container.querySelector('[data-slot="group-row"] th') as HTMLTableCellElement
  ).colSpan;
  expect(span).toBe(shown ? 5 : 2);
  const busy = rowOf(screen.container, "busy-one");
  expect(busy.querySelectorAll("td")).toHaveLength(shown ? 5 : 4);
  expect(busy.querySelector('[data-part="status"]')?.textContent).toBe("Working");
  const under = busy.querySelector('[data-part="status-under"]');
  expect(under !== null).toBe(!shown);
  expect(visible(screen.container.querySelector('[data-part="hint"]')!)).toBe(shown);
  // The name, the status and Jump are still there, and nothing runs off the side.
  const name = rowOf(screen.container, "busy-one").querySelector('[data-part="name"]')!;
  expect(name.getBoundingClientRect().width).toBeGreaterThan(40);
  expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});

test("a long name is cut with an ellipsis and stays readable in full", async () => {
  const name = "a-very-long-session-name-that-keeps-going-".repeat(4);
  const sessions = [session(1, { name, status: "working" })];
  const screen = await render(
    <div style={{ width: 620 }}>
      <SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />
    </div>,
  );
  const label = screen.container.querySelector('[data-part="name"]') as HTMLElement;
  const card = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;

  expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
  expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
  expect(label.textContent).toBe(name);
  // Nothing spills out of the card.
  expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);

  // While it is cut, Tab stops on it and the whole name is in its tooltip.
  await vi.waitFor(() => expect(label.dataset.cut).toBe("true"));
  expect(label.tabIndex).toBe(0);
  startAtTop();
  // The switch in the head comes first.
  await userEvent.tab();
  await userEvent.tab();
  expect(document.activeElement).toBe(label);
  await expect.element(page.getByRole("tooltip")).toHaveTextContent(name);
});

test("a name that fits is plain text: no tooltip, and no stop for Tab", async () => {
  const sessions = [session(1, { name: "short", status: "working", cwd: null, project: null })];
  const screen = await render(
    <div style={{ width: 900 }}>
      <SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />
    </div>,
  );
  const label = screen.container.querySelector('[data-part="name"]') as HTMLElement;

  // Give the measurement time to run, then see that it found nothing cut.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(label.dataset.cut).toBe("false");
  expect(label.hasAttribute("tabindex")).toBe(false);
  await userEvent.hover(label);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
});

test("at the width of a phone every row has two lines, and no word is cut or runs into another", async () => {
  await page.viewport(375, 900);
  const screen = await render(
    <div style={{ width: 279 }}>
      <SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />
    </div>,
  );
  const card = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;
  expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

  for (const row of screen.container.querySelectorAll<HTMLElement>('[data-slot="session-row"]')) {
    const name = row.querySelector('[data-part="name"]') as HTMLElement;
    const what = name.textContent ?? "";
    // The name has room to be read whole, and the status and time sit under it.
    await vi.waitFor(() => expect(name.dataset.cut, what).toBe("false"));
    expect(name.getBoundingClientRect().width, what).toBeGreaterThan(50);
    const status = row.querySelector('[data-part="status"]') as HTMLElement;
    const duration = row.querySelector('[data-part="duration"]') as HTMLElement;
    expect(duration.getBoundingClientRect().top, what).toBeGreaterThanOrEqual(
      name.getBoundingClientRect().bottom - 1,
    );
    // The status in words is never cut.
    expect(status.scrollWidth, what).toBeLessThanOrEqual(status.clientWidth);
    expect(status.getBoundingClientRect().top, what).toBeGreaterThanOrEqual(
      name.getBoundingClientRect().bottom - 1,
    );
    // Nothing in the first cell runs into the Jump cell.
    const cells = row.querySelectorAll("td");
    const jumpCell = cells[cells.length - 1] as HTMLElement;
    expect(duration.getBoundingClientRect().right, what).toBeLessThanOrEqual(
      jumpCell.getBoundingClientRect().left,
    );
  }
});

test("the empty state says no agents are running and names what is being watched", async () => {
  const screen = await render(<SessionsCard sessions={[]} sources={[SOURCE_OK]} now={NOW} />);

  await expect.element(screen.getByText("No agents are running")).toBeVisible();
  await expect
    .element(screen.getByText(/Agent Lookout is watching Claude Code on this computer/))
    .toBeVisible();
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  expect(screen.container.querySelector('[role="status"]')).toBeNull();
  expect(screen.container.querySelector("table")).toBeNull();
  // Nothing turns: an empty list is not still loading.
  expect(screen.container.getAnimations({ subtree: true })).toHaveLength(0);
});

test("the first-run searching state names where it is looking, and is neither empty nor an error", async () => {
  const searching: SourceHealth = {
    ...SOURCE_OK,
    state: "searching",
    detail: "Looking for the claude command, then in ~/.claude/sessions.",
  };
  const screen = await render(<SessionsCard sessions={[]} sources={[searching]} now={NOW} />);

  await expect.element(screen.getByText("Looking for agents")).toBeVisible();
  await expect
    .element(screen.getByText("Looking for the claude command, then in ~/.claude/sessions."))
    .toBeVisible();
  await expect.element(screen.getByText(/It checks every two seconds/)).toBeVisible();
  expect(screen.container.textContent).not.toContain("No agents are running");
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  expect(warmPaint(screen.container)).toEqual([]);
});

test("searching without a detail says what it is looking for, and names no place it was not told", async () => {
  const searching: SourceHealth = { ...SOURCE_OK, state: "searching" };
  const screen = await render(<SessionsCard sessions={[]} sources={[searching]} now={NOW} />);

  await expect
    .element(screen.getByText("Looking for Claude Code sessions on this computer."))
    .toBeVisible();
  // Only the collector knows which command and folder it uses.
  expect(screen.container.textContent).not.toContain("~/.claude");
  expect(screen.container.textContent).not.toContain("--json");
});

test("commands, paths and variable names in a source's message are set in mono", async () => {
  const missing: SourceHealth = {
    ...SOURCE_OK,
    state: "unavailable",
    detail:
      "Claude Code sessions could not be read. AGENT_LOOKOUT_CLAUDE_BIN is set to /tmp/example/bin/not-claude, which is not a program this user can run, and there is no session registry at /tmp/example/sessions.",
  };
  const screen = await render(<SessionsCard sessions={[]} sources={[missing]} now={NOW} />);
  const notice = screen.getByRole("status").element();

  const facts = [...notice.querySelectorAll('[data-slot="fact"]')];
  expect(facts.map((fact) => fact.textContent)).toEqual([
    "AGENT_LOOKOUT_CLAUDE_BIN",
    "/tmp/example/bin/not-claude",
    "/tmp/example/sessions",
  ]);
  for (const fact of facts) {
    expect(getComputedStyle(fact).fontFamily).toMatch(/^"?Atkinson Hyperlegible Mono/);
  }
  // The words around them stay in the sans face, and the sentence is unchanged.
  expect(getComputedStyle(facts[0]?.parentElement as Element).fontFamily).toMatch(
    /^"?Atkinson Hyperlegible Next/,
  );
  expect(notice.textContent).toContain(missing.detail);

  // In the searching state too, a double hyphen is two hyphens, not one long dash.
  const searching: SourceHealth = {
    ...SOURCE_OK,
    state: "searching",
    detail: "Looking for sessions with claude agents --json and in ~/.claude/sessions.",
  };
  await screen.rerender(<SessionsCard sessions={[]} sources={[searching]} now={NOW} />);
  const looking = [...screen.container.querySelectorAll('[data-slot="fact"]')];
  expect(looking.map((fact) => fact.textContent)).toEqual([
    "claude agents --json",
    "~/.claude/sessions",
  ]);
});

test("a source that was not found is said calmly, with what to do", async () => {
  const missing: SourceHealth = {
    ...SOURCE_OK,
    state: "unavailable",
    detail: "Looked for the claude command and in ~/.claude/sessions. Neither was found.",
  };
  const screen = await render(<SessionsCard sessions={[]} sources={[missing]} now={NOW} />);

  const notice = screen.getByRole("status");
  await expect.element(notice).toHaveTextContent("Claude Code was not found");
  await expect.element(notice).toHaveTextContent("Neither was found.");
  await expect.element(notice).toHaveTextContent("Install Claude Code or start a session.");
  expect(screen.container.textContent).not.toContain("No agents are running");
});

test("when the collector says what to do about a missing source, that is said in place of installing it", async () => {
  const misdirected: SourceHealth = {
    ...SOURCE_OK,
    state: "unavailable",
    detail:
      "Claude Code sessions could not be read. AGENT_LOOKOUT_CLAUDE_BIN is set to /tmp/example/bin/not-claude, which is not a program this user can run, and there is no session registry at /tmp/example/sessions.",
    advice: "Correct AGENT_LOOKOUT_CLAUDE_BIN, or unset it.",
  };
  const screen = await render(<SessionsCard sessions={[]} sources={[misdirected]} now={NOW} />);

  // Still calm: a wrong setting is not a failure of the source.
  const notice = screen.getByRole("status");
  await expect.element(notice).toHaveTextContent("Claude Code was not found");
  await expect.element(notice).toHaveTextContent("which is not a program this user can run");
  const advice = notice.element().querySelector('[data-part="advice"]') as HTMLElement;
  expect(advice.textContent).toBe("Correct AGENT_LOOKOUT_CLAUDE_BIN, or unset it.");
  // The variable in it is a machine fact too.
  const variable = advice.querySelector('[data-slot="fact"]') as HTMLElement;
  expect(variable.textContent).toBe("AGENT_LOOKOUT_CLAUDE_BIN");
  expect(getComputedStyle(variable).fontFamily).toMatch(/^"?Atkinson Hyperlegible Mono/);

  // Installing Claude Code would not help someone who pointed at the wrong program.
  expect(notice.element().textContent).not.toMatch(/install/i);
  expect(screen.container.textContent).not.toContain("No agents are running");
});

test("a source that failed is an error, never looks like an empty list, and is not warm", async () => {
  const failed: SourceHealth = {
    ...SOURCE_OK,
    state: "error",
    detail: "The claude command stopped with an error.",
  };
  const screen = await render(<SessionsCard sessions={[]} sources={[failed]} now={NOW} />);

  const alert = screen.getByRole("alert");
  await expect.element(alert).toHaveTextContent("Claude Code could not be read");
  await expect.element(alert).toHaveTextContent("The claude command stopped with an error.");
  expect(screen.container.textContent).not.toContain("No agents are running");
  expect(warmPaint(screen.container)).toEqual([]);
});

test("a source problem is shown above the sessions that were still found", async () => {
  const failed: SourceHealth = { ...SOURCE_OK, state: "error", detail: "Fell back to the folder." };
  const sessions = [session(1, { name: "still-here", status: "idle" })];
  const screen = await render(<SessionsCard sessions={sessions} sources={[failed]} now={NOW} />);

  await expect.element(screen.getByRole("alert")).toHaveTextContent("Fell back to the folder.");
  await expect.element(screen.getByText("still-here")).toBeVisible();
  const alert = screen.getByRole("alert").element().getBoundingClientRect();
  expect(alert.bottom).toBeLessThanOrEqual(
    screen.container.querySelector("table")!.getBoundingClientRect().top,
  );
});

const CODEX_MISSING: SourceHealth = {
  id: "codex",
  label: "Codex",
  state: "unavailable",
  detail:
    "Codex was not found: there is no ~/.codex folder. Agent Lookout looks again every minute.",
  checkedAt: NOW,
};
const CODEX_OK: SourceHealth = { ...CODEX_MISSING, state: "ok", detail: "Codex is read." };

/** Codex sessions beside MIXED: Codex has no Jump and never needs the person. */
const CODEX: Session[] = [
  makeSession({
    id: `codex:${uuid(21)}`,
    source: "codex",
    name: "codex-busy",
    status: "working",
    statusSince: NOW - 3 * MINUTE,
  }),
  makeSession({
    id: `codex:${uuid(22)}`,
    source: "codex",
    name: "codex-idle",
    surface: "vscode",
    status: "idle",
    statusSince: NOW - 9 * MINUTE,
  }),
];
const BOTH = [...MIXED, ...CODEX];

/** The card's markup once it has settled, with React's generated ids set aside. */
async function settledMarkup(container: HTMLElement): Promise<string> {
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  return container.innerHTML.replace(/_r_[a-z0-9]+_/g, "_r_");
}

test.each([
  [1280, MIXED],
  [1280, []],
  [375, MIXED],
])(
  "at %i pixels wide, a Codex that is not on this computer changes nothing on the card",
  async (width, sessions) => {
    await page.viewport(width, 900);
    const alone = await render(
      <SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />,
    );
    const before = await settledMarkup(alone.container);
    await alone.unmount();
    const both = await render(
      <SessionsCard sessions={sessions} sources={[SOURCE_OK, CODEX_MISSING]} now={NOW} />,
    );

    expect(await settledMarkup(both.container)).toBe(before);
    expect(both.container.textContent).not.toContain("Codex");
    expect(both.container.querySelector('[data-part="agent"]')).toBeNull();
  },
);

const STATUS_FILES_OK: SourceHealth = {
  id: "status-files",
  label: "Status files",
  state: "ok",
  checkedAt: NOW,
};

/** A session one agent says it has in a status file. Its link is one a Claude Code session could have. */
const custom = (n: number, overrides: Partial<Session> = {}) =>
  makeSession({
    id: `status-files:session-${n}.json`,
    source: "status-files",
    agent: "Night Shift",
    surface: "unknown",
    status: "working",
    statusSince: NOW - 2 * MINUTE,
    links: { open: jumpLink(n) },
    ...overrides,
  });

test("a session from a status file names its own agent in the Agent column, and has no Jump", async () => {
  const sessions = [
    ...MIXED,
    custom(31, { name: "billing-webhooks" }),
    custom(32, { name: "search-indexing", agent: "my-agent", status: "idle" }),
  ];
  const screen = await render(
    <SessionsCard sessions={sessions} sources={[SOURCE_OK, STATUS_FILES_OK]} now={NOW} />,
  );

  const heads = [...screen.container.querySelectorAll("thead th")].map((th) => th.textContent);
  expect(heads).toEqual(["Session", "Agent", "Folder", "App", "Status and time", "Jump or resume"]);
  const billing = rowOf(screen.container, "billing-webhooks");
  expect(billing.querySelector('[data-part="agent"]')?.textContent).toBe("Night Shift");
  expect(billing.querySelector('[data-part="status"]')?.textContent).toBe("Working");
  expect(
    rowOf(screen.container, "search-indexing").querySelector('[data-part="agent"]')?.textContent,
  ).toBe("my-agent");
  // The Claude Code rows say whose they are too.
  expect(
    rowOf(screen.container, "busy-one").querySelector('[data-part="agent"]')?.textContent,
  ).toBe("Claude Code");
  // No Jump, and nothing to follow, whatever link the session carries.
  for (const name of ["billing-webhooks", "search-indexing"]) {
    const row = rowOf(screen.container, name);
    expect(row.querySelector('[data-part="jump"]'), name).toBeNull();
  }
  expect(rowOf(screen.container, "stale-one").querySelector('a[data-part="jump"]')).not.toBeNull();
});

test("an agent's name too long for the Agent column is cut, and stays readable in full", async () => {
  const agent = "Night Shift Overnight Refactoring Helper";
  expect(agent).toHaveLength(40);
  const sessions = [...MIXED, custom(34, { name: "api-rate-limits", agent })];
  const screen = await render(
    <SessionsCard sessions={sessions} sources={[SOURCE_OK, STATUS_FILES_OK]} now={NOW} />,
  );
  const cell = rowOf(screen.container, "api-rate-limits").querySelector(
    '[data-part="agent"]',
  ) as HTMLElement;
  const label = cell.firstElementChild as HTMLElement;

  expect(cell.textContent).toBe(agent);
  expect(cell.scrollWidth).toBeLessThanOrEqual(cell.clientWidth);
  // While it is cut, Tab stops on it and the whole name is in its tooltip.
  await vi.waitFor(() => expect(label.dataset.cut).toBe("true"));
  expect(label.tabIndex).toBe(0);
  await userEvent.hover(label);
  await expect.element(page.getByRole("tooltip")).toHaveTextContent(agent);
  // One that fits is plain text, as before.
  const fits = rowOf(screen.container, "busy-one").querySelector('[data-part="agent"]')!;
  expect((fits.firstElementChild as HTMLElement).dataset.cut).toBe("false");
});

test("a name or an agent that holds markup is shown as the text it is", async () => {
  const sessions = [
    custom(33, { name: "<img src=x onerror=alert(1)>", agent: "<b>Night Shift</b>" }),
  ];
  const screen = await render(
    <SessionsCard sessions={sessions} sources={[SOURCE_OK, STATUS_FILES_OK]} now={NOW} />,
  );
  const row = rowOf(screen.container, "<img src=x onerror=alert(1)>");
  expect(row.querySelector("img, b")).toBeNull();
  expect(row.querySelector('[data-part="agent"]')?.textContent).toBe("<b>Night Shift</b>");
});

test.each([
  [1280, MIXED],
  [1280, []],
  [375, MIXED],
])(
  "at %i pixels wide, a folder of status files that is not set up changes nothing on the card",
  async (width, sessions) => {
    await page.viewport(width, 900);
    const alone = await render(
      <SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />,
    );
    const before = await settledMarkup(alone.container);
    await alone.unmount();
    const notSetUp: SourceHealth = {
      ...STATUS_FILES_OK,
      state: "not-set-up",
      detail: "To show any other agent here, make the folder ~/.agent-lookout/sessions.",
    };
    const both = await render(
      <SessionsCard sessions={sessions} sources={[SOURCE_OK, notSetUp]} now={NOW} />,
    );

    expect(await settledMarkup(both.container)).toBe(before);
    expect(both.container.textContent).not.toContain("Status files");
  },
);

test("with both tools found, each row names its tool in plain words in an Agent column", async () => {
  const screen = await render(
    <SessionsCard sessions={BOTH} sources={[SOURCE_OK, CODEX_OK]} now={NOW} />,
  );
  const heads = [...screen.container.querySelectorAll("thead th")].map((th) => th.textContent);
  expect(heads).toEqual(["Session", "Agent", "Folder", "App", "Status and time", "Jump or resume"]);
  // The group row spans every column there is.
  for (const th of screen.container.querySelectorAll<HTMLTableCellElement>(
    '[data-slot="group-row"] th',
  )) {
    expect(th.colSpan).toBe(6);
  }

  for (const row of screen.container.querySelectorAll<HTMLElement>('[data-slot="session-row"]')) {
    const agent = row.querySelector('[data-part="agent"]') as HTMLElement;
    const expected = row.dataset.session?.startsWith("codex:") ? "Codex" : "Claude Code";
    expect(agent.tagName).toBe("TD");
    expect(agent.textContent).toBe(expected);
    // Words only: no logo, no icon, no badge.
    expect(agent.querySelector("svg, img, [data-slot]")).toBeNull();
    // Styled as the Folder and App cells beside it: the same words, the same ink.
    const app = row.querySelector('[data-part="app"]') as HTMLElement;
    const folder = row.querySelector('[data-part="project"]') as HTMLElement;
    for (const neighbour of [app, folder]) {
      expect(getComputedStyle(agent).fontSize).toBe(getComputedStyle(neighbour).fontSize);
      expect(getComputedStyle(agent).fontFamily).toBe(getComputedStyle(neighbour).fontFamily);
      expect(getComputedStyle(agent).color).toBe(getComputedStyle(neighbour).color);
    }
    // Right after the name.
    expect(row.children[1]).toBe(agent);
    expect(row.querySelector('[data-part="agent-under"], [data-part="agent-lead"]')).toBeNull();
  }
  expect(
    getComputedStyle(rowOf(screen.container, "codex-busy").querySelector('[data-part="agent"]')!)
      .color,
  ).toBe(rgbOf("var(--ink-secondary)"));
  // Codex sessions get no Jump, and no tool's name adds a warm colour, not even on the waiting row.
  expect(rowOf(screen.container, "codex-busy").querySelector('a[data-part="jump"]')).toBeNull();
  for (const agent of screen.container.querySelectorAll('[data-part="agent"]')) {
    expect(warmPaint(agent)).toEqual([]);
  }
});

const EVERY_COLUMN = ["Session", "Agent", "Folder", "App", "Status and time", "Jump or resume"];
const WITHOUT_APP = ["Session", "Agent", "Folder", "Status and time", "Jump or resume"];
const WITHOUT_APP_OR_FOLDER = ["Session", "Agent", "Status and time", "Jump or resume"];

// The card's widths on the Overview: beside the Events card in a window 1440
// pixels wide, alone at 1000, beside it at 1280 and 1181, and alone at 761, the
// widest window that is not narrow.
test.each([
  [835, EVERY_COLUMN],
  [888, EVERY_COLUMN],
  [733, WITHOUT_APP],
  [670, WITHOUT_APP],
  [649, WITHOUT_APP_OR_FOLDER],
])(
  "in a card %i pixels wide, every row names its tool in an Agent column, and the names keep their room",
  async (width, expected) => {
    // The heads are out of sight, so the column is measured from its first cell.
    const sessionColumn = (container: HTMLElement) =>
      container.querySelector('[data-slot="session-row"] td')!.getBoundingClientRect().width;
    const alone = await render(
      <div style={{ width }}>
        <SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />
      </div>,
    );
    const withOneTool = sessionColumn(alone.container);
    await alone.unmount();

    const screen = await render(
      <div style={{ width }}>
        <SessionsCard sessions={BOTH} sources={[SOURCE_OK, CODEX_OK]} now={NOW} />
      </div>,
    );
    const heads = [...screen.container.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(heads).toEqual(expected);
    for (const th of screen.container.querySelectorAll<HTMLTableCellElement>(
      '[data-slot="group-row"] th',
    )) {
      expect(th.colSpan).toBe(expected.length);
    }

    const hasApp = expected.includes("App");
    const hasFolder = expected.includes("Folder");
    for (const row of screen.container.querySelectorAll<HTMLElement>('[data-slot="session-row"]')) {
      const agent = row.querySelector('[data-part="agent"]') as HTMLElement;
      expect(agent.tagName).toBe("TD");
      expect(agent.textContent).toBe(
        row.dataset.session?.startsWith("codex:") ? "Codex" : "Claude Code",
      );
      // The whole word is shown, not cut: the cell does not cut it, and nor does its text.
      expect(agent.scrollWidth).toBeLessThanOrEqual(agent.clientWidth);
      const label = agent.firstElementChild as HTMLElement;
      expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
      expect(row.querySelector('[data-part="app"]') !== null).toBe(hasApp);
      expect(row.querySelector('[data-part="project"]') !== null).toBe(hasFolder);
      expect(row.querySelector('[data-part="status-under"]')).toBeNull();
      // The status and its time are never cut.
      const status = row.querySelector('[data-part="status"]')!.parentElement as HTMLElement;
      expect(status.scrollWidth).toBeLessThanOrEqual(status.clientWidth);
    }

    // The table stays inside the card, so no column is clipped at its edge.
    const card = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;
    const table = screen.container.querySelector("table") as HTMLElement;
    expect(table.getBoundingClientRect().width).toBeLessThanOrEqual(card.clientWidth + 0.5);

    // The name comes first: the columns beside it give way before the Session
    // column falls under 200px, a name of about 18 letters. With one tool there
    // is one column fewer, so the names have at least as much room.
    const session = sessionColumn(screen.container);
    expect(session).toBeGreaterThanOrEqual(200);
    expect(withOneTool).toBeGreaterThanOrEqual(200);
  },
);

// Ordinary names of 15 to 18 letters, in the cards a window 761 and 1181 pixels
// wide gives the Sessions card, beside the Events card at 1181 and alone at 761.
test.each([
  [649, [SOURCE_OK, CODEX_OK]],
  [670, [SOURCE_OK, CODEX_OK]],
  [649, [SOURCE_OK]],
  [670, [SOURCE_OK]],
] as const)(
  "in a card %i pixels wide, common names of 15 to 18 letters are not cut",
  async (width, sources) => {
    const names = [
      "billing-webhooks",
      "mobile-onboarding",
      "search-indexing",
      "email-templates",
      "release-checklist",
      "payments-refactor1",
    ];
    const sessions = names.map((name, index) =>
      makeSession({
        id: `${index % 2 && sources.length > 1 ? "codex" : "claude-code"}:${uuid(40 + index)}`,
        source: index % 2 && sources.length > 1 ? "codex" : "claude-code",
        name,
        project: "platform-api",
        surface: index === 0 ? "vscode" : "desktop",
        // The last has the longest phrase a row can show: "Finished 23h 59m ago".
        status: index === 5 ? "finished" : "working",
        statusSince: index === 5 ? NOW - (24 * HOUR - MINUTE) : NOW - (index + 1) * 23 * HOUR,
        alive: index !== 5,
        links: index === 0 ? { open: jumpLink(40 + index) } : {},
      }),
    );
    const screen = await render(
      <div style={{ width }}>
        <SessionsCard sessions={sessions} sources={[...sources]} now={NOW} />
      </div>,
    );

    for (const name of names) {
      const label = rowOf(screen.container, name).querySelector(
        '[data-part="name"]',
      ) as HTMLElement;
      await vi.waitFor(() => expect(label.dataset.cut, name).toBe("false"));
      expect(label.scrollWidth, name).toBeLessThanOrEqual(label.clientWidth);
    }
    // The longest status phrase a row can have fits its column.
    for (const row of screen.container.querySelectorAll<HTMLElement>('[data-slot="session-row"]')) {
      const status = row.querySelector('[data-part="status"]')!.parentElement as HTMLElement;
      expect(status.scrollWidth).toBeLessThanOrEqual(status.clientWidth);
    }
    const card = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
  },
);

test("at the width of a phone the tool leads the line under the name, and neither it nor the status is cut", async () => {
  await page.viewport(375, 900);
  const screen = await render(
    <div style={{ width: 279 }}>
      <SessionsCard sessions={BOTH} sources={[SOURCE_OK, CODEX_OK]} now={NOW} />
    </div>,
  );
  expect([...screen.container.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual([
    "Session",
    "Jump or resume",
  ]);
  for (const row of screen.container.querySelectorAll<HTMLElement>('[data-slot="session-row"]')) {
    const what = row.querySelector('[data-part="name"]')?.textContent ?? "";
    const line = row.querySelector('[data-part="status-under"]') as HTMLElement;
    const agent = line.querySelector('[data-part="agent"]') as HTMLElement;
    expect(agent.textContent, what).toBe(
      row.dataset.session?.startsWith("codex:") ? "Codex" : "Claude Code",
    );
    // The tool comes first on the line under the name, and a two-word name is
    // never cut while a line can hold it: the status goes on to the next line.
    expect(agent.getBoundingClientRect().left, what).toBeLessThanOrEqual(
      line.getBoundingClientRect().left + 1,
    );
    await vi.waitFor(() => expect(agent.dataset.cut, what).toBe("false"));
    expect(agent.scrollWidth, what).toBeLessThanOrEqual(agent.clientWidth);
    const status = line.querySelector('[data-part="status"]') as HTMLElement;
    expect(status.scrollWidth, what).toBeLessThanOrEqual(status.clientWidth);
    // The dot between them shows only when they share a line.
    const dot = line.querySelector('[data-part="dot"]') as HTMLElement;
    const shared =
      Math.abs(status.getBoundingClientRect().top - agent.getBoundingClientRect().top) < 2;
    const dotShown = dot.getBoundingClientRect().left >= line.getBoundingClientRect().left;
    expect(dotShown, what).toBe(shared);
  }
  const busy = rowOf(screen.container, "codex-busy");
  // Read as "Codex, Working for 3 minutes"; the dot and the short time are for the eye.
  expect(busy.querySelector('[data-part="status-under"]')?.textContent).toBe(
    "Codex, ·Workingfor 3 minutes3m",
  );
  const card = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;
  expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
});

test("with Codex not found and no session running, the empty state names only what is watched", async () => {
  const screen = await render(
    <SessionsCard sessions={[]} sources={[SOURCE_OK, CODEX_MISSING]} now={NOW} />,
  );
  await expect
    .element(screen.getByText(/Agent Lookout is watching Claude Code on this computer/))
    .toBeVisible();
  expect(screen.container.querySelector('[role="status"]')).toBeNull();
  expect(screen.container.textContent).not.toContain("Codex");
});

test("a tool that cannot be read is said above the empty state, not hidden by it", async () => {
  const failed: SourceHealth = {
    ...CODEX_OK,
    state: "error",
    detail: "The folder could not be listed.",
  };
  const screen = await render(
    <SessionsCard sessions={[]} sources={[SOURCE_OK, failed]} now={NOW} />,
  );

  await expect.element(screen.getByRole("alert")).toHaveTextContent("Codex could not be read");
  await expect
    .element(screen.getByText(/Agent Lookout is watching Claude Code on this computer/))
    .toBeVisible();
  expect(screen.container.textContent).not.toMatch(/watching Claude Code and Codex/);
});

test("with no tool found, each is said", async () => {
  const missing: SourceHealth = {
    ...SOURCE_OK,
    state: "unavailable",
    detail: "Neither was found.",
  };
  const screen = await render(
    <SessionsCard sessions={[]} sources={[missing, CODEX_MISSING]} now={NOW} />,
  );
  const notices = [...screen.container.querySelectorAll('[role="status"]')];
  expect(notices).toHaveLength(2);
  expect(notices[0]?.textContent).toContain("Claude Code was not found");
  expect(notices[1]?.textContent).toContain("Codex was not found");
});

/** Sessions in a terminal: one found in a tmux pane, one in VS Code with its link, one in neither. */
const IN_TMUX = session(21, {
  name: "billing-webhooks",
  status: "working",
  statusSince: NOW - 3 * MINUTE,
  pid: 4321,
  alive: true,
  jump: { kind: "tmux", place: "work:2.1" },
});
const IN_VSCODE = session(22, {
  name: "docs-site",
  surface: "vscode",
  status: "idle",
  statusSince: NOW - 9 * MINUTE,
  links: { open: jumpLink(22) },
});
const IN_NEITHER = session(23, {
  name: "search-indexing",
  status: "idle",
  statusSince: NOW - MINUTE,
});

test("a session in a tmux pane has its Jump in the Jump column, a button where a VS Code session has a link", async () => {
  const screen = await render(
    <div style={{ width: 900 }}>
      <SessionsCard sessions={[IN_TMUX, IN_VSCODE, IN_NEITHER]} sources={[SOURCE_OK]} now={NOW} />
    </div>,
  );

  const heads = [...screen.container.querySelectorAll("thead th")].map((head) => head.textContent);
  expect(heads).toEqual(["Session", "Folder", "App", "Status and time", "Jump"]);

  const button = screen
    .getByRole("button", { name: "Jump to billing-webhooks in tmux, work:2.1" })
    .element();
  const link = screen.getByRole("link", { name: "Jump to docs-site in VS Code" }).element();
  expect(button.tagName).toBe("BUTTON");
  expect(rowOf(screen.container, "billing-webhooks").lastElementChild?.contains(button)).toBe(true);
  // The two line up, and are drawn alike: the quiet capsule, never the solid one.
  expect(button.getBoundingClientRect().left).toBe(link.getBoundingClientRect().left);
  expect(button.getBoundingClientRect().width).toBe(link.getBoundingClientRect().width);
  expect(button.getAttribute("data-variant")).toBe("quiet");
  expect(solidButtons(screen.container)).toEqual([]);

  // A session in neither has an empty cell, as before.
  expect(rowOf(screen.container, "search-indexing").querySelector('[data-part="jump"]')).toBeNull();
  expect(warmPaint(screen.container)).toEqual([]);
});

test.each([
  ["only sessions in tmux", [IN_TMUX, IN_NEITHER], "Jump selects the session's pane in tmux"],
  [
    "sessions in tmux and in VS Code",
    [IN_TMUX, IN_VSCODE],
    "Jump opens the session, or selects its pane in tmux",
  ],
  ["only sessions with a link", [IN_VSCODE, IN_NEITHER], "Jump opens the session where it runs"],
])("with %s, the head says what the Jumps in the table do", async (_what, sessions, words) => {
  const screen = await render(<SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />);

  expect(screen.container.querySelector('[data-part="hint"]')?.textContent).toBe(words);
});

test("a session whose pane is of no kind this page knows gets no Jump, and alone it makes no Jump column", async () => {
  const odd = { ...IN_NEITHER, jump: { kind: "screen", place: "work:2.1" } } as unknown as Session;
  const screen = await render(<SessionsCard sessions={[odd]} sources={[SOURCE_OK]} now={NOW} />);

  expect(
    [...screen.container.querySelectorAll("thead th")].map((head) => head.textContent),
  ).toEqual(["Session", "Folder", "App", "Status and time"]);
  expect(screen.container.querySelector('[data-part="jump"]')).toBeNull();
});

test.each([
  ["the pane is selected", 200, { ok: true, kind: "tmux", place: "work:2.1" }, "Selected in tmux"],
  ["the pane has gone", 409, { error: "x", reason: "pane-gone" }, "That pane has closed"],
])(
  "pressing a tmux Jump asks for that session, and when %s the row says so beside the name without growing",
  async (_what, status, body, words) => {
    const sent: { path: string; body: unknown }[] = [];
    setApiHost(async (path, init) => {
      sent.push({ path, body: init?.body });
      return new Response(JSON.stringify(body), { status });
    });
    const screen = await render(
      <div style={{ width: 900 }}>
        <SessionsCard sessions={[IN_TMUX, IN_VSCODE, IN_NEITHER]} sources={[SOURCE_OK]} now={NOW} />
      </div>,
    );
    const row = rowOf(screen.container, "billing-webhooks");

    await screen.getByRole("button", { name: /^Jump to billing-webhooks/ }).click();
    await expect.element(screen.getByRole("status")).toHaveTextContent(words);

    expect(sent).toEqual([{ path: "/api/jump", body: JSON.stringify({ sessionId: IN_TMUX.id }) }]);
    const note = row.querySelector('[data-part="jump-note"]') as HTMLElement;
    expect(note.textContent).toBe(words);
    // Beside the name, on its line, in the row it belongs to and no other.
    expect(note.parentElement?.contains(row.querySelector('[data-part="name"]'))).toBe(true);
    expect(screen.container.querySelectorAll('[data-part="jump-note"]')).toHaveLength(1);
    expect(row.getBoundingClientRect().height).toBe(44);
    expect(row.querySelector('[data-part="name"]')?.textContent).toBe("billing-webhooks");
    expect(warmPaint(screen.container)).toEqual([]);
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
  },
);

// The card a window 1,181 to 1,440 pixels wide gives the Sessions list, beside
// the Events card: the name's line is too short for the name and the badge.
test.each([
  ["the pane is selected", 200, { ok: true, kind: "tmux", place: "work:2.1" }, "Selected in tmux"],
  [
    "another jump was made a moment before",
    429,
    { error: "x", reason: "too-soon" },
    "Try again in a moment",
  ],
])(
  "in a card too narrow to hold both on a line, when %s the row says so under the name, which is not cut for it, without growing",
  async (_what, status, body, words) => {
    setApiHost(async () => new Response(JSON.stringify(body), { status }));
    const screen = await render(
      <div style={{ width: 670 }}>
        <SessionsCard
          sessions={[IN_TMUX, IN_VSCODE, IN_NEITHER]}
          sources={[SOURCE_OK, CODEX_OK]}
          now={NOW}
        />
      </div>,
    );
    const row = rowOf(screen.container, "billing-webhooks");
    const cell = row.firstElementChild as HTMLElement;
    const name = row.querySelector('[data-part="name"]') as HTMLElement;
    const nameWidth = name.getBoundingClientRect().width;
    expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);

    await screen.getByRole("button", { name: /^Jump to billing-webhooks/ }).click();
    await expect.element(screen.getByRole("status")).toHaveTextContent(words);

    const note = row.querySelector('[data-part="jump-note"]') as HTMLElement;
    expect(note.textContent).toBe(words);
    // Under the name, at its left edge, and whole inside the name's cell.
    expect(note.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      name.getBoundingClientRect().bottom,
    );
    expect(note.getBoundingClientRect().left).toBe(name.getBoundingClientRect().left);
    expect(note.getBoundingClientRect().right).toBeLessThanOrEqual(
      cell.getBoundingClientRect().right,
    );
    // The name kept every letter and all its room.
    expect(name.getBoundingClientRect().width).toBe(nameWidth);
    expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
    expect(name.getAttribute("data-cut")).toBe("false");
    // The row's 44 pixels hold both lines, so no row under it moves.
    expect(row.getBoundingClientRect().height).toBe(44);
  },
);

test("in a narrow window a tmux session keeps its Jump, and what it came to has a line of its own under the name, which is not cut for it", async () => {
  await page.viewport(375, 800);
  setApiHost(
    async () => new Response(JSON.stringify({ error: "x", reason: "pane-gone" }), { status: 409 }),
  );
  const screen = await render(
    <SessionsCard sessions={[IN_TMUX]} sources={[SOURCE_OK]} now={NOW} />,
  );
  const card = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;
  const row = rowOf(screen.container, "billing-webhooks");
  const name = row.querySelector('[data-part="name"]') as HTMLElement;
  const nameWidth = name.getBoundingClientRect().width;

  await screen.getByRole("button", { name: /^Jump to billing-webhooks/ }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("That pane has closed");

  const note = row.querySelector('[data-part="jump-note"]') as HTMLElement;
  // Under the name and over the status, at the name's left edge, as wide as its words.
  expect(note.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    name.getBoundingClientRect().bottom,
  );
  expect(note.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    (row.querySelector('[data-part="status-under"]') as HTMLElement).getBoundingClientRect().top,
  );
  expect(note.getBoundingClientRect().left).toBe(name.getBoundingClientRect().left);
  expect(note.getBoundingClientRect().width).toBeLessThan(160);
  // The name kept every letter and all its room.
  expect(name.getBoundingClientRect().width).toBe(nameWidth);
  expect(name.getAttribute("data-cut")).toBe("false");
  expect(screen.container.querySelectorAll('[data-part="jump-note"]')).toHaveLength(1);
  expect(screen.container.querySelectorAll('[data-part="jump-said"]')).toHaveLength(1);
  expect(note.getBoundingClientRect().right).toBeLessThanOrEqual(
    card.getBoundingClientRect().right,
  );
  expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
});

/**
 * Sessions whose agents last wrote at different times: a Codex session quiet
 * past the threshold, a session from a status file quiet for less, a Claude
 * Code session that gives no time, and an idle and a finished one whose files
 * have not been written to for longer.
 */
const LAST_WRITES: Session[] = [
  makeSession({
    id: `codex:${uuid(41)}`,
    source: "codex",
    name: "billing-webhooks",
    status: "working",
    statusSince: NOW - 34 * MINUTE,
    lastWriteAt: NOW - 12 * MINUTE,
  }),
  custom(42, {
    name: "search-indexing",
    links: {},
    statusSince: NOW - 20 * MINUTE,
    lastWriteAt: NOW - 4 * MINUTE,
  }),
  session(43, { name: "checkout-flow", status: "working", statusSince: NOW - 15 * MINUTE }),
  makeSession({
    id: `codex:${uuid(44)}`,
    source: "codex",
    name: "docs-site",
    status: "idle",
    statusSince: NOW - 26 * MINUTE,
    lastWriteAt: NOW - 26 * MINUTE,
  }),
  makeSession({
    id: `codex:${uuid(45)}`,
    source: "codex",
    name: "api-rate-limits",
    status: "finished",
    statusSince: NOW - 2 * HOUR,
    lastWriteAt: NOW - 2 * HOUR,
    alive: false,
  }),
];

const ALL_SOURCES = [SOURCE_OK, CODEX_OK, STATUS_FILES_OK];

/** What a row says of its agent's quiet stretch: what is shown and what is read out. Null when it says nothing. */
function quietOf(row: HTMLElement): { shown: string; read: string } | null {
  const quiet = row.querySelector<HTMLElement>('[data-part="quiet"]');
  if (!quiet) return null;
  return {
    shown: quiet.querySelector("[aria-hidden]")?.textContent ?? "",
    read: quiet.querySelector(".sr-only")?.textContent ?? "",
  };
}

test.each(["dark", "light"] as const)(
  "at 1440 in the %s theme, a working session quiet for 5 minutes or more says how long under its status and time, in the muted ink, and stays working",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    await page.viewport(1440, 900);
    const screen = await render(
      <SessionsCard sessions={LAST_WRITES} sources={ALL_SOURCES} now={NOW} />,
    );
    const billing = rowOf(screen.container, "billing-webhooks");

    expect(quietOf(billing)).toEqual({ shown: "quiet for 12m", read: "quiet for 12 minutes" });
    // Read after "Working for 34 minutes", in the cell that holds the status and its time.
    const quiet = billing.querySelector('[data-part="quiet"]') as HTMLElement;
    const status = billing.querySelector('[data-part="status"]') as HTMLElement;
    const duration = billing.querySelector('[data-part="duration"]') as HTMLElement;
    expect(quiet.closest("td")).toBe(status.closest("td"));
    expect(quiet.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      status.getBoundingClientRect().bottom - 1,
    );
    expect(quiet.getBoundingClientRect().left).toBe(status.getBoundingClientRect().left);
    expect(quiet.getBoundingClientRect().right).toBeLessThanOrEqual(
      duration.getBoundingClientRect().right,
    );
    const style = getComputedStyle(quiet);
    expect(style.color).toBe(rgbOf("var(--ink-muted)"));
    expect(style.fontSize).toBe("13px");
    expect(style.fontFamily).toMatch(/^"?Atkinson Hyperlegible Next/);
    expect(style.fontVariantNumeric).toContain("tabular-nums");

    // The status keeps its word, its mark, its group and its colours: those of
    // a working row that says nothing of the kind.
    const plain = rowOf(screen.container, "checkout-flow");
    expect(status.textContent).toBe("Working");
    expect(duration.querySelector("[aria-hidden]")?.textContent).toBe("34m");
    expect(billing.dataset.status).toBe("working");
    expect(billing.closest("tbody")?.dataset.group).toBe("working");
    expect(billing.querySelector('[data-slot="status-mark"]')?.getAttribute("data-kind")).toBe(
      "working",
    );
    const look = (row: HTMLElement, part: string) => {
      const element = row.querySelector(`[data-part="${part}"]`) as HTMLElement;
      return [getComputedStyle(element).color, getComputedStyle(element).fontWeight];
    };
    for (const part of ["status", "duration", "name"]) {
      expect(look(billing, part), part).toEqual(look(plain, part));
    }
    const markColour = (row: HTMLElement) =>
      getComputedStyle(row.querySelector('[data-slot="status-mark"]') as HTMLElement).color;
    expect(markColour(billing)).toBe(markColour(plain));

    // Under the threshold, without a time, and in any other status, nothing is said.
    for (const name of ["search-indexing", "checkout-flow", "docs-site", "api-rate-limits"]) {
      expect(quietOf(rowOf(screen.container, name)), name).toBeNull();
    }
    // The two lines fit the row, so every row is still 44px, and none of it is warm.
    for (const row of screen.container.querySelectorAll<HTMLElement>('[data-slot="session-row"]')) {
      expect(row.getBoundingClientRect().height).toBe(44);
    }
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("the time of the last write is one hover or one Tab away", async () => {
  await page.viewport(1440, 900);
  const screen = await render(
    <SessionsCard sessions={LAST_WRITES} sources={ALL_SOURCES} now={NOW} />,
  );
  const quiet = rowOf(screen.container, "billing-webhooks").querySelector(
    '[data-part="quiet"]',
  ) as HTMLElement;
  const tooltip = page.getByRole("tooltip");
  const said = `Last write at ${formatSince(NOW - 12 * MINUTE, NOW)}`;

  await userEvent.hover(quiet);
  await expect.element(tooltip).toHaveTextContent(said);
  await pointAway();
  await expect.element(tooltip).not.toBeInTheDocument();

  startAtTop();
  for (let presses = 0; presses < 20 && document.activeElement !== quiet; presses += 1) {
    await userEvent.tab();
  }
  expect(document.activeElement).toBe(quiet);
  await expect.element(tooltip).toHaveTextContent(said);
  // It is the only stop of its kind: the rows that say nothing have none.
  expect(screen.container.querySelectorAll('[data-part="quiet"]')).toHaveLength(1);
});

test("it comes once the quiet stretch reaches 5 minutes, counts with the clock, and goes when the agent writes again", async () => {
  const quietAt = (now: number, sessions = LAST_WRITES) =>
    render(<SessionsCard sessions={sessions} sources={ALL_SOURCES} now={now} />);
  const indexing = (container: HTMLElement) =>
    quietOf(rowOf(container, "search-indexing"))?.shown ?? null;

  const screen = await quietAt(NOW + MINUTE - 1);
  expect(indexing(screen.container)).toBeNull();
  await screen.rerender(
    <SessionsCard sessions={LAST_WRITES} sources={ALL_SOURCES} now={NOW + MINUTE} />,
  );
  expect(indexing(screen.container)).toBe("quiet for 5m");
  await screen.rerender(
    <SessionsCard sessions={LAST_WRITES} sources={ALL_SOURCES} now={NOW + 61 * MINUTE} />,
  );
  expect(indexing(screen.container)).toBe("quiet for 1h 05m");

  // The agent writes to its file: the next answer carries the new time, and the row says nothing.
  const written = LAST_WRITES.map((s) =>
    s.name === "search-indexing" ? { ...s, lastWriteAt: NOW + 60 * MINUTE } : s,
  );
  await screen.rerender(
    <SessionsCard sessions={written} sources={ALL_SOURCES} now={NOW + 61 * MINUTE} />,
  );
  expect(indexing(screen.container)).toBeNull();
  expect(
    rowOf(screen.container, "search-indexing").querySelector('[data-part="status"]')?.textContent,
  ).toBe("Working");
});

test.each(["dark", "light"] as const)(
  "at 375 in the %s theme, it joins the line under the name, on a line of its own under the status and its time, and nothing is cut or runs past the card",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    await page.viewport(375, 900);
    const screen = await render(
      <div style={{ width: 279 }}>
        <SessionsCard sessions={LAST_WRITES} sources={ALL_SOURCES} now={NOW} />
      </div>,
    );
    const card = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;
    const billing = rowOf(screen.container, "billing-webhooks");
    const name = billing.querySelector('[data-part="name"]') as HTMLElement;
    const line = billing.querySelector('[data-part="status-under"]') as HTMLElement;
    const status = line.querySelector('[data-part="status"]') as HTMLElement;
    const quiet = line.querySelector('[data-part="quiet"]') as HTMLElement;

    expect(quietOf(billing)).toEqual({ shown: "quiet for 12m", read: "quiet for 12 minutes" });
    // Read as "Codex, Working for 34 minutes, quiet for 12 minutes".
    expect(line.textContent).toBe(
      "Codex, ·Workingfor 34 minutes34m, quiet for 12 minutesquiet for 12m",
    );
    expect(status.textContent).toBe("Working");
    expect(billing.dataset.status).toBe("working");
    // Under the status and its time, at the line's left edge, every word of it whole.
    const duration = line.querySelector('[data-part="duration"]') as HTMLElement;
    expect(name.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      status.getBoundingClientRect().top + 1,
    );
    expect(quiet.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      Math.max(status.getBoundingClientRect().bottom, duration.getBoundingClientRect().bottom) - 1,
    );
    expect(quiet.getBoundingClientRect().left).toBe(line.getBoundingClientRect().left);
    expect(quiet.getBoundingClientRect().right).toBeLessThanOrEqual(
      line.getBoundingClientRect().right + 0.5,
    );
    expect(quiet.scrollWidth).toBeLessThanOrEqual(quiet.clientWidth);
    expect(getComputedStyle(quiet).color).toBe(rgbOf("var(--ink-muted)"));
    expect(getComputedStyle(quiet).fontSize).toBe("13px");
    // The time keeps its place at the right edge, where every other row's time stands.
    const rights = [...screen.container.querySelectorAll('[data-part="duration"]')].map((d) =>
      Math.round(d.getBoundingClientRect().right),
    );
    expect(new Set(rights).size).toBe(1);

    for (const other of ["search-indexing", "checkout-flow", "docs-site", "api-rate-limits"]) {
      expect(quietOf(rowOf(screen.container, other)), other).toBeNull();
    }
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("a switch in the head lays the sessions out as a list or as a board, and the list comes first", async () => {
  const screen = await render(<SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />);
  const head = screen.container.querySelector('[data-part="head"]') as HTMLElement;
  const choice = screen.getByRole("radiogroup", { name: "Show sessions as" });

  // In the head, at its right, after the hint.
  expect(head.contains(choice.element())).toBe(true);
  expect(choice.element().getAttribute("data-slot")).toBe("segmented-control");
  await expect.element(screen.getByRole("radio", { name: "List" })).toBeChecked();
  await expect.element(screen.getByRole("radio", { name: "Board" })).not.toBeChecked();
  expect(screen.container.querySelector('[data-slot="session-list"]')).not.toBeNull();
  expect(screen.container.querySelector('[data-slot="session-board"]')).toBeNull();
  expect(localStorage.getItem(SESSIONS_LAYOUT_STORAGE_KEY)).toBeNull();

  await screen.getByRole("radio", { name: "Board" }).click();

  expect(screen.container.querySelector('[data-slot="session-list"]')).toBeNull();
  const board = screen.container.querySelector('[data-slot="session-board"]') as HTMLElement;
  // The board has every session, the ones that need the person among them.
  expect(board.querySelectorAll('[data-slot="board-card"]')).toHaveLength(MIXED.length);
  expect(board.textContent).toContain("blocked-one");
  // The count in the head is the same either way.
  expect(head.querySelector('[data-part="count"]')?.textContent).toBe("7");
  expect(localStorage.getItem(SESSIONS_LAYOUT_STORAGE_KEY)).toBe("board");

  await screen.getByRole("radio", { name: "List" }).click();
  expect(screen.container.querySelector('[data-slot="session-list"]')).not.toBeNull();
  expect(localStorage.getItem(SESSIONS_LAYOUT_STORAGE_KEY)).toBe("list");
});

test("the choice is remembered: a card drawn again, as on the next visit, opens on the board", async () => {
  const first = await render(<SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />);
  await first.getByRole("radio", { name: "Board" }).click();
  await first.unmount();

  const again = await render(<SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />);

  await expect.element(again.getByRole("radio", { name: "Board" })).toBeChecked();
  expect(again.container.querySelector('[data-slot="session-board"]')).not.toBeNull();
  expect(again.container.querySelector('[data-slot="session-list"]')).toBeNull();
});

test("anything else in storage is the list", async () => {
  localStorage.setItem(SESSIONS_LAYOUT_STORAGE_KEY, "kanban");
  const screen = await render(<SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />);

  await expect.element(screen.getByRole("radio", { name: "List" })).toBeChecked();
  expect(screen.container.querySelector('[data-slot="session-list"]')).not.toBeNull();
});

test("Tab reaches the switch, the arrow keys move between List, Repos and Board, and the next Tab goes into the board", async () => {
  const screen = await render(<SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />);
  startAtTop();

  await userEvent.tab();
  await expect.element(screen.getByRole("radio", { name: "List" })).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(screen.getByRole("radio", { name: "Repos" })).toBeChecked();
  expect(screen.container.querySelector('[data-group="no-repository"]')).not.toBeNull();
  expect(localStorage.getItem(SESSIONS_LAYOUT_STORAGE_KEY)).toBe("repositories");
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(screen.getByRole("radio", { name: "Board" })).toHaveFocus();
  await expect.element(screen.getByRole("radio", { name: "Board" })).toBeChecked();
  expect(screen.container.querySelector('[data-slot="session-board"]')).not.toBeNull();
  expect(localStorage.getItem(SESSIONS_LAYOUT_STORAGE_KEY)).toBe("board");

  // One Tab stop for the switch: the next is on the first card.
  await userEvent.tab();
  const active = document.activeElement as HTMLElement;
  expect(active.closest('[data-slot="board-card"]')?.getAttribute("data-session")).toBe(
    MIXED[1]!.id,
  );

  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await userEvent.keyboard("{ArrowLeft}");
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(screen.getByRole("radio", { name: "List" })).toBeChecked();
  expect(screen.container.querySelector('[data-slot="session-list"]')).not.toBeNull();
  await pointAway();
});

test("the switch leaves the head as tall as a head without one, so its title stays level with the card beside it", async () => {
  const screen = await render(
    <div style={{ display: "grid", gridTemplateColumns: "1.75fr 1fr", gap: 16, width: 1300 }}>
      <SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />
      <SessionsCard sessions={[]} sources={[SOURCE_OK]} now={NOW} />
    </div>,
  );
  const [withSwitch, without] = [
    ...screen.container.querySelectorAll<HTMLElement>('[data-part="head"]'),
  ];

  expect(withSwitch!.querySelector('[data-slot="segmented-control"]')).not.toBeNull();
  expect(without!.querySelector('[data-slot="segmented-control"]')).toBeNull();
  expect(withSwitch!.getBoundingClientRect().height).toBe(without!.getBoundingClientRect().height);
  expect(withSwitch!.querySelector("h2")!.getBoundingClientRect().top).toBe(
    without!.querySelector("h2")!.getBoundingClientRect().top,
  );
  // It ends 24px in from the card's right edge, as the head's words do.
  const card = withSwitch!.closest('[data-slot="section-card"]') as HTMLElement;
  const control = withSwitch!.querySelector('[data-slot="segmented-control"]') as HTMLElement;
  expect(card.getBoundingClientRect().right - control.getBoundingClientRect().right).toBe(24);
});

// The card's widths on the Overview, as above, and at 761 with a scrollbar
// that takes 15px, as on Windows or a Mac set to show them always.
test.each([
  [888, true],
  [835, true],
  [733, true],
  [670, false],
  [649, false],
  [634, false],
])(
  "in a card %i pixels wide the head stays one line, the longest hint and a count of hundreds with it, and the hint is shown: %s",
  async (width, shown) => {
    const idle = Array.from({ length: 120 }, (_, n) =>
      session(100 + n, { name: `idle-${n}`, status: "idle", statusSince: NOW - MINUTE }),
    );
    for (const sessions of [
      [IN_TMUX, IN_VSCODE],
      [IN_TMUX, IN_VSCODE, ...idle],
    ]) {
      const screen = await render(
        <div style={{ width }}>
          <SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />
        </div>,
      );
      const head = screen.container.querySelector('[data-part="head"]') as HTMLElement;
      const hint = head.querySelector('[data-part="hint"]') as HTMLElement;
      const title = head.querySelector("h2")!.getBoundingClientRect();
      const control = head
        .querySelector('[data-slot="segmented-control"]')!
        .getBoundingClientRect();

      expect(hint.textContent).toBe("Jump opens the session, or selects its pane in tmux");
      expect(getComputedStyle(hint).display !== "none", `${sessions.length} sessions`).toBe(shown);
      // As tall as any card's head, with the switch beside the title, never under it.
      expect(head.getBoundingClientRect().height, `${sessions.length} sessions`).toBe(51.5);
      expect(control.left).toBeGreaterThan(title.right);
      await screen.unmount();
    }
  },
);

test.each(["list", "repositories", "board"] as const)(
  "on a phone the switch is the card's first line, 12px under the title, and the %s starts under it",
  async (layout) => {
    localStorage.setItem(SESSIONS_LAYOUT_STORAGE_KEY, layout);
    await page.viewport(375, 900);
    // The width the Overview gives the card on a phone.
    const screen = await render(
      <div style={{ width: 283 }}>
        <SessionsCard sessions={MIXED} sources={[SOURCE_OK]} now={NOW} />
      </div>,
    );
    const head = screen.container.querySelector('[data-part="head"]') as HTMLElement;
    const title = head.querySelector("h2")!.getBoundingClientRect();
    const control = screen.getByRole("radiogroup", { name: "Show sessions as" }).element();
    const box = control.getBoundingClientRect();

    expect(head.contains(control)).toBe(false);
    // The head is as tall as any card's: 20px above the title's line, 12px under it.
    expect(head.getBoundingClientRect().height).toBe(51.5);
    expect(box.top).toBeGreaterThanOrEqual(title.bottom + 12);
    expect(box.left).toBe(title.left);
    const first = screen.container.querySelector(
      layout === "board" ? '[data-slot="board-column"]' : '[data-slot="group-row"]',
    )!;
    expect(first.getBoundingClientRect().top).toBeGreaterThanOrEqual(box.bottom);
    // It is still the first stop on the way into the card.
    startAtTop();
    await userEvent.tab();
    expect(control.contains(document.activeElement)).toBe(true);
  },
);

test("with no session there is nothing to lay out, so the switch is not offered and the empty state is the same", async () => {
  localStorage.setItem(SESSIONS_LAYOUT_STORAGE_KEY, "board");
  const screen = await render(<SessionsCard sessions={[]} sources={[SOURCE_OK]} now={NOW} />);

  expect(screen.container.querySelector('[data-slot="segmented-control"]')).toBeNull();
  expect(screen.container.querySelector('[data-slot="session-board"]')).toBeNull();
  expect(screen.container.textContent).toContain("No agents are running");
});

test("when every session needs the person, the board holds them in its Needs you column", async () => {
  localStorage.setItem(SESSIONS_LAYOUT_STORAGE_KEY, "board");
  const waiting = MIXED.filter((s) => s.status === "needs-you");
  const screen = await render(<SessionsCard sessions={waiting} sources={[SOURCE_OK]} now={NOW} />);

  expect(screen.container.querySelector('[data-part="all-waiting"]')).toBeNull();
  await expect.element(screen.getByRole("list", { name: "Needs you 2" })).toBeVisible();
  expect(screen.container.querySelectorAll('[data-slot="board-card"]')).toHaveLength(2);
});

test("on the board the hint says what every card's Jump does, a waiting session's included", async () => {
  localStorage.setItem(SESSIONS_LAYOUT_STORAGE_KEY, "board");
  // Only the waiting session can be jumped to, so the list has no Jump and no hint.
  const sessions = [
    session(1, {
      name: "checkout-flow",
      status: "needs-you",
      surface: "vscode",
      links: { open: jumpLink(1) },
    }),
    IN_TMUX,
  ];
  const screen = await render(<SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />);

  expect(screen.container.querySelector('[data-part="hint"]')?.textContent).toBe(
    "Jump opens the session, or selects its pane in tmux",
  );
  await screen.getByRole("radio", { name: "List" }).click();
  expect(screen.container.querySelector('[data-part="hint"]')?.textContent).toBe(
    "Jump selects the session's pane in tmux",
  );
});

test("a source that cannot be read is said above the board, as above the list", async () => {
  localStorage.setItem(SESSIONS_LAYOUT_STORAGE_KEY, "board");
  const failed: SourceHealth = { ...SOURCE_OK, state: "error", detail: "Fell back to the folder." };
  const screen = await render(<SessionsCard sessions={MIXED} sources={[failed]} now={NOW} />);
  const board = screen.container.querySelector('[data-slot="session-board"]') as HTMLElement;

  await expect.element(screen.getByRole("alert")).toHaveTextContent("Fell back to the folder.");
  expect(screen.getByRole("alert").element().getBoundingClientRect().bottom).toBeLessThanOrEqual(
    board.getBoundingClientRect().top,
  );
});

const STOREFRONT = { id: "9aaa5f0ab35a5f84", name: "storefront" };
const PLATFORM_API = { id: "1c2d3e4f5a6b7c8d", name: "platform-api" };
const DOCS = { id: "7ba69a8b81747824", name: "docs" };

/**
 * Storefront's main folder and two of its worktrees, with a third waiting on
 * the person, platform-api, docs at a commit, and two sessions in no
 * repository, one of them with no folder at all.
 */
const BY_REPOSITORY: Session[] = [
  session(1, {
    name: "billing-webhooks",
    status: "idle",
    statusSince: NOW - 26 * MINUTE,
    cwd: "/Users/example/code/storefront",
    project: "storefront",
    git: { branch: "main", repository: STOREFRONT },
  }),
  session(2, {
    name: "checkout-flow",
    status: "working",
    statusSince: NOW - 12 * MINUTE,
    cwd: "/Users/example/code/storefront-checkout",
    project: "storefront-checkout",
    git: { branch: "checkout-flow", repository: STOREFRONT },
  }),
  session(3, {
    name: "search-indexing",
    status: "finished",
    statusSince: NOW - 2 * HOUR,
    alive: false,
    cwd: "/Users/example/code/storefront-search",
    project: "storefront-search",
    git: { branch: "search-indexing", repository: STOREFRONT },
  }),
  session(4, {
    name: "payment-retries",
    status: "needs-you",
    waitingReason: "permission",
    statusSince: NOW - 3 * MINUTE,
    cwd: "/Users/example/code/storefront-payments",
    project: "storefront-payments",
    git: { branch: "payment-retries", repository: STOREFRONT },
  }),
  session(5, {
    name: "api-rate-limits",
    status: "working",
    statusSince: NOW - 34 * MINUTE,
    cwd: "/Users/example/code/platform-api",
    project: "platform-api",
    git: { branch: "fix/rate-limits", repository: PLATFORM_API },
  }),
  session(6, {
    name: "docs-site",
    status: "idle",
    statusSince: NOW - 8 * MINUTE,
    cwd: "/Users/example/code/docs",
    project: "docs",
    git: { commit: "3f9a2c1", repository: DOCS },
  }),
  session(7, {
    name: "mobile-onboarding",
    status: "idle",
    statusSince: NOW - 41 * MINUTE,
    cwd: "/Users/example/code/mobile-app",
    project: "mobile-app",
  }),
  session(8, {
    name: "infra-terraform",
    status: "working",
    statusSince: NOW - 4 * MINUTE,
    cwd: null,
    project: null,
  }),
];

/** Each group of the table: its kind, its head's words, and the names of its rows. */
function tableOf(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('tbody[data-slot="session-group"]')].map(
    (group) => [
      group.dataset.group,
      group.querySelector('[data-slot="group-row"]')?.textContent,
      [...group.querySelectorAll('[data-part="name"]')].map((name) => name.textContent),
    ],
  );
}

test("the switch offers List, Repos and Board, and Repos groups the list under a head for each repository, the ones in none last", async () => {
  const screen = await render(
    <SessionsCard sessions={BY_REPOSITORY} sources={[SOURCE_OK]} now={NOW} />,
  );
  const choice = screen.getByRole("radiogroup", { name: "Show sessions as" }).element();

  expect([...choice.querySelectorAll('[role="radio"]')].map((radio) => radio.textContent)).toEqual([
    "List",
    "Repos",
    "Board",
  ]);
  await screen.getByRole("radio", { name: "Repos" }).click();

  expect(localStorage.getItem(SESSIONS_LAYOUT_STORAGE_KEY)).toBe("repositories");
  // In order of name, each with how many it holds. The session that needs the
  // person is the hero's, as in the list by status, and storefront counts the
  // three left. Inside each group, the order of the status groups: working,
  // idle, then the endings.
  expect(tableOf(screen.container)).toEqual([
    ["repository", "docs1", ["docs-site"]],
    ["repository", "platform-api1", ["api-rate-limits"]],
    ["repository", "storefront3", ["checkout-flow", "billing-webhooks", "search-indexing"]],
    ["no-repository", "No repository2", ["infra-terraform", "mobile-onboarding"]],
  ]);
  expect(screen.container.textContent).not.toContain("payment-retries");
  // Each repository's group is told apart by its id, never by a path.
  const groups = [...screen.container.querySelectorAll<HTMLElement>('[data-group="repository"]')];
  expect(groups.map((group) => group.dataset.repository)).toEqual([
    DOCS.id,
    PLATFORM_API.id,
    STOREFRONT.id,
  ]);
  // The card's count is still every session.
  expect(
    screen.container.querySelector('[data-part="head"] [data-part="count"]')?.textContent,
  ).toBe("8");
  // Each row is the list's own row, its folder and branch included.
  const checkout = rowOf(screen.container, "checkout-flow");
  expect(checkout.querySelector('[data-part="project"]')?.textContent).toBe("storefront-checkout");
  expect(checkout.querySelector('[data-part="git"]')?.textContent).toBe("on branch checkout-flow");
  expect(checkout.querySelector('[data-part="status"]')?.textContent).toBe("Working");

  await screen.getByRole("radio", { name: "List" }).click();
  expect(tableOf(screen.container).map(([group]) => group)).toEqual(["working", "idle", "ended"]);
  expect(localStorage.getItem(SESSIONS_LAYOUT_STORAGE_KEY)).toBe("list");
});

test("the choice of Repos is remembered: a card drawn again, as on the next visit, opens grouped by repository", async () => {
  const first = await render(
    <SessionsCard sessions={BY_REPOSITORY} sources={[SOURCE_OK]} now={NOW} />,
  );
  await first.getByRole("radio", { name: "Repos" }).click();
  await first.unmount();

  const again = await render(
    <SessionsCard sessions={BY_REPOSITORY} sources={[SOURCE_OK]} now={NOW} />,
  );

  await expect.element(again.getByRole("radio", { name: "Repos" })).toBeChecked();
  expect(tableOf(again.container).map(([, head]) => head)).toEqual([
    "docs1",
    "platform-api1",
    "storefront3",
    "No repository2",
  ]);
});

test("with no session in a repository, Repos puts them all under No repository", async () => {
  localStorage.setItem(SESSIONS_LAYOUT_STORAGE_KEY, "repositories");
  const screen = await render(<SessionsCard sessions={CALM} sources={[SOURCE_OK]} now={NOW} />);

  expect(tableOf(screen.container)).toEqual([
    [
      "no-repository",
      `No repository${CALM.length}`,
      ["busy-one", "idle-one", "stale-one", "failed-one", "done-one"],
    ],
  ]);
});

test("a repository's name too long for its head is cut, and stays one hover or one Tab away", async () => {
  localStorage.setItem(SESSIONS_LAYOUT_STORAGE_KEY, "repositories");
  const long = { id: "0f0f0f0f0f0f0f0f", name: `platform-${"services-".repeat(12)}api` };
  const sessions = [{ ...BY_REPOSITORY[4]!, git: { branch: "main", repository: long } }];
  const screen = await render(
    <div style={{ width: 600 }}>
      <SessionsCard sessions={sessions} sources={[SOURCE_OK]} now={NOW} />
    </div>,
  );
  const name = screen.container.querySelector(
    '[data-slot="group-row"] [data-part="repository"]',
  ) as HTMLElement;
  const head = name.closest("th") as HTMLElement;

  await expect.poll(() => name.dataset.cut).toBe("true");
  expect(name.tabIndex).toBe(0);
  // Its count stays in sight, and the head keeps its height.
  const count = head.querySelector('[data-part="count"]') as HTMLElement;
  expect(count.getBoundingClientRect().right).toBeLessThanOrEqual(
    head.getBoundingClientRect().right,
  );
  expect(head.getBoundingClientRect().height).toBe(40);
  // The switch is the first stop on the way into the card, and the name the next.
  startAtTop();
  await userEvent.tab();
  await userEvent.tab();
  expect(document.activeElement).toBe(name);
  await expect.element(page.getByRole("tooltip")).toHaveTextContent(long.name);
});

test.each([
  ["dark", 1440],
  ["light", 1440],
  ["dark", 375],
  ["light", 375],
] as const)(
  "in the %s theme at %ipx the list by repository has the status groups' quiet heads and rows, and nothing warm or new",
  async (theme, width) => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(SESSIONS_LAYOUT_STORAGE_KEY, "repositories");
    await page.viewport(width, 900);
    // The width the Overview gives the card at each.
    const screen = await render(
      <div style={{ width: width === 1440 ? 832 : 283 }}>
        <SessionsCard sessions={BY_REPOSITORY} sources={[SOURCE_OK]} now={NOW} />
      </div>,
    );
    await document.fonts.ready;
    const card = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;
    const heads = [...screen.container.querySelectorAll<HTMLElement>('[data-slot="group-row"] th')];

    expect(heads).toHaveLength(4);
    for (const head of heads) {
      const style = getComputedStyle(head);
      // A head of words on the glass, as every status group's is.
      expect(head.getAttribute("scope")).toBe("rowgroup");
      expect(head.getBoundingClientRect().height).toBe(40);
      expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(style.borderBottomWidth).toBe("0px");
      expect(style.fontSize).toBe("12px");
      expect(style.fontWeight).toBe("600");
      expect(style.color).toBe(rgbOf("var(--ink-secondary)"));
      const count = head.querySelector('[data-part="count"]') as HTMLElement;
      expect(getComputedStyle(count).color).toBe(rgbOf("var(--ink-muted)"));
      expect(getComputedStyle(count).fontVariantNumeric).toBe("tabular-nums");
      // The name is whole, and its words start where every row's name does.
      const name = head.querySelector('[data-part="repository"]');
      if (name) expect((name as HTMLElement).dataset.cut).toBe("false");
    }
    const rows = [...screen.container.querySelectorAll<HTMLElement>('[data-slot="session-row"]')];
    expect(rows).toHaveLength(7);
    if (width === 1440) {
      // Every row is the list's 44px, and the columns line up across the groups.
      expect(new Set(rows.map((row) => row.getBoundingClientRect().height))).toEqual(new Set([44]));
      const lefts = new Set(
        rows.map((row) =>
          Math.round(row.querySelector('[data-part="status"]')!.getBoundingClientRect().left),
        ),
      );
      expect(lefts.size).toBe(1);
    } else {
      // On a phone, the switch's three options sit on one line inside the card,
      // each word whole, and every row has its status under its name.
      const control = screen.getByRole("radiogroup", { name: "Show sessions as" }).element();
      const radios = [...control.querySelectorAll<HTMLElement>('[role="radio"]')];
      expect(new Set(radios.map((radio) => radio.getBoundingClientRect().top)).size).toBe(1);
      for (const radio of radios) expect(radio.scrollWidth).toBeLessThanOrEqual(radio.clientWidth);
      expect(control.getBoundingClientRect().right).toBeLessThanOrEqual(
        card.getBoundingClientRect().right - 24,
      );
      for (const row of rows) {
        const name = row.querySelector('[data-part="name"]') as HTMLElement;
        const status = row.querySelector('[data-part="status"]') as HTMLElement;
        expect(status.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          name.getBoundingClientRect().bottom - 1,
        );
      }
    }
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

/** A session left running in VS Code, idle 30 hours, that the collector can stop. */
function leftOpen() {
  return session(8, {
    name: "left-open",
    surface: "vscode",
    status: "idle",
    statusSince: NOW - 30 * HOUR,
    stale: true,
    pid: 4248,
    alive: true,
    stop: { how: "signal" },
  });
}

test("the sessions left running are a band under the card's head, over the list and the board, and stay in the list under Idle", async () => {
  localStorage.removeItem("agent-lookout-hidden-sessions");
  const screen = await render(
    <SessionsCard sessions={[...CALM, leftOpen()]} sources={[SOURCE_OK]} now={NOW} />,
  );
  const group = screen.container.querySelector('[data-slot="left-running"]') as HTMLElement;
  const list = screen.container.querySelector('[data-slot="session-list"]') as HTMLElement;

  expect(group.querySelector("h3")?.textContent).toBe("Left running1");
  // Folded at first, so the first group of the list sits just under it.
  expect(group.querySelector('[data-slot="left-running-row"]')).toBeNull();
  const first = list.querySelector('[data-slot="session-group"]') as HTMLElement;
  expect(first.getBoundingClientRect().top - group.getBoundingClientRect().top).toBeLessThanOrEqual(
    64,
  );
  await userEvent.click(screen.getByRole("button", { name: "Review…" }));
  expect(
    [...group.querySelectorAll('[data-slot="left-running-row"] [data-part="name"]')].map(
      (name) => name.textContent,
    ),
  ).toEqual(["left-open"]);
  expect(group.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // Still a row of the list, under Idle, where every stale session is.
  expect(rowOf(screen.container, "left-open").closest('[data-group="idle"]')).not.toBeNull();
  // The stale session with no process to stop is not left running.
  expect(group.textContent).not.toContain("stale-one");
  expect(warmPaint(group)).toEqual([]);

  await userEvent.click(screen.getByRole("radio", { name: "Board" }));
  expect(screen.container.querySelector('[data-slot="left-running"]')).not.toBeNull();
});

test("hiding the last session left running gives focus to the card's title", async () => {
  localStorage.removeItem("agent-lookout-hidden-sessions");
  const screen = await render(
    <SessionsCard sessions={[...CALM, leftOpen()]} sources={[SOURCE_OK]} now={NOW} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Review…" }));
  await userEvent.click(screen.getByRole("button", { name: "Hide left-open until it changes" }));

  expect(screen.container.querySelector('[data-slot="left-running"]')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Sessions" }).element());
  localStorage.removeItem("agent-lookout-hidden-sessions");
});

test.each([375, 1280])(
  "at %ipx, a session on another machine has the machine's name beside its own, and no Jump",
  async (width) => {
    await page.viewport(width, 900);
    const devbox: SourceHealth = {
      id: "remote:devbox",
      label: "devbox",
      machine: "devbox",
      state: "ok",
      checkedAt: NOW,
    };
    const sessions = [
      session(1, {
        name: "here-one",
        surface: "vscode",
        status: "working",
        statusSince: NOW - MINUTE,
        links: { open: jumpLink(1) },
      }),
      makeSession({
        id: `remote:devbox:claude-code:${uuid(2)}`,
        source: "remote:devbox",
        agent: "Claude Code",
        machine: "devbox",
        name: "there-one",
        status: "working",
        statusSince: NOW - MINUTE,
      }),
    ];
    const screen = await render(
      <SessionsCard sessions={sessions} sources={[SOURCE_OK, devbox]} now={NOW} />,
    );

    const row = rowOf(screen.container, "there-one");
    const badge = row.querySelector<HTMLElement>('[data-part="machine"]');
    if (!badge) throw new Error("expected the machine's name");
    // Read as "on devbox", and seen as the name alone, in a quiet badge.
    expect(badge.textContent).toBe("on devbox");
    expect(badge.getAttribute("data-slot")).toBe("badge");
    expect(badge.getAttribute("data-tone")).toBe("neutral");
    // Beside the name, on its line, and whole, inside the row; narrow, on a line of its own under it.
    const name = row.querySelector('[data-part="name"]') as HTMLElement;
    const named = name.getBoundingClientRect();
    const said = badge.getBoundingClientRect();
    expect(said.width).toBeGreaterThan(20);
    if (width === 375) {
      expect(said.top).toBeGreaterThanOrEqual(named.bottom - 1);
      expect(said.left).toBe(named.left);
    } else {
      expect(said.left).toBeGreaterThanOrEqual(named.right);
      expect(Math.abs((said.top + said.bottom) / 2 - (named.top + named.bottom) / 2)).toBeLessThan(
        4,
      );
    }
    expect(said.right).toBeLessThanOrEqual(row.getBoundingClientRect().right);
    expect(badge.scrollWidth).toBeLessThanOrEqual(badge.clientWidth);
    // One agent here and there is one agent, so no row names it.
    expect(row.querySelector('[data-part="agent"]')).toBeNull();
    // Jump acts on this computer only.
    expect(row.querySelector('[data-part="jump"]')).toBeNull();
    const here = rowOf(screen.container, "here-one");
    expect(here.querySelector('[data-part="jump"]')).not.toBeNull();
    expect(here.querySelector('[data-part="machine"]')).toBeNull();
    expect(warmPaint(screen.container)).toEqual([]);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  },
);

test("with only another machine read, the empty card says it is watching that machine", async () => {
  const devbox: SourceHealth = {
    id: "remote:devbox",
    label: "devbox",
    machine: "devbox",
    state: "ok",
    checkedAt: NOW,
  };
  const screen = await render(
    <SessionsCard sessions={[]} sources={[SOURCE_OK, devbox]} now={NOW} />,
  );
  await expect
    .element(
      screen.getByText(
        "Agent Lookout is watching Claude Code on this computer and the sessions on devbox. A session shows up here within a few seconds of starting.",
      ),
    )
    .toBeVisible();
});

test.each([375, 1280])(
  "at %ipx, a machine's name as long as one can be never cuts the session's name, and goes under it when the line cannot hold both",
  async (width) => {
    await page.viewport(width, 900);
    const long = "build-server-eu-west-02a";
    const there: SourceHealth = {
      id: `remote:${long}`,
      label: long,
      machine: long,
      state: "ok",
      checkedAt: NOW,
    };
    const sessions = ["demo-local", "checkout-flow-and-payments-retry"].map((name, index) =>
      makeSession({
        id: `remote:${long}:claude-code:${uuid(index + 1)}`,
        source: `remote:${long}`,
        agent: "Claude Code",
        machine: long,
        name,
        status: "working",
        statusSince: NOW - MINUTE,
      }),
    );
    const screen = await render(
      <div style={{ width: width === 375 ? 319 : 760 }}>
        <SessionsCard sessions={sessions} sources={[SOURCE_OK, there]} now={NOW} />
      </div>,
    );
    for (const sessionName of ["demo-local", "checkout-flow-and-payments-retry"]) {
      const row = rowOf(screen.container, sessionName);
      const name = row.querySelector('[data-part="name"]') as HTMLElement;
      const badge = row.querySelector('[data-part="machine"]') as HTMLElement;
      // The badge is whole, and the name keeps the room of its line.
      expect(badge.scrollWidth).toBeLessThanOrEqual(badge.clientWidth);
      expect(name.getBoundingClientRect().width).toBeGreaterThan(60);
      if (sessionName === "demo-local") expect(name.getAttribute("data-cut")).toBe("false");
      const said = badge.getBoundingClientRect();
      const named = name.getBoundingClientRect();
      if (width === 375 || said.top > named.top + 2) {
        expect(said.top).toBeGreaterThanOrEqual(named.bottom - 1);
      }
      expect(said.right).toBeLessThanOrEqual(row.getBoundingClientRect().right);
    }
    // In a wide row, a name and the badge that cannot share the line keep the row's height.
    if (width === 1280) {
      const tall = rowOf(screen.container, "checkout-flow-and-payments-retry");
      const short = rowOf(screen.container, "demo-local");
      expect(tall.getBoundingClientRect().height).toBe(short.getBoundingClientRect().height);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  },
);

test("with this computer read and another machine not connected, the empty card names the machine", async () => {
  const devbox: SourceHealth = {
    id: "remote:devbox",
    label: "devbox",
    machine: "devbox",
    state: "unavailable",
    checkedAt: NOW,
  };
  const screen = await render(
    <SessionsCard sessions={[]} sources={[SOURCE_OK, devbox]} now={NOW} />,
  );
  await expect
    .element(
      screen.getByText(
        "Agent Lookout is watching Claude Code on this computer. devbox is not connected, so its sessions are not known. A session shows up here within a few seconds of starting.",
      ),
    )
    .toBeVisible();
});

test("a machine that is not connected is left to Sources while this computer is read, and named when nothing is", async () => {
  const devbox: SourceHealth = {
    id: "remote:devbox",
    label: "devbox",
    machine: "devbox",
    state: "unavailable",
    detail: "ssh is connected to devbox, but no Agent Lookout answers on its port 4777.",
    advice: "Start it there with npx agent-lookout, and leave it running.",
    checkedAt: NOW,
  };
  const calm = await render(
    <SessionsCard sessions={CALM} sources={[SOURCE_OK, devbox]} now={NOW} />,
  );
  expect(calm.container.textContent).not.toContain("devbox");
  calm.unmount();

  const screen = await render(
    <SessionsCard
      sessions={[]}
      sources={[{ ...SOURCE_OK, state: "unavailable" }, devbox]}
      now={NOW}
    />,
  );
  await expect.element(screen.getByText("devbox is not connected")).toBeVisible();
  await expect.element(screen.getByText(/no Agent Lookout answers on its port 4777/)).toBeVisible();
  await expect
    .element(screen.getByText("Start it there with npx agent-lookout, and leave it running."))
    .toBeVisible();
});
