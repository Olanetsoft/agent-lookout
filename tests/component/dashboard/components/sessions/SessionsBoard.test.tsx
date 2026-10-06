import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { Session } from "@core/sessions/session";
import { SessionsBoard } from "@dashboard/components/sessions/SessionsBoard";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import { AUTOMATION_NOTE_STORAGE_KEY } from "@dashboard/lib/api/automationNote";
import { makeSession } from "@tests/fixtures/session";
import { pointAway, startAtTop } from "@tests/support/browser/browser";
import { coloursIn, isWarm, rgbOf, warmElements, warmPaint } from "@tests/support/browser/colours";

const NOW = 1_700_000_600_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const jumpLink = (n: number) => `vscode://anthropic.claude-code/open?session=${uuid(n)}`;

function session(n: number, overrides: Partial<Session>): Session {
  return makeSession({ id: `claude-code:${uuid(n)}`, ...overrides });
}

/** Eight sessions, two in each column, a stale one among the idle. */
const SESSIONS: Session[] = [
  session(1, {
    name: "api-rate-limits",
    status: "needs-you",
    waitingReason: "question",
    statusSince: NOW - 38_000,
  }),
  session(2, {
    name: "checkout-flow",
    surface: "vscode",
    status: "needs-you",
    waitingReason: "permission",
    cwd: "/Users/example/code/storefront",
    project: "storefront",
    git: { branch: "checkout-flow" },
    statusSince: NOW - (4 * MINUTE + 12_000),
    links: { open: jumpLink(2) },
  }),
  session(3, {
    name: "billing-webhooks",
    status: "working",
    statusSince: NOW - 34 * MINUTE,
    pid: 4242,
    alive: true,
    jump: { kind: "tmux", place: "work:2.1" },
  }),
  session(4, { name: "search-indexing", status: "working", statusSince: NOW - 52_000 }),
  session(5, {
    name: "mobile-onboarding",
    status: "idle",
    stale: true,
    statusSince: NOW - 3 * DAY,
  }),
  session(6, { name: "docs-site", status: "idle", statusSince: NOW - 26 * MINUTE }),
  session(7, {
    name: "infra-terraform",
    status: "finished",
    statusSince: NOW - 2 * HOUR,
    alive: false,
  }),
  session(8, { name: "email-templates", status: "failed", statusSince: NOW - 41 * MINUTE }),
];

/** The board as the Sessions card holds it, in a card of the given width. */
function renderBoard(sessions: readonly Session[], width = 835, now = NOW) {
  return render(
    <section data-slot='section-card' className='glass-card' style={{ width }}>
      <SessionsBoard sessions={sessions} now={now} />
    </section>,
  );
}

const columnOf = (root: ParentNode, id: string) =>
  root.querySelector(`[data-slot="board-column"][data-column="${id}"]`) as HTMLElement;

/** The names on a column's cards, top to bottom. */
const namesIn = (column: Element) =>
  [...column.querySelectorAll('[data-slot="board-card"] [data-part="name"]')].map(
    (name) => name.textContent,
  );

function cardOf(root: ParentNode, name: string): HTMLElement {
  const cards = [...root.querySelectorAll<HTMLElement>('[data-slot="board-card"]')];
  const card = cards.find((c) => c.querySelector('[data-part="name"]')?.textContent === name);
  if (!card) throw new Error(`No card named ${name}`);
  return card;
}

/** Warm paint that is not part of a needs-you mark. */
function warmBeyondTheLamp(root: Element): Element[] {
  return warmElements(root).filter(
    (element) => element.closest('[data-slot="status-mark"][data-kind="needs-you"]') === null,
  );
}

beforeEach(async () => {
  // A desktop window, wide enough for any card a test draws.
  await page.viewport(1280, 900);
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  setApiHost();
});

test("there are four columns, Needs you, Working, Idle and Finished or failed, each a list named by its head and count", async () => {
  const screen = await renderBoard(SESSIONS);

  const columns = [...screen.container.querySelectorAll('[data-slot="board-column"]')];
  expect(columns.map((column) => column.getAttribute("data-column"))).toEqual([
    "needs-you",
    "working",
    "idle",
    "ended",
  ]);
  const heads = screen.container.querySelectorAll("h3");
  expect([...heads].map((head) => head.textContent)).toEqual([
    "Needs you2",
    "Working2",
    "Idle1Stale1",
    "Finished or failed2",
  ]);
  // Each column is a list a screen reader names by its head.
  for (const [name, items] of [
    ["Needs you 2", 2],
    ["Working 2", 2],
    ["Idle 1 Stale 1", 2],
    ["Finished or failed 2", 2],
  ] as const) {
    const list = screen.getByRole("list", { name });
    await expect.element(list).toBeVisible();
    expect(list.element().querySelectorAll(":scope > li")).toHaveLength(items);
  }
  // The heads are a group head of the list: caption words at 600, the count muted.
  const head = heads[1] as HTMLElement;
  expect(getComputedStyle(head).fontSize).toBe("12px");
  expect(getComputedStyle(head).fontWeight).toBe("600");
  expect(getComputedStyle(head).color).toBe(rgbOf("var(--ink-secondary)"));
  const count = head.querySelector('[data-part="count"]') as HTMLElement;
  expect(getComputedStyle(count).color).toBe(rgbOf("var(--ink-muted)"));
  expect(getComputedStyle(count).fontVariantNumeric).toBe("tabular-nums");
});

