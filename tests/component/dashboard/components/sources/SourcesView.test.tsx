import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { SessionsSnapshot, SourceHealth } from "@core/sessions/session";
import { SourcesView } from "@dashboard/components/sources/SourcesView";
import type { CollectorState } from "@dashboard/lib/api/collectorStore";
import { makeSession } from "@tests/fixtures/session";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";

const NOW = new Date(2026, 0, 5, 18, 0, 0).getTime();

const DETAIL =
  "Sessions are read from Claude Code's session registry and checked against its own list of sessions.";

const SOURCE: SourceHealth = {
  id: "claude-code",
  label: "Claude Code",
  state: "ok",
  detail: DETAIL,
  watching: [
    { label: "Registry folder", value: "/tmp/example-home/sessions" },
    { label: "Registry read", value: "every 2 seconds" },
    { label: "Command", value: "claude agents --json --all" },
    { label: "Command run", value: "every 30 seconds" },
  ],
  checkedAt: NOW - 2_000,
};

function snapshot(sources: SourceHealth[] = [SOURCE]): SessionsSnapshot {
  return {
    generatedAt: NOW,
    sources,
    sessions: [
      makeSession({ id: "claude-code:00000000-0000-4000-8000-000000000001", name: "demo-project" }),
      makeSession({ id: "claude-code:00000000-0000-4000-8000-000000000002", name: "demo-api" }),
    ],
  };
}

function state(overrides: Partial<CollectorState> = {}): CollectorState {
  return {
    phase: "live",
    snapshot: snapshot(),
    events: [],
    history: { points: [], startedAt: NOW - 60_000 },
    lastOkAt: NOW,
    problem: null,
    problemKind: null,
    ...overrides,
  };
}

