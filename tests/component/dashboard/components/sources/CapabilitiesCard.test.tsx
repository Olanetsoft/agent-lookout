import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { SourceCapabilities, SourceHealth } from "@core/sessions/session";
import { CapabilitiesCard } from "@dashboard/components/sources/CapabilitiesCard";
import { pointAway, startAtTop } from "@tests/support/browser/browser";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";

const NOW = new Date(2026, 0, 5, 18, 0, 0).getTime();

const LONG_REASON =
  "In VS Code, in tmux, and in a tab of Terminal or iTerm2 on a Mac. Not in the desktop app or another terminal.";

/** Three invented declarations, with reasons as long as the adapters' longest. */
const FIRST: SourceCapabilities = {
  "working-and-idle": { level: "yes" },
  "needs-you": { level: "yes" },
  finished: { level: "partly", reason: "Only background jobs." },
  failed: { level: "partly", reason: "Only background jobs, and never one that just ended." },
  names: { level: "yes" },
  jump: { level: "partly", reason: LONG_REASON },
  "quiet-for": { level: "no", reason: "Its file is not rewritten as a session works." },
  tokens: { level: "no", reason: "Its transcripts are not read for token counts yet." },
  stop: {
    level: "partly",
    reason: "In a terminal, in VS Code and for background jobs. Not in the desktop app.",
  },
  answer: { level: "partly", reason: "With the Agent Lookout plugin installed in Claude Code." },
};

const SECOND: SourceCapabilities = {
  "working-and-idle": { level: "yes" },
  "needs-you": { level: "no", reason: "It does not record approval waits." },
  finished: { level: "partly", reason: "Only once no program has the session open." },
  failed: { level: "no", reason: "It does not record errors in its files." },
  names: { level: "partly", reason: "Its desktop app keeps no names, so folders name them." },
  jump: { level: "no", reason: "Its files name no process to find and no link to open." },
  "quiet-for": { level: "yes" },
  tokens: { level: "yes" },
  stop: { level: "no", reason: "Its files name no process that could be confirmed and stopped." },
  answer: { level: "no", reason: "It records no approval waits." },
};

const THIRD: SourceCapabilities = {
  "working-and-idle": { level: "partly", reason: "If the agent writes working and idle." },
  "needs-you": { level: "partly", reason: "If the agent writes waiting." },
  finished: { level: "partly", reason: "If the agent writes finished." },
  failed: { level: "partly", reason: "If the agent writes failed." },
  names: { level: "partly", reason: "If the agent writes a name." },
  jump: { level: "no", reason: "Nothing in a file is used to reach a session." },
  "quiet-for": { level: "partly", reason: "If the agent writes its file again as it works." },
  tokens: { level: "no", reason: "A file has no field for token counts." },
  stop: { level: "no", reason: "Nothing in a file is used to stop a session." },
  answer: { level: "no", reason: "Nothing in a file is used to answer a session." },
};

const source = (
  id: SourceHealth["id"],
  label: string,
  capabilities: SourceCapabilities | undefined,
  state: SourceHealth["state"] = "ok",
): SourceHealth => ({
  id,
  label,
  state,
  checkedAt: NOW,
  ...(capabilities && { capabilities }),
});

const SOURCES: SourceHealth[] = [
  source("claude-code", "Claude Code", FIRST),
  // A tool that is not on this computer still says what it could report.
  source("codex", "Codex", SECOND, "unavailable"),
  source("status-files", "Status files", THIRD, "not-set-up"),
];

const HEADS = [
  "Agent",
  "Working and idle",
  "Needs you",
  "Finished",
  "Failed",
  "Names",
  "Jump",
  "Quiet for",
  "Tokens",
  "Stop",
  "Answer",
];

/**
 * How wide the card is in the app: two of the Sources view's three columns at
 * 1440, beside the rail and the window's edges; the whole main area, beside
 * the narrowed rail, at 375.
 */
const CARD_WIDTH = { 1440: 880, 375: 283 } as const;

/** The card at the width the app gives it in a window this wide. */
async function renderAt(width: keyof typeof CARD_WIDTH, sources: SourceHealth[] = SOURCES) {
  await page.viewport(width, width === 375 ? 812 : 900);
  return render(
    <div style={{ width: CARD_WIDTH[width] }}>
      <CapabilitiesCard sources={sources} />
    </div>,
  );
}

