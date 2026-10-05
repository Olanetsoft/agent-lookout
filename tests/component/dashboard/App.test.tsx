import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { Session, SessionEvent, SessionsSnapshot } from "@core/session";
import App from "@dashboard/App";
import { setApiHost, type ApiHost } from "@dashboard/lib/apiHost";
import type { CollectorState, CollectorStore } from "@dashboard/lib/collectorStore";
import { resetThemeForTests, THEME_STORAGE_KEY } from "@dashboard/lib/theme";
import type { ViewId } from "@dashboard/lib/view";
import { makeSession } from "@tests/fixtures/session";
import { pointAway, startAtTop } from "@tests/support/browser";
import { rgbOf, warmElements, warmPaint } from "@tests/support/colours";
import { preferColorScheme, preferReducedMotion } from "@tests/support/media";
import { atFullSize, pixelsOf } from "@tests/support/pixels";

const MINUTE = 60_000;

const BLOCKED_ID = "claude-code:00000000-0000-4000-8000-000000000001";

function session(n: number, overrides: Partial<Session>): Session {
  return makeSession({
    id: `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    ...overrides,
  });
}

/** One session waiting for permission in VS Code, and one idle in a terminal. */
function snapshot(): SessionsSnapshot {
  const now = Date.now();
  return {
    generatedAt: now,
    sources: [
      {
        id: "claude-code",
        label: "Claude Code",
        state: "ok",
        detail:
          "Sessions are read from Claude Code's session registry and checked against its own list of sessions.",
        watching: [
          { label: "Registry folder", value: "/tmp/example-home/sessions" },
          { label: "Registry read", value: "every 2 seconds" },
          { label: "Command", value: "claude agents --json --all" },
          { label: "Command run", value: "every 30 seconds" },
        ],
        checkedAt: now,
      },
    ],
    sessions: [
      session(1, {
        name: "blocked-one",
        surface: "vscode",
        status: "needs-you",
        waitingReason: "permission",
        statusSince: now - 4 * MINUTE,
        links: {
          open: "vscode://anthropic.claude-code/open?session=00000000-0000-4000-8000-000000000001",
        },
      }),
      session(2, {
        name: "idle-one",
        status: "idle",
        statusSince: now - 20 * MINUTE,
        links: {
          open: "vscode://anthropic.claude-code/open?session=00000000-0000-4000-8000-000000000002",
        },
      }),
    ],
  };
}

/** The same, with the wait answered: nothing needs the person. */
function calmSnapshot(): SessionsSnapshot {
  const calm = snapshot();
  calm.sessions = calm.sessions.map((s) =>
    s.status === "needs-you"
      ? { ...s, status: "working", waitingReason: undefined, statusSince: Date.now() - MINUTE }
      : s,
  );
  return calm;
}

/** The wait beginning, and, when it was answered, its end. Newest first. */
function events(answered: boolean): SessionEvent[] {
  const now = Date.now();
  const began: SessionEvent = {
    id: "event-1",
    at: now - 4 * MINUTE,
    sessionId: BLOCKED_ID,
    sessionName: "blocked-one",
    kind: "status-changed",
    from: "working",
    to: "needs-you",
    severity: "warning",
  };
  if (!answered) return [began];
  return [{ ...began, id: "event-2", at: now - MINUTE, from: "needs-you", to: "working" }, began];
}

/** Polls every two seconds for the last ten minutes. */
function history(needsYou: number) {
  const now = Date.now();
  const points = [];
  for (let at = now - 10 * MINUTE; at <= now; at += 2_000) {
    points.push({ at, needsYou, working: 1 - needsYou, idle: 1, total: 2 });
  }
  return { points, startedAt: now - 10 * MINUTE };
}

function liveState(overrides: Partial<CollectorState> = {}): CollectorState {
  return {
    phase: "live",
    snapshot: snapshot(),
    events: events(false),
    history: history(1),
    lastOkAt: Date.now(),
    problem: null,
    problemKind: null,
    ...overrides,
  };
}

function calmState(overrides: Partial<CollectorState> = {}): CollectorState {
  return liveState({
    snapshot: calmSnapshot(),
    events: events(true),
    history: history(0),
    ...overrides,
  });
}

/** A store that holds whatever state the test gives it, and makes no requests. */
function fixedStore(initial: CollectorState) {
  let state = initial;
  const listeners = new Set<() => void>();
  const store: CollectorStore & { set: (next: CollectorState) => void } = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    refresh: vi.fn(),
    set(next) {
      state = next;
      for (const listener of listeners) listener();
    },
  };
  return store;
}

/** The view a URL fragment names, without the page moving or the hash being kept for the next test. */
function atView(view: ViewId | null) {
  history_.replaceState(
    null,
    "",
    `${location.pathname}${location.search}${view ? `#${view}` : ""}`,
  );
}
const history_ = window.history;

const main = () => document.querySelector("main") as HTMLElement;
const rail = () => document.querySelector('[data-slot="rail"]') as HTMLElement;
const header = () => document.querySelector('[data-slot="header"]') as HTMLElement;
const railLink = (view: ViewId) =>
  document.querySelector(`[data-slot="rail-link"][data-view="${view}"]`) as HTMLAnchorElement;

/** Tabs until this element has focus, and fails if it never does. */
async function tabTo(element: Element, most = 60) {
  for (let presses = 0; presses < most && document.activeElement !== element; presses += 1) {
    await userEvent.tab();
  }
  expect(document.activeElement).toBe(element);
}

/** Everything fixed to the screen rather than laid out in the page. */
function fixedToScreen(): Element[] {
  return [...document.body.querySelectorAll("*")].filter(
    (element) => getComputedStyle(element).position === "fixed",
  );
}

const ground = () => document.querySelector('[data-slot="ground"]') as HTMLElement;
/** The same ground, laid again over the inset above the sticky header. */
const groundAbove = () => document.querySelector('[data-slot="ground-above"]') as HTMLElement;
const hero = () => document.querySelector('[data-slot="hero"]') as HTMLElement;

/** Buttons drawn solid: in the lamp's fill, as only the hero's Jump is. */
function solidButtons(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="button"]')].filter(
    (button) => getComputedStyle(button).backgroundColor === rgbOf("var(--status-needs-you)"),
  );
}

/** Every element on the page whose glass blurs what passes behind it. */
function blurred(): Element[] {
  return [...document.body.querySelectorAll("*")].filter(
    (element) => getComputedStyle(element).backdropFilter !== "none",
  );
}

beforeEach(async () => {
  // A desktop window.
  await page.viewport(1280, 900);
  atView(null);
});

afterEach(() => {
  setApiHost();
  localStorage.clear();
  resetThemeForTests();
  document.documentElement.removeAttribute("data-theme");
  atView(null);
});

test("the first screen has the rail, the header with the wordmark, the status line and the switch, and the Overview", async () => {
  const screen = await render(<App store={fixedStore(liveState())} />);

  // The rail: 76px down the left edge, inset 12px from the window's edges.
  const nav = screen.getByRole("navigation", { name: "Views" });
  await expect.element(nav).toBeVisible();
  expect(nav.element().getBoundingClientRect().width).toBe(76);
  expect(nav.element().getBoundingClientRect().left).toBe(12);
  expect(nav.element().getBoundingClientRect().top).toBe(12);

  // The header: 56px tall, beside the rail, the wordmark in mixed case, never
  // spaced wider than normal.
  expect(header().getBoundingClientRect().height).toBe(56);
  expect(header().getBoundingClientRect().left - nav.element().getBoundingClientRect().right).toBe(
    12,
  );
  const wordmark = screen.getByRole("heading", { level: 1, name: "Agent Lookout" });
  await expect.element(wordmark).toBeVisible();
  expect(wordmark.element().textContent).toBe("Agent Lookout");
  const type = getComputedStyle(wordmark.element());
  expect(type.textTransform).toBe("none");
  expect(type.fontSize).toBe("19px");
  expect(type.fontWeight).toBe("600");
  expect(type.fontFamily).toMatch(/^"?Atkinson Hyperlegible Next/);
  expect(parseFloat(type.letterSpacing)).toBeLessThan(0);

  // What is being watched, and when it was last checked.
  const status = screen.container.querySelector('[data-slot="status-line"]') as HTMLElement;
  expect(status.dataset.status).toBe("watching");
  const sentence = status.querySelector("a") as HTMLAnchorElement;
  // A terminal session can be in any terminal, so it is not named as an app.
  expect(sentence.textContent).toBe("Watching 2 sessions in VS Code and a terminal");
  expect(sentence.getAttribute("href")).toBe("#sources");
  const checked = status.querySelector('[data-part="checked"]') as HTMLElement;
  expect(checked.textContent).toMatch(/^checked (just now|\d+s ago)$/);
  expect(getComputedStyle(checked).fontVariantNumeric).toBe("tabular-nums");
  // It ticks every second, so it is shown and never announced.
  expect(checked.getAttribute("aria-hidden")).toBe("true");

  // The Night and Day switch.
  await expect.element(screen.getByRole("radio", { name: "Dark theme" })).toBeChecked();
  await expect.element(screen.getByRole("radio", { name: "Light theme" })).not.toBeChecked();

  // The Overview, in the main area.
  expect(main().dataset.view).toBe("overview");
  expect(main().getAttribute("aria-label")).toBe("Overview");
  await expect.element(screen.getByRole("region", { name: /^Needs you/ })).toBeVisible();
  for (const region of ["Last hour", "Sessions", "Events", "Timeline"]) {
    await expect.element(screen.getByRole("region", { name: region })).toBeVisible();
  }
  await expect.element(screen.getByRole("group", { name: "Summary" })).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "Jump to blocked-one in VS Code" }))
    .toBeVisible();
  // Nothing floats over it. The only things fixed to the screen are the ground
  // behind everything and the strip of the same ground above the header, which
  // nobody can point at or read.
  expect(fixedToScreen()).toEqual([ground(), groundAbove()]);
  for (const layer of [ground(), groundAbove()]) {
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(getComputedStyle(layer).pointerEvents).toBe("none");
  }
});

test.each(["dark", "light"] as const)(
  "in the %s theme, scrolled, the content passes behind the header's glass and is never seen above it",
  async (theme) => {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    await preferReducedMotion();
    await atFullSize();
    const screen = await render(<App store={fixedStore(liveState())} />);
    await expect.element(screen.getByRole("region", { name: "Timeline" })).toBeVisible();
    onTestFinished(() => window.scrollTo({ top: 0 }));
    // Far enough that the hero's top is under the inset above the header.
    window.scrollTo({ top: 200 });
    await vi.waitFor(() => expect(window.scrollY).toBe(200));

    // The header stays 12px below the window's edge, and the content passes
    // behind its glass.
    const box = header().getBoundingClientRect();
    expect(box.top).toBe(12);
    // Over that inset lies the same ground, the same layers in the same place,
    // above the content and under the header. The rail stays over it, so it
    // still reaches the window's edge as the page scrolls.
    const above = groundAbove();
    const strip = above.getBoundingClientRect();
    expect([strip.top, strip.left, strip.height]).toEqual([0, 0, box.top]);
    expect(strip.right).toBe(window.innerWidth);
    expect([...above.children].map((field) => field.className)).toEqual(
      [...ground().children].map((field) => field.className),
    );
    expect(getComputedStyle(above).backgroundAttachment).toBe("fixed");
    const z = (element: Element) => Number(getComputedStyle(element).zIndex);
    expect(z(above)).toBeLessThan(z(header()));
    expect(z(above)).toBeLessThan(z(rail()));

    // What is drawn in the inset over the content's column.
    const probe = document.createElement("div");
    probe.style.cssText = `position: fixed; z-index: 100; pointer-events: none; top: 0; left: ${box.left}px; width: ${box.width}px; height: ${box.top}px;`;
    document.body.append(probe);
    onTestFinished(() => probe.remove());
    const drawn = () =>
      new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const most = (a: Awaited<ReturnType<typeof pixelsOf>>, b: typeof a) => {
      let difference = 0;
      for (let y = 0; y < a.height; y += 1) {
        for (let x = 0; x < a.width; x += 1) {
          const [p, q] = [a.at(x, y), b.at(x, y)];
          for (const channel of [0, 1, 2]) {
            difference = Math.max(difference, Math.abs(p[channel]! - q[channel]!));
          }
        }
      }
      return difference;
    };
    const shot = async () => {
      await drawn();
      return pixelsOf(probe);
    };

    // With the hero's words under the inset, they would show there without the
    // ground laid over them. With it, the inset is the same whether the content
    // is there or not.
    const covered = await shot();
    above.style.visibility = "hidden";
    const open = await shot();
    above.style.visibility = "";
    main().style.visibility = "hidden";
    const empty = await shot();
    main().style.visibility = "";
    expect(most(open, covered)).toBeGreaterThan(20);
    expect(most(covered, empty)).toBeLessThanOrEqual(1);

    // At the top of the page nothing is under the inset, and there the ground
    // laid over it cannot be told from the ground beneath. The two are separate
    // drawings of the same layers, and a browser need not round them alike:
    // headless Chromium on Linux draws them up to 3 levels apart. The dither
    // moves a pixel about two levels each way, so a difference of 4 or less is
    // inside its swing and cannot be seen.
    window.scrollTo({ top: 0 });
    await vi.waitFor(() => expect(window.scrollY).toBe(0));
    const laid = await shot();
    above.style.visibility = "hidden";
    const beneath = await shot();
    above.style.visibility = "";
    expect(most(laid, beneath)).toBeLessThanOrEqual(4);
  },
);

test("the tab title carries how many sessions need the person", async () => {
  const store = fixedStore(liveState());
  await render(<App store={store} />);
  await vi.waitFor(() => expect(document.title).toBe("(1) Agent Lookout"));

  store.set(calmState());

  await vi.waitFor(() => expect(document.title).toBe("Agent Lookout"));
});

test("a rail link puts its view in the main area, marks it current and moves focus there, and the rail and header stay", async () => {
  const screen = await render(<App store={fixedStore(liveState())} />);
  const railBefore = rail();
  const headerBefore = header();
  const headerBox = headerBefore.getBoundingClientRect();
  const railBox = railBefore.getBoundingClientRect();

  await screen.getByRole("link", { name: "Sources", exact: true }).click();

  await vi.waitFor(() => expect(main().dataset.view).toBe("sources"));
  expect(location.hash).toBe("#sources");
  await expect.element(screen.getByRole("region", { name: "Claude Code" })).toBeVisible();
  expect(screen.container.querySelector('[data-slot="hero"]')).toBeNull();
  expect(railLink("sources").getAttribute("aria-current")).toBe("page");
  expect(railLink("overview").hasAttribute("aria-current")).toBe(false);
  expect(main().getAttribute("aria-label")).toBe("Sources");
  // Focus is where the eye goes, so the keyboard and a screen reader are there too.
  await vi.waitFor(() => expect(document.activeElement).toBe(main()));

  // The same rail and header, where they were.
  expect(rail()).toBe(railBefore);
  expect(header()).toBe(headerBefore);
  expect(header().getBoundingClientRect().toJSON()).toEqual(headerBox.toJSON());
  expect(rail().getBoundingClientRect().left).toBe(railBox.left);

  // A view is not a dialog, and nothing floats.
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(fixedToScreen()).toEqual([ground(), groundAbove()]);

  await screen.getByRole("link", { name: "Settings", exact: true }).click();
  await vi.waitFor(() => expect(main().dataset.view).toBe("settings"));
  await expect.element(screen.getByRole("region", { name: "Theme" })).toBeVisible();
  expect(railLink("settings").getAttribute("aria-current")).toBe("page");
  expect(document.querySelector('[role="dialog"]')).toBeNull();

  // The mark goes back to the Overview.
  await screen.getByRole("link", { name: /^Agent Lookout, 1 session needs you$/ }).click();
  await vi.waitFor(() => expect(main().dataset.view).toBe("overview"));
  await expect.element(screen.getByRole("region", { name: "Sessions" })).toBeVisible();
});

test("the views work from the keyboard: Tab to a rail link, Enter, and focus lands in the view", async () => {
  const screen = await render(<App store={fixedStore(liveState())} />);

  startAtTop();
  await tabTo(railLink("settings"));
  expect(getComputedStyle(railLink("settings")).outlineStyle).toBe("solid");
  expect(getComputedStyle(railLink("settings")).outlineColor).toBe(rgbOf("var(--focus)"));
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() => expect(main().dataset.view).toBe("settings"));
  await vi.waitFor(() => expect(document.activeElement).toBe(main()));
  expect(railLink("settings").getAttribute("aria-current")).toBe("page");

  // The next Tab goes into the view, not back to the top of the page.
  await userEvent.tab();
  expect(main().contains(document.activeElement)).toBe(true);
  await expect.element(screen.getByRole("radio", { name: "Dark theme" }).last()).toHaveFocus();

  // The browser's back button goes back a view.
  history_.back();
  await vi.waitFor(() => expect(main().dataset.view).toBe("overview"));
});

test("the status line is a link to the Sources view", async () => {
  const screen = await render(<App store={fixedStore(liveState())} />);

  await screen.getByRole("link", { name: "Watching 2 sessions in VS Code and a terminal" }).click();

  await vi.waitFor(() => expect(main().dataset.view).toBe("sources"));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("the Sources view shows each source's facts as rows, and a long folder wraps inside its card", async () => {
  const deep = snapshot();
  const folder = `/tmp/${"a-very-long-folder-name/".repeat(8)}sessions`;
  deep.sources = deep.sources.map((source) => ({
    ...source,
    watching: [{ label: "Registry folder", value: folder }, ...(source.watching ?? []).slice(1)],
  }));
  atView("sources");
  const screen = await render(<App store={fixedStore(liveState({ snapshot: deep }))} />);
  const card = screen.getByRole("region", { name: "Claude Code" });
  await expect.element(card).toHaveTextContent(folder);

  const rows = [...card.element().querySelectorAll('[data-slot="fact-row"] dt')];
  expect(rows.map((row) => row.textContent)).toEqual([
    "Registry folder",
    "Registry read",
    "Command",
    "Command run",
    "Sessions found",
    "Last checked",
  ]);
  for (const width of [1280, 620]) {
    await page.viewport(width, 900);
    expect(card.element().scrollWidth).toBeLessThanOrEqual(card.element().clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  }
});

test("the header's switch shows Night and Day, marks the theme in force and stores a choice", async () => {
  const screen = await render(<App store={fixedStore(liveState())} />);
  const switcher = screen.getByRole("radiogroup", { name: "Theme" });
  const night = screen.getByRole("radio", { name: "Dark theme" });
  const day = screen.getByRole("radio", { name: "Light theme" });

  expect(header().contains(switcher.element())).toBe(true);
  await expect.element(night).toHaveTextContent("Night");
  await expect.element(day).toHaveTextContent("Day");
  await expect.element(night).toBeChecked();

  await day.click();
  expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  // Day's warm stone, from the window's edge to the ground behind the glass.
  expect(getComputedStyle(document.documentElement).backgroundColor).toBe("rgb(212, 208, 202)");
  expect(getComputedStyle(ground()).backgroundImage).toContain("rgb(212, 208, 202)");
  await expect.element(day).toBeChecked();
  // The thumb slides under the choice.
  const thumb = switcher.element().querySelector('[data-part="thumb"]') as HTMLElement;
  await vi.waitFor(() =>
    expect(
      Math.abs(thumb.getBoundingClientRect().left - day.element().getBoundingClientRect().left),
    ).toBeLessThan(1),
  );

  await night.click();
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  expect(getComputedStyle(document.documentElement).backgroundColor).toBe("rgb(9, 9, 8)");
});

test("the theme chosen in Settings is remembered, and System follows the computer, which the header's switch shows", async () => {
  await preferColorScheme("light");
  atView("settings");
  const screen = await render(<App store={fixedStore(liveState())} />);
  const settings = screen.getByRole("region", { name: "Theme" });

  // Night is the default.
  await expect.element(settings.getByRole("radio", { name: "Dark theme" })).toBeChecked();
  await settings.getByRole("radio", { name: "Light theme" }).click();
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  expect(document.documentElement.getAttribute("data-theme")).toBe("light");

  // Remembered when the page is drawn again.
  await screen.unmount();
  resetThemeForTests();
  const again = await render(<App store={fixedStore(liveState())} />);
  const theme = again.getByRole("region", { name: "Theme" });
  await expect.element(theme.getByRole("radio", { name: "Light theme" })).toBeChecked();

  // System: the computer is light, so the page is, and the header marks Day.
  await theme.getByRole("radio", { name: "Follow the computer's setting" }).click();
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  const headerSwitch = again.getByRole("radiogroup", { name: "Theme" }).first();
  expect(header().contains(headerSwitch.element())).toBe(true);
  await expect.element(headerSwitch.getByRole("radio", { name: "Light theme" })).toBeChecked();

  // The computer turns dark, and the page and the header follow it.
  await preferColorScheme("dark");
  await vi.waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("dark"));
  await expect.element(headerSwitch.getByRole("radio", { name: "Dark theme" })).toBeChecked();
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
});

test("the hero's title opens the Needs you history in a dialog of floating glass, which keeps focus and gives it back when closed", async () => {
  const screen = await render(<App store={fixedStore(liveState())} />);

  const open = screen.getByRole("button", { name: "Needs you" });
  startAtTop();
  await tabTo(open.element());
  await userEvent.keyboard("{Enter}");

  const dialog = screen.getByRole("dialog", { name: "Needs you" });
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog).toHaveTextContent("How many sessions were waiting on you");
  await expect.element(dialog).toHaveTextContent("What this counts");

  // Floating glass over a flat scrim: the densest tint with the page blurred
  // behind it, a rim, the deepest shadow and the panel's corners.
  const box = getComputedStyle(dialog.element());
  expect(box.backgroundColor).toBe(rgbOf("var(--glass-float)"));
  expect(box.borderRadius).toBe("24px");
  expect(box.backdropFilter).toMatch(/^blur\(30px\)/);
  expect(getComputedStyle(dialog.element(), "::before").backgroundImage).toMatch(/gradient/);
  const scrim = document.querySelector('[data-slot="scrim"]') as HTMLElement;
  expect(getComputedStyle(scrim).backdropFilter).toBe("none");
  expect(getComputedStyle(dialog.element().parentElement as Element).backdropFilter).toBe("none");

  // The window control is a set of radios, starting on 15 minutes.
  await expect.element(screen.getByRole("radio", { name: "15 min" })).toBeChecked();
  await expect.element(screen.getByRole("radio", { name: "6 hours" })).not.toBeChecked();

  // The chart: a line where it was measured, a hatch where it was not, both axes.
  const chart = screen.getByRole("slider", {
    name: /Sessions that need you over the last 15 minutes/,
  });
  await expect.element(chart).toBeVisible();
  await vi.waitFor(() => {
    const drawn = chart.element();
    expect(drawn.querySelector('[data-part="line"]')).not.toBeNull();
    expect(drawn.querySelector('[data-part="unmeasured"]')).not.toBeNull();
    expect(drawn.querySelectorAll('[data-part="grid"]').length).toBeGreaterThanOrEqual(2);
    expect(drawn.querySelectorAll('[data-part="time-tick"]').length).toBeGreaterThanOrEqual(3);
  });
  expect(chart.element().getAttribute("aria-valuetext")).toMatch(/^\d\d:\d\d:\d\d: 1 needs you$/);

  // Focus is held inside while it is open.
  for (let presses = 0; presses < 8; presses += 1) {
    await userEvent.tab();
    expect(dialog.element().contains(document.activeElement)).toBe(true);
  }

  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(open).toHaveFocus();
});

test("the dialog fades out when it closes, and is gone once it has", async () => {
  // The exit takes 150ms. It is slowed here so the test can look at it part-way.
  const slow = document.createElement("style");
  slow.textContent = "* { animation-duration: 800ms !important; }";
  document.head.append(slow);
  onTestFinished(() => slow.remove());

  const screen = await render(<App store={fixedStore(liveState())} />);
  await screen.getByRole("button", { name: "Working: open history" }).click();
  const dialog = screen.getByRole("dialog", { name: "Working" });
  await expect.element(dialog).toBeVisible();
  const panel = dialog.element();
  const scrim = document.querySelector('[data-slot="scrim"]') as HTMLElement;

  await userEvent.keyboard("{Escape}");

  // Still in the page, and on its way out: the dialog, its overlay and the scrim.
  expect(panel.isConnected).toBe(true);
  expect(panel.getAttribute("data-state")).toBe("closed");
  expect(getComputedStyle(panel).animationName).toBe("drop");
  expect(getComputedStyle(panel.parentElement as Element).animationName).toBe("fade-out");
  expect(scrim.getAttribute("data-state")).toBe("closed");
  expect(getComputedStyle(scrim).animationName).toBe("fade-out");

  await expect.element(dialog).not.toBeInTheDocument();
  await vi.waitFor(() => expect(scrim.isConnected).toBe(false));
});

test("a count that was not counted has no history to open, and nor has the hero", async () => {
  const blind = snapshot();
  blind.sessions = [];
  blind.sources = [{ id: "claude-code", label: "Claude Code", state: "unavailable", checkedAt: 1 }];
  const screen = await render(<App store={fixedStore(liveState({ snapshot: blind }))} />);

  await expect.element(screen.getByRole("group", { name: "Working" })).toBeVisible();
  expect(screen.container.querySelector('[data-slot="counts-row"] button')).toBeNull();
  expect(screen.container.querySelector('[data-slot="hero"] button')).toBeNull();
});

test("a fault while drawing a view is said in the main area, with the rail and the header still there", async () => {
  // A store that skips the reader, holding a session no reader would let through.
  const broken = snapshot();
  broken.sessions = [{ ...broken.sessions[0], name: { a: 1 } } as unknown as Session];
  const store = fixedStore(liveState({ snapshot: broken, events: [] }));
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => quiet.mockRestore());

  const screen = await render(<App store={store} />);

  const alert = screen.getByRole("alert");
  await expect.element(alert).toHaveTextContent("Agent Lookout could not draw this page");
  expect(main().contains(alert.element())).toBe(true);
  await expect
    .element(screen.getByRole("heading", { level: 1, name: "Agent Lookout" }))
    .toBeVisible();
  await expect.element(screen.getByRole("navigation", { name: "Views" })).toBeVisible();
  // And the rail still leads somewhere that works.
  await screen.getByRole("link", { name: "Settings", exact: true }).click();
  await expect.element(screen.getByRole("region", { name: "Theme" })).toBeVisible();
  expect(screen.container.querySelector('[data-slot="page-error"]')).toBeNull();

  // Back on the Overview with data it can draw, the dashboard is back.
  store.set(liveState());
  await screen.getByRole("link", { name: "Overview", exact: true }).click();
  await expect
    .element(screen.getByRole("region", { name: "Sessions" }).getByText("idle-one"))
    .toBeVisible();
  expect(screen.container.querySelector('[data-slot="page-error"]')).toBeNull();
});

test("when updates stop, the status line says so, with the time of the last answer, and names no healthy source", async () => {
  const store = fixedStore(liveState());
  const screen = await render(<App store={store} />);
  const status = () => screen.container.querySelector('[data-slot="status-line"]') as HTMLElement;
  expect(status().dataset.status).toBe("watching");

  const lastOkAt = new Date(2026, 0, 5, 17, 59, 40).getTime();
  store.set(liveState({ phase: "stalled", lastOkAt }));

  await vi.waitFor(() => expect(status().dataset.status).toBe("not-updating"));
  expect(status().querySelector("a")?.textContent).toBe("Not updating");
  const since = status().querySelector('[data-part="checked"]') as HTMLElement;
  expect(since.textContent).toBe("since 17:59:40");
  // A fixed time, so it can be announced.
  expect(since.hasAttribute("aria-hidden")).toBe(false);
  expect(header().textContent).not.toContain("Watching");
  expect(header().textContent).not.toContain("Claude Code");
  await expect.element(screen.getByRole("alert")).toHaveTextContent("has stopped updating");
  // The sessions it last saw are still there.
  await expect
    .element(screen.getByRole("link", { name: "Jump to blocked-one in VS Code" }))
    .toBeVisible();
});

test("once answers stop, the lamp keeps the last count while the page says the data is old", async () => {
  const store = fixedStore(liveState());
  const screen = await render(<App store={store} />);
  const mark = () => screen.container.querySelector('[data-slot="rail-mark"]') as HTMLElement;
  expect(mark().dataset.lit).toBe("true");

  store.set(liveState({ phase: "stalled", lastOkAt: Date.now() - 20_000 }));

  await expect.element(screen.getByRole("alert")).toHaveTextContent("has stopped updating");
  expect(mark().dataset.lit).toBe("true");
  await expect
    .element(screen.getByRole("link", { name: "Agent Lookout, 1 session needs you" }))
    .toBeVisible();
  // It agrees with the hero under the notice, which keeps its lamp.
  expect(hero().dataset.state).toBe("one");
  expect(hero().dataset.light).toBe("lamp");
});

test("a failure to connect says so in the status line, and Try now polls at once", async () => {
  const store = fixedStore(
    liveState({
      phase: "unreachable",
      snapshot: null,
      events: [],
      history: null,
      lastOkAt: null,
      problem: "The local server did not answer.",
      problemKind: "no-answer",
    }),
  );
  const screen = await render(<App store={store} />);

  const status = screen.container.querySelector('[data-slot="status-line"]') as HTMLElement;
  expect(status.dataset.status).toBe("not-connected");
  expect(status.textContent).toBe("Not connected to the local server");
  // Nothing is known, so the lamp is out.
  expect(
    (screen.container.querySelector('[data-slot="rail-mark"]') as HTMLElement).dataset.lit,
  ).toBe("false");
  await screen.getByRole("button", { name: "Try now" }).click();

  expect(store.refresh).toHaveBeenCalledTimes(1);
});

test("with its own store, the app reads everything through apiRequest and nothing else", async () => {
  const requests: string[] = [];
  const host: ApiHost = async (path) => {
    requests.push(path);
    const body = path.startsWith("/api/sessions")
      ? snapshot()
      : path.startsWith("/api/events")
        ? { events: [] }
        : { points: [], startedAt: Date.now() - MINUTE };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  setApiHost(host);
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  onTestFinished(() => fetchSpy.mockRestore());

  const screen = await render(<App />);

  await expect
    .element(screen.getByRole("region", { name: "Sessions" }).getByText("idle-one"))
    .toBeVisible();
  // The first poll asks for the hour the timeline covers.
  expect(requests.slice(0, 3)).toEqual([
    "/api/sessions",
    "/api/events?since=0",
    "/api/history?windowMs=3600000",
  ]);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("at 760 pixels and below the status line keeps a short form under the wordmark, and the switch shows its icons", async () => {
  onTestFinished(() => page.viewport(1280, 900));
  const screen = await render(<App store={fixedStore(liveState())} />);
  const status = () => screen.container.querySelector('[data-slot="status-line"]') as HTMLElement;
  const wordmark = () => screen.getByRole("heading", { level: 1 }).element();
  const night = () => screen.getByRole("radio", { name: "Dark theme" }).element() as HTMLElement;

  // Wide: one line beside the wordmark, and the switch in words.
  expect(status().querySelector("a")?.textContent).toBe(
    "Watching 2 sessions in VS Code and a terminal",
  );
  expect(status().getBoundingClientRect().left).toBeGreaterThan(
    wordmark().getBoundingClientRect().right,
  );
  expect(night().textContent).toBe("Night");

  for (const width of [760, 375]) {
    await page.viewport(width, 900);
    await vi.waitFor(() => expect(status().querySelector("a")?.textContent).toBe("2 sessions"));
    // Shown, under the wordmark, with when it was checked beside it.
    const line = status().getBoundingClientRect();
    expect(getComputedStyle(status()).display, `${width}`).not.toBe("none");
    expect(line.top, `${width}`).toBeGreaterThanOrEqual(wordmark().getBoundingClientRect().bottom);
    expect(line.left).toBe(wordmark().getBoundingClientRect().left);
    expect(line.bottom).toBeLessThanOrEqual(header().getBoundingClientRect().bottom);
    const checked = status().querySelector('[data-part="checked"]') as HTMLElement;
    expect(checked.textContent).toMatch(/^checked (just now|\d+s ago)$/);
    expect(checked.getBoundingClientRect().right).toBeLessThanOrEqual(
      screen.getByRole("radiogroup", { name: "Theme" }).element().getBoundingClientRect().left,
    );
    // Still the link to the Sources view, named by what it says.
    await expect.element(screen.getByRole("link", { name: "2 sessions" })).toBeVisible();

    // The switch: the moon and the sun, each in the middle of its option, and still named.
    expect(night().textContent).toBe("");
    const icon = night().querySelector("svg")!.getBoundingClientRect();
    const option = night().getBoundingClientRect();
    expect(icon.left - option.left).toBeCloseTo(option.right - icon.right, 0);
    await expect.element(screen.getByRole("radio", { name: "Light theme" })).toBeVisible();

    // Nothing in the header runs past the window or into its 16px side.
    expect(document.documentElement.scrollWidth, `${width}`).toBeLessThanOrEqual(width);
    for (const element of header().querySelectorAll("*")) {
      expect(element.getBoundingClientRect().right, `${width}`).toBeLessThanOrEqual(width - 16);
    }
  }
});

test.each([1180, 1000, 760, 620, 375])(
  "at %i pixels wide nothing runs off the side, in any of the three views, and the rail is there",
  async (width) => {
    await page.viewport(width, 900);
    const screen = await render(<App store={fixedStore(liveState())} />);
    await expect.element(screen.getByRole("region", { name: "Sessions" })).toBeVisible();

    for (const view of ["overview", "sources", "settings"] as const) {
      location.hash = `#${view}`;
      await vi.waitFor(() => expect(main().dataset.view).toBe(view));
      expect(document.documentElement.scrollWidth, view).toBeLessThanOrEqual(window.innerWidth);
      // Nor does anything inside a card run past it, the hero included.
      for (const card of document.querySelectorAll<HTMLElement>(
        '[data-slot="section-card"], [data-slot="hero"], [data-slot="source"]',
      )) {
        expect(card.scrollWidth, view).toBeLessThanOrEqual(card.clientWidth);
        expect(card.getBoundingClientRect().right, view).toBeLessThanOrEqual(window.innerWidth);
      }
      // The rail is still there: 76px, and narrowed to its icons at 760 and below.
      expect(rail().getBoundingClientRect().width, view).toBe(width <= 760 ? 56 : 76);
      await expect
        .element(screen.getByRole("link", { name: "Settings", exact: true }))
        .toBeInTheDocument();
    }
  },
);

