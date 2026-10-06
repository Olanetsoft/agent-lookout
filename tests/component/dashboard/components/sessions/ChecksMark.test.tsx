import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { PullRequest, Session, SourceHealth } from "@core/sessions/session";
import { SessionsCard } from "@dashboard/components/sessions/SessionsCard";
import { SESSIONS_LAYOUT_STORAGE_KEY } from "@dashboard/lib/shell/sessionsLayout";
import { makeSession } from "@tests/fixtures/session";
import { pointAway } from "@tests/support/browser/browser";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";

const NOW = 1_700_000_600_000;
const MINUTE = 60_000;

const SOURCE: SourceHealth = {
  id: "claude-code",
  label: "Claude Code",
  state: "ok",
  checkedAt: NOW,
};
const REPOSITORY = { id: "9aaa5f0ab35a5f84", name: "storefront" };

function pullRequest(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number,
    title: `Pull request ${number}`,
    state: "open",
    checks: { state: "failing", passing: 4, failing: 2, pending: 0 },
    url: `https://github.com/example-org/storefront/pull/${number}`,
    ...overrides,
  };
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A session in a worktree of storefront, on a branch with the pull request given. */
function on(
  n: number,
  name: string,
  branch: string,
  overrides: Partial<Session> = {},
  pr?: PullRequest,
) {
  return makeSession({
    id: `claude-code:${uuid(n)}`,
    name,
    status: "working",
    statusSince: NOW - 12 * MINUTE,
    cwd: `/Users/example/code/storefront-${name}`,
    project: `storefront-${name}`,
    git: { branch, repository: REPOSITORY, ...(pr && { pullRequest: pr }) },
    ...overrides,
  });
}

/**
 * Two branches whose pull requests have a check failing, one open and one a
 * draft, and three that are marked with nothing: checks passing, a pull
 * request merged with a check failing, and no pull request at all.
 */
const SESSIONS: Session[] = [
  on(1, "checkout-flow", "checkout-flow", {}, pullRequest(51)),
  on(
    2,
    "search-indexing",
    "search-indexing",
    { status: "idle" },
    pullRequest(52, {
      checks: { state: "passing", passing: 6, failing: 0, pending: 0 },
    }),
  ),
  on(3, "release-notes", "release-notes", {}, pullRequest(49, { state: "merged" })),
  on(
    4,
    "board-layout",
    "board-layout",
    { status: "idle" },
    pullRequest(53, {
      state: "draft",
      checks: { state: "failing", passing: 0, failing: 1, pending: 2 },
    }),
  ),
  on(5, "docs-site", "docs-site"),
];

/** The marks drawn, by the session they are on, in the order drawn. */
function marked(container: HTMLElement, holder: string): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-part="checks"]')]
    .filter((mark) => mark.checkVisibility())
    .map((mark) => mark.closest(holder)?.querySelector('[data-part="name"]')?.textContent ?? "");
}

beforeEach(async () => {
  await page.viewport(1280, 900);
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  localStorage.removeItem(SESSIONS_LAYOUT_STORAGE_KEY);
});

test.each(["dark", "light"] as const)(
  "in the %s theme at 1280 pixels, the list marks a branch whose open pull request, or draft, has a check failing, and nothing else",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(<SessionsCard sessions={SESSIONS} sources={[SOURCE]} now={NOW} />);
    await expect.element(screen.getByText("checkout-flow", { exact: true }).first()).toBeVisible();
    await pointAway();

    expect(marked(screen.container, '[data-slot="session-row"]').sort()).toEqual([
      "board-layout",
      "checkout-flow",
    ]);

    const mark = screen.container.querySelector<HTMLElement>(
      '[data-slot="session-row"] [data-part="checks"]',
    ) as HTMLElement;
    const git = mark.closest('[data-part="git"]') as HTMLElement;
    const branch = git.querySelector('[data-part="branch"]') as HTMLElement;
    // After the branch, on its line, a small cross in a failed session's colour beside its muted words.
    expect(mark.previousElementSibling).toBe(branch);
    const svg = mark.querySelector("svg") as SVGElement;
    expect(svg.getBoundingClientRect().width).toBe(12);
    expect(svg.getBoundingClientRect().height).toBe(12);
    expect(mark.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      branch.getBoundingClientRect().right,
    );
    expect(mark.getBoundingClientRect().right).toBeLessThanOrEqual(
      (git.closest("td") as HTMLElement).getBoundingClientRect().right,
    );
    expect(
      Math.abs(
        mark.getBoundingClientRect().top +
          mark.getBoundingClientRect().height / 2 -
          (branch.getBoundingClientRect().top + branch.getBoundingClientRect().height / 2),
      ),
    ).toBeLessThanOrEqual(1);
    // The colour of a failed session's own cross, so it never outranks the row's status.
    expect(getComputedStyle(mark).color).toBe(rgbOf("var(--status-finished)"));
    expect(getComputedStyle(branch).color).toBe(rgbOf("var(--ink-muted)"));
    // Read with the branch: which pull request, and how its checks stand.
    expect(git.textContent).toBe(
      "on branch checkout-flow, pull request #51: 2 checks failing, 4 passing",
    );
    // Nothing of it is warm: a failing check is not a session waiting on the person.
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("the mark is a Tab stop whose tooltip says which pull request and how its checks stand, and a click on it opens no details", async () => {
  const screen = await render(<SessionsCard sessions={SESSIONS} sources={[SOURCE]} now={NOW} />);
  const mark = screen.container.querySelector<HTMLElement>(
    '[data-slot="session-row"] [data-part="checks"]',
  ) as HTMLElement;
  await expect.element(mark).toBeVisible();

  mark.focus({ focusVisible: true } as FocusOptions);
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await userEvent.tab();
  expect(document.activeElement).toBe(mark);
  await expect
    .element(page.getByRole("tooltip"))
    .toHaveTextContent("Pull request #51: 2 checks failing, 4 passing");

  const before = window.location.hash;
  await userEvent.click(mark);
  expect(window.location.hash).toBe(before);
  await pointAway();
});

test.each([1280, 375])(
  "at %i pixels the board marks the same branches, on the card, and nothing runs off its side",
  async (width) => {
    await page.viewport(width, 900);
    localStorage.setItem(SESSIONS_LAYOUT_STORAGE_KEY, "board");
    const screen = await render(<SessionsCard sessions={SESSIONS} sources={[SOURCE]} now={NOW} />);
    const board = screen.container.querySelector('[data-slot="session-board"]') as HTMLElement;
    await vi.waitFor(() =>
      expect(board.querySelectorAll('[data-slot="board-card"]')).toHaveLength(5),
    );

    expect(marked(screen.container, '[data-slot="board-card"]').sort()).toEqual([
      "board-layout",
      "checkout-flow",
    ]);
    for (const mark of board.querySelectorAll<HTMLElement>('[data-part="checks"]')) {
      const card = mark.closest('[data-slot="board-card"]') as HTMLElement;
      const place = mark.closest('[data-part="place"]') as HTMLElement;
      expect(place).not.toBeNull();
      expect(mark.getBoundingClientRect().right).toBeLessThanOrEqual(
        card.getBoundingClientRect().right,
      );
      expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("at 375 pixels the list leaves the Folder column out, and the branch and its mark go with it", async () => {
  await page.viewport(375, 900);
  const screen = await render(<SessionsCard sessions={SESSIONS} sources={[SOURCE]} now={NOW} />);
  await expect.element(screen.getByText("checkout-flow", { exact: true }).first()).toBeVisible();
  expect(marked(screen.container, '[data-slot="session-row"]')).toEqual([]);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});