const card = () => document.querySelector('[data-slot="capabilities"]') as HTMLElement;
const cellsOf = (row: Element) => [...row.querySelectorAll('[data-part="capability"]')];

beforeEach(async () => {
  await page.viewport(1440, 900);
});

afterEach(async () => {
  document.documentElement.removeAttribute("data-theme");
  await pointAway();
});

/** Nothing is warm, nothing overflows, and the card is a card. */
function expectCalmCard(): void {
  const element = card();
  expect(warmPaint(document.body)).toEqual([]);
  expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  const style = getComputedStyle(element);
  expect(style.backgroundColor).toBe(rgbOf("var(--glass-card)"));
  expect(style.backdropFilter).toBe("none");
}

/** Yes is said quietly; no and partly are the news, in ink at 500. Neither has a colour of its own. */
function expectWordInk(cell: Element): void {
  const style = getComputedStyle(cell);
  if (cell.getAttribute("data-level") === "yes") {
    expect(style.color).toBe(rgbOf("var(--ink-secondary)"));
    expect(style.fontWeight).toBe("400");
  } else {
    expect(style.color).toBe(rgbOf("var(--ink)"));
    expect(style.fontWeight).toBe("500");
  }
}

describe.each(["dark", "light"] as const)("in the %s theme", (theme) => {
  beforeEach(() => {
    document.documentElement.setAttribute("data-theme", theme);
  });

  test("at 1440 it is a table: a row for each agent and a column for each thing it can report", async () => {
    await renderAt(1440);
    const table = card().querySelector("table") as HTMLTableElement;
    await expect.element(table).toBeVisible();
    expect(card().querySelector("h2")?.textContent).toBe("What each agent can report");
    expect(card().querySelector('[data-part="blocks"]')).toBeNull();

    const heads = [...table.querySelectorAll("thead th")];
    expect(heads.map((head) => head.textContent)).toEqual(HEADS);
    for (const head of heads) expect(head.getAttribute("scope")).toBe("col");

    const rows = [...table.querySelectorAll("tbody tr")];
    expect(rows.map((row) => row.querySelector("th")?.textContent)).toEqual([
      "Claude Code",
      "Codex",
      "Status files",
    ]);
    expect(rows.map((row) => cellsOf(row).map((cell) => cell.firstChild?.textContent))).toEqual([
      ["Yes", "Yes", "Partly", "Partly", "Yes", "Partly", "No", "No", "Partly", "Partly"],
      ["Yes", "No", "Partly", "No", "Partly", "No", "Yes", "Yes", "No", "No"],
      ["Partly", "Partly", "Partly", "Partly", "Partly", "No", "Partly", "No", "No", "No"],
    ]);
    for (const cell of rows.flatMap(cellsOf)) expectWordInk(cell);

    // Each row sits on one line of cells, the head's words on at most two.
    for (const row of rows) expect(row.getBoundingClientRect().height).toBeLessThan(48);
    expect(table.querySelector("thead tr")?.getBoundingClientRect().height).toBeLessThan(48);
    expectCalmCard();
  });

  test("at 375 it is a block for each agent, with a fact row for each thing and the reason under it", async () => {
    await renderAt(375);
    const blocks = card().querySelector('[data-part="blocks"]') as HTMLElement;
    await expect.element(blocks).toBeVisible();
    expect(card().querySelector("table")).toBeNull();

    const agents = [...blocks.querySelectorAll("[data-source]")];
    expect(agents.map((agent) => agent.querySelector("h3")?.textContent)).toEqual([
      "Claude Code",
      "Codex",
      "Status files",
    ]);
    const first = agents[0] as HTMLElement;
    const rows = [...first.querySelectorAll('[data-slot="fact-row"]')];
    expect(rows.map((row) => row.querySelector("dt")?.textContent)).toEqual(HEADS.slice(1));
    expect(rows.map((row) => row.querySelector('[data-part="capability"]')?.textContent)).toEqual([
      "Yes",
      "Yes",
      "Partly",
      "Partly",
      "Yes",
      "Partly",
      "No",
      "No",
      "Partly",
      "Partly",
    ]);
    for (const cell of agents.flatMap(cellsOf)) expectWordInk(cell);

    // A phone has no hover, so a reason is a line of its own under its row, as
    // wide as the row, and a yes has none.
    const jump = rows[5] as HTMLElement;
    const note = jump.querySelector('[data-part="note"]') as HTMLElement;
    expect(note.textContent).toBe(LONG_REASON);
    expect(note.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      (jump.querySelector("dt") as Element).getBoundingClientRect().bottom,
    );
    expect(note.getBoundingClientRect().width).toBeGreaterThan(
      jump.getBoundingClientRect().width * 0.9,
    );
    expect(getComputedStyle(note).color).toBe(rgbOf("var(--ink-secondary)"));
    expect(rows[0]?.querySelector('[data-part="note"]')).toBeNull();
    // Nothing is hidden behind a tooltip, so nothing needs a Tab stop.
    expect(card().querySelector("[tabindex]")).toBeNull();
    expect(card().querySelector('[data-part="lead"]')?.textContent).not.toMatch(/Point at/);
    expectCalmCard();
  });
});