/** Two waiting sessions named longer than any card has room for at the width of a phone. */
const LONG_NAMES = [
  "a-waiting-session-whose-name-runs-far-past-the-width-of-a-phone-screen",
  "another-waiting-session-whose-name-is-also-far-too-long-for-any-card",
] as const;

/** The busy Overview with both waiting, as the collector would report them. */
function longNamedState(): CollectorState {
  const now = Date.now();
  const busy = snapshot();
  busy.sessions = [
    { ...busy.sessions[0]!, name: LONG_NAMES[0] },
    session(3, {
      name: LONG_NAMES[1],
      status: "needs-you",
      waitingReason: "question",
      statusSince: now - 2 * MINUTE,
      links: {
        open: "vscode://anthropic.claude-code/open?session=00000000-0000-4000-8000-000000000003",
      },
    }),
    busy.sessions[1]!,
  ];
  const began = (id: string, name: string, ago: number): SessionEvent => ({
    id: `event-${id}`,
    at: now - ago,
    sessionId: id,
    sessionName: name,
    kind: "status-changed",
    from: "working",
    to: "needs-you",
    severity: "warning",
  });
  return liveState({
    snapshot: busy,
    events: [
      began(busy.sessions[1]!.id, LONG_NAMES[1], 2 * MINUTE),
      began(BLOCKED_ID, LONG_NAMES[0], 4 * MINUTE),
    ],
    // Polls every two seconds for ten minutes, agreeing with when each wait began.
    history: {
      points: history(0).points.map((point) => {
        const needsYou =
          Number(point.at >= now - 4 * MINUTE) + Number(point.at >= now - 2 * MINUTE);
        return { at: point.at, needsYou, working: 2 - needsYou, idle: 1, total: 3 };
      }),
      startedAt: now - 10 * MINUTE,
    },
  });
}

