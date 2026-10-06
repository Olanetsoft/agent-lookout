import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { HistoryResponse } from "@core/api";
import type { HistoryPoint, Session, SessionEvent, SourceHealth } from "@core/sessions/session";
import { HeroPanel } from "@dashboard/components/hero/HeroPanel";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import { readSession } from "@dashboard/lib/api/readApi";
import { sessionHref } from "@dashboard/lib/shell/sessionDetails";
import { makeSession } from "@tests/fixtures/session";
import { pointAway, startAtTop } from "@tests/support/browser/browser";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** A moment on the local clock, on one ordinary winter day. */
const at = (hours: number, minutes: number, seconds = 0) =>
  new Date(2026, 0, 5, hours, minutes, seconds).getTime();

const NOW = at(14, 32, 30);

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const jumpLink = (n: number) => `vscode://anthropic.claude-code/open?session=${uuid(n)}`;

function session(n: number, overrides: Partial<Session>): Session {
  return makeSession({ id: `claude-code:${uuid(n)}`, name: `project-${n}`, ...overrides });
}

const CLAUDE: SourceHealth = {
  id: "claude-code",
  label: "Claude Code",
  state: "ok",
  checkedAt: NOW,
};
const CODEX: SourceHealth = { id: "codex", label: "Codex", state: "ok", checkedAt: NOW };

/** A session waiting for permission in VS Code for 4 minutes 11 seconds. */
const WAITING = session(1, {
  name: "demo-project",
  surface: "vscode",
  status: "needs-you",
  waitingReason: "permission",
  waitingDetail: "Allow the shell command in demo",
  statusSince: NOW - (4 * MINUTE + 11 * SECOND),
  links: { open: jumpLink(1) },
});
const BUSY = session(2, { status: "working", statusSince: NOW - 34 * MINUTE });
const RESTING = session(3, { status: "idle", statusSince: NOW - 65 * MINUTE });

/** Polls every two seconds from 13:30 to the present. */
function watched(from = at(13, 30), to = NOW): HistoryResponse {
  const points: HistoryPoint[] = [];
  for (let moment = from; moment <= to; moment += 2 * SECOND) {
    points.push({ at: moment, needsYou: 0, working: 1, idle: 1, total: 2 });
  }
  return { startedAt: from, points };
}

let serial = 0;
function changed(n: number, moment: number, from: Session["status"], to: Session["status"]) {
  serial += 1;
  return {
    id: `event-${serial}`,
    at: moment,
    sessionId: `claude-code:${uuid(n)}`,
    sessionName: `project-${n}`,
    kind: "status-changed",
    from,
    to,
    severity: to === "needs-you" ? "warning" : "advisory",
  } satisfies SessionEvent;
}

/** A wait from 14:10 to 14:13 by session 4, answered. Newest first. */
const ANSWERED_WAIT: SessionEvent[] = [
  changed(4, at(14, 13), "needs-you", "working"),
  changed(4, at(14, 10), "working", "needs-you"),
];

type HeroProps = Parameters<typeof HeroPanel>[0];

function renderHero(props: Partial<HeroProps> = {}) {
  return render(
    <div style={{ width: 820, padding: 24 }}>
      <HeroPanel
        sessions={[WAITING, BUSY, RESTING]}
        sources={[CLAUDE]}
        events={[changed(1, WAITING.statusSince as number, "working", "needs-you")]}
        history={watched()}
        now={NOW}
        {...props}
      />
    </div>,
  );
}

function hero(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-slot="hero"]') as HTMLElement;
}

function part(root: ParentNode, name: string): HTMLElement {
  return root.querySelector(`[data-part="${name}"]`) as HTMLElement;
}

/** The words of every element under `root` that sets words of its own. */
function wordColours(root: Element): { text: string; colour: string }[] {
  return [root, ...root.querySelectorAll("*")]
    .filter((element) =>
      [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
      ),
    )
    .filter((element) => !element.closest(".sr-only, [hidden]"))
    .map((element) => ({
      text: element.textContent?.trim().slice(0, 30) ?? "",
      colour: getComputedStyle(element).color,
    }));
}

/** Presses Tab until `target` has focus, a few times at most. */
async function tabTo(target: Element, most = 4) {
  for (let presses = 0; presses < most && document.activeElement !== target; presses += 1) {
    await userEvent.tab();
  }
  expect(document.activeElement).toBe(target);
}

beforeEach(async () => {
  await page.viewport(1280, 900);
});

afterEach(async () => {
  document.documentElement.removeAttribute("data-theme");
  setApiHost();
  await page.viewport(414, 896);
});

test("one session waiting: its name large, why, where, a timer, and the one solid Jump", async () => {
  const screen = await renderHero();
  const panel = hero(screen.container);

  // A region called by its title, on the highest glass, holding the lamp.
  await expect.element(screen.getByRole("region", { name: /^Needs you/ })).toBeVisible();
  expect(panel.dataset.state).toBe("one");
  expect(panel.dataset.light).toBe("lamp");
  expect(getComputedStyle(panel).backgroundColor).toBe(rgbOf("var(--glass-raised)"));
  expect(part(panel, "count").textContent).toBe("1");
  expect(panel.querySelector('[data-slot="status-mark"]')?.getAttribute("data-lit")).toBe("true");

  // The name, at the hero's name size.
  const name = part(panel, "name");
  expect(name.textContent).toBe("demo-project");
  expect(getComputedStyle(name).fontSize).toBe("34px");
  expect(getComputedStyle(name).fontWeight).toBe("600");

  // Why it waits, in plain words, in the lamp's label colour, at the lead size.
  const reason = part(panel, "reason-text");
  expect(reason.textContent).toContain("Waiting for permission");
  expect(getComputedStyle(reason).color).toBe(rgbOf("var(--label-needs-you)"));
  expect(getComputedStyle(part(panel, "reason")).fontSize).toBe("16px");

  // Where it runs: the folder and the app.
  expect(part(panel, "place").textContent).toBe("demo in VS Code");
  // With one tool, the tool is not named.
  expect(part(panel, "agent")).toBeNull();

  // How long, at the wait size, in the sans, and when it began.
  const wait = part(panel, "wait");
  const figure = wait.querySelector('[data-slot="duration-figure"]') as HTMLElement;
  expect(figure.textContent).toBe("4m11s");
  expect(getComputedStyle(figure).fontSize).toBe("46px");
  expect(getComputedStyle(figure).fontFamily).toMatch(/^"?Atkinson Hyperlegible Next/);
  expect(getComputedStyle(figure.parentElement?.parentElement as Element).color).toBe(
    rgbOf("var(--label-needs-you)"),
  );
  expect(wait.textContent).toContain("Waiting 4 minutes 11 seconds");
  expect(part(panel, "since").textContent).toBe("waiting since 14:28");

  // The one solid button: the lamp's fill, 38px, a link to where the session runs.
  const jump = screen.getByRole("link", { name: "Jump to demo-project in VS Code" });
  await expect.element(jump).toHaveAttribute("href", jumpLink(1));
  const style = getComputedStyle(jump.element());
  expect(jump.element().getAttribute("data-variant")).toBe("needs-you");
  expect(style.backgroundColor).toBe(rgbOf("var(--status-needs-you)"));
  expect(style.color).toBe(rgbOf("var(--on-needs-you)"));
  expect(style.height).toBe("38px");
});

test("the vendor's own wording is one hover or one Tab away, and read out with the reason", async () => {
  const screen = await renderHero();
  const reason = part(hero(screen.container), "reason-text");

  // It is in the page for assistive technology, and on screen only in the tooltip.
  expect(reason.textContent).toBe("Waiting for permission: Allow the shell command in demo");
  expect(reason.tabIndex).toBe(0);
  await userEvent.hover(reason);
  await expect
    .element(page.getByRole("tooltip"))
    .toHaveTextContent("Waiting for permission: Allow the shell command in demo");
  await pointAway();
  await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();

  startAtTop();
  await tabTo(reason);
  await expect.element(page.getByRole("tooltip")).toHaveTextContent("Allow the shell command");
  await userEvent.keyboard("{Escape}");
});

/** A second session waiting, for a question, with no Jump. */
const LATER = session(9, {
  name: "docs-site",
  status: "needs-you",
  waitingReason: "question",
  statusSince: NOW - MINUTE,
});

/** Where a run of words is drawn, apart from any padding round it. */
function wordsOf(element: Element): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(element);
  return range.getBoundingClientRect();
}