test("a no or a partly has its reason one hover away, and a yes has no tooltip", async () => {
  const screen = await renderAt(1440);
  const [claude] = [...card().querySelectorAll("tbody tr")];
  const [working, , finished, , , jump] = cellsOf(claude as Element) as HTMLElement[];

  await userEvent.hover(jump as HTMLElement);
  await expect.element(page.getByRole("tooltip")).toHaveTextContent(LONG_REASON);
  expect(warmPaint(document.body)).toEqual([]);
  await pointAway();
  await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();

  await userEvent.hover(finished as HTMLElement);
  await expect.element(page.getByRole("tooltip")).toHaveTextContent("Only background jobs.");
  await pointAway();

  await userEvent.hover(working as HTMLElement);
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  expect(screen.container.textContent).toContain("Point at No or Partly");
});

test("Tab reaches each no and partly in reading order and opens its reason, and passes every yes by", async () => {
  await renderAt(1440);
  const reachable = [...card().querySelectorAll<HTMLElement>('[data-part="capability"]')].filter(
    (cell) => cell.getAttribute("data-level") !== "yes",
  );
  expect(reachable).toHaveLength(7 + 7 + 10);
  for (const cell of card().querySelectorAll('[data-level="yes"]')) {
    expect(cell.hasAttribute("tabindex")).toBe(false);
  }

  startAtTop();
  for (const cell of reachable.slice(0, 3)) {
    await userEvent.tab();
    expect(document.activeElement).toBe(cell);
  }
  // The third is Claude Code's Jump.
  await expect.element(page.getByRole("tooltip")).toHaveTextContent(LONG_REASON);
  expect(getComputedStyle(document.activeElement as Element).outlineColor).toBe(
    rgbOf("var(--focus)"),
  );
  await userEvent.keyboard("{Escape}");
});

test("a screen reader hears each cell's word with its reason, and the table's heads", async () => {
  const screen = await renderAt(1440);

  const table = screen.getByRole("table");
  await expect.element(table.getByRole("columnheader", { name: "Needs you" })).toBeVisible();
  await expect.element(table.getByRole("rowheader", { name: "Codex" })).toBeVisible();

  const [claude, codex] = [...card().querySelectorAll("tbody tr")] as Element[];
  const said = (row: Element) => cellsOf(row).map((cell) => cell.textContent);
  expect(said(codex as Element)).toEqual([
    "Yes",
    "No: It does not record approval waits.",
    "Partly: Only once no program has the session open.",
    "No: It does not record errors in its files.",
    "Partly: Its desktop app keeps no names, so folders name them.",
    "No: Its files name no process to find and no link to open.",
    "Yes",
    "Yes",
    "No: Its files name no process that could be confirmed and stopped.",
    "No: It records no approval waits.",
  ]);
  expect(said(claude as Element)[5]).toBe(`Partly: ${LONG_REASON}`);
  // The reason is for the ear only: on screen it is in the tooltip.
  const hidden = (claude as Element).querySelector(".sr-only") as HTMLElement;
  expect(hidden.getBoundingClientRect().width).toBeLessThanOrEqual(1);
});