test.each([1280, 1000, 760, 375])(
  "at %i pixels waiting sessions with very long names are cut in the hero and its bars, and nothing runs off the side",
  async (width) => {
    await page.viewport(width, 900);
    const screen = await render(<App store={fixedStore(longNamedState())} />);
    await expect.element(screen.getByRole("region", { name: "Sessions" })).toBeVisible();

    // Both are in the hero, the longest wait in full and the other in a row,
    // and both have a bar in Waited on you, so the long names are really drawn.
    expect(hero().dataset.state).toBe("several");
    const names = [...hero().querySelectorAll<HTMLElement>('[data-part="name"]')];
    expect(names.map((name) => name.textContent)).toEqual([...LONG_NAMES]);
    const bars = () => [
      ...hero().querySelectorAll<HTMLElement>('[data-slot="waited-on-you"] [data-part="waited"]'),
    ];
    await vi.waitFor(() => expect(bars()).toHaveLength(2));
    expect(bars().map((bar) => bar.querySelector('[data-part="who"]')?.textContent)).toEqual([
      ...LONG_NAMES,
    ]);

    // The page never scrolls sideways, no card's content reaches past the card,
    // and nothing in the hero reaches past the hero.
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    for (const card of document.querySelectorAll<HTMLElement>(
      '[data-slot="section-card"], [data-slot="hero"]',
    )) {
      const what = card.querySelector("h2")?.textContent ?? card.dataset.slot;
      expect(card.scrollWidth, `${what}`).toBeLessThanOrEqual(card.clientWidth);
      expect(card.getBoundingClientRect().right, `${what}`).toBeLessThanOrEqual(window.innerWidth);
    }
    const edge = hero().getBoundingClientRect().right;
    for (const element of hero().querySelectorAll("*")) {
      expect(
        element.getBoundingClientRect().right,
        element.outerHTML.slice(0, 80),
      ).toBeLessThanOrEqual(edge + 0.5);
    }

    // A name with no room is cut with an ellipsis and reachable in full by Tab.
    // At the width of a phone none of them has room.
    for (const name of [
      ...names,
      ...bars().map((bar) => bar.querySelector<HTMLElement>('[data-part="who"]')!),
    ]) {
      const what = `${name.textContent} at ${width}`;
      expect(getComputedStyle(name).textOverflow, what).toBe("ellipsis");
      const cut = name.scrollWidth > name.clientWidth;
      if (width === 375) expect(cut, what).toBe(true);
      await expect.poll(() => name.dataset.cut, { message: what }).toBe(String(cut));
      expect(name.getAttribute("tabindex"), what).toBe(cut ? "0" : null);
    }
    for (const bar of bars()) {
      const value = bar.querySelector('[data-part="value"]') as HTMLElement;
      expect(value.textContent).toMatch(/^\d+m \d\ds$/);
      expect(value.scrollWidth).toBeLessThanOrEqual(value.clientWidth);
      expect(value.getBoundingClientRect().right).toBeLessThanOrEqual(edge + 0.5);
    }
  },
);