test("each waiting session's name is a link to its details, named for it, with no tooltip when it fits", async () => {
  const screen = await renderHero({ sessions: [{ ...WAITING, waitingDetail: undefined }, LATER] });
  const lead = screen.getByRole("link", { name: "demo-project, details" });
  const later = screen.getByRole("link", { name: "docs-site, details" });

  for (const [link, waiting] of [
    [lead, WAITING],
    [later, LATER],
  ] as const) {
    const name = link.element() as HTMLAnchorElement;
    expect(name.dataset.part).toBe("name");
    expect(name.closest('[data-slot="hero-session"]')?.getAttribute("data-session")).toBe(
      waiting.id,
    );
    await expect.element(link).toHaveAttribute("href", sessionHref(waiting.id));
    await expect.element(link).toHaveAttribute("aria-haspopup", "dialog");
    // A link is always a stop on the way through the page.
    expect(name.tabIndex).toBe(0);
    // It fits with room to spare. Cut text has a tooltip; text that fits has
    // none. At the name size the line is tighter than the letters, and that
    // alone must not read as cut.
    expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(name.dataset.cut).toBe("false");
  }
});

test("a click on a waiting session's name opens its details at their address, and a click anywhere else in the hero opens nothing", async () => {
  const start = location.href;
  onTestFinished(() => history.replaceState(null, "", start));
  const screen = await renderHero({ sessions: [WAITING, LATER, BUSY] });
  const rows = [
    ...hero(screen.container).querySelectorAll<HTMLElement>('[data-slot="hero-session"]'),
  ];
  expect(rows).toHaveLength(2);

  // The hero is not a row: its reason, its place, its wait and its blank space open nothing.
  for (const row of rows) {
    for (const name of ["reason", "place", "wait"]) await userEvent.click(part(row, name));
    const blank = { x: Math.round(row.getBoundingClientRect().width * 0.6), y: 4 };
    expect(
      document
        .elementFromPoint(
          row.getBoundingClientRect().left + blank.x,
          row.getBoundingClientRect().top + blank.y,
        )
        ?.closest("a"),
    ).toBeNull();
    await userEvent.click(row, { position: blank });
  }
  expect(location.hash).toBe("");

  await screen.getByRole("link", { name: "docs-site, details" }).click();
  expect(location.hash).toBe(sessionHref(LATER.id));
  await screen.getByRole("link", { name: "demo-project, details" }).click();
  expect(location.hash).toBe(sessionHref(WAITING.id));
});

test.each(["dark", "light"] as const)(
  "in the %s theme, wide and narrow, each waiting name looks as it did, lights under the pointer as a quiet shape, and has the one focus ring",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    for (const [width, leadSize] of [
      [1440, 34],
      [375, 28],
    ] as const) {
      await page.viewport(width, 900);
      const screen = await render(
        <div style={{ maxWidth: 820, padding: 16 }}>
          <HeroPanel
            sessions={[WAITING, LATER, BUSY]}
            sources={[CLAUDE]}
            history={watched()}
            now={NOW}
          />
        </div>,
      );
      const rows = [
        ...hero(screen.container).querySelectorAll<HTMLElement>('[data-slot="hero-session"]'),
      ];
      for (const [row, size] of [
        [rows[0]!, leadSize],
        [rows[1]!, 16],
      ] as const) {
        const name = part(row, "name");
        const what = `${width}: ${name.textContent}`;
        const style = getComputedStyle(name);

        // The name's type, size and colour, with nothing under it and no underline.
        expect(style.fontSize, what).toBe(`${size}px`);
        expect(style.fontWeight, what).toBe("600");
        expect(style.color, what).toBe(rgbOf("var(--ink)"));
        expect(style.textDecorationLine, what).toBe("none");
        expect(style.backgroundColor, what).toBe("rgba(0, 0, 0, 0)");
        expect(style.outlineStyle, what).toBe("none");
        // Its words start where the reason's do, and its line is no taller than its words'.
        const words = wordsOf(name);
        expect(words.left, what).toBeCloseTo(wordsOf(part(row, "reason-text")).left, 0);
        expect(name.parentElement!.getBoundingClientRect().height, what).toBeCloseTo(
          Number.parseFloat(style.lineHeight),
          0,
        );

        // Under the pointer it lights as a quiet rounded shape round the words, which stay put.
        await userEvent.hover(name);
        await vi.waitFor(() =>
          expect(getComputedStyle(name).backgroundColor, what).toBe(rgbOf("var(--fill-hover)")),
        );
        expect(getComputedStyle(name).transitionDuration, what).toBe("0.12s");
        expect(getComputedStyle(name).borderRadius, what).toBe("10px");
        const shape = name.getBoundingClientRect();
        expect(shape.left, what).toBeLessThan(words.left);
        expect(shape.right, what).toBeGreaterThan(words.right);
        expect(wordsOf(name).left, what).toBe(words.left);
        expect(warmPaint(name), what).toEqual([]);
        await pointAway();

        // Reached by Tab, the one ring every control has, round that shape.
        startAtTop();
        await tabTo(name, 12);
        const ring = getComputedStyle(name);
        expect(name.matches(":focus-visible"), what).toBe(true);
        expect(ring.outlineStyle, what).toBe("solid");
        expect(ring.outlineWidth, what).toBe("2px");
        expect(ring.outlineOffset, what).toBe("2px");
        expect(ring.outlineColor, what).toBe(rgbOf("var(--focus)"));
        expect(ring.color, what).toBe(rgbOf("var(--ink)"));
      }
      // The amber Jump is as it was.
      const jump = part(rows[0]!, "jump");
      expect(getComputedStyle(jump).backgroundColor).toBe(rgbOf("var(--status-needs-you)"));
      expect(getComputedStyle(jump).height).toBe("38px");
      screen.unmount();
    }
  },
);

test("wording that only repeats the reason is left out, and the reason is then no stop on the way", async () => {
  const screen = await renderHero({
    sessions: [{ ...WAITING, waitingDetail: "permission prompt" }],
  });
  const reason = part(hero(screen.container), "reason-text");

  expect(reason.textContent).toBe("Waiting for permission");
  expect(reason.hasAttribute("tabindex")).toBe(false);
});

test("the folder's whole path is one hover or one Tab away", async () => {
  const screen = await renderHero({
    sessions: [{ ...WAITING, waitingDetail: undefined }],
  });
  const folder = part(hero(screen.container), "project");

  expect(folder.textContent).toBe("demo");
  expect(folder.tabIndex).toBe(0);
  startAtTop();
  await tabTo(folder);
  await expect.element(page.getByRole("tooltip")).toHaveTextContent("/Users/example/code/demo");
  await userEvent.keyboard("{Escape}");

  // With no folder, it says the app alone.
  await screen.rerender(
    <HeroPanel
      sessions={[{ ...WAITING, project: null, cwd: null }]}
      sources={[CLAUDE]}
      history={watched()}
      now={NOW}
    />,
  );
  expect(part(hero(screen.container), "place").textContent).toBe("In VS Code");
});

test("with two tools found, the hero names the session's tool beside where it runs", async () => {
  const screen = await renderHero({ sources: [CLAUDE, CODEX] });
  const place = part(hero(screen.container), "place");

  expect(part(place, "agent").textContent).toBe("Claude Code");
  // Read as "demo in VS Code, Claude Code"; the dot between them is only on screen.
  expect(place.textContent).toBe("demo in VS Code, ·Claude Code");
  // A tool that was not found is not a second tool.
  await screen.rerender(
    <HeroPanel
      sessions={[WAITING]}
      sources={[CLAUDE, { ...CODEX, state: "unavailable" }]}
      history={watched()}
      now={NOW}
    />,
  );
  expect(part(hero(screen.container), "agent")).toBeNull();
});