test("Needs you has the longest wait first, as the hero; the others the most recent change first, as the list", async () => {
  const screen = await renderBoard(SESSIONS);

  expect(namesIn(columnOf(screen.container, "needs-you"))).toEqual([
    "checkout-flow",
    "api-rate-limits",
  ]);
  expect(namesIn(columnOf(screen.container, "working"))).toEqual([
    "search-indexing",
    "billing-webhooks",
  ]);
  // Stale sits in Idle, after the idle one, with its own mark and word.
  expect(namesIn(columnOf(screen.container, "idle"))).toEqual(["docs-site", "mobile-onboarding"]);
  const stale = cardOf(screen.container, "mobile-onboarding");
  expect(stale.querySelector('[data-slot="status-mark"]')?.getAttribute("data-kind")).toBe("stale");
  expect(stale.querySelector('[data-part="status"]')?.textContent).toBe("Stale");
  // A failure before a finish, as the list has them.
  expect(namesIn(columnOf(screen.container, "ended"))).toEqual([
    "email-templates",
    "infra-terraform",
  ]);
});

test("an empty column keeps its head with a zero and says it is empty in one quiet line", async () => {
  const screen = await renderBoard([SESSIONS[3]!]);

  const expected = {
    "needs-you": "Nothing waiting",
    idle: "Nothing idle",
    ended: "Nothing finished or failed",
  };
  for (const [id, words] of Object.entries(expected)) {
    const column = columnOf(screen.container, id);
    expect(column.querySelector('[data-part="count"]')?.textContent).toBe("0");
    expect(column.querySelector("ul")).toBeNull();
    const line = column.querySelector('[data-part="empty"]') as HTMLElement;
    expect(line.textContent).toBe(words);
    expect(getComputedStyle(line).fontSize).toBe("12px");
    expect(getComputedStyle(line).color).toBe(rgbOf("var(--ink-muted)"));
  }
  expect(columnOf(screen.container, "working").querySelector('[data-part="empty"]')).toBeNull();
  await expect.element(screen.getByRole("list", { name: "Working 1" })).toBeVisible();
});

test("a card gives the name, the folder and its branch, the app, and its status and how long as one phrase", async () => {
  const screen = await renderBoard(SESSIONS);
  const card = cardOf(screen.container, "checkout-flow");

  expect(card.querySelector('[data-part="name"]')?.textContent).toBe("checkout-flow");
  const place = card.querySelector('[data-part="place"]') as HTMLElement;
  expect(place.querySelector('[data-part="project"]')?.textContent).toBe("storefront");
  expect(place.querySelector('[data-part="branch"]')?.textContent).toBe("checkout-flow");
  // Read as "storefront on branch checkout-flow".
  expect(place.textContent).toBe("storefront on branch checkout-flow");
  expect(card.querySelector('[data-part="app"]')?.textContent).toBe("VS Code");
  // With one tool found, no card names it.
  expect(card.querySelector('[data-part="agent"]')).toBeNull();
  expect(card.querySelector('[data-part="status"]')?.textContent).toBe("Needs you");
  const duration = card.querySelector('[data-part="duration"]') as HTMLElement;
  expect(duration.querySelector('[aria-hidden="true"]')?.textContent).toBe("4m");
  expect(duration.textContent).toContain("for 4 minutes");
  expect(getComputedStyle(duration).color).toBe(rgbOf("var(--ink)"));

  // An ending says how long ago, and is quiet.
  const done = cardOf(screen.container, "infra-terraform");
  expect(done.querySelector('[data-part="status"]')?.textContent).toBe("Finished");
  expect(done.querySelector('[data-part="duration"] [aria-hidden="true"]')?.textContent).toBe(
    "2h 00m ago",
  );
  const doneName = done.querySelector('[data-part="name"]') as HTMLElement;
  expect(getComputedStyle(doneName).color).toBe(rgbOf("var(--ink-secondary)"));
  // Each mark is drawn once, beside the name, and the word says the status.
  expect(card.querySelector('[data-slot="status-mark"]')?.getAttribute("aria-hidden")).toBe("true");
});

test("once two tools are found, a card names its own after the app", async () => {
  const sessions = [
    session(1, { name: "docs-site", status: "idle", agent: "my-agent", surface: "terminal" }),
  ];
  const screen = await render(
    <div style={{ width: 835 }}>
      <SessionsBoard sessions={sessions} now={NOW} agentOf={(s) => s.agent ?? "Claude Code"} />
    </div>,
  );
  const where = screen.container.querySelector('[data-part="where"]') as HTMLElement;

  expect(where.querySelector('[data-part="app"]')?.textContent).toBe("Terminal");
  expect(where.querySelector('[data-part="agent"]')?.textContent).toBe("my-agent");
  // Read as "Terminal, my-agent"; on screen a dot sets the two apart.
  expect(where.textContent).toBe("Terminal, ·my-agent");
});