test("below 1181 pixels the hero stacks first, with its light still behind it", async () => {
  const screen = await render(<App store={fixedStore(liveState())} />);
  await expect.element(screen.getByRole("region", { name: "Sessions" })).toBeVisible();

  for (const width of [1180, 375]) {
    await page.viewport(width, 900);
    const light = document.querySelector('[data-slot="hero-light"]') as HTMLElement;
    const cards = [hero(), screen.getByRole("region", { name: "Last hour" }).element()];
    expect(cards[0]!.getBoundingClientRect().bottom, `${width}`).toBeLessThan(
      cards[1]!.getBoundingClientRect().top,
    );
    expect(light.offsetTop - hero().offsetTop, `${width}`).toBe(-90);
    expect(light.getBoundingClientRect().right, `${width}`).toBeLessThanOrEqual(
      hero().getBoundingClientRect().right + 1,
    );
    expect(document.documentElement.scrollWidth, `${width}`).toBeLessThanOrEqual(width);
  }
});

test.each([
  ["dark", "lamp"],
  ["light", "lamp"],
  ["dark", "rest"],
  ["light", "rest"],
] as const)(
  "in the %s theme the %s light lies behind the hero and draws nothing on the rail, however narrow the window",
  async (theme, kind) => {
    await preferReducedMotion();
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    const screen = await render(
      <App store={fixedStore(kind === "lamp" ? liveState() : calmState())} />,
    );
    await expect.element(screen.getByRole("region", { name: "Sessions" })).toBeVisible();
    const light = document.querySelector('[data-slot="hero-light"]') as HTMLElement;
    expect(light.dataset.light).toBe(kind);

    // A clear box over the part of the rail that the light's box reaches across,
    // read as drawn, then again with the light hidden. The ground and the rail
    // are hidden while it is read, so nothing but the window's own colour is
    // behind, and any difference is light. Window heights stay short enough that
    // the page is shown at its real size.
    // A change waits two frames to be drawn.
    const drawn = () =>
      new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    await vi.waitFor(() =>
      expect(document.getAnimations().filter((a) => a.playState === "running")).toHaveLength(0),
    );
    const probe = document.createElement("div");
    probe.style.cssText = "position: fixed; z-index: 100; pointer-events: none;";
    document.body.append(probe);
    onTestFinished(() => probe.remove());

    for (const width of [1200, 1000, 760, 375]) {
      await page.viewport(width, 700);
      await drawn();
      const railBox = rail().getBoundingClientRect();
      const lightBox = light.getBoundingClientRect();
      // The box reaches under the rail at every width. The light must not.
      expect(lightBox.left, `${width}`).toBeLessThan(railBox.right);
      const top = Math.max(railBox.top, lightBox.top);
      Object.assign(probe.style, {
        left: `${railBox.left}px`,
        top: `${top}px`,
        width: `${railBox.width}px`,
        height: `${Math.min(lightBox.bottom, 700) - top}px`,
      });

      ground().style.visibility = "hidden";
      rail().style.visibility = "hidden";
      await drawn();
      const lit = await pixelsOf(probe);
      light.style.visibility = "hidden";
      await drawn();
      const unlit = await pixelsOf(probe);
      for (const element of [light, ground(), rail()]) element.style.visibility = "";
      let most = 0;
      for (let y = 0; y < lit.height; y += 1) {
        for (let x = 0; x < lit.width; x += 1) {
          const [a, b] = [lit.at(x, y), unlit.at(x, y)];
          most = Math.max(most, ...[0, 1, 2].map((channel) => Math.abs(a[channel]! - b[channel]!)));
        }
      }
      expect(most, `${width}`).toBeLessThanOrEqual(1);
    }
  },
);