/** Waiting sessions in a worktree on a branch, in a repository at a commit, and in no repository. */
function inRepositories(): Session[] {
  return [
    {
      ...WAITING,
      cwd: "/Users/example/code/storefront-checkout",
      project: "storefront",
      git: { branch: "checkout-flow" },
    },
    session(5, {
      name: "docs-site",
      status: "needs-you",
      waitingReason: "question",
      statusSince: NOW - 2 * MINUTE,
      cwd: "/Users/example/code/docs",
      project: "docs",
      git: { commit: "3f9a2c1" },
    }),
    session(6, {
      name: "mobile-onboarding",
      status: "needs-you",
      waitingReason: "question",
      statusSince: NOW - MINUTE,
      cwd: "/Users/example/code/mobile-app",
      project: "mobile-app",
    }),
  ];
}

test.each(["dark", "light"] as const)(
  "in the %s theme where a session runs says its branch, or its commit with no branch checked out, and nothing in no repository",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await renderHero({ sessions: inRepositories() });
    const [lead, docs, mobile] = [
      ...hero(screen.container).querySelectorAll<HTMLElement>('[data-slot="hero-session"]'),
    ].map((row) => part(row, "place"));

    // "storefront on checkout-flow in VS Code", read as "on branch checkout-flow".
    expect(lead?.textContent).toBe("storefront on branch checkout-flow in VS Code");
    const branch = part(lead!, "branch");
    expect(branch.textContent).toBe("checkout-flow");
    // A word, like the folder: the sans, in ink at 500, on the folder's line.
    const project = part(lead!, "project").getBoundingClientRect();
    const box = branch.getBoundingClientRect();
    expect(box.top).toBeLessThan(project.bottom);
    expect(box.bottom).toBeGreaterThan(project.top);
    for (const style of [getComputedStyle(branch), getComputedStyle(part(lead!, "project"))]) {
      expect(style.fontFamily).toMatch(/^"?Atkinson Hyperlegible Next/);
      expect(style.color).toBe(rgbOf("var(--ink)"));
      expect(style.fontWeight).toBe("500");
    }

    // With no branch checked out, the commit, a string read character by character.
    expect(docs?.textContent).toBe("docs at commit 3f9a2c1 in Terminal");
    const commit = part(docs!, "commit");
    expect(commit.textContent).toBe("3f9a2c1");
    expect(getComputedStyle(commit).fontFamily).toMatch(/^"?Atkinson Hyperlegible Mono/);
    expect(getComputedStyle(commit).color).toBe(rgbOf("var(--ink)"));

    // In no repository, the place is as it always was.
    expect(mobile?.textContent).toBe("mobile-app in Terminal");
    expect(part(mobile!, "git")).toBeNull();

    // None of it is warm, and none of it is in the muted ink the hero never uses.
    for (const place of [lead, docs, mobile]) {
      expect(warmPaint(place!)).toEqual([]);
      for (const { text, colour } of wordColours(place!)) {
        expect(colour, text).not.toBe(rgbOf("var(--ink-muted)"));
      }
    }
  },
);

test("a branch too long for its line is cut there, and stays one hover or one Tab away", async () => {
  await page.viewport(375, 800);
  const long = `fix/${"rate-limits-".repeat(30)}end`;
  const waiting = { ...inRepositories()[0]!, git: { branch: long } };
  const screen = await render(
    <div style={{ width: 283 }}>
      <HeroPanel sessions={[waiting, inRepositories()[1]!]} sources={[CLAUDE]} now={NOW} />
    </div>,
  );
  const panel = hero(screen.container);
  const [lead, other] = [...panel.querySelectorAll<HTMLElement>('[data-part="place"]')];
  const branch = part(lead!, "branch");

  expect(branch.textContent).toBe(long);
  expect(getComputedStyle(branch).textOverflow).toBe("ellipsis");
  expect(branch.getBoundingClientRect().right).toBeLessThanOrEqual(
    lead!.getBoundingClientRect().right + 0.5,
  );
  expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
    document.documentElement.clientWidth,
  );
  expect(part(other!, "commit").textContent).toBe("3f9a2c1");

  await vi.waitFor(() => expect(branch.dataset.cut).toBe("true"));
  startAtTop();
  await tabTo(part(lead!, "project"));
  await userEvent.keyboard("{Escape}");
  await tabTo(branch);
  await expect.element(page.getByRole("tooltip")).toHaveTextContent(long);
});

test.each(["dark", "light"] as const)(
  "in the %s theme at the width of a phone, a later wait's long branch is cut by its own ellipsis, and the app and the agent still show",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    await page.viewport(375, 800);
    const long = "feature/checkout-retry-on-gateway-timeout";
    const later = {
      ...inRepositories()[1]!,
      cwd: "/Users/example/code/infra",
      project: "infra",
      git: { branch: long },
    };
    const screen = await render(
      <div style={{ width: 283 }}>
        <HeroPanel sessions={[inRepositories()[0]!, later]} sources={[CLAUDE, CODEX]} now={NOW} />
      </div>,
    );
    const panel = hero(screen.container);
    const place = part(panel.querySelector(`[data-session="${later.id}"]`) as HTMLElement, "place");
    const branch = part(place, "branch");
    const bounds = place.getBoundingClientRect();

    expect(branch.textContent).toBe(long);
    expect(getComputedStyle(branch).textOverflow).toBe("ellipsis");
    await vi.waitFor(() => expect(branch.dataset.cut).toBe("true"));
    // The branch, the app and the agent each show inside the place: none is hidden past its end.
    for (const name of ["branch", "app", "agent"]) {
      const box = part(place, name).getBoundingClientRect();
      expect(box.width, name).toBeGreaterThan(0);
      expect(box.left, name).toBeGreaterThanOrEqual(bounds.left - 0.5);
      expect(box.right, name).toBeLessThanOrEqual(bounds.right + 0.5);
      expect(box.bottom, name).toBeLessThanOrEqual(bounds.bottom + 0.5);
    }
    expect(part(place, "app").textContent).toBe("Terminal");
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    );
  },
);

test("Jump is there only when the session's link is one its source is known to build", async () => {
  for (const links of [
    {},
    { open: "https://example.com/session" },
    { open: "vscode://another.extension/open?session=1" },
    { open: `${jumpLink(1)}&next=https://example.com` },
  ]) {
    const screen = await renderHero({ sessions: [{ ...WAITING, links }] });
    expect(
      hero(screen.container).querySelector('[data-part="jump"]'),
      JSON.stringify(links),
    ).toBeNull();
    // Everything else about the wait is still there.
    expect(part(hero(screen.container), "name").textContent).toBe("demo-project");
  }
  // Codex documents no address that opens a session, so it has no Jump.
  const codex = await renderHero({
    sessions: [{ ...WAITING, id: "codex:demo", source: "codex", links: { open: jumpLink(1) } }],
  });
  expect(hero(codex.container).querySelector('[data-part="jump"]')).toBeNull();
});

const STATUS_FILES: SourceHealth = {
  id: "status-files",
  label: "Status files",
  state: "ok",
  checkedAt: NOW,
};

/** A session waiting in a status file Night Shift wrote, named after its file. */
function custom(file: string, overrides: Partial<Session> = {}): Session {
  return {
    ...WAITING,
    id: `status-files:${file}.json`,
    source: "status-files",
    agent: "Night Shift",
    surface: "unknown",
    name: file,
    cwd: `/Users/example/code/${file}`,
    project: file,
    waitingReason: "question",
    waitingDetail: undefined,
    ...overrides,
  };
}

test("a waiting session from a status file names its own agent, and has no Jump", async () => {
  // A link the page would open for Claude Code is still no Jump here.
  const waiting = custom("checkout-flow", { links: { open: jumpLink(1) } });
  const screen = await renderHero({ sessions: [waiting, BUSY], sources: [CLAUDE, STATUS_FILES] });
  const panel = hero(screen.container);

  expect(part(panel, "name").textContent).toBe("checkout-flow");
  expect(part(panel, "reason").textContent).toContain("Asked you a question");
  expect(part(part(panel, "place"), "agent").textContent).toBe("Night Shift");
  expect(panel.querySelector('[data-part="jump"]')).toBeNull();
  // Its one link is its name's, to its details.
  expect(panel.querySelector('a:not([data-part="name"])')).toBeNull();
});

