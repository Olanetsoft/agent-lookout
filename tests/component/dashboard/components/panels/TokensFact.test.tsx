import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { Session, SourceHealth, TokenCounts } from "@core/sessions/session";
import { TokensFact } from "@dashboard/components/panels/TokensFact";
import { FactList } from "@dashboard/components/ui/facts/FactRow";
import { NOT_READ_YET } from "@dashboard/lib/tokens/tokenWords";
import {
  CLAUDE_CODE_CAPABILITIES,
  CLAUDE_CODE_THERE_CAPABILITIES,
  CODEX_CAPABILITIES,
  STATUS_FILE_CAPABILITIES,
} from "@site-tour/feed/sources";
import { makeSession } from "@tests/fixtures/session";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";

const NOW = new Date(2026, 9, 6, 14, 32, 30).getTime();

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
  {
    id: "remote:devbox",
    label: "devbox",
    machine: "devbox",
    state: "ok",
    agents: [
      { label: "Codex", capabilities: CODEX_CAPABILITIES },
      { label: "Claude Code", capabilities: CLAUDE_CODE_THERE_CAPABILITIES },
    ],
    checkedAt: NOW,
  },
];

const COUNTED = makeSession({
  id: "codex:00000000-0000-4000-8000-000000000002",
  source: "codex",
  name: "api-rate-limits",
  status: "working",
  tokens: { input: 182_431, cached: 141_002, output: 9_120 },
});

/** The counts a Claude Code session's last-message answer gave. */
const READ: TokenCounts = { input: 63_478, cached: 61_090, output: 1_244 };

async function renderFact(
  session: Session,
  sources: SourceHealth[] = SOURCES,
  { read, notRead }: { read?: TokenCounts; notRead?: string } = {},
) {
  await render(
    <div style={{ width: 712 }}>
      <FactList>
        <TokensFact session={session} sources={sources} read={read} notRead={notRead} />
      </FactList>
    </div>,
  );
  const row = document.querySelector('[data-slot="fact-row"]') as HTMLElement;
  return {
    row,
    value: row.querySelector('[data-part="tokens"]') as HTMLElement,
    note: row.querySelector('[data-part="tokens-note"]') as HTMLElement,
  };
}

/** What is drawn, leaving out what only a screen reader hears. */
function shown(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll(".sr-only")) hidden.remove();
  return copy.textContent ?? "";
}

/** What a screen reader hears, leaving out what is drawn for the eye alone. */
function heard(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent ?? "";
}