test.each(["dark", "light"] as const)(
  "in the %s theme, with nothing waiting, no view holds a warm colour and the lamp in the mark is a hollow ring in ink",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    const screen = await render(<App store={fixedStore(calmState())} />);
    await expect.element(screen.getByRole("region", { name: "Sessions" })).toBeVisible();
    // The timeline has been drawn, with its answered wait.
    await vi.waitFor(() =>
      expect(document.querySelector('[data-part="segment"][data-open="false"]')).not.toBeNull(),
    );

    // The hero is held by the silver light, not the lamp.
    expect(hero().dataset.light).toBe("rest");
    expect(document.querySelector(".lamp-light")).toBeNull();
    expect(document.querySelector(".rest-light")).not.toBeNull();

    for (const view of ["overview", "sources", "settings"] as const) {
      location.hash = `#${view}`;
      await vi.waitFor(() => expect(main().dataset.view).toBe(view));
      expect(warmPaint(document.body), view).toEqual([]);
    }
    const lamp = document.querySelector(
      '[data-slot="rail-mark"] [data-part="lamp"]',
    ) as SVGCircleElement;
    expect(getComputedStyle(lamp).fill).toBe("none");
    expect(getComputedStyle(lamp).stroke).toBe(rgbOf("var(--ink)"));
    expect(solidButtons()).toEqual([]);
  },
);