test("where a session runs leaves out an app that is not known, in the longest wait and in a later one", async () => {
  const sessions = [
    custom("checkout-flow", {
      agent: "my-agent",
      cwd: "/Users/example/code/storefront",
      project: "storefront",
      git: { branch: "checkout-flow" },
      statusSince: NOW - 10 * MINUTE,
    }),
    custom("billing-webhooks", { agent: "my-agent", statusSince: NOW - MINUTE }),
  ];
  const screen = await renderHero({ sessions, sources: [CLAUDE, STATUS_FILES] });
  const panel = hero(screen.container);
  const [lead, later] = [...panel.querySelectorAll<HTMLElement>('[data-slot="hero-session"]')].map(
    (row) => part(row, "place"),
  );

  // "storefront on checkout-flow · my-agent", read as "on branch checkout-flow, my-agent".
  expect(lead?.textContent).toBe("storefront on branch checkout-flow, ·my-agent");
  expect(later?.textContent).toBe("billing-webhooks, ·my-agent");
  for (const place of [lead!, later!]) {
    expect(part(place, "app")).toBeNull();
    expect(part(place, "agent").textContent).toBe("my-agent");
  }
  expect(panel.textContent).not.toContain("Unknown app");

  // With no folder, the tool stands alone, with no dot before it.
  await screen.rerender(
    <HeroPanel
      sessions={[custom("checkout-flow", { agent: "my-agent", cwd: null, project: null })]}
      sources={[CLAUDE, STATUS_FILES]}
      history={watched()}
      now={NOW}
    />,
  );
  const alone = part(hero(screen.container), "place");
  expect(alone.textContent).toBe("my-agent");
  expect(alone.querySelector('[aria-hidden="true"]')).toBeNull();

  // With no tool to name either, there is nothing to say, and no line.
  await screen.rerender(
    <HeroPanel
      sessions={[{ ...WAITING, surface: "unknown", cwd: null, project: null }]}
      sources={[CLAUDE]}
      history={watched()}
      now={NOW}
    />,
  );
  expect(hero(screen.container).querySelector('[data-part="place"]')).toBeNull();
  expect(part(hero(screen.container), "name").textContent).toBe("demo-project");
  expect(hero(screen.container).textContent).not.toContain("Unknown app");
});

test.each([
  ["in the longest wait", 0],
  ["in a later wait", 1],
])(
  "at the width of a phone, an agent and a folder that status files give as one long word stay inside the page, the agent %s",
  async (_, longAgentAt) => {
    await page.viewport(375, 800);
    // No hyphen, so no place where a browser would break it of its own accord.
    const folder = "searchindexing".repeat(43);
    // The one that has waited longer is the hero's lead.
    const since = (index: number) => NOW - (index === longAgentAt ? 10 : 1) * MINUTE;
    const sessions = [
      custom("checkout-flow", { agent: "W".repeat(40), statusSince: since(0) }),
      custom("billing-webhooks", {
        cwd: `/Users/example/code/${folder}`,
        project: folder,
        statusSince: since(1),
      }),
    ];
    // The hero as a window 375 pixels wide draws it, beside the rail.
    const screen = await render(
      <div style={{ width: 283 }}>
        <HeroPanel
          sessions={sessions}
          sources={[CLAUDE, STATUS_FILES]}
          history={watched()}
          now={NOW}
        />
      </div>,
    );
    const panel = hero(screen.container);

    expect(panel.querySelectorAll('[data-slot="hero-session"]')).toHaveLength(2);
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    );
  },
);

test("a waiting session whose process has gone says so beside its name", async () => {
  const screen = await renderHero({ sessions: [{ ...WAITING, alive: false }] });

  await expect.element(screen.getByText("Process ended")).toBeVisible();
  const badge = screen.container.querySelector('[data-slot="badge"]') as HTMLElement;
  expect(badge.getAttribute("data-tone")).toBe("outline");
  expect(badge.parentElement?.contains(part(hero(screen.container), "name"))).toBe(true);
});

test.each([375, 1280])(
  "at %ipx, a wait on another machine has the machine's name beside its name, no Jump, no Allow or Deny, and counts",
  async (width) => {
    await page.viewport(width, 900);
    // As the page reads it, whatever was sent: a Jump and a request to answer act here only.
    const there = readSession({
      ...makeSession({
        ...WAITING,
        id: `remote:devbox:claude-code:${uuid(1)}`,
        source: "remote:devbox",
        agent: "Claude Code",
        machine: "devbox",
        links: {},
      }),
      jump: { kind: "tmux", place: "work:1.0" },
      ask: {
        requestId: "0123456789abcdef0123456789abcdef",
        tool: "Bash",
        command: "npm test",
        allow: true,
        until: NOW + 300_000,
      },
    });
    if (!there) throw new Error("expected a session");
    const devbox: SourceHealth = {
      id: "remote:devbox",
      label: "devbox",
      machine: "devbox",
      state: "ok",
      checkedAt: NOW,
    };
    const screen = await render(
      <div style={{ width: width === 375 ? 343 : 820 }}>
        <HeroPanel
          sessions={[there, BUSY]}
          sources={[CLAUDE, devbox]}
          history={watched()}
          now={NOW}
        />
      </div>,
    );
    const panel = hero(screen.container);
    const badge = part(panel, "machine");
    expect(badge.textContent).toBe("on devbox");
    expect(badge.getAttribute("data-tone")).toBe("neutral");
    expect(badge.parentElement?.contains(part(panel, "name"))).toBe(true);
    // The wait is counted under Needs you, and has no Jump of its own.
    expect(panel.querySelectorAll('[data-slot="hero-session"]')).toHaveLength(1);
    expect(panel.querySelector('[data-part="jump"]')).toBeNull();
    expect(panel.querySelector('[data-slot="answer"]')).toBeNull();
    // Only the needs-you signals are warm: the badge is not.
    expect(warmPaint(badge)).toEqual([]);
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  },
);

/** Another machine's source, read or not. */
function machine(name: string, state: SourceHealth["state"]): SourceHealth {
  return { id: `remote:${name}`, label: name, machine: name, state, checkedAt: NOW };
}

test.each([375, 1280])(
  "at %ipx, a machine's name as long as one can be goes under the session's name, which is not cut for it",
  async (width) => {
    await page.viewport(width, 900);
    const long = "build-server-eu-west-02a";
    const there = (n: number, name: string) =>
      makeSession({
        ...WAITING,
        id: `remote:${long}:claude-code:${uuid(n)}`,
        source: `remote:${long}`,
        agent: "Claude Code",
        machine: long,
        name,
        statusSince: NOW - n * MINUTE,
        links: {},
      });
    const screen = await render(
      <div style={{ width: width === 375 ? 283 : 820 }}>
        <HeroPanel
          sessions={[there(9, "demo-local"), there(3, "demo-local-two")]}
          sources={[CLAUDE, machine(long, "ok")]}
          history={watched()}
          now={NOW}
        />
      </div>,
    );
    const panel = hero(screen.container);
    for (const row of panel.querySelectorAll('[data-slot="hero-session"]')) {
      const name = part(row, "name");
      const badge = part(row, "machine");
      // Every letter of the session's name is shown, and the machine's whole.
      expect(name.getAttribute("data-cut")).toBe("false");
      expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
      expect(badge.scrollWidth).toBeLessThanOrEqual(badge.clientWidth);
      expect(badge.textContent).toBe(`on ${long}`);
      if (width === 375) {
        expect(badge.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          name.getBoundingClientRect().bottom - 1,
        );
      }
    }
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  },
);

test("with another machine not connected, the quiet hero speaks for this computer only, and says which is not known", async () => {
  const screen = await renderHero({
    sessions: [BUSY, RESTING],
    sources: [CLAUDE, machine("devbox", "unavailable")],
  });
  const panel = hero(screen.container);
  expect(panel.dataset.state).toBe("quiet");
  await expect
    .element(screen.getByRole("heading", { level: 2, name: "Nothing on this computer needs you" }))
    .toBeVisible();
  expect(panel.textContent).not.toContain("Nothing needs you");
  expect(part(panel, "unseen").textContent).toBe(
    "devbox is not connected, so its sessions are not known. Sources says why.",
  );
  const link = screen.getByRole("link", { name: "Sources" });
  await expect.element(link).toHaveAttribute("href", "#sources");
  // Said plainly: a machine that is switched off is no fault, so nothing is warm.
  expect(warmPaint(part(panel, "unseen"))).toEqual([]);
});