beforeEach(async () => {
  await page.viewport(1440, 900);
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

describe.each(["dark", "light"] as const)("in the %s theme", (theme) => {
  beforeEach(() => {
    document.documentElement.setAttribute("data-theme", theme);
  });

  test("gives the newest reply's input and output, with the cached part under them, in figures that keep their width", async () => {
    const { row, value, note } = await renderFact(COUNTED);
    await expect.element(value).toBeVisible();
    expect(row.querySelector("dt")?.textContent).toBe("Tokens");
    expect(shown(value)).toBe("182,431 in, 9,120 out");
    expect(note.textContent).toBe("Newest reply · 141,002 of the input from a cache");

    // Figures in the sans, never the mono, which is for literal strings.
    const dd = row.querySelector("dd") as HTMLElement;
    expect(getComputedStyle(dd).fontFamily).toMatch(/^"?Atkinson Hyperlegible Next/);
    expect(getComputedStyle(value).fontVariantNumeric).toContain("tabular-nums");
    expect(getComputedStyle(note).fontVariantNumeric).toContain("tabular-nums");
    expect(getComputedStyle(note).color).toBe(rgbOf("var(--ink-secondary)"));
    // Nothing about it is warm.
    expect(warmPaint(document.body)).toEqual([]);
  });

  test("with none, a dash and why, and nothing warm", async () => {
    const { value, note } = await renderFact(makeSession({ source: "status-files" }));
    await expect.element(value).toBeVisible();
    expect(shown(value)).toBe("–");
    expect(note.textContent).toBe("A status file has no field for token counts.");
    expect(warmPaint(document.body)).toEqual([]);
  });
});

test("a screen reader hears the counts as tokens, with what they are of", async () => {
  const { row, value } = await renderFact(COUNTED);
  expect(heard(value)).toBe("182,431 tokens in, 9,120 tokens out");
  expect(heard(row.querySelector("dd") as Element)).toBe(
    "182,431 tokens in, 9,120 tokens outNewest reply · 141,002 of the input from a cache",
  );
  // The words for the ear take no room on screen.
  const hidden = value.querySelector(".sr-only") as HTMLElement;
  expect(hidden.getBoundingClientRect().width).toBeLessThanOrEqual(1);
});

test("a screen reader hears the dash as not recorded, then why", async () => {
  const { row, value } = await renderFact(makeSession({ source: "status-files" }));
  expect(heard(value)).toBe("Not recorded");
  expect(heard(row.querySelector("dd") as Element)).toBe(
    "Not recordedA status file has no field for token counts.",
  );
});

test("a Claude Code session's counts are the ones its last-message answer gave, said as any others are", async () => {
  const { row, value, note } = await renderFact(makeSession({ source: "claude-code" }), SOURCES, {
    read: READ,
  });
  expect(shown(value)).toBe("63,478 in, 1,244 out");
  expect(heard(value)).toBe("63,478 tokens in, 1,244 tokens out");
  expect(note.textContent).toBe("Newest reply · 61,090 of the input from a cache");
  expect(row.querySelector("[aria-live], [role='status']")).toBeNull();
});

test("the session's own counts come before any an answer gave", async () => {
  const { value } = await renderFact(COUNTED, SOURCES, { read: READ });
  expect(shown(value)).toBe("182,431 in, 9,120 out");
});

test("until a Claude Code session's first answer, its counts are not read yet", async () => {
  const { row, value, note } = await renderFact(makeSession({ source: "claude-code" }), SOURCES, {
    notRead: NOT_READ_YET,
  });
  expect(shown(value)).toBe("–");
  expect(note.textContent).toBe("Not read yet");
  expect(heard(row.querySelector("dd") as Element)).toBe("Not recordedNot read yet");
  expect(row.textContent).not.toMatch(/\b0\b/);
});

test("a Claude Code session whose answer could not read its counts says why under the dash", async () => {
  const { value, note } = await renderFact(makeSession({ source: "claude-code" }), SOURCES, {
    notRead: "Its transcript was not found",
  });
  expect(shown(value)).toBe("–");
  expect(note.textContent).toBe("Its transcript was not found");
});

test("with no cached part recorded, it says only that the counts are the newest reply's", async () => {
  const { value, note } = await renderFact(
    makeSession({ source: "codex", tokens: { input: 2_048, output: 64 } }),
  );
  expect(shown(value)).toBe("2,048 in, 64 out");
  expect(note.textContent).toBe("Newest reply");
});

test.each([
  [
    "Claude Code, once its answer gave none",
    makeSession({ source: "claude-code" }),
    "None recorded yet",
  ],
  [
    "Claude Code with its transcripts not read",
    makeSession({ source: "claude-code" }),
    "AGENT_LOOKOUT_WAITING_TEXT is off, so no transcript is read.",
  ],
  ["Codex, before its first reply", makeSession({ source: "codex" }), "None recorded yet"],
  [
    "a status file",
    makeSession({ source: "status-files" }),
    "A status file has no field for token counts.",
  ],
  [
    "Codex on another machine",
    makeSession({ source: "remote:devbox", agent: "Codex", machine: "devbox" }),
    "devbox sent none",
  ],
  [
    "Claude Code on another machine",
    makeSession({ source: "remote:devbox", agent: "Claude Code", machine: "devbox" }),
    "Read only on devbox, while a session's details are open there.",
  ],
])(
  "%s, with no counts, has a dash and its own reason, never a 0",
  async (what, session, reason) => {
    // With AGENT_LOOKOUT_WAITING_TEXT off, Claude Code says Tokens is no, and why.
    const sources = what.includes("not read")
      ? SOURCES.map((source) =>
          source.id === "claude-code"
            ? {
                ...source,
                capabilities: {
                  ...CLAUDE_CODE_CAPABILITIES,
                  tokens: { level: "no" as const, reason },
                },
              }
            : source,
        )
      : SOURCES;
    const { row, value, note } = await renderFact(session, sources);
    expect(shown(value)).toBe("–");
    expect(note.textContent).toBe(reason);
    expect(row.textContent).not.toMatch(/\b0\b/);
  },
);

test("says nothing as the counts change, and is no meter", async () => {
  const { row: root } = await renderFact(COUNTED);
  expect(
    root.querySelector("[aria-live], [role='status'], [role='alert'], [role='log']"),
  ).toBeNull();
  expect(root.querySelector("[role='meter'], [role='progressbar'], meter, progress")).toBeNull();
});