beforeEach(async () => {
  await page.viewport(1280, 900);
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

/**
 * A source's fact rows: a folder, a file or a command in the mono, as a literal
 * string; a phrase such as "every 2 seconds" in the sans, because words are
 * never set in the mono; and the last two, the count and the age, as figures in
 * the sans with figures that keep their width.
 */
function expectFactFonts(rows: Element[]): void {
  const figures = rows.slice(-2);
  const literal = /^(Registry folder|Command|Sessions folder|Open-sessions folder|Names file)$/;
  for (const row of rows) {
    const value = row.querySelector("dd") as Element;
    const label = row.querySelector("dt")?.textContent ?? "";
    if (figures.includes(row)) {
      expect(getComputedStyle(value).fontFamily, label).toMatch(/^"?Atkinson Hyperlegible Next/);
      const figure = value.querySelector(".tabular-nums") ?? value;
      expect(getComputedStyle(figure).fontVariantNumeric, label).toContain("tabular-nums");
    } else if (literal.test(label)) {
      expect(getComputedStyle(value).fontFamily, label).toMatch(/^"?Atkinson Hyperlegible Mono/);
    } else {
      expect(getComputedStyle(value).fontFamily, label).toMatch(/^"?Atkinson Hyperlegible Next/);
    }
  }
  expect(figures.map((row) => row.querySelector("dt")?.textContent)).toEqual([
    "Sessions found",
    "Last checked",
  ]);
}

test("each source is a card that says its state in words, how it is read, and what it reads and runs", async () => {
  const screen = await render(<SourcesView state={state()} now={NOW} />);
  const source = screen.getByRole("region", { name: "Claude Code" });

  await expect.element(source).toBeVisible();
  expect(source.element().querySelector('[data-part="state"]')?.textContent).toBe("Watching");
  // The state is said, not drawn as a coloured dot.
  expect(source.element().querySelector('[data-slot="status-mark"], [data-slot="pulse-dot"]')).toBe(
    null,
  );
  expect(source.element().getAnimations({ subtree: true })).toHaveLength(0);
  await expect.element(source).toHaveTextContent(DETAIL);

  const rows = [...source.element().querySelectorAll('[data-slot="fact-row"]')];
  expect(rows.map((row) => row.querySelector("dt")?.textContent)).toEqual([
    "Registry folder",
    "Registry read",
    "Command",
    "Command run",
    "Sessions found",
    "Last checked",
  ]);
  expect(rows.map((row) => row.querySelector("dd")?.textContent)).toEqual([
    "/tmp/example-home/sessions",
    "every 2 seconds",
    "claude agents --json --all",
    "every 30 seconds",
    "2",
    "2s ago",
  ]);
  // A folder and a command are literal strings, in the mono. How often is
  // words, and the count and the age are figures: all three in the sans.
  expectFactFonts(rows);
  // The sentence stays above the rows, and nothing is picked out of it.
  const detail = source.element().querySelector('[data-part="detail"]') as HTMLElement;
  expect(detail.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    (rows[0] as Element).getBoundingClientRect().top,
  );
  expect(detail.querySelector('[data-slot="fact"]')).toBeNull();

  // The folder and the command are each said once, by the collector, and no
  // fixed folder is named beside the real one.
  const text = screen.container.textContent ?? "";
  expect(text.split("/tmp/example-home/sessions")).toHaveLength(2);
  expect(text.split("claude agents --json")).toHaveLength(2);
  expect(text).not.toContain("~/.claude/sessions");
});

test("what each agent can report sits under the source cards, from what each source declares, and stays once updates stop", async () => {
  const capabilities = {
    "working-and-idle": { level: "yes" },
    "needs-you": { level: "yes" },
    finished: { level: "partly", reason: "Only background jobs." },
    failed: { level: "partly", reason: "Only background jobs." },
    names: { level: "yes" },
    jump: { level: "partly", reason: "Only where a place is found." },
    "quiet-for": { level: "no", reason: "Its file is not rewritten as it works." },
    stop: { level: "partly", reason: "Not in the desktop app." },
    answer: { level: "partly", reason: "With the plugin installed." },
  } as const;
  const declared = snapshot([{ ...SOURCE, capabilities }]);
  const screen = await render(<SourcesView state={state({ snapshot: declared })} now={NOW} />);

  const table = screen.getByRole("region", { name: "What each agent can report" });
  await expect.element(table).toBeVisible();
  const source = screen.getByRole("region", { name: "Claude Code" }).element();
  // In the column of source cards, after them, and not beside them with About sources.
  expect(table.element().parentElement).toBe(source.parentElement);
  expect(table.element().getBoundingClientRect().top).toBeGreaterThan(
    source.getBoundingClientRect().bottom,
  );
  await expect.element(table).toHaveTextContent("No: Its file is not rewritten as it works.");

  await screen.rerender(
    <SourcesView
      state={state({ snapshot: declared, phase: "stalled", lastOkAt: NOW - 1_000 })}
      now={NOW}
    />,
  );
  await expect.element(table).toBeVisible();
});

test("the view says that Agent Lookout sends nothing unless email or a webhook is set up, and that a listed command is the tool's own", async () => {
  const screen = await render(<SourcesView state={state()} now={NOW} />);
  const about = screen.getByRole("region", { name: "About sources" });

  await expect
    .element(about)
    .toHaveTextContent(
      "Unless you set up email or a webhook, Agent Lookout itself sends nothing anywhere.",
    );
  await expect.element(about).toHaveTextContent("that tool's own program");
  await expect.element(about).toHaveTextContent("It reads its files and never writes to them.");
  await expect
    .element(about)
    .toHaveTextContent(
      "Agent Lookout stops a Claude Code session only when you press Stop and confirm.",
    );
  expect(about.element().textContent).not.toContain("It only reads");
});

test("a source that sends no list of facts gets no rows for them, and a path in its sentence is still mono", async () => {
  const older: SourceHealth = {
    id: "claude-code",
    label: "Claude Code",
    state: "ok",
    detail:
      "There is no session registry at /tmp/example-home/sessions, so sessions are listed with the claude command every 5 seconds instead.",
    checkedAt: NOW,
  };
  const screen = await render(
    <SourcesView state={state({ snapshot: snapshot([older]) })} now={NOW} />,
  );
  const source = screen.getByRole("region", { name: "Claude Code" });

  const labels = [...source.element().querySelectorAll('[data-slot="fact-row"] dt')];
  expect(labels.map((label) => label.textContent)).toEqual(["Sessions found", "Last checked"]);
  expect(source.element().querySelector('[data-part="watching"]')).toBeNull();

  const facts = [...source.element().querySelectorAll('[data-slot="fact"]')];
  expect(facts.map((fact) => fact.textContent)).toEqual(["/tmp/example-home/sessions", "claude"]);
  for (const fact of facts) {
    expect(getComputedStyle(fact).fontFamily).toMatch(/^"?Atkinson Hyperlegible Mono/);
  }
});

test.each([1280, 620])(
  "a long folder wraps inside its card at %i pixels instead of pushing it wider",
  async (width) => {
    await page.viewport(width, 900);
    const folder = `/tmp/${"a-very-long-folder-name/".repeat(8)}sessions`;
    const deep = snapshot([{ ...SOURCE, watching: [{ label: "Registry folder", value: folder }] }]);
    const screen = await render(<SourcesView state={state({ snapshot: deep })} now={NOW} />);
    const card = screen.getByRole("region", { name: "Claude Code" }).element();
    await expect.element(card).toHaveTextContent(folder);

    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    const value = card.querySelector('[data-part="watching"]') as HTMLElement;
    expect(value.getBoundingClientRect().right).toBeLessThanOrEqual(
      card.getBoundingClientRect().right,
    );
    expect(value.getBoundingClientRect().height).toBeGreaterThan(20);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
);

test("once updates stop, each source is its last known state, with a clock that does not move", async () => {
  const checkedAt = new Date(2026, 0, 5, 17, 59, 40).getTime();
  const last = snapshot([{ ...SOURCE, checkedAt }]);
  const screen = await render(<SourcesView state={state({ snapshot: last })} now={NOW} />);
  const source = screen.getByRole("region", { name: "Claude Code" });

  await expect.element(source).toHaveTextContent("Watching");
  await expect.element(source).toHaveTextContent(/Last checked.*ago/);

  const stalled = state({ snapshot: last, phase: "stalled", lastOkAt: checkedAt + 1_000 });
  await screen.rerender(<SourcesView state={stalled} now={NOW} />);

  expect(source.element().querySelector('[data-part="state"]')?.textContent).toBe(
    "Last known: watching",
  );
  expect(source.element().textContent).not.toContain("Watching");
  // A clock time, which stays where it is. Not an age, which would keep growing.
  await expect.element(source).toHaveTextContent("Last checked17:59:40");
  expect(source.element().textContent).not.toMatch(/ago/);
  await screen.rerender(<SourcesView state={stalled} now={NOW + 60_000} />);
  await expect.element(source).toHaveTextContent("Last checked17:59:40");

  // And the view says it has stopped, from when.
  const alert = screen.getByRole("alert");
  await expect.element(alert).toHaveTextContent("Agent Lookout has stopped updating");
  await expect.element(alert).toHaveTextContent("17:59:41");
});

test.each([
  ["not found", "unavailable", "Not found"],
  ["not working", "error", "Not working"],
  ["searching", "searching", "Searching"],
] as const)("a source that is %s says so in words", async (_name, sourceState, words) => {
  const screen = await render(
    <SourcesView
      state={state({ snapshot: snapshot([{ ...SOURCE, state: sourceState }]) })}
      now={NOW}
    />,
  );

  const source = screen.getByRole("region", { name: "Claude Code" });
  expect(source.element().querySelector('[data-part="state"]')?.textContent).toBe(words);
});

test("with no source set up it says so, before the first answer it waits, and with no answer at all it is an error", async () => {
  const screen = await render(<SourcesView state={state({ snapshot: snapshot([]) })} now={NOW} />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("No sources are set up");
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();

  await screen.rerender(
    <SourcesView
      state={state({ phase: "connecting", snapshot: null, history: null, lastOkAt: null })}
      now={NOW}
    />,
  );
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent("Waiting for the first answer");
  expect(screen.container.querySelector('[data-slot="loading"]')).not.toBeNull();
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();

  await screen.rerender(
    <SourcesView
      state={state({
        phase: "unreachable",
        snapshot: null,
        history: null,
        lastOkAt: null,
        problem: "The local server did not answer.",
        problemKind: "no-answer",
      })}
      now={NOW}
    />,
  );
  const alert = screen.getByRole("alert");
  await expect.element(alert).toHaveTextContent("Agent Lookout is not answering");
  await expect.element(alert).toHaveTextContent("Check that Agent Lookout is still running");
  expect(screen.container.querySelector('[data-slot="loading"]')).toBeNull();
});

test.each([
  ["no-answer", "The local server did not answer.", /answer|reach/gi],
  [
    "error-status",
    "The local server answered /api/sessions with error 500.",
    /error|refused|failed/gi,
  ],
  [
    "not-data",
    "The local server answered /api/sessions with something that is not data.",
    /not (session )?data|not with/gi,
  ],
] as const)(
  "with no answer at all (%s), the message says what happened once, and then what to do",
  async (kind, problem, sameThing) => {
    const screen = await render(
      <SourcesView
        state={state({
          phase: "unreachable",
          snapshot: null,
          history: null,
          lastOkAt: null,
          problem,
          problemKind: kind,
        })}
        now={NOW}
      />,
    );
    const alert = screen.getByRole("alert").element();
    const text = alert.textContent ?? "";

    // The title is what happened. The request's own words are not said again under it.
    expect(text).not.toContain(problem);
    expect(text.match(sameThing), text).toHaveLength(1);
    // And it says what to do.
    expect(text).toMatch(/Check that|Restart|Start Agent Lookout/);
  },
);

test.each(["dark", "light"] as const)(
  "in the %s theme nothing in the Sources view is warm, whatever state a source is in",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    // Two more sources than the app ships, so every state is on the page at once.
    const other = (id: string) => id as SourceHealth["id"];
    const sources: SourceHealth[] = [
      SOURCE,
      { ...SOURCE, id: other("broken-tool"), label: "Broken", state: "error" },
      { ...SOURCE, id: other("missing-tool"), label: "Missing", state: "unavailable" },
    ];
    const screen = await render(
      <SourcesView state={state({ snapshot: snapshot(sources) })} now={NOW} />,
    );

    await expect.element(screen.getByRole("region", { name: "Broken" })).toBeVisible();
    expect(warmPaint(screen.container)).toEqual([]);

    // Every card is glass at card height, with no blur, whatever its source's state.
    const cards = [
      ...screen.container.querySelectorAll<HTMLElement>(
        '[data-slot="source"], [data-slot="section-card"]',
      ),
    ];
    expect(cards.length).toBe(4);
    for (const card of cards) {
      const style = getComputedStyle(card);
      expect(style.backgroundColor).toBe(rgbOf("var(--glass-card)"));
      expect(style.borderRadius).toBe("24px");
      expect(style.borderTopWidth).toBe("0px");
      expect(style.backdropFilter).toBe("none");
    }
  },
);

const CODEX_FACTS = (read: string) => [
  { label: "Sessions folder", value: "~/.codex/sessions" },
  { label: "Read", value: read },
  { label: "Open-sessions folder", value: "~/.codex/thread-writer-locks" },
  { label: "Names file", value: "~/.codex/session_index.jsonl" },
];

const NEEDS_YOU_NOTE =
  "Codex's session files do not record when it is waiting for your approval, so a Codex session that is waiting for you shows as working.";

test("a Codex that is not on this computer is a calm Not found card that names where it looked", async () => {
  const missing: SourceHealth = {
    id: "codex",
    label: "Codex",
    state: "unavailable",
    detail:
      "Codex was not found: there is no ~/.codex folder. Agent Lookout looks again every minute.",
    watching: CODEX_FACTS("not found"),
    checkedAt: NOW - 2_000,
  };
  const screen = await render(
    <SourcesView state={state({ snapshot: snapshot([SOURCE, missing]) })} now={NOW} />,
  );
  const card = screen.getByRole("region", { name: "Codex" });

  await expect.element(card).toBeVisible();
  expect(card.element().querySelector('[data-part="state"]')?.textContent).toBe("Not found");
  const detail = card.element().querySelector('[data-part="detail"]') as HTMLElement;
  expect(detail.textContent).toBe(missing.detail);
  // The folder it looked for is a machine fact, in the mono.
  const folder = detail.querySelector('[data-slot="fact"]') as HTMLElement;
  expect(folder.textContent).toBe("~/.codex");
  expect(getComputedStyle(folder).fontFamily).toMatch(/^"?Atkinson Hyperlegible Mono/);
  // Calm: no alert, no advice to install anything, nothing warm.
  expect(card.element().querySelector('[role="alert"]')).toBeNull();
  expect(card.element().textContent).not.toMatch(/install/i);
  expect(warmPaint(card.element())).toEqual([]);
  // Claude Code is still listed first, as it was.
  const titles = [...screen.container.querySelectorAll('[data-slot="source"] h2')];
  expect(titles.map((title) => title.textContent)).toEqual(["Claude Code", "Codex"]);
});

test("a Codex that is found says in plain words that a wait for approval shows as working", async () => {
  const found: SourceHealth = {
    id: "codex",
    label: "Codex",
    state: "ok",
    detail: `Sessions are read from the files Codex saves in ~/.codex/sessions. ${NEEDS_YOU_NOTE}`,
    watching: CODEX_FACTS("every 2 seconds"),
    checkedAt: NOW - 2_000,
  };
  const sessions = [
    ...snapshot().sessions,
    makeSession({ id: "codex:00000000-0000-4000-8000-0000000000c1", source: "codex" }),
  ];
  const screen = await render(
    <SourcesView
      state={state({ snapshot: { generatedAt: NOW, sources: [SOURCE, found], sessions } })}
      now={NOW}
    />,
  );
  const card = screen.getByRole("region", { name: "Codex" });

  expect(card.element().querySelector('[data-part="state"]')?.textContent).toBe("Watching");
  await expect.element(card).toHaveTextContent(NEEDS_YOU_NOTE);
  const rows = [...card.element().querySelectorAll('[data-slot="fact-row"]')];
  expect(rows.map((row) => row.querySelector("dt")?.textContent)).toEqual([
    "Sessions folder",
    "Read",
    "Open-sessions folder",
    "Names file",
    "Sessions found",
    "Last checked",
  ]);
  // Only its own sessions are counted.
  expect(rows[4]?.querySelector("dd")?.textContent).toBe("1");
  expectFactFonts(rows);
  expect(warmPaint(card.element())).toEqual([]);
});

const STATUS_FOLDER = "~/.agent-lookout/sessions";

const statusFiles = (overrides: Partial<SourceHealth>): SourceHealth => ({
  id: "status-files",
  label: "Status files",
  state: "ok",
  detail: `Each file ending in .json in ${STATUS_FOLDER} is one session, written by the agent it belongs to.`,
  watching: [
    { label: "Folder", value: STATUS_FOLDER },
    { label: "Read", value: "every 2 seconds" },
    { label: "Files read", value: "2" },
    { label: "Files skipped", value: "1" },
  ],
  checkedAt: NOW - 2_000,
  ...overrides,
});

const customSession = (name: string) =>
  makeSession({
    id: `status-files:${name}.json`,
    source: "status-files",
    agent: "Night Shift",
    surface: "unknown",
    name,
  });

describe("the card for status files", () => {
  test("watching, it gives the folder, how often it is read, and the files read and skipped as figures", async () => {
    const sessions = [
      ...snapshot().sessions,
      customSession("checkout-flow"),
      customSession("billing-webhooks"),
    ];
    const screen = await render(
      <SourcesView
        state={state({
          snapshot: { generatedAt: NOW, sources: [SOURCE, statusFiles({})], sessions },
        })}
        now={NOW}
      />,
    );
    const card = screen.getByRole("region", { name: "Status files" });

    expect(card.element().querySelector('[data-part="state"]')?.textContent).toBe("Watching");
    const rows = [...card.element().querySelectorAll('[data-slot="fact-row"]')];
    expect(rows.map((row) => row.querySelector("dt")?.textContent)).toEqual([
      "Folder",
      "Read",
      "Files read",
      "Files skipped",
      "Sessions found",
      "Last checked",
    ]);
    expect(rows.map((row) => row.querySelector("dd")?.textContent)).toEqual([
      STATUS_FOLDER,
      "every 2 seconds",
      "2",
      "1",
      "2",
      "2s ago",
    ]);
    // The folder is a literal string, in the mono. Every count is a figure in the
    // sans that keeps its width.
    const value = (index: number) => rows[index]?.querySelector("dd") as HTMLElement;
    expect(getComputedStyle(value(0)).fontFamily).toMatch(/^"?Atkinson Hyperlegible Mono/);
    for (const index of [1, 2, 3, 4]) {
      expect(getComputedStyle(value(index)).fontFamily).toMatch(/^"?Atkinson Hyperlegible Next/);
    }
    for (const index of [2, 3]) {
      const figure = value(index).querySelector('[data-part="watching"]') as HTMLElement;
      expect(getComputedStyle(figure).fontVariantNumeric).toContain("tabular-nums");
    }
    // A phrase is words, not a figure.
    const phrase = value(1).querySelector('[data-part="watching"]') as HTMLElement;
    expect(getComputedStyle(phrase).fontVariantNumeric).not.toContain("tabular-nums");
    expect(warmPaint(card.element())).toEqual([]);
  });

  test("not set up, it is calm and says in one sentence how to start", async () => {
    const detail = `To show any other agent here, make the folder ${STATUS_FOLDER} and have the agent write a small JSON file in it for each session, as "Your own agents" in docs/GUIDE.md describes.`;
    const notSetUp = statusFiles({
      state: "not-set-up",
      detail,
      watching: [
        { label: "Folder", value: STATUS_FOLDER },
        { label: "Read", value: "not found" },
      ],
    });
    const screen = await render(
      <SourcesView state={state({ snapshot: snapshot([SOURCE, notSetUp]) })} now={NOW} />,
    );
    const card = screen.getByRole("region", { name: "Status files" });

    await expect.element(card).toBeVisible();
    expect(card.element().querySelector('[data-part="state"]')?.textContent).toBe("Not set up");
    const sentence = card.element().querySelector('[data-part="detail"]') as HTMLElement;
    expect(sentence.textContent).toBe(detail);
    expect(sentence.textContent?.match(/\.(\s|$)/g)).toHaveLength(1);
    // The folder in it is a machine fact, in the mono.
    const folder = sentence.querySelector('[data-slot="fact"]') as HTMLElement;
    expect(folder.textContent).toBe(STATUS_FOLDER);
    expect(getComputedStyle(folder).fontFamily).toMatch(/^"?Atkinson Hyperlegible Mono/);
    const rows = [...card.element().querySelectorAll('[data-slot="fact-row"] dt')];
    expect(rows.map((row) => row.textContent)).toEqual([
      "Folder",
      "Read",
      "Sessions found",
      "Last checked",
    ]);
    // Calm: no alert, nothing warm.
    expect(card.element().querySelector('[role="alert"]')).toBeNull();
    expect(warmPaint(card.element())).toEqual([]);
  });

  test("once updates stop, not set up is the last known state", async () => {
    const screen = await render(
      <SourcesView
        state={state({
          snapshot: snapshot([SOURCE, statusFiles({ state: "not-set-up" })]),
          phase: "stalled",
          lastOkAt: NOW - 1_000,
        })}
        now={NOW}
      />,
    );
    const card = screen.getByRole("region", { name: "Status files" });
    expect(card.element().querySelector('[data-part="state"]')?.textContent).toBe(
      "Last known: not set up",
    );
  });

  test("a folder it cannot read is not working", async () => {
    const broken = statusFiles({
      state: "error",
      detail: `Status files could not be read: the folder ${STATUS_FOLDER} could not be listed.`,
      watching: [
        { label: "Folder", value: STATUS_FOLDER },
        { label: "Read", value: "cannot be read" },
      ],
    });
    const screen = await render(
      <SourcesView state={state({ snapshot: snapshot([SOURCE, broken]) })} now={NOW} />,
    );
    const card = screen.getByRole("region", { name: "Status files" });

    expect(card.element().querySelector('[data-part="state"]')?.textContent).toBe("Not working");
    await expect.element(card).toHaveTextContent(broken.detail as string);
  });

  test("the view says what status files are for", async () => {
    const screen = await render(<SourcesView state={state()} now={NOW} />);
    await expect
      .element(screen.getByRole("region", { name: "About sources" }))
      .toHaveTextContent("Status files are how any other agent appears");
  });
});

describe("the card for another machine", () => {
  const COMMAND =
    "/usr/bin/ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ControlMaster=no -o ControlPath=none -L 127.0.0.1:53211:127.0.0.1:4777 -- dev@devbox.local";

  const machine = (overrides: Partial<SourceHealth>): SourceHealth => ({
    id: "remote:devbox",
    label: "devbox",
    machine: "devbox",
    state: "ok",
    watching: [
      { label: "Connects to", value: "dev@devbox.local" },
      { label: "Command", value: COMMAND },
      { label: "Asks for", value: "/api/health and /api/sessions" },
      { label: "Read", value: "every 2 seconds" },
      { label: "Agent Lookout there", value: "0.2.3" },
      { label: "Claude Code there", value: "Watching" },
    ],
    checkedAt: NOW - 2_000,
    ...overrides,
  });

  const there = (n: number) =>
    makeSession({
      id: `remote:devbox:claude-code:${n}`,
      source: "remote:devbox",
      agent: "Claude Code",
      machine: "devbox",
      name: `demo-there-${n}`,
    });

  function withMachine(card: SourceHealth, sessions = [there(1)]): CollectorState {
    const base = snapshot([SOURCE, card]);
    return state({ snapshot: { ...base, sessions: [...base.sessions, ...sessions] } });
  }

  test("connected, it says so, how it is read, and counts the sessions there alone", async () => {
    const screen = await render(
      <SourcesView
        state={withMachine(
          machine({
            detail:
              "Sessions are read from Agent Lookout 0.2.3 on devbox, through ssh to dev@devbox.local. Jump, Stop, Allow and Deny act on this computer only.",
          }),
        )}
        now={NOW}
      />,
    );
    const card = screen.getByRole("region", { name: "devbox" });
    await expect.element(card).toBeVisible();
    expect(card.element().querySelector('[data-part="state"]')?.textContent).toBe("Connected");
    await expect
      .element(card)
      .toHaveTextContent("Jump, Stop, Allow and Deny act on this computer only.");
    const rows = [...card.element().querySelectorAll('[data-slot="fact-row"]')];
    const fact = (label: string) =>
      rows.find((row) => row.querySelector("dt")?.textContent === label)?.querySelector("dd");
    expect(fact("Command")?.textContent).toBe(COMMAND);
    expect(getComputedStyle(fact("Command") as Element).fontFamily).toMatch(
      /^"?Atkinson Hyperlegible Mono/,
    );
    expect(fact("Asks for")?.textContent).toBe("/api/health and /api/sessions");
    expect(fact("Sessions found")?.textContent).toBe("1");
    // This computer's card counts its own two.
    const here = screen.getByRole("region", { name: "Claude Code" }).element();
    expect(
      [...here.querySelectorAll('[data-slot="fact-row"]')]
        .find((row) => row.querySelector("dt")?.textContent === "Sessions found")
        ?.querySelector("dd")?.textContent,
    ).toBe("2");
    expect(warmPaint(card.element())).toEqual([]);
  });

  test("while ssh signs in, it is connecting", async () => {
    const screen = await render(
      <SourcesView
        state={withMachine(
          machine({
            state: "searching",
            detail: "Connecting to devbox over SSH, as dev@devbox.local.",
          }),
          [],
        )}
        now={NOW}
      />,
    );
    const card = screen.getByRole("region", { name: "devbox" });
    expect(card.element().querySelector('[data-part="state"]')?.textContent).toBe("Connecting");
    await expect.element(card).toHaveTextContent("Connecting to devbox over SSH");
  });

  test.each([
    "The ssh command was not found on PATH or in /usr/bin, /opt/homebrew/bin, /usr/local/bin, so devbox cannot be reached. Looking again in 5 seconds.",
    "devbox turned the SSH connection away: dev@devbox.local: Permission denied (publickey). Trying again in 5 seconds.",
    "The SSH connection to devbox dropped: Connection to devbox.local closed by remote host. Connecting again.",
    "ssh is connected to devbox, but no Agent Lookout answers on its port 4777.",
    "devbox runs Agent Lookout 9.0.0, and this computer's, 0.2.3, cannot read its list of sessions.",
  ])("not connected, it gives the plain reason: %s", async (detail) => {
    const screen = await render(
      <SourcesView state={withMachine(machine({ state: "unavailable", detail }), [])} now={NOW} />,
    );
    const card = screen.getByRole("region", { name: "devbox" });
    expect(card.element().querySelector('[data-part="state"]')?.textContent).toBe("Not connected");
    expect(card.element().querySelector('[data-part="detail"]')?.textContent).toBe(detail);
  });

  test.each([
    [
      "devbox turned the SSH connection away: dev@devbox.local: Permission denied (publickey). Trying again in 5 seconds.",
      "Check that ssh dev@devbox.local connects without asking for anything. Agent Lookout runs ssh with BatchMode, so it never types a password or answers a question.",
    ],
    [
      "ssh is connected to devbox, but no Agent Lookout answers on its port 4777.",
      "Start it there with npx agent-lookout, and leave it running. If it listens on another port, give it as devbox=dev@devbox.local:<port>.",
    ],
  ])("not connected, it says what to do under the reason: %s", async (detail, advice) => {
    const screen = await render(
      <SourcesView
        state={withMachine(machine({ state: "unavailable", detail, advice }), [])}
        now={NOW}
      />,
    );
    const card = screen.getByRole("region", { name: "devbox" }).element();
    const said = card.querySelector<HTMLElement>('[data-part="advice"]');
    if (!said) throw new Error("expected what to do");
    expect(said.textContent).toBe(advice);
    // A second paragraph under the reason, in the body's secondary ink, as the reason is.
    const reason = card.querySelector('[data-part="detail"]') as HTMLElement;
    expect(said.getBoundingClientRect().top).toBeGreaterThan(reason.getBoundingClientRect().bottom);
    expect(getComputedStyle(said).color).toBe(getComputedStyle(reason).color);
    expect(getComputedStyle(said).fontSize).toBe(getComputedStyle(reason).fontSize);
    expect(warmPaint(card)).toEqual([]);
  });

  test("a card with no advice has no paragraph for it", async () => {
    const screen = await render(<SourcesView state={withMachine(machine({}))} now={NOW} />);
    const card = screen.getByRole("region", { name: "devbox" }).element();
    expect(card.querySelector('[data-part="advice"]')).toBeNull();
  });

  test("a setting that cannot be read is an Other machines card, not set up, that says why and what to do", async () => {
    const setting: SourceHealth = {
      id: "remote:",
      label: "Other machines",
      state: "not-set-up",
      detail:
        "AGENT_LOOKOUT_REMOTES gives devbox a target that Agent Lookout does not hand to ssh. Give a host alias from your ssh config, a host name or user@host, with no spaces, no leading dash and no other punctuation.",
      advice:
        "Correct AGENT_LOOKOUT_REMOTES, or unset it, and start Agent Lookout again. Until then no other machine is read and ssh is never run.",
      watching: [{ label: "Setting", value: "AGENT_LOOKOUT_REMOTES" }],
      checkedAt: NOW - 2_000,
    };
    const screen = await render(
      <SourcesView state={state({ snapshot: snapshot([SOURCE, setting]) })} now={NOW} />,
    );
    const card = screen.getByRole("region", { name: "Other machines" }).element();
    expect(card.querySelector('[data-part="state"]')?.textContent).toBe("Not set up");
    expect(card.querySelector('[data-part="detail"]')?.textContent).toBe(setting.detail);
    expect(card.querySelector('[data-part="advice"]')?.textContent).toBe(setting.advice);
    expect(warmPaint(card)).toEqual([]);
  });

  test("each agent there has a row in what each agent can report, with No under Jump, Stop and Answer", async () => {
    const there = {
      "working-and-idle": { level: "yes" },
      "needs-you": { level: "yes" },
      finished: { level: "partly", reason: "Only background jobs." },
      failed: { level: "partly", reason: "Only background jobs." },
      names: { level: "yes" },
      jump: { level: "no", reason: "Jump acts on this computer only, not on devbox." },
      "quiet-for": { level: "no", reason: "Its file is not rewritten as it works." },
      stop: { level: "no", reason: "Stop acts on this computer only, not on devbox." },
      answer: { level: "no", reason: "Answer acts on this computer only, not on devbox." },
    } as const;
    const screen = await render(
      <SourcesView
        state={withMachine(machine({ agents: [{ label: "Claude Code", capabilities: there }] }))}
        now={NOW}
      />,
    );
    const table = screen.getByRole("region", { name: "What each agent can report" });
    await expect.element(table).toBeVisible();
    const heads = [...table.element().querySelectorAll("thead th")].map((th) => th.textContent);
    expect(heads.at(-1)).toBe("Answer");
    const row = table.element().querySelector('[data-agent="Claude Code"]') as HTMLElement;
    expect(row.querySelector("th")?.textContent).toBe("Claude Code on devbox");
    const levels = [...row.querySelectorAll('[data-part="capability"]')].map((cell) =>
      cell.getAttribute("data-level"),
    );
    expect(levels).toHaveLength(9);
    // Jump, Stop and Answer, the sixth, the eighth and the ninth.
    expect([levels[5], levels[7], levels[8]]).toEqual(["no", "no", "no"]);
  });

  test("About sources says what another machine is, once one is named, and not before", async () => {
    const without = await render(<SourcesView state={state()} now={NOW} />);
    expect(without.container.querySelector('[data-part="machines"]')).toBeNull();
    without.unmount();

    const screen = await render(<SourcesView state={withMachine(machine({}))} now={NOW} />);
    const about = screen.getByRole("region", { name: "About sources" });
    await expect
      .element(about)
      .toHaveTextContent(
        "Another machine is one named in AGENT_LOOKOUT_REMOTES, with Agent Lookout running there.",
      );
    await expect
      .element(about)
      .toHaveTextContent("Jump, Stop, Allow and Deny act on this computer only.");
  });
});