test("a machine that is read is named with this computer, and one still connecting is not known yet", async () => {
  const screen = await renderHero({
    sessions: [BUSY],
    sources: [CLAUDE, machine("gpu", "ok"), machine("devbox", "searching")],
  });
  const panel = hero(screen.container);
  await expect
    .element(
      screen.getByRole("heading", { level: 2, name: "Nothing on this computer or gpu needs you" }),
    )
    .toBeVisible();
  expect(part(panel, "unseen").textContent).toBe(
    "devbox is still connecting, so its sessions are not known yet. Sources says why.",
  );
});

test("with every machine read, the quiet hero says Nothing needs you as before", async () => {
  const screen = await renderHero({
    sessions: [BUSY],
    sources: [CLAUDE, machine("devbox", "ok")],
  });
  await expect
    .element(screen.getByRole("heading", { level: 2, name: "Nothing needs you" }))
    .toBeVisible();
  expect(part(hero(screen.container), "unseen")).toBeNull();
});

test("while only another machine is still being reached, the hero says so, not that agents here are looked for", async () => {
  const screen = await renderHero({
    sessions: [],
    sources: [{ ...CLAUDE, state: "unavailable" }, machine("devbox", "searching")],
  });
  const panel = hero(screen.container);
  expect(panel.dataset.state).toBe("uncounted");
  expect(part(panel, "uncounted").textContent).toBe(
    "Agent Lookout is still connecting to devbox over SSH. The count follows as soon as it is read.",
  );
});

test("the timer ticks with the clock, and stops at the last answer once answers stop", async () => {
  const screen = await renderHero();
  const figure = () =>
    hero(screen.container).querySelector('[data-part="wait"] [data-slot="duration-figure"]')
      ?.textContent;

  expect(figure()).toBe("4m11s");
  await screen.rerender(
    <HeroPanel sessions={[WAITING]} sources={[CLAUDE]} history={watched()} now={NOW + 5_000} />,
  );
  expect(figure()).toBe("4m16s");

  // Answers stopped at NOW. The clock goes on; nothing was measured after it.
  for (const later of [10_000, 61_000]) {
    await screen.rerender(
      <HeroPanel
        sessions={[WAITING]}
        sources={[CLAUDE]}
        history={watched()}
        now={NOW + later}
        asOf={NOW}
      />,
    );
    expect(figure()).toBe("4m11s");
  }
});

test("a wait whose start was not reported says so, and claims no length", async () => {
  const screen = await renderHero({ sessions: [{ ...WAITING, statusSince: null }] });
  const wait = part(hero(screen.container), "wait");

  expect(wait.querySelector('[data-slot="duration-figure"]')).toBeNull();
  expect(wait.textContent).toContain("How long it has waited was not reported");
  expect(part(hero(screen.container), "since").textContent).toBe("time not reported");
});

test("several waiting: every one is listed longest wait first, each with its reason, its timer and its Jump", async () => {
  const sessions = [
    session(5, {
      name: "recent-wait",
      status: "needs-you",
      waitingReason: "question",
      statusSince: NOW - 38 * SECOND,
      links: { open: jumpLink(5) },
    }),
    WAITING,
    session(6, {
      name: "middle-wait",
      surface: "terminal",
      status: "needs-you",
      statusSince: NOW - (1 * MINUTE + 5 * SECOND),
      links: { open: jumpLink(6) },
    }),
    session(7, { name: "unreported-wait", status: "needs-you", statusSince: null }),
    BUSY,
  ];
  const screen = await renderHero({ sessions });
  const panel = hero(screen.container);

  expect(panel.dataset.state).toBe("several");
  expect(part(panel, "count").textContent).toBe("4");
  const order = [...panel.querySelectorAll('[data-slot="hero-session"] [data-part="name"]')].map(
    (name) => name.textContent,
  );
  expect(order).toEqual(["demo-project", "middle-wait", "recent-wait", "unreported-wait"]);

  // The longest is shown in full; the others are a list under it.
  const list = screen.getByRole("list", { name: "Also waiting, longest first" }).element();
  const rows = [...list.querySelectorAll<HTMLElement>('[data-slot="hero-session"]')];
  expect(rows).toHaveLength(3);
  const [middle, recent, unreported] = rows as [HTMLElement, HTMLElement, HTMLElement];
  expect(part(middle, "reason").textContent).toContain("Waiting for you");
  expect(part(middle, "wait").textContent).toContain("1m 05s");
  expect(part(recent, "reason").textContent).toContain("Asked you a question");
  expect(part(recent, "wait").textContent).toContain("38s");
  expect(part(unreported, "wait").textContent).toContain("not reported");
  for (const row of rows) {
    expect(getComputedStyle(part(row, "wait")).color).toBe(rgbOf("var(--label-needs-you)"));
  }

  // Each with a link has its own Jump, each the lamp's solid button.
  const jumps = [...panel.querySelectorAll<HTMLElement>('[data-part="jump"]')];
  expect(jumps.map((jump) => jump.getAttribute("aria-label"))).toEqual([
    "Jump to demo-project in VS Code",
    "Jump to middle-wait in Terminal",
    "Jump to recent-wait in Terminal",
  ]);
  for (const jump of jumps) {
    expect(getComputedStyle(jump).backgroundColor).toBe(rgbOf("var(--status-needs-you)"));
  }

  // They tick together, and keep their order.
  await screen.rerender(
    <div style={{ width: 820, padding: 24 }}>
      <HeroPanel sessions={sessions} sources={[CLAUDE]} history={watched()} now={NOW + 20_000} />
    </div>,
  );
  expect(middle.isConnected).toBe(true);
  expect(part(middle, "wait").textContent).toContain("1m 25s");
  expect(part(recent, "wait").textContent).toContain("58s");
});

test("nothing waiting: it says Nothing needs you at the name's size with the lamp out, and gives the last wait that is over", async () => {
  const screen = await renderHero({ sessions: [BUSY, RESTING], events: ANSWERED_WAIT });
  const panel = hero(screen.container);

  expect(panel.dataset.state).toBe("quiet");
  expect(panel.dataset.light).toBe("rest");
  const title = screen.getByRole("heading", { level: 2, name: "Nothing needs you" });
  expect(getComputedStyle(title.element()).fontSize).toBe("34px");
  const mark = title.element().querySelector('[data-slot="status-mark"]') as HTMLElement;
  expect(mark.dataset.lit).toBe("false");
  await expect.element(screen.getByRole("region", { name: "Nothing needs you" })).toBeVisible();

  // The last wait, at the wait size in ink, and whose it was and when it was answered.
  const last = part(panel, "last-wait");
  const figure = last.querySelector('[data-slot="duration-figure"]') as HTMLElement;
  expect(figure.textContent).toBe("3m00s");
  expect(getComputedStyle(figure.parentElement?.parentElement as Element).color).toBe(
    rgbOf("var(--ink)"),
  );
  expect(last.textContent).toContain("The last wait lasted 3 minutes");
  expect(part(last, "last-note").textContent).toBe("project-4, answered at 14:13");

  // No timer, no reason, no Jump.
  expect(panel.querySelector('[data-slot="hero-session"]')).toBeNull();
  expect(panel.querySelector('[data-part="jump"]')).toBeNull();
});

test("a last wait that the session's ending closed says ended, not answered", async () => {
  const screen = await renderHero({
    sessions: [BUSY],
    events: [
      { ...changed(4, at(14, 20), "needs-you", "unknown"), kind: "ended", to: undefined },
      changed(4, at(14, 18), "working", "needs-you"),
    ],
  });

  expect(part(hero(screen.container), "last-note").textContent).toBe("project-4, ended at 14:20");
});