test("on a phone a screen reader hears the reason as part of the row", async () => {
  const screen = await renderAt(375);

  const [codex] = [
    ...card().querySelectorAll('[data-source="codex"] [data-slot="fact-row"]'),
  ].slice(1);
  const parts = [...(codex as Element).children].map((part) => [part.tagName, part.textContent]);
  expect(parts).toEqual([
    ["DT", "Needs you"],
    ["DD", "No"],
    ["DD", "It does not record approval waits."],
  ]);
  await expect.element(screen.getByRole("heading", { name: "Codex", level: 3 })).toBeVisible();
});

test("a source that declares nothing has no row, and with none at all there is no card", async () => {
  const screen = await render(
    <CapabilitiesCard sources={[...SOURCES.slice(0, 1), source("codex", "Codex", undefined)]} />,
  );
  const rows = [...card().querySelectorAll("tbody tr")];
  expect(rows.map((row) => row.querySelector("th")?.textContent)).toEqual(["Claude Code"]);

  await screen.rerender(<CapabilitiesCard sources={[source("codex", "Codex", undefined)]} />);
  expect(card()).toBeNull();
  await screen.rerender(<CapabilitiesCard sources={[]} />);
  expect(card()).toBeNull();
});

/** Another machine, with the agents its Agent Lookout found there. */
const MACHINE: SourceHealth = {
  id: "remote:devbox",
  label: "devbox",
  machine: "devbox",
  state: "ok",
  checkedAt: NOW,
  agents: [
    {
      label: "Claude Code",
      capabilities: {
        ...FIRST,
        jump: { level: "no", reason: "Jump acts on this computer only, not on devbox." },
        stop: { level: "no", reason: "Stop acts on this computer only, not on devbox." },
        answer: { level: "no", reason: "Answer acts on this computer only, not on devbox." },
      },
    },
    { label: "Status files", capabilities: THIRD },
  ],
};

test.each([1440, 375] as const)(
  "at %i another machine has a row for each agent there, named for the machine, with no Jump, no Stop and no Answer",
  async (width) => {
    await renderAt(width, [source("claude-code", "Claude Code", FIRST), MACHINE]);
    const rows = [...card().querySelectorAll<HTMLElement>("[data-source]")];
    expect(rows.map((row) => [row.dataset.source, row.dataset.agent])).toEqual([
      ["claude-code", undefined],
      ["remote:devbox", "Claude Code"],
      ["remote:devbox", "Status files"],
    ]);
    const label = (row: HTMLElement) => row.querySelector(width === 375 ? "h3" : "th")?.textContent;
    expect(rows.map(label)).toEqual([
      "Claude Code",
      "Claude Code on devbox",
      "Status files on devbox",
    ]);
    const there = rows[1] as HTMLElement;
    if (width === 375) {
      // On a phone, an agent there that reports what it does here is one line.
      expect(cellsOf(there)).toEqual([]);
      expect(there.querySelector('[data-part="same-as"]')?.textContent).toBe(
        "As Claude Code on this computer, but Jump: No, Stop: No and Answer: No, which act on this computer only.",
      );
      // One that has no match here keeps its rows.
      expect(cellsOf(rows[2] as HTMLElement)).toHaveLength(10);
    } else {
      const levels = cellsOf(there).map((cell) => cell.getAttribute("data-level"));
      // Jump, Stop and Answer, the sixth, the ninth and the tenth, are no.
      expect([levels[5], levels[8], levels[9]]).toEqual(["no", "no", "no"]);
    }
    expectCalmCard();
  },
);

test("on a phone, an agent there that reports otherwise than here, beyond Jump, Stop and Answer, keeps its rows", async () => {
  const different: SourceHealth = {
    ...MACHINE,
    agents: [
      {
        label: "Claude Code",
        capabilities: {
          ...FIRST,
          names: { level: "no", reason: "That version names no session." },
          jump: { level: "no", reason: "Jump acts on this computer only, not on devbox." },
          stop: { level: "no", reason: "Stop acts on this computer only, not on devbox." },
          answer: { level: "no", reason: "Answer acts on this computer only, not on devbox." },
        },
      },
    ],
  };
  await renderAt(375, [source("claude-code", "Claude Code", FIRST), different]);
  const there = card().querySelector<HTMLElement>('[data-agent="Claude Code"]') as HTMLElement;
  expect(there.querySelector('[data-part="same-as"]')).toBeNull();
  expect(cellsOf(there)).toHaveLength(10);
});