test.each(["dark", "light"] as const)(
  "in the %s theme, with one session waiting, amber marks it everywhere it appears, and the hero's Jump is the one solid button",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    const screen = await render(<App store={fixedStore(liveState())} />);
    await expect.element(screen.getByRole("region", { name: "Sessions" })).toBeVisible();
    const fill = rgbOf("var(--status-needs-you)");

    // The lamp in the mark.
    const lamp = getComputedStyle(
      document.querySelector('[data-slot="rail-mark"] [data-part="lamp"]')!,
    );
    expect(lamp.fill).toBe(fill);

    // The hero: lit, its lamp breathing, with the lamp's light behind it.
    expect(hero().dataset.light).toBe("lamp");
    expect(
      hero()
        .querySelector('[data-part="title"] [data-slot="status-mark"]')
        ?.getAttribute("data-breathing"),
    ).toBe("true");
    const light = document.querySelector('[data-slot="hero-light"]') as HTMLElement;
    expect(light.classList.contains("lamp-light")).toBe(true);

    // Its Jump, the one solid button on the screen. The table's Jumps are quiet.
    const jump = screen.getByRole("link", { name: "Jump to blocked-one in VS Code" }).element();
    expect(solidButtons()).toEqual([jump]);
    expect(hero().contains(jump)).toBe(true);
    const quiet = screen.getByRole("link", { name: "Jump to idle-one in Terminal" }).element();
    expect(warmPaint(quiet)).toEqual([]);
    // The table has no row for it.
    expect(document.querySelector('[data-slot="session-row"][data-status="needs-you"]')).toBeNull();

    // Its event, with the lit lamp.
    const event = document.querySelector('[data-slot="event-row"][data-lit]') as HTMLElement;
    expect(event.textContent).toContain("blocked-one");
    expect(event.querySelector('[data-slot="status-mark"]')?.getAttribute("data-lit")).toBe("true");

    // Its open block on the timeline.
    await vi.waitFor(() =>
      expect(document.querySelector('[data-part="segment"][data-open="true"]')).not.toBeNull(),
    );
    const block = document.querySelector(
      '[data-part="segment"][data-open="true"] [data-part="mark"]',
    ) as HTMLElement;
    expect(getComputedStyle(block).backgroundColor).toBe(fill);

    // And nothing else: every warm paint on the page belongs to one of those, or
    // to the open wait at the foot of the Last hour bars and its legend.
    const allowed = [
      document.querySelector('[data-slot="rail-mark"]'),
      hero(),
      light,
      event,
      document.querySelector('[data-part="segment"][data-open="true"]'),
      document.querySelector('[data-slot="timeline-legend"] [data-kind="needs-you"]'),
      // The timeline's label for the waiting session carries its mark too.
      [...document.querySelectorAll('[data-slot="timeline-row"]')].find((r) =>
        r.querySelector('[data-slot="status-mark"][data-kind="needs-you"]'),
      ),
      ...document.querySelectorAll('[data-slot="last-hour-chart"] [data-kind="open"]'),
      document.querySelector('[data-slot="last-hour-legend"] [data-kind="needs-you"]'),
    ].filter((element): element is Element => element !== null && element !== undefined);
    const stray = warmElements(document.body).filter(
      (element) => !allowed.some((owner) => owner.contains(element)),
    );
    expect(stray.map((element) => element.outerHTML.slice(0, 120))).toEqual([]);
  },
);