test("a wait under way when the period began, then answered, is the last wait, its start said to be before the period, and the hero never says none above its bar", async () => {
  const screen = await renderHero({
    sessions: [BUSY, session(4, { status: "working", statusSince: at(14, 13) })],
    events: [changed(4, at(14, 13), "needs-you", "working")],
  });
  const panel = hero(screen.container);

  expect(part(panel, "last-note").textContent).toBe(
    "project-4, answered at 14:13, waiting since before 13:32",
  );
  expect(part(panel, "last-wait").textContent).toContain("The last wait lasted at least");
  expect(panel.querySelector('[data-slot="waited-on-you"]')).not.toBeNull();
  expect(panel.textContent).not.toContain("None since");
});

test("with no wait over in the period, the quiet hero says so for the period the page can vouch for", async () => {
  const screen = await renderHero({ sessions: [BUSY], events: [] });
  // The page holds an hour of history from 13:30: the period starts an hour ago.
  expect(part(hero(screen.container), "last-note").textContent).toBe("None since 13:32");
  // It says so once. With no session waiting there are no bars, so the bars and
  // their note, which would say the same again, are left out.
  expect(hero(screen.container).querySelector('[data-slot="waited-on-you"]')).toBeNull();
  expect(hero(screen.container).textContent?.match(/13:32/g)).toHaveLength(1);
  expect(part(hero(screen.container), "last-gaps")).toBeNull();
  // The counts still end the hero.
  expect(hero(screen.container).querySelector('[data-slot="counts-row"]')).not.toBeNull();

  // Time nobody measured in the period is said under it, where the bars' note would have said it.
  const broken = watched();
  broken.points = broken.points.filter((point) => point.at <= at(14, 6) || point.at >= at(14, 10));
  await screen.rerender(
    <HeroPanel sessions={[BUSY]} sources={[CLAUDE]} history={broken} now={NOW} />,
  );
  expect(part(hero(screen.container), "last-note").textContent).toBe("None since 13:32");
  expect(part(hero(screen.container), "last-gaps").textContent).toBe(
    "4m 00s not measured after 14:06",
  );
  expect(getComputedStyle(part(hero(screen.container), "last-gaps")).color).toBe(
    rgbOf("var(--ink-secondary)"),
  );

  // Watching since before midnight, it is today.
  const early = new Date(2026, 0, 5, 0, 40).getTime();
  const sinceYesterday = watched(new Date(2026, 0, 4, 23, 50).getTime(), early);
  await screen.rerender(
    <HeroPanel sessions={[BUSY]} sources={[CLAUDE]} history={sinceYesterday} now={early} />,
  );
  expect(part(hero(screen.container), "last-note").textContent).toBe("None today");

  // Without the history, nothing can be said about the period.
  await screen.rerender(
    <HeroPanel sessions={[BUSY]} sources={[CLAUDE]} history={null} now={NOW} />,
  );
  expect(part(hero(screen.container), "last-note").textContent).toBe("Not known");
});

test.each(["dark", "light"] as const)(
  "in the %s theme the quiet hero holds no warm colour, and the waiting hero has amber only where a session needs the person",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await renderHero({ sessions: [BUSY, RESTING], events: ANSWERED_WAIT });
    expect(warmPaint(hero(screen.container))).toEqual([]);

    await screen.rerender(
      <HeroPanel
        sessions={[WAITING, BUSY, session(4, { status: "working", statusSince: at(14, 13) })]}
        sources={[CLAUDE]}
        events={ANSWERED_WAIT}
        history={watched()}
        now={NOW}
      />,
    );
    const panel = hero(screen.container);
    // Amber sits in the title's lamp, the reason, the wait, the Jump and the
    // open bar. The counts row and the answered bars hold none.
    expect(warmPaint(part(panel, "count"))).toEqual([]);
    expect(warmPaint(panel.querySelector('[data-slot="counts-row"]') as Element)).toEqual([]);
    const answered = panel.querySelector('[data-part="waited"][data-open="false"]') as HTMLElement;
    expect(warmPaint(answered)).toEqual([]);
    for (const lit of ["reason-text", "jump"]) {
      expect(warmPaint(part(panel, lit)).length, lit).toBeGreaterThan(0);
    }
  },
);

test.each(["one", "several", "quiet", "loading", "uncounted"] as const)(
  "the hero never sets words in the muted ink, since the lamp's light can sit behind them: %s",
  async (state) => {
    const props: Record<typeof state, Partial<HeroProps>> = {
      one: {},
      several: {
        sessions: [WAITING, session(8, { status: "needs-you", statusSince: NOW - MINUTE }), BUSY],
      },
      quiet: { sessions: [BUSY, RESTING], events: ANSWERED_WAIT },
      loading: { sessions: null, history: null },
      uncounted: { sessions: [], sources: [{ ...CLAUDE, state: "searching" }] },
    };
    for (const theme of ["dark", "light"] as const) {
      document.documentElement.setAttribute("data-theme", theme);
      const screen = await renderHero(props[state]);
      const muted = rgbOf("var(--ink-muted)");
      const words = wordColours(hero(screen.container));
      expect(words.length).toBeGreaterThan(0);
      for (const { text, colour } of words) expect(colour, `${theme}: "${text}"`).not.toBe(muted);
    }
  },
);

test("before the first answer the hero holds its place with a spinner, no light and no number", async () => {
  const screen = await renderHero({ sessions: null, history: null, events: [] });
  const panel = hero(screen.container);

  expect(panel.dataset.state).toBe("loading");
  expect(panel.hasAttribute("data-light")).toBe(false);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Reading sessions");
  expect(panel.querySelector('[data-slot="status-mark"]')?.getAttribute("data-lit")).toBe("false");
  // No bars and no figure: nothing is claimed yet.
  expect(panel.querySelector('[data-slot="waited-on-you"]')).toBeNull();
  expect(panel.querySelector('[data-part="value"]')).toBeNull();
  expect(panel.textContent).not.toMatch(/\d/);
  expect(warmPaint(panel)).toEqual([]);
});

test.each([
  ["searching", "still looking for agents"],
  ["unavailable", "No agent tool could be read"],
  ["error", "No agent tool could be read"],
] as const)(
  "when the only source is %s, the hero shows a dash and says why, with no light and no zero",
  async (sourceState, why) => {
    const screen = await renderHero({ sessions: [], sources: [{ ...CLAUDE, state: sourceState }] });
    const panel = hero(screen.container);

    expect(panel.dataset.state).toBe("uncounted");
    expect(panel.hasAttribute("data-light")).toBe(false);
    await expect.element(screen.getByRole("img", { name: "Not known" }).first()).toBeVisible();
    expect(part(panel, "uncounted").textContent).toContain(why);
    expect(panel.textContent).not.toContain("Nothing needs you");
    expect(panel.querySelector('[data-slot="waited-on-you"]')).toBeNull();
    expect(panel.textContent).not.toMatch(/\b0\b/);
    expect(warmPaint(panel)).toEqual([]);
  },
);

test("the hero's title opens the history of how many sessions needed the person, busy or quiet", async () => {
  const onOpenHistory = vi.fn();
  const screen = await renderHero({ onOpenHistory });

  const title = screen.getByRole("button", { name: "Needs you" });
  await expect.element(title).toHaveAttribute("aria-haspopup", "dialog");
  await expect
    .element(title)
    .toHaveAccessibleDescription("Opens the history of how many sessions needed you");
  await title.click();
  expect(onOpenHistory).toHaveBeenLastCalledWith("needsYou");
  // The region keeps the title's words as its name.
  await expect.element(screen.getByRole("region", { name: /^Needs you/ })).toBeVisible();

  await screen.rerender(
    <HeroPanel
      sessions={[BUSY]}
      sources={[CLAUDE]}
      history={watched()}
      now={NOW}
      onOpenHistory={onOpenHistory}
    />,
  );
  (screen.getByRole("button", { name: "Nothing needs you" }).element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  expect(onOpenHistory).toHaveBeenCalledTimes(2);
  expect(onOpenHistory).toHaveBeenLastCalledWith("needsYou");
});

test.each(["dark", "light"] as const)(
  "in the %s theme the hero's title lights under the pointer, busy or quiet, so it reads as something that opens",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await renderHero({ onOpenHistory: vi.fn() });
    const check = async (name: string) => {
      const title = screen.getByRole("button", { name }).element() as HTMLElement;
      const words = title.getBoundingClientRect();
      expect(getComputedStyle(title).backgroundColor, name).toBe("rgba(0, 0, 0, 0)");
      await userEvent.hover(title);
      await vi.waitFor(() =>
        expect(getComputedStyle(title).backgroundColor, name).toBe(rgbOf("var(--fill-hover)")),
      );
      expect(getComputedStyle(title).transitionDuration, name).toBe("0.12s");
      // The shape reaches past the words; the words stay where they were.
      const range = document.createRange();
      range.selectNodeContents(title);
      const text = range.getBoundingClientRect();
      expect(text.left, name).toBeGreaterThan(words.left);
      expect(warmPaint(title), name).toEqual([]);
      await pointAway();
    };

    await check("Needs you");
    await screen.rerender(
      <HeroPanel
        sessions={[BUSY]}
        sources={[CLAUDE]}
        history={watched()}
        now={NOW}
        onOpenHistory={vi.fn()}
      />,
    );
    await check("Nothing needs you");
  },
);