test("a card leaves out an app that is not known, and the tool then stands alone", async () => {
  const sessions = [
    session(1, { name: "docs-site", status: "idle", agent: "my-agent", surface: "unknown" }),
    session(2, { name: "search-indexing", status: "working", surface: "unknown" }),
  ];
  const screen = await render(
    <div style={{ width: 835 }}>
      <SessionsBoard sessions={sessions} now={NOW} agentOf={(s) => s.agent ?? "Claude Code"} />
    </div>,
  );

  // With a tool to name, the line holds the tool alone, with no dot before it.
  const named = cardOf(screen.container, "docs-site");
  const where = named.querySelector('[data-part="where"]') as HTMLElement;
  expect(where.querySelector('[data-part="app"]')).toBeNull();
  expect(where.textContent).toBe("my-agent");
  expect(where.querySelector('[aria-hidden="true"]')).toBeNull();
  // The folder still says where it works.
  expect(named.querySelector('[data-part="place"]')?.textContent).toBe("demo");

  // With no tool to name either, there is no line at all.
  const alone = await render(
    <div style={{ width: 835 }}>
      <SessionsBoard sessions={[sessions[1]!]} now={NOW} />
    </div>,
  );
  const card = cardOf(alone.container, "search-indexing");
  expect(card.querySelector('[data-part="where"]')).toBeNull();
  expect(card.querySelector('[data-part="app"]')).toBeNull();

  for (const root of [screen.container, alone.container]) {
    expect(root.textContent).not.toContain("Unknown app");
    expect(root.textContent).not.toMatch(/unknown/i);
  }
});

test("a working session's card says how long its agent has been quiet, under its status", async () => {
  const quiet = session(1, {
    name: "billing-webhooks",
    status: "working",
    statusSince: NOW - 40 * MINUTE,
    lastWriteAt: NOW - 12 * MINUTE,
  });
  const screen = await renderBoard([quiet]);
  const card = cardOf(screen.container, "billing-webhooks");
  const line = card.querySelector('[data-part="quiet"]') as HTMLElement;

  expect(line.textContent).toBe("quiet for 12 minutesquiet for 12m");
  expect(line.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    card.querySelector('[data-part="status"]')!.getBoundingClientRect().bottom - 1,
  );
  expect(getComputedStyle(line).color).toBe(rgbOf("var(--ink-muted)"));
  expect(warmPaint(card)).toEqual([]);
});

test("a long name is cut on its card, and stays one hover or one Tab away", async () => {
  const long = "search-indexing-for-the-whole-catalogue-and-its-archives";
  const screen = await renderBoard([session(1, { name: long, status: "working" })]);
  const name = cardOf(screen.container, long).querySelector('[data-part="name"]') as HTMLElement;

  await expect.poll(() => name.getAttribute("data-cut")).toBe("true");
  expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
  expect(name.tabIndex).toBe(0);
  await userEvent.hover(name);
  await expect.element(screen.getByRole("tooltip")).toHaveTextContent(long);
  await pointAway();
});

test("a card has Jump where one exists: the quiet capsule, a link for VS Code and a button for tmux", async () => {
  const screen = await renderBoard(SESSIONS);

  const link = screen.getByRole("link", { name: "Jump to checkout-flow in VS Code" }).element();
  const button = screen
    .getByRole("button", { name: "Jump to billing-webhooks in tmux, work:2.1" })
    .element();
  expect(cardOf(screen.container, "checkout-flow").contains(link)).toBe(true);
  expect(cardOf(screen.container, "billing-webhooks").contains(button)).toBe(true);
  // Even for a session that needs the person: the solid Jump is the hero's alone.
  for (const jump of [link, button]) {
    expect(jump.getAttribute("data-variant")).toBe("quiet");
    expect(getComputedStyle(jump).backgroundColor).not.toBe(rgbOf("var(--status-needs-you)"));
  }
  // No way to reach it, no Jump.
  expect(cardOf(screen.container, "docs-site").querySelector('[data-part="jump"]')).toBeNull();
});