/** Ten minutes of polls in which one session waited for the first five, and none has since. */
function waitedEarlier() {
  const now = Date.now();
  const points = [];
  for (let at = now - 10 * MINUTE; at <= now; at += 2_000) {
    const needsYou = at < now - 5 * MINUTE ? 1 : 0;
    points.push({ at, needsYou, working: 1 - needsYou, idle: 1, total: 2 });
  }
  return { points, startedAt: now - 10 * MINUTE };
}

test.each(["dark", "light"] as const)(
  "in the %s theme the Needs you history is drawn in amber only while a session needs the person now",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    // Nothing waits now, though a session waited earlier in the window.
    const store = fixedStore(calmState({ history: waitedEarlier() }));
    const screen = await render(<App store={store} />);

    await screen.getByRole("button", { name: "Nothing needs you" }).click();
    await expect.element(screen.getByRole("dialog", { name: "Needs you" })).toBeVisible();
    const chart = screen.getByRole("slider", { name: /Sessions that need you/ }).element();
    await vi.waitFor(() => expect(chart.querySelector('[data-part="line"]')).not.toBeNull());
    const stroke = () => getComputedStyle(chart.querySelector('[data-part="line"]')!).stroke;

    // The past wait is still drawn, in the cool tone, and nothing on the screen,
    // the dialog included, is warm.
    expect(stroke()).toBe(rgbOf("var(--status-idle)"));
    expect(warmPaint(document.body)).toEqual([]);

    // A session starts waiting while the dialog is open, and the line lights with the lamp.
    store.set(liveState());
    await vi.waitFor(() => expect(stroke()).toBe(rgbOf("var(--status-needs-you-edge)")));
  },
);