test("with no history to open, or nothing counted, the title is words and not a button", async () => {
  const onOpenHistory = vi.fn();
  const screen = await renderHero({ onOpenHistory, history: null });
  expect(hero(screen.container).querySelector('[data-part="title"] button')).toBeNull();

  await screen.rerender(
    <HeroPanel
      sessions={[]}
      sources={[{ ...CLAUDE, state: "searching" }]}
      history={watched()}
      now={NOW}
      onOpenHistory={onOpenHistory}
    />,
  );
  expect(hero(screen.container).querySelector("button")).toBeNull();
});

test("the hero ends with the waits and then the counts, in that order", async () => {
  onTestFinished(() => document.documentElement.removeAttribute("data-theme"));
  const screen = await renderHero();
  const panel = hero(screen.container);
  const waited = panel.querySelector('[data-slot="waited-on-you"]') as HTMLElement;
  const counts = panel.querySelector('[data-slot="counts-row"]') as HTMLElement;
  const lead = panel.querySelector('[data-slot="hero-session"]') as HTMLElement;

  expect(lead.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    waited.getBoundingClientRect().top,
  );
  expect(waited.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    counts.getBoundingClientRect().top,
  );
  expect(panel.lastElementChild).toBe(counts);
  // The waits are drawn from the history, and name the period honestly.
  expect(waited.getAttribute("aria-label")).toBe("Waited on you since 13:32");
});

/** The same wait, in a terminal that runs inside a tmux pane: no link, and a place to select. */
const WAITING_IN_TMUX = session(1, {
  name: "demo-project",
  surface: "terminal",
  status: "needs-you",
  waitingReason: "permission",
  statusSince: NOW - (4 * MINUTE + 11 * SECOND),
  pid: 4321,
  alive: true,
  jump: { kind: "tmux", place: "work:2.1" },
});

test.each(["dark", "light"] as const)(
  "in the %s theme a waiting session in tmux has the solid Jump where a VS Code one has, as a button named for the place",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await renderHero({ sessions: [WAITING_IN_TMUX, BUSY, RESTING] });
    const jump = screen.getByRole("button", { name: "Jump to demo-project in tmux, work:2.1" });

    await expect.element(jump).toBeVisible();
    expect(jump.element().tagName).toBe("BUTTON");
    expect(jump.element().getAttribute("data-variant")).toBe("needs-you");
    const style = getComputedStyle(jump.element());
    expect(style.backgroundColor).toBe(rgbOf("var(--status-needs-you)"));
    expect(style.height).toBe("38px");
    // The hero's one link is the name's, to its details.
    expect(hero(screen.container).querySelector('a:not([data-part="name"])')).toBeNull();

    // It sits where the link sits for a session in VS Code.
    const place = jump.element().getBoundingClientRect();
    const linked = await renderHero();
    const link = linked.getByRole("link", { name: "Jump to demo-project in VS Code" }).element();
    expect(Math.round(place.right - hero(screen.container).getBoundingClientRect().right)).toBe(
      Math.round(
        link.getBoundingClientRect().right - hero(linked.container).getBoundingClientRect().right,
      ),
    );
    expect(Math.round(place.width)).toBe(Math.round(link.getBoundingClientRect().width));
  },
);

test.each([
  [
    "the pane is selected",
    200,
    { ok: true, kind: "tmux", place: "work:2.1" },
    "Selected in tmux",
    "neutral",
  ],
  ["tmux has stopped", 409, { error: "x", reason: "tmux-stopped" }, "tmux has stopped", "outline"],
] as const)(
  "pressing it asks for that session, and when %s the hero says so beside the name, in no warm colour",
  async (_what, status, body, words, tone) => {
    const sent: unknown[] = [];
    setApiHost(async (path, init) => {
      sent.push([path, init?.method, init?.body]);
      return new Response(JSON.stringify(body), { status });
    });
    const screen = await renderHero({ sessions: [WAITING_IN_TMUX, BUSY, RESTING] });
    const panel = hero(screen.container);
    const before = panel.getBoundingClientRect().height;

    await screen.getByRole("button", { name: /^Jump to demo-project/ }).click();
    await expect.element(screen.getByRole("status")).toHaveTextContent(words);

    expect(sent).toEqual([
      ["/api/jump", "POST", JSON.stringify({ sessionId: WAITING_IN_TMUX.id })],
    ]);
    const note = part(panel, "jump-note");
    expect(note.textContent).toBe(words);
    expect(note.getAttribute("data-tone")).toBe(tone);
    expect(note.parentElement?.contains(part(panel, "name"))).toBe(true);
    expect(warmPaint(note)).toEqual([]);
    // The hero never uses the muted ink, here included.
    expect(getComputedStyle(note).color).toBe(rgbOf("var(--ink-secondary)"));
    // Nothing moved to make room, and nothing opened over the page.
    expect(panel.getBoundingClientRect().height).toBe(before);
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
  },
);

test("where the name's line cannot hold both, what a press came to goes under the name, which is not cut for it", async () => {
  // The hero as a window 375 pixels wide draws it, beside the rail.
  await page.viewport(375, 800);
  setApiHost(
    async () => new Response(JSON.stringify({ ok: true, kind: "tmux", place: "work:2.1" })),
  );
  const screen = await render(
    <div style={{ width: 283 }}>
      <HeroPanel
        sessions={[{ ...WAITING_IN_TMUX, name: "checkout-flow" }]}
        sources={[CLAUDE]}
        history={watched()}
        now={NOW}
      />
    </div>,
  );
  const panel = hero(screen.container);
  const name = part(panel, "name");
  const nameWidth = name.getBoundingClientRect().width;
  expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);

  await screen.getByRole("button", { name: /^Jump to checkout-flow/ }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("Selected in tmux");

  const note = part(panel, "jump-note");
  expect(note.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    name.getBoundingClientRect().bottom,
  );
  expect(note.getBoundingClientRect().left).toBe(wordsOf(name).left);
  // The name kept every letter and all its room.
  expect(name.getBoundingClientRect().width).toBe(nameWidth);
  expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
  expect(name.getAttribute("data-cut")).toBe("false");
  expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
});

test("with several waiting, each one in tmux has its own solid Jump, and what one came to is said of that one alone", async () => {
  setApiHost(
    async () => new Response(JSON.stringify({ ok: true, kind: "tmux", place: "api:0.0" })),
  );
  const other = session(6, {
    name: "api-rate-limits",
    status: "needs-you",
    waitingReason: "question",
    statusSince: NOW - 40 * SECOND,
    pid: 4322,
    alive: true,
    jump: { kind: "tmux", place: "api:0.0" },
  });
  const plain = session(7, {
    name: "email-templates",
    status: "needs-you",
    waitingReason: "permission",
    statusSince: NOW - 20 * SECOND,
  });
  const screen = await renderHero({ sessions: [WAITING_IN_TMUX, other, plain] });
  const panel = hero(screen.container);

  const jumps = [...panel.querySelectorAll<HTMLElement>('[data-part="jump"]')];
  expect(jumps.map((jump) => jump.getAttribute("aria-label"))).toEqual([
    "Jump to demo-project in tmux, work:2.1",
    "Jump to api-rate-limits in tmux, api:0.0",
  ]);
  for (const jump of jumps) {
    expect(jump.tagName).toBe("BUTTON");
    expect(getComputedStyle(jump).backgroundColor).toBe(rgbOf("var(--status-needs-you)"));
  }

  await screen.getByRole("button", { name: /^Jump to api-rate-limits/ }).click();
  await vi.waitFor(() => expect(panel.querySelectorAll('[data-part="jump-note"]')).toHaveLength(1));
  const note = part(panel, "jump-note");
  const row = note.closest('[data-slot="hero-session"]') as HTMLElement;
  expect(row.getAttribute("data-session")).toBe(other.id);
  expect(note.textContent).toBe("Selected in tmux");
});