test("a card of a Claude Code session that is over has Resume at its right edge, which copies the command that resumes it", async () => {
  const written: string[] = [];
  const write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
    written.push(text);
  });
  onTestFinished(() => write.mockRestore());
  const screen = await renderBoard(SESSIONS);

  const holders = [...screen.container.querySelectorAll('[data-part="resume"]')].map(
    (button) =>
      button.closest('[data-slot="board-card"]')?.querySelector('[data-part="name"]')?.textContent,
  );
  expect(holders.sort()).toEqual(["email-templates", "infra-terraform"]);

  const card = cardOf(screen.container, "infra-terraform");
  const button = card.querySelector('[data-part="resume"]') as HTMLElement;
  expect(button.dataset.variant).toBe("quiet");
  // At the card's right edge, 14px in, as a Jump is.
  expect(
    Math.round(card.getBoundingClientRect().right - button.getBoundingClientRect().right),
  ).toBe(14);
  const before = location.hash;
  await userEvent.click(button);
  expect(written).toEqual([`cd '/Users/example/code/demo' && claude --resume ${uuid(7)}`]);
  expect(location.hash).toBe(before);
  expect(warmPaint(card)).toEqual([]);
  // A key pressed puts the page back in the keyboard's hands, so a test after
  // this one that focuses from script still shows the focus, and its tooltip.
  await userEvent.keyboard("{Shift}");
});