test("every control on the Overview shows the focus ring when reached by Tab", async () => {
  const screen = await render(<App store={fixedStore(liveState())} />);
  await expect.element(screen.getByRole("region", { name: "Sessions" })).toBeVisible();
  await pointAway();
  const focus = rgbOf("var(--focus)");

  startAtTop();
  const seen = new Set<Element>();
  for (let presses = 0; presses < 80; presses += 1) {
    await userEvent.tab();
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body || seen.has(active)) break;
    seen.add(active);
    // A count's button draws its ring around the whole count.
    const ringed = active.closest('[data-slot="count"][data-opens]') ?? active;
    const style = getComputedStyle(ringed);
    const what = `${active.tagName} ${active.getAttribute("aria-label") ?? active.textContent?.slice(0, 30)}`;
    expect(style.outlineStyle, what).toBe("solid");
    expect(style.outlineWidth, what).toBe("2px");
    expect(style.outlineColor, what).toBe(focus);
  }
  // The rail, the header, the hero's title and Jump, the counts, the Last hour
  // chart, the table, the log and the timeline were all on the way.
  const stops = [...seen];
  expect(stops.some((stop) => rail().contains(stop))).toBe(true);
  expect(stops.some((stop) => header().contains(stop))).toBe(true);
  expect(stops.some((stop) => stop.closest('[data-part="title"]'))).toBe(true);
  expect(
    stops.some((stop) => hero().contains(stop) && stop.getAttribute("data-part") === "jump"),
  ).toBe(true);
  expect(stops.some((stop) => stop.closest('[data-slot="count"]'))).toBe(true);
  expect(stops.some((stop) => stop.getAttribute("data-slot") === "last-hour-chart")).toBe(true);
  expect(stops.some((stop) => stop.closest('[data-slot="session-row"]'))).toBe(true);
  expect(stops.some((stop) => stop.getAttribute("data-slot") === "event-list")).toBe(true);
  expect(stops.some((stop) => stop.getAttribute("data-part") === "segment")).toBe(true);
  // In the order they are seen: the hero before the table.
  const order = (test: (stop: Element) => boolean) => stops.findIndex(test);
  expect(order((stop) => hero().contains(stop))).toBeLessThan(
    order((stop) => stop.closest('[data-slot="session-row"]') !== null),
  );
});

test("only the header, a tooltip and the dialog blur what passes behind them", async () => {
  const screen = await render(<App store={fixedStore(liveState())} />);
  await expect.element(screen.getByRole("region", { name: "Sessions" })).toBeVisible();

  // On the page itself, the sticky header alone: the rail, the hero and every
  // card are glass with no blur.
  expect(blurred()).toEqual([header()]);
  expect(getComputedStyle(header()).position).toBe("sticky");
  expect(getComputedStyle(header()).backdropFilter).toMatch(/^blur\(30px\) saturate\(/);
  expect(getComputedStyle(rail()).backdropFilter).toBe("none");

  // A tooltip floats, and blurs.
  const folder = document.querySelector(
    '[data-slot="session-row"] [data-part="project"]',
  ) as HTMLElement;
  await userEvent.hover(folder);
  const tooltip = page.getByRole("tooltip");
  await expect.element(tooltip).toBeVisible();
  const tip = document.querySelector('[data-slot="tooltip"]') as HTMLElement;
  expect(blurred()).toEqual([header(), tip]);
  await pointAway();
  await expect.element(tooltip).not.toBeInTheDocument();

  // So does the dialog.
  await screen.getByRole("button", { name: "Working: open history" }).click();
  const dialog = screen.getByRole("dialog", { name: "Working" });
  await expect.element(dialog).toBeVisible();
  expect(blurred()).toEqual([header(), dialog.element()]);
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
});

test("the ground's light drifts while the page is in sight, and holds still while it is hidden", async () => {
  const screen = await render(<App store={fixedStore(liveState())} />);
  await expect.element(screen.getByRole("region", { name: "Sessions" })).toBeVisible();
  // The ground, and the same ground laid over the inset above the header, which
  // drifts with it so the two cannot be told apart.
  const fields = [...ground().querySelectorAll("i"), ...groundAbove().querySelectorAll("i")];
  const states = () =>
    fields.flatMap((field) => field.getAnimations().map((animation) => animation.playState));
  const running = Array<string>(6).fill("running");
  const paused = Array<string>(6).fill("paused");

  expect(fields).toHaveLength(6);
  expect(states()).toEqual(running);
  expect(ground().hasAttribute("data-drift")).toBe(false);
  expect(groundAbove().hasAttribute("data-drift")).toBe(false);

  // The tab goes into the background.
  const hide = (hidden: boolean) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  onTestFinished(() => {
    delete (document as { hidden?: boolean }).hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  hide(true);
  await vi.waitFor(() => expect(ground().dataset.drift).toBe("paused"));
  expect(groundAbove().dataset.drift).toBe("paused");
  expect(states()).toEqual(paused);

  // And comes back.
  hide(false);
  await vi.waitFor(() => expect(ground().hasAttribute("data-drift")).toBe(false));
  expect(groundAbove().hasAttribute("data-drift")).toBe(false);
  expect(states()).toEqual(running);
  // Both started together and keep the same time, so their light stays in step.
  const times = fields.map((field) => field.getAnimations()[0]?.currentTime);
  expect(times.slice(3)).toEqual(times.slice(0, 3));
});

test("while a session waits, only the hero's lamp and the ground's light move, and under reduced motion nothing does", async () => {
  // Nothing is under the pointer, so no hover is fading in or out.
  await pointAway();
  const screen = await render(<App store={fixedStore(liveState())} />);
  await expect.element(screen.getByRole("region", { name: "Sessions" })).toBeVisible();
  const halo = () =>
    getComputedStyle(
      hero().querySelector('[data-part="title"] [data-slot="status-mark"] [data-part="halo"]')!,
    );
  const light = document.querySelector('[data-slot="hero-light"]') as HTMLElement;

  expect(halo().animationName).toBe("lamp");
  // Every animation running is the lamp breathing, its light rising into place,
  // or a field of the ground drifting, under the page or laid above the header.
  const running = document.getAnimations().filter((animation) => animation.playState === "running");
  const targets = running.map((animation) => (animation.effect as KeyframeEffect).target);
  const inGround = (target: unknown) =>
    target instanceof Element && (ground().contains(target) || groundAbove().contains(target));
  for (const target of targets) {
    const owner =
      target === light ||
      inGround(target) ||
      (target instanceof Element && target.closest('[data-slot="hero"] [data-part="title"]'));
    expect(owner, (target as Element | null)?.outerHTML.slice(0, 100)).toBeTruthy();
  }
  expect(targets.filter(inGround)).toHaveLength(6);
  expect(targets.some((target) => target instanceof SVGElement)).toBe(true);

  await preferReducedMotion();
  expect(halo().animationName).toBe("none");
  expect(getComputedStyle(light).animationName).toBe("none");
  expect(document.getAnimations().filter((a) => a.playState === "running")).toHaveLength(0);
});
