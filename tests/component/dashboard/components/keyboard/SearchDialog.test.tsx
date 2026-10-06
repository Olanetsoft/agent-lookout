import { useState } from "react";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { Session, SourceHealth } from "@core/sessions/session";
import { SearchDialog } from "@dashboard/components/keyboard/SearchDialog";
import { Button } from "@dashboard/components/ui/controls/Button";
import type { CollectorState } from "@dashboard/lib/api/collectorStore";
import { makeSession } from "@tests/fixtures/session";
import { pointAway, startAtTop } from "@tests/support/browser/browser";
import { rgbOf, warmElements } from "@tests/support/browser/colours";

const NOW = Date.UTC(2026, 9, 5, 14, 30);
const MINUTE = 60_000;

function session(n: number, overrides: Partial<Session>): Session {
  return makeSession({
    id: `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    ...overrides,
  });
}

const SOURCES: SourceHealth[] = [
  { id: "claude-code", label: "Claude Code", state: "ok", watching: [], checkedAt: NOW },
  { id: "codex", label: "Codex", state: "ok", watching: [], checkedAt: NOW },
  { id: "status-files", label: "Status files", state: "ok", watching: [], checkedAt: NOW },
];

/** Six sessions, given out of order: two waiting, two working, one idle, one finished. */
const SESSIONS: Session[] = [
  session(5, {
    name: "docs-site",
    status: "idle",
    surface: "vscode",
    statusSince: NOW - 62 * MINUTE,
    cwd: "/Users/example/code/docs",
    project: "docs",
    git: { branch: "main" },
    links: {
      open: "vscode://anthropic.claude-code/open?session=00000000-0000-4000-8000-000000000005",
    },
  }),
  session(1, {
    name: "checkout-flow",
    status: "needs-you",
    waitingReason: "permission",
    statusSince: NOW - 4 * MINUTE,
    cwd: "/Users/example/code/storefront",
    project: "storefront",
    git: { branch: "checkout-flow" },
    pid: 4242,
    alive: true,
    jump: { kind: "tmux", place: "work:2.1" },
  }),
  session(4, {
    name: "billing-webhooks",
    source: "status-files",
    agent: "night-shift",
    surface: "unknown",
    status: "working",
    statusSince: NOW - 12 * MINUTE,
    cwd: "/Users/example/code/payments",
    project: "payments",
    git: { branch: "billing-webhooks" },
  }),
  session(6, {
    name: "mobile-onboarding",
    status: "finished",
    statusSince: NOW - 121 * MINUTE,
    cwd: "/Users/example/code/mobile",
    project: "mobile",
  }),
  session(3, {
    id: "codex:00000000-0000-4000-8000-000000000003",
    source: "codex",
    name: "api-rate-limits",
    status: "working",
    statusSince: NOW - 3 * MINUTE,
    cwd: "/Users/example/code/gateway",
    project: "gateway",
    git: { branch: "api-rate-limits" },
  }),
  session(2, {
    name: "search-indexing",
    status: "needs-you",
    waitingReason: "question",
    statusSince: NOW - 9 * MINUTE,
    cwd: "/Users/example/code/search",
    project: "search",
    git: { commit: "3f9a2c1" },
  }),
];

/** The order the page lists them in. */
const ORDER = [
  "search-indexing",
  "checkout-flow",
  "api-rate-limits",
  "billing-webhooks",
  "docs-site",
  "mobile-onboarding",
];

function stateWith(sessions: Session[] | null, overrides: Partial<CollectorState> = {}) {
  return {
    phase: "live",
    snapshot: sessions === null ? null : { generatedAt: NOW, sessions, sources: SOURCES },
    events: [],
    history: null,
    lastOkAt: NOW,
    problem: null,
    problemKind: null,
    ...overrides,
  } satisfies CollectorState;
}

interface HarnessProps {
  state?: CollectorState;
  onChoose?: (session: Session) => void;
  onShortcuts?: () => void;
}

/** A page with a button that opens the search, as the header's does. */
function Harness({
  state = stateWith(SESSIONS),
  onChoose = () => {},
  onShortcuts = () => {},
}: HarnessProps) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ padding: 40 }}>
      <Button onClick={() => setOpen(true)}>Open search</Button>
      <SearchDialog
        open={open}
        onOpenChange={setOpen}
        state={state}
        now={NOW}
        onChoose={onChoose}
        onShortcuts={onShortcuts}
      />
    </div>
  );
}

const dialog = () => page.getByRole("dialog", { name: "Find a session" });
const field = () => page.getByRole("combobox", { name: "Find a session" });
const field_ = () => field().element() as HTMLInputElement;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const namesShown = () =>
  options().map((option) => option.querySelector('[data-part="name"]')?.textContent);
const lit = () => document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
const litName = () => lit()?.querySelector('[data-part="name"]')?.textContent;
const part = (root: Element, name: string) =>
  root.querySelector<HTMLElement>(`[data-part="${name}"]`)!;

/** Renders the page and opens the search from its button, by the keyboard. */
async function openSearch(props: HarnessProps = {}) {
  const screen = await render(<Harness {...props} />);
  startAtTop();
  await userEvent.tab();
  await userEvent.keyboard("{Enter}");
  await expect.element(dialog()).toBeVisible();
  return screen;
}

beforeEach(async () => {
  await page.viewport(1280, 900);
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

test.each([
  ["dark", 1440],
  ["dark", 375],
  ["light", 1440],
  ["light", 375],
] as const)(
  "in the %s theme at %i pixels the search is floating glass over the scrim, and nothing in it is warm but the marks of the sessions that need you",
  async (theme, width) => {
    onTestFinished(() => page.viewport(1280, 900));
    await page.viewport(width, 900);
    document.documentElement.setAttribute("data-theme", theme);
    await openSearch();
    await pointAway();
    const element = dialog().element() as HTMLElement;
    const style = getComputedStyle(element);

    expect(element.getAttribute("data-slot")).toBe("search-dialog");
    expect(style.backgroundColor).toBe(rgbOf("var(--glass-float)"));
    expect(style.backdropFilter).toMatch(/^blur\(30px\) saturate\(/);
    expect(style.borderRadius).toBe("24px");
    const scrim = document.querySelector('[data-slot="scrim"]') as HTMLElement;
    expect(getComputedStyle(scrim).backgroundColor).toBe(rgbOf("var(--scrim)"));

    // 600px wide and centred, or the window less a 16px side at the width of a phone.
    const box = element.getBoundingClientRect();
    expect(box.width).toBe(width === 375 ? 343 : 600);
    expect(box.left).toBeCloseTo(width - box.right, 0);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    for (const inside of element.querySelectorAll("*")) {
      expect(
        inside.getBoundingClientRect().right,
        inside.outerHTML.slice(0, 60),
      ).toBeLessThanOrEqual(box.right);
    }

    // The two sessions that need the person carry the lamp's mark, and nothing else is warm:
    // not their status, not their time, not the lit row.
    const warm = warmElements(element);
    expect(warm.length).toBeGreaterThan(0);
    for (const paint of warm) {
      expect(
        paint.closest('[data-slot="status-mark"][data-kind="needs-you"]'),
        paint.outerHTML,
      ).not.toBeNull();
    }
    const marks = element.querySelectorAll('[data-slot="status-mark"][data-kind="needs-you"]');
    expect(marks).toHaveLength(2);
    for (const mark of marks) expect(mark.getAttribute("data-breathing")).toBeNull();

    // The lit row is the selected fill, and nothing on it is in the muted ink, which
    // falls short of its contrast there.
    const row = lit()!;
    expect(getComputedStyle(row).backgroundColor).toBe(rgbOf("var(--fill-selected)"));
    expect(getComputedStyle(row).borderRadius).toBe("14px");
    for (const words of row.querySelectorAll("span, p")) {
      expect(getComputedStyle(words).color, words.textContent ?? "").not.toBe(
        rgbOf("var(--ink-muted)"),
      );
    }
    // Names in ink at 600, the status and the place in the secondary ink, the times in ink.
    expect(getComputedStyle(part(row, "name")).fontWeight).toBe("600");
    expect(getComputedStyle(part(row, "name")).color).toBe(rgbOf("var(--ink)"));
    expect(getComputedStyle(part(row, "status")).color).toBe(rgbOf("var(--ink-secondary)"));
    expect(getComputedStyle(part(row, "duration")).color).toBe(rgbOf("var(--ink)"));
    expect(getComputedStyle(part(row, "place")).color).toBe(rgbOf("var(--ink-secondary)"));
    expect(getComputedStyle(part(row, "duration")).fontVariantNumeric).toBe("tabular-nums");
  },
);

test("the field is a combobox that controls a list of sessions, and names the lit one to assistive technology", async () => {
  await openSearch();

  await expect.element(field()).toHaveFocus();
  const input = field_();
  expect(input.getAttribute("aria-expanded")).toBe("true");
  expect(input.getAttribute("aria-autocomplete")).toBe("list");
  expect(input.placeholder).toBe("Name, folder, branch or agent");
  const list = page.getByRole("listbox", { name: "Sessions" }).element();
  expect(input.getAttribute("aria-controls")).toBe(list.id);
  expect(options().every((option) => list.contains(option))).toBe(true);
  // The first option is lit, and the field says so.
  expect(input.getAttribute("aria-activedescendant")).toBe(options()[0]!.id);
  expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
  expect(
    options()
      .slice(1)
      .map((option) => option.getAttribute("aria-selected")),
  ).toEqual(Array(5).fill("false"));
  // How many it found is said once it changes.
  const count = page.getByRole("status").element();
  expect(count.textContent).toBe("6 sessions");

  // Each option is named in full: what it is, how long, where, whose, and where its Jump goes.
  await expect
    .element(
      page.getByRole("option", {
        name: "checkout-flow, Needs you for 4 minutes, storefront on branch checkout-flow, Claude Code, Jump to tmux, work:2.1",
      }),
    )
    .toBeInTheDocument();
  await expect
    .element(
      page.getByRole("option", {
        name: "search-indexing, Needs you for 9 minutes, search at commit 3f9a2c1, Claude Code",
      }),
    )
    .toBeInTheDocument();
  await expect
    .element(
      page.getByRole("option", {
        name: "docs-site, Idle for 1 hour 2 minutes, docs on branch main, Claude Code, Jump to VS Code",
      }),
    )
    .toBeInTheDocument();
  await expect
    .element(
      page.getByRole("option", {
        name: "mobile-onboarding, Finished 2 hours 1 minute ago, mobile, Claude Code",
      }),
    )
    .toBeInTheDocument();
  await expect
    .element(
      page.getByRole("option", {
        name: /^billing-webhooks, Working for 12 minutes, payments on branch billing-webhooks, night-shift$/,
      }),
    )
    .toBeInTheDocument();
});

test("an empty search lists every session, those that need you first, longest wait first, then in the Sessions list's order, each with its status, time, folder, branch and agent", async () => {
  await openSearch();

  expect(namesShown()).toEqual(ORDER);
  const shown = options().map((option) => [
    part(option, "status").textContent,
    part(option, "place").textContent,
    option.querySelector('[data-slot="status-mark"]')?.getAttribute("data-kind"),
  ]);
  expect(shown).toEqual([
    ["Needs you 9m", "search at 3f9a2c1·Claude Code", "needs-you"],
    ["Needs you 4m", "storefront on checkout-flow·Claude Code", "needs-you"],
    ["Working 3m", "gateway on api-rate-limits·Codex", "working"],
    ["Working 12m", "payments on billing-webhooks·night-shift", "working"],
    ["Idle 1h 02m", "docs on main·Claude Code", "idle"],
    ["Finished 2h 01m ago", "mobile·Claude Code", "finished"],
  ]);
  // A commit is read character by character, in the mono.
  const commit = part(options()[0]!, "commit");
  expect(getComputedStyle(commit).fontFamily).toMatch(/^"?Atkinson Hyperlegible Mono/);
  // An ended session is quiet, as its row is.
  const ended = options()[5]!;
  expect(getComputedStyle(part(ended, "name")).color).toBe(rgbOf("var(--ink-secondary)"));
  expect(getComputedStyle(part(ended, "name")).fontWeight).toBe("500");
});

test("typing narrows the list to sessions with every word somewhere in the name, folder, branch or agent, and says how many", async () => {
  const onChoose = vi.fn();
  await openSearch({ onChoose });
  const count = () => page.getByRole("status").element().textContent;

  const activeIs = () => field_().getAttribute("aria-activedescendant");
  const first = activeIs();

  await userEvent.keyboard("claude");
  expect(namesShown()).toEqual([
    "search-indexing",
    "checkout-flow",
    "docs-site",
    "mobile-onboarding",
  ]);
  await expect.poll(count).toBe("4 sessions");
  // The same session is lit, so the field names the same option.
  expect(activeIs()).toBe(first);

  await userEvent.keyboard(" STORE");
  expect(namesShown()).toEqual(["checkout-flow"]);
  await expect.poll(count).toBe("1 session");
  // The first one found is lit. It is first, as the last one was, and the field names the new one.
  expect(litName()).toBe("checkout-flow");
  expect(activeIs()).not.toBe(first);
  expect(activeIs()).toBe(lit()!.id);

  await userEvent.clear(field());
  await userEvent.keyboard("night billing");
  expect(namesShown()).toEqual(["billing-webhooks"]);

  await userEvent.clear(field());
  await userEvent.keyboard("3f9a");
  expect(namesShown()).toEqual(["search-indexing"]);

  // Nothing found: said plainly, nothing lit, and Enter does nothing.
  await userEvent.keyboard(" zzz");
  expect(options()).toEqual([]);
  expect(part(dialog().element(), "empty").textContent).toBe("No session matches “3f9a zzz”.");
  await expect.poll(count).toBe("No session matches “3f9a zzz”.");
  expect(field_().hasAttribute("aria-activedescendant")).toBe(false);
  expect(part(dialog().element(), "enter").textContent).toBe("");
  await userEvent.keyboard("{Enter}");
  await expect.element(dialog()).toBeVisible();
  expect(onChoose).not.toHaveBeenCalled();
});

test("a session whose app is not known is shown and named with nothing said of the app, and is not found by it", async () => {
  const sessions = [
    ...SESSIONS,
    session(7, {
      name: "infra-terraform",
      source: "status-files",
      agent: "night-shift",
      surface: "unknown",
      status: "idle",
      statusSince: NOW - 5 * MINUTE,
      cwd: null,
      project: null,
    }),
  ];
  await openSearch({ state: stateWith(sessions) });
  const optionOf = (name: string) =>
    options().find((option) => part(option, "name").textContent === name)!;

  // With a folder: the folder, its branch and the agent, and no app.
  const billing = optionOf("billing-webhooks");
  expect(part(billing, "place").textContent).toBe("payments on billing-webhooks·night-shift");
  expect(billing.querySelector('[data-part="app"]')).toBeNull();
  // With no folder: the agent alone.
  const infra = optionOf("infra-terraform");
  expect(part(infra, "place").textContent).toBe("night-shift");
  await expect
    .element(
      page.getByRole("option", {
        name: /^infra-terraform, Idle for 5 minutes, night-shift$/,
      }),
    )
    .toBeInTheDocument();
  for (const option of options()) {
    expect(`${option.textContent} ${option.getAttribute("aria-label")}`).not.toMatch(/unknown/i);
  }

  // Words the page does not show find nothing.
  await userEvent.keyboard("unknown");
  expect(options()).toEqual([]);
});

test("Up and Down move the lit session, round from the last to the first and from the first to the last, and the pointer lights one too", async () => {
  await openSearch();
  const activeIs = () => field_().getAttribute("aria-activedescendant");

  await userEvent.keyboard("{ArrowDown}{ArrowDown}");
  expect(litName()).toBe("api-rate-limits");
  expect(activeIs()).toBe(lit()!.id);
  // Focus never leaves the field.
  await expect.element(field()).toHaveFocus();

  await userEvent.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
  expect(litName()).toBe("mobile-onboarding");
  await userEvent.keyboard("{ArrowDown}");
  expect(litName()).toBe("search-indexing");
  expect(activeIs()).toBe(options()[0]!.id);
  expect(document.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
  // The caret stays where it was: the keys move the list, not the text.
  await userEvent.keyboard("ab{ArrowUp}");
  expect(field_().selectionStart).toBe(2);

  await userEvent.clear(field());
  await userEvent.hover(page.getByRole("option", { name: /^docs-site/ }));
  expect(litName()).toBe("docs-site");
  await expect.element(field()).toHaveFocus();
});

test("the list is no stop of Tab, and a click in it, between sessions, leaves focus in the field", async () => {
  await openSearch();
  const list = page.getByRole("listbox", { name: "Sessions" });

  await userEvent.tab();
  await expect.element(page.getByRole("button", { name: "? for shortcuts" })).toHaveFocus();
  await userEvent.tab();
  await expect.element(field()).toHaveFocus();

  // The list's padding, over the first session.
  await list.click({ position: { x: 40, y: 4 } });
  await expect.element(dialog()).toBeVisible();
  await expect.element(field()).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  expect(litName()).toBe("checkout-flow");
});

test("the lit session stays lit when an answer moves the sessions about", async () => {
  const screen = await openSearch();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
  expect(litName()).toBe("docs-site");
  const before = field_().getAttribute("aria-activedescendant");

  // A session starts waiting, and goes to the top.
  const waiting = session(7, {
    name: "email-templates",
    status: "needs-you",
    waitingReason: "permission",
    statusSince: NOW - 20 * MINUTE,
  });
  await screen.rerender(<Harness state={stateWith([...SESSIONS, waiting])} />);
  expect(namesShown()[0]).toBe("email-templates");
  expect(litName()).toBe("docs-site");
  // It has moved down one, and the field still names the same option.
  expect(field_().getAttribute("aria-activedescendant")).toBe(before);
  expect(lit()!.id).toBe(before);

  // The lit session goes away: the first is lit.
  await screen.rerender(
    <Harness state={stateWith([...SESSIONS, waiting].filter((s) => s.name !== "docs-site"))} />,
  );
  expect(litName()).toBe("email-templates");
});

test("under the list it says what Enter will do with the lit session: jump to it, and where, or show it on the Overview", async () => {
  await openSearch();
  const enter = () => part(dialog().element(), "enter").textContent;

  expect(enter()).toBe("Enter shows it on the Overview");
  await userEvent.keyboard("{ArrowDown}");
  expect(enter()).toBe("Enter jumps to it in tmux, work:2.1");
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
  expect(enter()).toBe("Enter jumps to it in VS Code");
  // The key in the mono, the words in the muted ink of a caption.
  const key = dialog().element().querySelector('[data-part="enter"] kbd') as HTMLElement;
  expect(getComputedStyle(key).fontFamily).toMatch(/^"?Atkinson Hyperlegible Mono/);
  expect(getComputedStyle(part(dialog().element(), "enter")).color).toBe(rgbOf("var(--ink-muted)"));
  expect(getComputedStyle(part(dialog().element(), "enter")).fontSize).toBe("12px");
});

test("Enter chooses the lit session once the dialog has gone, and a click on a session chooses it", async () => {
  const chosen: { name: string; dialogGone: boolean }[] = [];
  const onChoose = (s: Session) =>
    chosen.push({ name: s.name, dialogGone: document.querySelector('[role="dialog"]') === null });
  await openSearch({ onChoose });

  await userEvent.keyboard("{ArrowDown}{Enter}");
  await expect.element(dialog()).not.toBeInTheDocument();
  await vi.waitFor(() => expect(chosen).toEqual([{ name: "checkout-flow", dialogGone: true }]));

  await page.getByRole("button", { name: "Open search" }).click();
  await expect.element(dialog()).toBeVisible();
  // Each opening starts afresh: an empty field, the first session lit.
  expect(field_().value).toBe("");
  expect(litName()).toBe("search-indexing");
  await page.getByRole("option", { name: /^billing-webhooks/ }).click();
  await expect.element(dialog()).not.toBeInTheDocument();
  await vi.waitFor(() =>
    expect(chosen.map((c) => c.name)).toEqual(["checkout-flow", "billing-webhooks"]),
  );
});

test("Escape closes it, chooses nothing and gives focus back to what opened it", async () => {
  const onChoose = vi.fn();
  const onShortcuts = vi.fn();
  await openSearch({ onChoose, onShortcuts });
  await userEvent.keyboard("checkout{ArrowDown}");

  await userEvent.keyboard("{Escape}");
  await expect.element(dialog()).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Open search" })).toHaveFocus();
  expect(onChoose).not.toHaveBeenCalled();
  expect(onShortcuts).not.toHaveBeenCalled();
});

test('"?" with nothing typed, or the button that says so, hands over to the shortcuts once the dialog has gone; typed after other words it is searched for', async () => {
  const handed: (string | null | undefined)[] = [];
  const onShortcuts = () => handed.push(document.activeElement?.textContent);
  await openSearch({ onShortcuts });

  // Typed into a search, it is part of the search.
  await userEvent.keyboard("a?");
  expect(field_().value).toBe("a?");
  await expect.element(dialog()).toBeVisible();
  expect(handed).toEqual([]);

  await userEvent.clear(field());
  await userEvent.keyboard("?");
  await expect.element(dialog()).not.toBeInTheDocument();
  // Focus is back with the opener before the sheet opens, so the sheet gives it back there.
  await vi.waitFor(() => expect(handed).toEqual(["Open search"]));

  await page.getByRole("button", { name: "Open search" }).click();
  await expect.element(dialog()).toBeVisible();
  const button = page.getByRole("button", { name: "? for shortcuts" });
  await expect.element(button).toHaveAttribute("aria-haspopup", "dialog");
  expect(getComputedStyle(button.element()).color).toBe(rgbOf("var(--ink-muted)"));
  await button.click();
  await expect.element(dialog()).not.toBeInTheDocument();
  await vi.waitFor(() => expect(handed).toHaveLength(2));
});

test("before the first answer, and with no sessions running, it says so plainly", async () => {
  const screen = await openSearch({
    state: stateWith(null, { phase: "connecting", lastOkAt: null }),
  });
  expect(options()).toEqual([]);
  expect(part(dialog().element(), "empty").textContent).toBe(
    "Agent Lookout has not read any sessions yet.",
  );

  await screen.rerender(<Harness state={stateWith([])} />);
  expect(part(dialog().element(), "empty").textContent).toBe("No agents are running.");
  expect(page.getByRole("status").element().textContent).toBe("No agents are running.");
});

test("once answers stop, how long is counted up to the last one", async () => {
  await openSearch({
    state: stateWith(SESSIONS, { phase: "stalled", lastOkAt: NOW - 2 * MINUTE }),
  });
  expect(part(options()[0]!, "status").textContent).toBe("Needs you 7m");
});

test("at the width of a phone a long name wraps rather than being cut, and the time keeps its place", async () => {
  onTestFinished(() => page.viewport(1280, 900));
  await page.viewport(375, 900);
  const long = session(8, {
    name: "a-session-whose-name-runs-far-past-the-width-of-any-phone-screen",
    status: "working",
    statusSince: NOW - 5 * MINUTE,
    project: "a-folder-whose-name-is-also-very-long-indeed",
    git: { branch: "feature/a-branch-name-that-goes-on-and-on" },
  });
  await openSearch({ state: stateWith([long]) });
  const option = options()[0]!;
  const name = part(option, "name");

  expect(name.textContent).toBe(long.name);
  expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
  expect(getComputedStyle(name).textOverflow).not.toBe("ellipsis");
  expect(name.getBoundingClientRect().height).toBeGreaterThan(30);
  const status = part(option, "status");
  expect(status.textContent).toBe("Working 5m");
  expect(status.getBoundingClientRect().right).toBeLessThanOrEqual(
    option.getBoundingClientRect().right,
  );
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
});