test.each([
  [1280, 835],
  [375, 279],
])(
  "at %ipx, when the clipboard is refused a card says so under its name and leaves the command to select by hand",
  async (viewport, width) => {
    await page.viewport(viewport, 900);
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValue(new DOMException("Write permission denied.", "NotAllowedError"));
    onTestFinished(() => write.mockRestore());
    // A key pressed after puts the page back in the keyboard's hands, as the tests after this
    // one that focus from script need, even when this one fails partway.
    onTestFinished(() => userEvent.keyboard("{Shift}"));
    const folder = "/Users/example/code/a-folder-with-a-rather-long-name/storefront";
    const sessions = SESSIONS.map((each) =>
      each.name === "infra-terraform" ? { ...each, cwd: folder } : each,
    );
    const screen = await renderBoard(sessions, width);
    if (viewport === 375) {
      // One column, as on a phone.
      const columns = [...screen.container.querySelectorAll('[data-slot="board-column"]')];
      expect(new Set(columns.map((column) => column.getBoundingClientRect().left)).size).toBe(1);
    }

    const card = cardOf(screen.container, "infra-terraform");
    const before = location.hash;
    await userEvent.click(card.querySelector('[data-part="resume"]') as HTMLElement);
    await expect.poll(() => card.querySelector('[data-part="resume-line"]')).not.toBeNull();
    const line = card.querySelector('[data-part="resume-line"]') as HTMLElement;
    const command = `cd '${folder}' && claude --resume ${uuid(7)}`;
    expect(line.textContent).toBe(`Not copied. Select the command to copy it: ${command}`);
    expect(line.querySelector('[data-part="resume-command"]')?.textContent).toBe(command);
    // Only on the card that was pressed.
    expect(screen.container.querySelectorAll('[data-part="resume-line"]')).toHaveLength(1);
    // Under the name, inside the card.
    const name = card.querySelector('[data-part="name"]') as HTMLElement;
    expect(line.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      name.getBoundingClientRect().bottom - 1,
    );
    expect(line.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      card.getBoundingClientRect().left,
    );
    expect(line.getBoundingClientRect().right).toBeLessThanOrEqual(
      card.getBoundingClientRect().right,
    );
    // Nothing runs past the card, the board or the page.
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    const board = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;
    expect(board.scrollWidth).toBeLessThanOrEqual(board.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

    // A click on the command selects it, and does not open the session's details.
    await userEvent.click(line.querySelector('[data-part="resume-command"]') as HTMLElement);
    expect(location.hash).toBe(before);
    expect(warmPaint(card)).toEqual([]);
  },
);

test("at the width the Overview gives the board at 1440, every Jump keeps to its card's right edge, under the status when a long wait leaves no room beside it", async () => {
  const waiting = session(1, {
    name: "checkout-flow",
    surface: "vscode",
    status: "needs-you",
    waitingReason: "permission",
    statusSince: NOW - 12 * MINUTE,
    links: { open: jumpLink(1) },
  });
  const screen = await renderBoard([waiting, SESSIONS[2]!]);
  await document.fonts.ready;
  const place = (name: string) => {
    const card = cardOf(screen.container, name).getBoundingClientRect();
    const jump = cardOf(screen.container, name)
      .querySelector('[data-part="jump"]')!
      .getBoundingClientRect();
    const phrase = cardOf(screen.container, name)
      .querySelector('[data-part="status"]')!
      .parentElement!.getBoundingClientRect();
    return {
      fromRight: card.right - jump.right,
      besidePhrase: Math.abs(jump.top + jump.height / 2 - (phrase.top + phrase.height / 2)) < 2,
      underPhrase: jump.top >= phrase.bottom,
    };
  };

  // "Needs you 12m" and Jump share a line, as "Working 34m" and its Jump do.
  expect(place("checkout-flow")).toEqual({ fromRight: 14, besidePhrase: true, underPhrase: false });
  expect(place("billing-webhooks")).toEqual({
    fromRight: 14,
    besidePhrase: true,
    underPhrase: false,
  });

  // An hour on, "Needs you 1h 05m" leaves no room, and Jump goes under it, still at the right.
  await screen.rerender(
    <section data-slot='section-card' className='glass-card' style={{ width: 835 }}>
      <SessionsBoard sessions={[waiting, SESSIONS[2]!]} now={NOW + 53 * MINUTE} />
    </section>,
  );
  expect(place("checkout-flow")).toEqual({ fromRight: 14, besidePhrase: false, underPhrase: true });
});

test("a folder and a long branch take two lines at most, with on kept beside its branch", async () => {
  const sessions = [
    session(1, {
      name: "mobile-onboarding",
      status: "working",
      cwd: "/Users/example/code/mobile-app-monorepo-packages",
      project: "mobile-app-monorepo-packages",
      git: { branch: "feature/mobile-onboarding-redesign-with-new-welcome-screens" },
    }),
    session(2, {
      name: "api-rate-limits",
      status: "working",
      cwd: "/Users/example/code/gateway-ui",
      project: "gateway-ui",
      git: { branch: "rate-limit-dashboard" },
    }),
  ];
  const screen = await renderBoard(sessions);
  await document.fonts.ready;

  for (const name of ["mobile-onboarding", "api-rate-limits"]) {
    const place = cardOf(screen.container, name).querySelector('[data-part="place"]')!;
    const git = place.querySelector('[data-part="git"]') as HTMLElement;
    const branch = git.querySelector('[data-part="branch"]')!.getBoundingClientRect();
    const on = document.createRange();
    on.selectNodeContents(git.firstChild!);
    const lineHeight = parseFloat(getComputedStyle(place).lineHeight);

    expect(on.toString()).toBe("on");
    // "on" starts the second line with its branch, which keeps to that line.
    const onBox = on.getBoundingClientRect();
    expect(onBox.top + onBox.height / 2).toBeGreaterThan(branch.top);
    expect(onBox.top + onBox.height / 2).toBeLessThan(branch.bottom);
    expect(branch.top).toBeGreaterThanOrEqual(
      place.querySelector('[data-part="project"]')!.getBoundingClientRect().bottom,
    );
    expect(git.getBoundingClientRect().height).toBeLessThanOrEqual(lineHeight + 0.5);
    expect(place.getBoundingClientRect().height).toBeLessThanOrEqual(2 * lineHeight + 0.5);
    expect(git.getBoundingClientRect().right).toBeLessThanOrEqual(
      place.getBoundingClientRect().right,
    );
  }
  // The long branch is cut, and stays one hover or one Tab away.
  const long = cardOf(screen.container, "mobile-onboarding").querySelector(
    '[data-part="branch"]',
  ) as HTMLElement;
  await expect.poll(() => long.getAttribute("data-cut")).toBe("true");
  expect(long.tabIndex).toBe(0);
  expect(
    cardOf(screen.container, "api-rate-limits")
      .querySelector('[data-part="branch"]')
      ?.getAttribute("data-cut"),
  ).toBe("false");
});

const STOREFRONT = { id: "9aaa5f0ab35a5f84", name: "storefront" };

/** A worktree of storefront, storefront's main folder, and a folder in no repository. */
const IN_WORKTREES: Session[] = [
  session(1, {
    name: "checkout-flow",
    status: "working",
    statusSince: NOW - 12 * MINUTE,
    cwd: "/Users/example/code/storefront-checkout",
    project: "storefront-checkout",
    git: { branch: "checkout-flow", repository: STOREFRONT },
  }),
  session(2, {
    name: "billing-webhooks",
    status: "idle",
    statusSince: NOW - 26 * MINUTE,
    cwd: "/Users/example/code/storefront",
    project: "storefront",
    git: { branch: "main", repository: STOREFRONT },
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
  "in the %s theme a worktree's card names its repository before its folder, in the folder's own ink and size, and the main folder's card does not",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    // One column of a board as wide as a phone's, where the whole line fits.
    const screen = await renderBoard(IN_WORKTREES, 283);
    await document.fonts.ready;
    const place = cardOf(screen.container, "checkout-flow").querySelector(
      '[data-part="place"]',
    ) as HTMLElement;
    const repository = place.querySelector('[data-part="repository"]') as HTMLElement;
    const folder = place.querySelector('[data-part="project"]') as HTMLElement;

    // Shown as "storefront · storefront-checkout on checkout-flow", and read
    // as "storefront, storefront-checkout on branch checkout-flow".
    expect(repository.textContent).toBe("storefront");
    expect(place.querySelector('[aria-hidden="true"]')?.textContent).toBe(" ·");
    expect(place.textContent).toBe("storefront ·, storefront-checkout on branch checkout-flow");
    expect(repository.getBoundingClientRect().right).toBeLessThan(
      folder.getBoundingClientRect().left,
    );
    expect(repository.getBoundingClientRect().top).toBe(folder.getBoundingClientRect().top);
    // No colour or size of its own: the folder's.
    for (const property of ["color", "fontSize", "fontWeight", "fontFamily", "lineHeight"]) {
      expect(getComputedStyle(repository).getPropertyValue(property), property).toBe(
        getComputedStyle(folder).getPropertyValue(property),
      );
    }
    expect(getComputedStyle(repository).color).toBe(rgbOf("var(--ink-secondary)"));
    // The folder's whole path is still one Tab away, and the repository's name, whole, is no stop.
    expect(folder.tabIndex).toBe(0);
    expect(repository.dataset.cut).toBe("false");
    expect(repository.hasAttribute("tabindex")).toBe(false);

    // The main folder is named for its repository already, and a folder in none has none.
    const main = cardOf(screen.container, "billing-webhooks").querySelector('[data-part="place"]')!;
    expect(main.querySelector('[data-part="repository"]')).toBeNull();
    expect(main.textContent).toBe("storefront on branch main");
    expect(
      cardOf(screen.container, "mobile-onboarding").querySelector('[data-part="place"]')
        ?.textContent,
    ).toBe("mobile-app");
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("in a narrow column the dot stays with the repository, the folder and the branch take a line each, and nothing runs past the card", async () => {
  const screen = await renderBoard(IN_WORKTREES);
  await document.fonts.ready;
  const card = cardOf(screen.container, "checkout-flow");
  const place = card.querySelector('[data-part="place"]') as HTMLElement;
  const repository = place.querySelector('[data-part="repository"]')!.getBoundingClientRect();
  const dot = place.querySelector('[aria-hidden="true"]')!.getBoundingClientRect();
  const folder = place.querySelector('[data-part="project"]')!.getBoundingClientRect();
  const branch = place.querySelector('[data-part="branch"]')!.getBoundingClientRect();
  const lineHeight = parseFloat(getComputedStyle(place).lineHeight);

  // The line ends with the dot: no line starts with one.
  expect(dot.top).toBe(repository.top);
  expect(dot.left).toBeGreaterThanOrEqual(repository.right - 0.5);
  expect(folder.top).toBeGreaterThanOrEqual(repository.bottom - 0.5);
  expect(branch.top).toBeGreaterThanOrEqual(folder.bottom - 0.5);
  expect(place.getBoundingClientRect().height).toBeLessThanOrEqual(3 * lineHeight + 0.5);
  for (const part of [repository, dot, folder, branch]) {
    expect(part.right).toBeLessThanOrEqual(place.getBoundingClientRect().right + 0.5);
  }
  expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
});

test("a repository's name too long for its card is cut, and stays one hover or one Tab away", async () => {
  const long = { id: "1c2d3e4f5a6b7c8d", name: `platform-${"services-".repeat(5)}api` };
  const sessions = [
    session(1, {
      name: "api-rate-limits",
      status: "working",
      cwd: "/Users/example/code/rate-limits",
      project: "rate-limits",
      git: { branch: "fix/rate-limits", repository: long },
    }),
  ];
  const screen = await renderBoard(sessions);
  const repository = screen.container.querySelector('[data-part="repository"]') as HTMLElement;

  await expect.poll(() => repository.getAttribute("data-cut")).toBe("true");
  expect(repository.tabIndex).toBe(0);
  repository.focus();
  await expect.element(page.getByRole("tooltip")).toHaveTextContent(long.name);
  const place = repository.closest('[data-part="place"]') as HTMLElement;
  expect(repository.getBoundingClientRect().right).toBeLessThanOrEqual(
    place.getBoundingClientRect().right + 0.5,
  );
});

test.each([
  ["the pane is selected", 200, { ok: true, kind: "tmux", place: "work:2.1" }, "Selected in tmux"],
  ["the pane has gone", 409, { error: "x", reason: "pane-gone" }, "That pane has closed"],
])(
  "pressing a card's tmux Jump asks for that session, and when %s the card says so by its name",
  async (_what, status, body, words) => {
    const sent: { path: string; body: unknown }[] = [];
    setApiHost(async (path, init) => {
      sent.push({ path, body: init?.body });
      return new Response(JSON.stringify(body), { status });
    });
    const screen = await renderBoard(SESSIONS);
    const card = cardOf(screen.container, "billing-webhooks");

    await screen.getByRole("button", { name: /^Jump to billing-webhooks/ }).click();
    await expect.element(screen.getByRole("status")).toHaveTextContent(words);

    expect(sent).toEqual([
      { path: "/api/jump", body: JSON.stringify({ sessionId: SESSIONS[2]!.id }) },
    ]);
    const note = card.querySelector('[data-part="jump-note"]') as HTMLElement;
    expect(note.textContent).toBe(words);
    expect(screen.container.querySelectorAll('[data-part="jump-note"]')).toHaveLength(1);
    // Inside its card, and the name keeps every letter.
    const cardBox = card.getBoundingClientRect();
    expect(note.getBoundingClientRect().right).toBeLessThanOrEqual(cardBox.right);
    expect(card.querySelector('[data-part="name"]')?.getAttribute("data-cut")).toBe("false");
    expect(warmPaint(card)).toEqual([]);
  },
);

test("a card's Jump to a Terminal tab says, while macOS asks, that it will ask once, in a line of the card's own", async () => {
  localStorage.removeItem(AUTOMATION_NOTE_STORAGE_KEY);
  let answer: (response: Response) => void = () => {};
  setApiHost(() => new Promise<Response>((resolve) => (answer = resolve)));
  const inTerminal = session(1, {
    name: "billing-webhooks",
    status: "working",
    pid: 4243,
    alive: true,
    jump: { kind: "terminal", app: "Terminal", place: "Terminal" },
  });
  const screen = await renderBoard([inTerminal], 300);
  const card = cardOf(screen.container, "billing-webhooks");

  await screen.getByRole("button", { name: "Jump to billing-webhooks in Terminal" }).click();
  await expect
    .poll(() => card.querySelector('[data-part="jump-line"]'), { timeout: 2_500 })
    .not.toBeNull();
  const line = card.querySelector('[data-part="jump-line"]') as HTMLElement;
  expect(line.textContent).toMatch(/^macOS will ask once/);
  // The line wraps inside the card, which grows for it, and runs off no side.
  expect(line.getBoundingClientRect().right).toBeLessThanOrEqual(
    card.getBoundingClientRect().right,
  );
  expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
  answer(new Response(JSON.stringify({ ok: true, kind: "terminal", app: "Terminal" })));
  await expect.element(screen.getByRole("status")).toHaveTextContent("Switched to Terminal");
  localStorage.removeItem(AUTOMATION_NOTE_STORAGE_KEY);
});

test("Tab goes through the cards column by column, top to bottom, each card's name, its folder and then its Jump or its Resume", async () => {
  const screen = await renderBoard(SESSIONS);
  startAtTop();

  const stops: string[] = [];
  for (let i = 0; i < 24; i++) {
    await userEvent.tab();
    const active = document.activeElement as HTMLElement;
    const card = active.closest('[data-slot="board-card"]');
    if (!card || !screen.container.contains(active)) break;
    stops.push(
      `${card.querySelector('[data-part="name"]')?.textContent} ${active.getAttribute("data-part")}`,
    );
  }

  expect(stops).toEqual([
    "checkout-flow name",
    "checkout-flow project",
    "checkout-flow jump",
    "api-rate-limits name",
    "api-rate-limits project",
    "search-indexing name",
    "search-indexing project",
    "billing-webhooks name",
    "billing-webhooks project",
    "billing-webhooks jump",
    "docs-site name",
    "docs-site project",
    "mobile-onboarding name",
    "mobile-onboarding project",
    "email-templates name",
    "email-templates project",
    "email-templates resume",
    "infra-terraform name",
    "infra-terraform project",
    "infra-terraform resume",
  ]);
  await pointAway();
});

test("cards cannot be dragged, and nothing about them looks as if they could", async () => {
  const screen = await renderBoard(SESSIONS);
  const cards = [...screen.container.querySelectorAll<HTMLElement>('[data-slot="board-card"]')];

  expect(cards).toHaveLength(8);
  for (const card of cards) {
    expect(card.draggable).toBe(false);
    expect(card.getAttribute("aria-grabbed")).toBeNull();
    expect(card.getAttribute("aria-roledescription")).toBeNull();
    for (const element of [card, ...card.querySelectorAll("*")]) {
      expect(["grab", "grabbing", "move"]).not.toContain(getComputedStyle(element).cursor);
    }
  }
  // No handle, and nothing listens for a drop.
  expect(screen.container.querySelector('[data-part="handle"], [draggable="true"]')).toBeNull();
  const start = new DragEvent("dragstart", { bubbles: true, cancelable: true });
  cards[0]!.querySelector('[data-part="name"]')!.dispatchEvent(start);
  expect(namesIn(columnOf(screen.container, "needs-you"))[0]).toBe("checkout-flow");
});

test("a card is an inner surface of the card's glass: a faint fill in a hairline on 14px corners, with no shadow of its own", async () => {
  const screen = await renderBoard(SESSIONS);
  const card = cardOf(screen.container, "docs-site");
  const style = getComputedStyle(card);
  const panel = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;

  expect(style.borderTopLeftRadius).toBe("14px");
  expect(style.backgroundColor).toBe(rgbOf("var(--fill-zebra)"));
  // The rim is the hairline, drawn inside. Nothing drops a shadow.
  // Tailwind lays a transparent shadow for each layer not used; those draw nothing.
  const drawn = style.boxShadow
    .split(/,(?![^(]*\))/)
    .map((shadow) => shadow.trim())
    .filter((shadow) => !shadow.startsWith("rgba(0, 0, 0, 0)"));
  expect(drawn).toEqual([`${rgbOf("var(--hairline)")} 0px 0px 0px 1px inset`]);
  // 10px inside the panel, so its corners are concentric with the panel's.
  const first = cardOf(screen.container, "checkout-flow").getBoundingClientRect();
  expect(first.left - panel.getBoundingClientRect().left).toBe(10);
  // Its words start 24px in, level with the panel's head and the column's.
  const mark = cardOf(screen.container, "checkout-flow").querySelector(
    '[data-slot="status-mark"]',
  )!;
  expect(mark.getBoundingClientRect().left - panel.getBoundingClientRect().left).toBe(24);
  const head = columnOf(screen.container, "needs-you").querySelector("h3 span") as HTMLElement;
  expect(head.getBoundingClientRect().left - panel.getBoundingClientRect().left).toBe(24);
});

test.each([
  [835, 4],
  [888, 4],
  [733, 2],
  [500, 2],
  [283, 1],
])(
  "in a card %i pixels wide the columns stand %i across, and nothing runs off the side",
  async (width, across) => {
    const screen = await renderBoard(SESSIONS, width);
    const columns = [
      ...screen.container.querySelectorAll<HTMLElement>('[data-slot="board-column"]'),
    ];
    const tops = new Set(columns.map((column) => Math.round(column.getBoundingClientRect().top)));
    const lefts = new Set(columns.map((column) => Math.round(column.getBoundingClientRect().left)));

    expect(lefts.size).toBe(across);
    expect(tops.size).toBe(4 / across);
    // Read in order: across, then down.
    const order = [...columns].sort(
      (a, b) =>
        a.getBoundingClientRect().top - b.getBoundingClientRect().top ||
        a.getBoundingClientRect().left - b.getBoundingClientRect().left,
    );
    expect(order).toEqual(columns);
    const panel = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
    for (const card of screen.container.querySelectorAll<HTMLElement>('[data-slot="board-card"]')) {
      expect(card.scrollWidth, card.textContent ?? "").toBeLessThanOrEqual(card.clientWidth);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
);

test("a column holds five cards and says how many more there are, which the list shows", async () => {
  const idle = Array.from({ length: 8 }, (_, i) =>
    session(10 + i, { name: `docs-site-${i + 1}`, status: "idle", statusSince: NOW - i * MINUTE }),
  );
  const screen = await renderBoard([...idle, SESSIONS[3]!]);
  const column = columnOf(screen.container, "idle");

  // The most recent changes are the ones shown.
  expect(namesIn(column)).toEqual([
    "docs-site-1",
    "docs-site-2",
    "docs-site-3",
    "docs-site-4",
    "docs-site-5",
  ]);
  expect(column.querySelector('[data-part="count"]')?.textContent).toBe("8");
  expect(column.querySelector('[data-part="more"]')?.textContent).toBe("and 3 more in the list");
  // Nothing scrolls inside the column.
  for (const element of [column, ...column.querySelectorAll<HTMLElement>("*")]) {
    expect(getComputedStyle(element).overflowY).not.toMatch(/auto|scroll/);
  }
  expect(columnOf(screen.container, "working").querySelector('[data-part="more"]')).toBeNull();
});

test("a session whose status is not known has no card, and a line under the board says the list shows it", async () => {
  const odd = session(9, { name: "search-indexing", status: "unknown" });
  const screen = await renderBoard([SESSIONS[5]!, odd]);

  expect(screen.container.textContent).not.toContain("search-indexing");
  expect(screen.container.querySelector('[data-part="unknown"]')?.textContent).toBe(
    "The status of 1 session is not known. The list shows it.",
  );
  await screen.rerender(
    <section data-slot='section-card' className='glass-card' style={{ width: 835 }}>
      <SessionsBoard sessions={[odd, { ...odd, id: "claude-code:other" }]} now={NOW} />
    </section>,
  );
  expect(screen.container.querySelector('[data-part="unknown"]')?.textContent).toBe(
    "The status of 2 sessions is not known. The list shows them.",
  );
});

test.each(["dark", "light"] as const)(
  "in the %s theme the only warm colour on the board is the needs-you mark",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await renderBoard(SESSIONS);
    const board = screen.container.querySelector('[data-slot="session-board"]') as HTMLElement;

    expect(warmBeyondTheLamp(board).map((element) => element.outerHTML.slice(0, 80))).toEqual([]);
    const lit = warmElements(board).map(
      (element) =>
        element.closest('[data-slot="board-card"]')?.querySelector('[data-part="name"]')
          ?.textContent,
    );
    expect(new Set(lit)).toEqual(new Set(["checkout-flow", "api-rate-limits"]));
    // The needs-you column is not warm itself: no background, no rim, no border.
    const column = columnOf(screen.container, "needs-you");
    for (const element of [
      column,
      ...column.querySelectorAll('h3, ul, [data-slot="board-card"]'),
    ]) {
      const style = getComputedStyle(element);
      const paint = [
        style.backgroundColor,
        style.backgroundImage,
        style.boxShadow,
        style.borderColor,
      ];
      expect(paint.flatMap(coloursIn).filter(isWarm)).toEqual([]);
    }
    // A card under the pointer brings its Jump up, quietly.
    const card = cardOf(screen.container, "billing-webhooks");
    await userEvent.hover(card);
    const jump = card.querySelector('[data-part="jump"]') as HTMLElement;
    await expect
      .poll(() => getComputedStyle(jump).backgroundColor)
      .toBe(rgbOf("var(--fill-selected)"));
    expect(warmPaint(card)).toEqual([]);
    await pointAway();
  },
);
