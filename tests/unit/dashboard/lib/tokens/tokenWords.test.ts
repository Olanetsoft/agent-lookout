import { describe, expect, test } from "vitest";

import {
  ANTIGRAVITY_CAPABILITIES,
  CLAUDE_CODE_CAPABILITIES,
  CODEX_CAPABILITIES,
  STATUS_FILE_CAPABILITIES,
} from "@site-tour/feed/sources";
import type { SourceHealth } from "@core/sessions/session";
import {
  NEWEST_REPLY,
  noTokensReason,
  NONE_YET,
  NOT_RECORDED,
  tokenCount,
  tokenCountsCaption,
  tokenCountsLine,
  tokenCountsSaid,
} from "@dashboard/lib/tokens/tokenWords";
import { makeSession } from "@tests/fixtures/session";

const NOW = 1_700_000_100_000;

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
    id: "antigravity-cli",
    label: "Antigravity CLI",
    state: "ok",
    capabilities: ANTIGRAVITY_CAPABILITIES,
    checkedAt: NOW,
  },
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
      {
        label: "Claude Code",
        capabilities: {
          ...CLAUDE_CODE_CAPABILITIES,
          tokens: {
            level: "no",
            reason: "The Agent Lookout on devbox does not send token counts.",
          },
        },
      },
    ],
    checkedAt: NOW,
  },
];

describe("the counts in words", () => {
  test("are whole, with their thousands grouped, never cut to k or M", () => {
    expect(tokenCount(0)).toBe("0");
    expect(tokenCount(999)).toBe("999");
    expect(tokenCount(9_120)).toBe("9,120");
    expect(tokenCount(182_431)).toBe("182,431");
    expect(tokenCount(1_048_576)).toBe("1,048,576");
    expect(tokenCount(Number.MAX_SAFE_INTEGER)).toBe("9,007,199,254,740,991");
  });

  test("give the input and the output, and say them whole to a screen reader", () => {
    const tokens = { input: 182_431, cached: 141_002, output: 9_120 };
    expect(tokenCountsLine(tokens)).toBe("182,431 in, 9,120 out");
    expect(tokenCountsSaid(tokens)).toBe("182,431 tokens in, 9,120 tokens out");
  });

  test("always say they are the newest reply's, with how much of the input came from a cache when it is known", () => {
    expect(tokenCountsCaption({ input: 182_431, cached: 141_002, output: 9_120 })).toBe(
      "Newest reply · 141,002 of the input from a cache",
    );
    expect(tokenCountsCaption({ input: 2_048, cached: 0, output: 64 })).toBe(
      "Newest reply · none of the input from a cache",
    );
    expect(tokenCountsCaption({ input: 2_048, output: 64 })).toBe("Newest reply");
    expect(NEWEST_REPLY).toBe("Newest reply");
  });
});

describe("why there are none", () => {
  test("is the reason the session's agent gives in Sources when it cannot report them", () => {
    const reason = (source: SourceHealth["id"]) => noTokensReason(makeSession({ source }), SOURCES);
    expect(reason("claude-code")).toBe(
      "Agent Lookout does not read the token counts in its transcripts yet.",
    );
    expect(reason("antigravity-cli")).toBe(
      "Agent Lookout does not read token counts from agy's transcripts yet.",
    );
    expect(reason("status-files")).toBe("A status file has no field for token counts.");
  });

  test("for an agent that can report them, is that none are recorded yet", () => {
    expect(noTokensReason(makeSession({ source: "codex" }), SOURCES)).toBe("None recorded yet");
    expect(NONE_YET).toBe("None recorded yet");
    // A source the page does not know says nothing more.
    expect(noTokensReason(makeSession({ source: "codex" }), [])).toBe("None recorded yet");
  });

  test("on another machine, is its agent's reason there, or else that the machine sent none", () => {
    const there = (agent: string) =>
      noTokensReason(makeSession({ source: "remote:devbox", agent, machine: "devbox" }), SOURCES);
    expect(there("Claude Code")).toBe("The Agent Lookout on devbox does not send token counts.");
    expect(there("Codex")).toBe("devbox sent none");
    expect(there("Night Shift")).toBe("devbox sent none");
  });

  test("the dash is read as not recorded, never as a count", () => {
    expect(NOT_RECORDED).toBe("Not recorded");
    expect(NOT_RECORDED).not.toMatch(/\d/);
  });
});

test("nothing it says is money or a guess", () => {
  const tokens = { input: 182_431, cached: 141_002, output: 9_120 };
  const said = [
    tokenCountsLine(tokens),
    tokenCountsSaid(tokens),
    tokenCountsCaption(tokens),
    tokenCountsCaption({ input: 10, output: 1 }),
    NOT_RECORDED,
    ...SOURCES.flatMap((source) =>
      ["Claude Code", "Codex"].map((agent) =>
        noTokensReason(makeSession({ source: source.id, agent, machine: source.machine }), SOURCES),
      ),
    ),
  ].join("\n");
  for (const word of ["$", "cost", "price", "estimat", "about", "~", "%"]) {
    expect(said.toLowerCase(), word).not.toContain(word);
  }
  // Never cut short, as "182k" or "1.2M".
  expect(said).not.toMatch(/\d\s?[kKmM]\b/);
});