test("what a press came to does not pass to another session that takes the lead", async () => {
  setApiHost(
    async () => new Response(JSON.stringify({ ok: true, kind: "tmux", place: "work:2.1" })),
  );
  const screen = await renderHero({ sessions: [WAITING_IN_TMUX] });
  await screen.getByRole("button", { name: /^Jump to demo-project/ }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("Selected in tmux");

  // The first is answered, and another session is now the one waiting.
  const next = session(8, {
    name: "infra-terraform",
    status: "needs-you",
    waitingReason: "permission",
    statusSince: NOW - 5 * SECOND,
    pid: 4323,
    alive: true,
    jump: { kind: "tmux", place: "infra:1.0" },
  });
  await screen.rerender(
    <div style={{ width: 820, padding: 24 }}>
      <HeroPanel sessions={[next]} sources={[CLAUDE]} history={watched()} now={NOW} />
    </div>,
  );

  expect(part(hero(screen.container), "name").textContent).toBe("infra-terraform");
  expect(hero(screen.container).querySelector('[data-part="jump-note"]')).toBeNull();
});

describe("what a waiting session is asking", () => {
  const ASKING = { ...WAITING, waitingText: "Run: npm test" };
  const ASKED = {
    ...LATER,
    waitingText: "Which database should we use? (+1 more)",
  };

  test("is a quiet line of its own under the reason, in the longest wait and in a later one, never warm", async () => {
    const screen = await renderHero({ sessions: [ASKING, ASKED, BUSY] });
    const panel = hero(screen.container);
    const lead = panel.querySelector(`[data-session="${ASKING.id}"]`) as HTMLElement;
    const later = panel.querySelector(`[data-session="${ASKED.id}"]`) as HTMLElement;

    for (const [root, text] of [
      [lead, "Run: npm test"],
      [later, "Which database should we use? (+1 more)"],
    ] as const) {
      const asking = part(root, "asking");
      expect(asking.textContent).toBe(text);
      // The body size in the hero's quieter ink: the hero never uses the muted ink.
      const style = getComputedStyle(asking);
      expect(style.fontSize).toBe("13px");
      expect(style.fontWeight).toBe("400");
      expect(style.color).toBe(rgbOf("var(--ink-secondary)"));
      expect(style.color).not.toBe(rgbOf("var(--ink-muted)"));
      expect(warmPaint(asking)).toEqual([]);
      // Under the reason, on a line of its own.
      expect(asking.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        part(root, "reason").getBoundingClientRect().bottom - 0.5,
      );
      // It fits, so it is no stop on the way through the page.
      await vi.waitFor(() => expect(asking.dataset.cut).toBe("false"));
      expect(asking.tabIndex).toBe(-1);
    }
    // In the longest wait it comes before where the session runs.
    expect(part(lead, "asking").getBoundingClientRect().bottom).toBeLessThanOrEqual(
      part(lead, "place").getBoundingClientRect().top + 0.5,
    );
  });

  test("a session that says nothing more has no such line", async () => {
    const screen = await renderHero({ sessions: [WAITING, LATER] });
    expect(hero(screen.container).querySelector('[data-part="asking"]')).toBeNull();
  });

  test("a request held for the plugin is shown whole in place of the line, with Allow and Deny, and nothing warm", async () => {
    const held = {
      ...ASKING,
      ask: {
        requestId: "0123456789abcdef0123456789abcdef",
        tool: "Bash",
        command: "npm test\nnpm run build",
        allow: true,
        until: NOW + 300_000,
      },
    };
    const screen = await renderHero({ sessions: [held, ASKED, BUSY] });
    const lead = hero(screen.container).querySelector(`[data-session="${held.id}"]`) as HTMLElement;
    expect(lead.querySelector('[data-part="asking"]')).toBeNull();
    const answer = lead.querySelector('[data-slot="answer"]') as HTMLElement;
    expect(part(answer, "command").textContent).toBe("npm test\nnpm run build");
    expect([...answer.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Deny",
      "Allow",
    ]);
    expect(warmPaint(answer)).toEqual([]);
    for (const element of answer.querySelectorAll("*")) {
      expect(getComputedStyle(element).color).not.toBe(rgbOf("var(--ink-muted)"));
    }
    // A later wait with no request held keeps its line, and has no buttons.
    const later = hero(screen.container).querySelector(
      `[data-session="${ASKED.id}"]`,
    ) as HTMLElement;
    expect(part(later, "asking").textContent).toBe("Which database should we use? (+1 more)");
    expect(later.querySelector('[data-slot="answer"]')).toBeNull();
  });

  test("once an answered session stops waiting and leaves the hero, focus goes to the hero's title", async () => {
    setApiHost(async () => new Response(JSON.stringify({ ok: true, decision: "allow" })));
    const held = {
      ...ASKING,
      ask: {
        requestId: "0123456789abcdef0123456789abcdef",
        tool: "Bash",
        command: "npm test",
        allow: true,
        until: NOW + 300_000,
      },
    };
    const screen = await renderHero({ sessions: [held, ASKED, BUSY] });
    const allow = screen.getByRole("button", { name: `Allow, for ${held.name}` });
    await expect
      .poll(() => allow.element().getAttribute("aria-disabled"), { timeout: 3_000 })
      .toBeNull();
    await allow.click();
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Allowed from Agent Lookout.");
    await screen.rerender(
      <div style={{ width: 820, padding: 24 }}>
        <HeroPanel
          sessions={[{ ...held, status: "working", ask: undefined }, ASKED, BUSY]}
          sources={[CLAUDE]}
          events={[changed(1, WAITING.statusSince as number, "working", "needs-you")]}
          history={watched()}
          now={NOW}
        />
      </div>,
    );
    await expect.poll(() => document.activeElement?.getAttribute("data-part")).toBe("title");
    expect(hero(screen.container).contains(document.activeElement)).toBe(true);
  });

  test.each([375, 320])(
    "at %i pixels a long command is cut at two lines, stays inside the hero, and is whole one hover or one Tab away",
    async (width) => {
      await page.viewport(width, 800);
      const command = `Run: ./scripts/${"deploy-to-the-staging-environment-".repeat(5)}now --force`;
      const path = `Edit: src/${"very/deeply/nested/folders/".repeat(6)}app.ts`;
      const screen = await render(
        <div style={{ width: width - 92 }}>
          <HeroPanel
            sessions={[
              { ...WAITING, waitingText: command },
              { ...LATER, waitingText: path },
            ]}
            sources={[CLAUDE]}
            now={NOW}
          />
        </div>,
      );
      const panel = hero(screen.container);
      const lines = [...panel.querySelectorAll<HTMLElement>('[data-part="asking"]')];
      expect(lines.map((line) => line.textContent)).toEqual([command, path]);

      for (const line of lines) {
        // Two lines at most, broken anywhere, and cut with an ellipsis.
        const lineHeight = Number.parseFloat(getComputedStyle(line).lineHeight);
        expect(line.getBoundingClientRect().height).toBeLessThanOrEqual(2 * lineHeight + 1);
        expect(getComputedStyle(line).webkitLineClamp).toBe("2");
        expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
        expect(line.getBoundingClientRect().right).toBeLessThanOrEqual(
          panel.getBoundingClientRect().right + 0.5,
        );
        await vi.waitFor(() => expect(line.dataset.cut).toBe("true"));
      }
      expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        document.documentElement.clientWidth,
      );

      // While it is cut, Tab reaches it and the tooltip gives all of it.
      startAtTop();
      await tabTo(lines[0]!, 6);
      await expect.element(page.getByRole("tooltip")).toHaveTextContent(command);
      await userEvent.keyboard("{Escape}");
    },
  );
});
