import { describe, expect, test } from "vitest";

import {
  columns,
  countsLine,
  MAX_NAME_COLUMNS,
  statusCount,
  statusJson,
  statusReport,
  statusText,
  terminalText,
  type ReportedSnapshot,
} from "@cli/statusReport";
import type { Session, SourceHealth } from "@core/sessions/session";
import { sortSessions } from "@core/sessions/sorting";
import { makeSession } from "@tests/fixtures/session";

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Characters a hostile name might carry, written by code point so none is hidden in this file. */
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI_ONE_BYTE = String.fromCharCode(0x9b);
const OSC_ONE_BYTE = String.fromCharCode(0x9d);
const ST_ONE_BYTE = String.fromCharCode(0x9c);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
const ARABIC_LETTER_MARK = String.fromCodePoint(0x061c);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const DELETE = String.fromCharCode(0x7f);

/** Every character a terminal or tmux could act on. None may reach the output. */
const ACTS_ON_A_TERMINAL =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

const SOURCES: Pick<SourceHealth, "id" | "label" | "state">[] = [
  { id: "claude-code", label: "Claude Code", state: "ok" },
  { id: "codex", label: "Codex", state: "ok" },
];

function waiting(name: string, overrides: Partial<Session> = {}): Session {
  return makeSession({
    id: `claude-code:${name}`,
    name,
    project: name,
    status: "needs-you",
    waitingReason: "permission",
    statusSince: NOW - MINUTE,
    ...overrides,
  });
}

function snapshot(sessions: Session[], sources = SOURCES): ReportedSnapshot {
  return { sessions, sources };
}

function report(sessions: Session[], sources = SOURCES) {
  return statusReport(snapshot(sessions, sources), NOW);
}

describe("the counts", () => {
  test("count each session once, as the dashboard does, with a stale session apart from idle", () => {
    const counted = report([
      waiting("checkout-flow"),
      makeSession({ id: "a", status: "working" }),
      makeSession({ id: "b", status: "working" }),
      makeSession({ id: "c", status: "idle" }),
      makeSession({ id: "d", status: "idle", stale: true }),
      makeSession({ id: "e", status: "finished" }),
      makeSession({ id: "f", status: "failed" }),
      makeSession({ id: "g", status: "unknown" }),
    ]);

    expect(counted).toMatchObject({
      counted: true,
      needsYou: 1,
      working: 2,
      idle: 1,
      stale: 1,
    });
    expect(countsLine(counted)).toBe("1 needs you · 2 working · 1 idle · 1 stale");
  });

  test("say nothing needs you when nothing does, and leave stale out when there is none", () => {
    const quiet = report([
      makeSession({ id: "a", status: "working" }),
      makeSession({ id: "b", status: "working" }),
      makeSession({ id: "c", status: "working" }),
      makeSession({ id: "d", status: "working" }),
      makeSession({ id: "e", status: "idle" }),
      makeSession({ id: "f", status: "idle" }),
    ]);

    expect(statusText(quiet)).toBe("Nothing needs you · 4 working · 2 idle\n");
    expect(statusCount(quiet)).toBe("0\n");
  });

  test("with no session found but an agent read, nothing needing you is a real zero", () => {
    const empty = report([]);
    expect(empty.counted).toBe(true);
    expect(statusText(empty)).toBe("Nothing needs you · 0 working · 0 idle\n");
    expect(statusCount(empty)).toBe("0\n");
  });

  test("claim no zero before any agent could be read", () => {
    const looking = report([], [{ id: "claude-code", label: "Claude Code", state: "searching" }]);
    expect(looking.counted).toBe(false);
    expect(statusText(looking)).toBe(
      "Agent Lookout is still looking for agents on this computer\n",
    );
    expect(statusCount(looking)).toBe("–\n");

    const unreadable = report(
      [],
      [
        { id: "claude-code", label: "Claude Code", state: "unavailable" },
        { id: "codex", label: "Codex", state: "error" },
      ],
    );
    expect(statusText(unreadable)).toBe(
      "No agent tool could be read, so nothing could be counted\n",
    );
    expect(statusCount(unreadable)).toBe("–\n");
    expect(JSON.parse(statusJson(unreadable))).toMatchObject({ counted: false, needsYou: 0 });
  });
});

describe("the waiting sessions", () => {
  test("print as the issue shows them: the counts, then name, reason and wait in columns", () => {
    const text = statusText(
      report([
        waiting("checkout-flow", { statusSince: NOW - (4 * MINUTE + 12 * SECOND) }),
        waiting("search-indexing", { waitingReason: "question", statusSince: NOW - 31 * SECOND }),
        makeSession({ id: "a", status: "working" }),
        makeSession({ id: "b", status: "working" }),
        makeSession({ id: "c", status: "working" }),
        makeSession({ id: "d", status: "idle" }),
        makeSession({ id: "e", status: "idle" }),
      ]),
    );

    expect(text).toBe(
      [
        "2 need you · 3 working · 2 idle",
        "checkout-flow    Waiting for permission  4m 12s",
        "search-indexing  Asked you a question    31s",
        "",
      ].join("\n"),
    );
  });

  test("a session on another machine says which, after its name", () => {
    const text = statusText(
      report([
        waiting("checkout-flow", {
          id: "remote:devbox:claude-code:1",
          source: "remote:devbox",
          agent: "Claude Code",
          machine: "devbox",
          statusSince: NOW - (4 * MINUTE + 12 * SECOND),
        }),
        waiting("search-indexing", { waitingReason: "question", statusSince: NOW - 31 * SECOND }),
      ]),
    );
    expect(text.split("\n").slice(1, 3)).toEqual([
      "checkout-flow on devbox  Waiting for permission  4m 12s",
      "search-indexing          Asked you a question    31s",
    ]);
    const json = JSON.parse(
      statusJson(report([waiting("checkout-flow", { machine: "devbox" }), waiting("docs-site")])),
    ) as { waiting: { machine: string | null }[] };
    expect(json.waiting.map((session) => session.machine)).toEqual(["devbox", null]);
  });

  test("a machine that is not a machine's name is not printed", () => {
    const text = statusText(report([waiting("docs-site", { machine: "dev\u001b[2Jbox" })]));
    expect(text.split("\n")[1]).toBe("docs-site  Waiting for permission  1m 00s");
  });

  test.each([
    ["permission", "Waiting for permission"],
    ["question", "Asked you a question"],
    ["other", "Waiting for you"],
    [undefined, "Waiting for you"],
    ["something-new", "Waiting for you"],
  ])("a wait for %s is said in the dashboard's words: %s", (reason, words) => {
    const text = statusText(
      report([waiting("docs-site", { waitingReason: reason as Session["waitingReason"] })]),
    );
    expect(text.split("\n")[1]).toBe(`docs-site  ${words}  1m 00s`);
  });

  test.each([
    [0, "0s"],
    [31 * SECOND, "31s"],
    [4 * MINUTE + 11 * SECOND, "4m 11s"],
    [HOUR + 4 * MINUTE + 59 * SECOND, "1h 04m"],
    [2 * 24 * HOUR + 3 * HOUR, "2d 03h"],
  ])("a wait of %d ms reads %s, as on the page", (waited, words) => {
    const text = statusText(report([waiting("email-templates", { statusSince: NOW - waited })]));
    expect(text.split("\n")[1]).toBe(`email-templates  Waiting for permission  ${words}`);
  });

  test("keep the order the server sends, which is the Needs you panel's, and show a dash for an unknown start", () => {
    // The collector sends sessions sorted, as the panel sorts them: longest wait
    // first, waits with no known start last, and ties by name whatever its case.
    const sessions = sortSessions([
      waiting("Billing-webhooks", { statusSince: null }),
      waiting("api-rate-limits", { statusSince: null }),
      waiting("search-indexing", { statusSince: NOW - 5 * SECOND }),
      waiting("mobile-onboarding", { statusSince: NOW - 2 * HOUR }),
    ]);
    const text = statusText(report(sessions));

    expect(text.split("\n").slice(1, 5)).toEqual([
      "mobile-onboarding  Waiting for permission  2h 00m",
      "search-indexing    Waiting for permission  5s",
      "api-rate-limits    Waiting for permission  –",
      "Billing-webhooks   Waiting for permission  –",
    ]);
  });

  test("a clock a little behind the server's start time never makes a wait negative", () => {
    const ahead = report([waiting("docs-site", { statusSince: NOW + 3 * SECOND })]);
    expect(ahead.waiting[0]?.waitedMs).toBe(0);
  });

  test("a session with no name is called by its folder, then its id, as on the dashboard", () => {
    const text = statusText(
      report([
        waiting("", { id: "claude-code:1", project: "billing-webhooks", statusSince: NOW - 2_000 }),
        waiting(" ", { id: "status-files:docs.json", project: null, statusSince: NOW - 1_000 }),
      ]),
    );
    expect(text.split("\n").slice(1, 3)).toEqual([
      "billing-webhooks        Waiting for permission  2s",
      "status-files:docs.json  Waiting for permission  1s",
    ]);
  });
});

describe("names from sessions", () => {
  test("lose escape sequences, so a name cannot clear the screen, set a title or change colours", () => {
    const names = [
      `${ESC}[2J${ESC}[Hcheckout-flow`,
      `${ESC}]0;not your terminal${BEL}checkout-flow`,
      `${ESC}]8;;http://example.com${ESC}\\checkout-flow${ESC}]8;;${ESC}\\`,
      `${ESC}[31mcheckout-flow${ESC}[0m`,
      `${CSI_ONE_BYTE}2Jcheckout-flow`,
      `${OSC_ONE_BYTE}0;title${ST_ONE_BYTE}checkout-flow`,
      `${ESC}Pq#0;2;0;0;0${ESC}\\checkout-flow`,
      `${ESC}ccheckout-flow`,
      `checkout-flow${ESC}[`,
    ];
    for (const name of names) {
      expect(terminalText(name), JSON.stringify(name)).toBe("checkout-flow");
    }
  });

  test("lose control characters, line breaks and reordering marks, each left as a space", () => {
    expect(terminalText(`checkout\nflow\rreset${BEL}${DELETE}`)).toBe("checkout flow reset");
    expect(terminalText(`docs${LINE_SEPARATOR}site`)).toBe("docs site");
    expect(terminalText(`api${RIGHT_TO_LEFT_OVERRIDE}stimil-etar`)).toBe("api stimil-etar");
    expect(terminalText(`docs${ARABIC_LETTER_MARK}site`)).toBe("docs site");
    expect(terminalText("  search\t\tindexing  ")).toBe("search indexing");
  });

  test("keep letters from any script, accents and emoji", () => {
    expect(terminalText("café-menü")).toBe("café-menü");
    expect(terminalText("数据同步")).toBe("数据同步");
    expect(terminalText("déploiement 🚀")).toBe("déploiement 🚀");
  });

  test("keep # as it is in a terminal, and double it for tmux, which shows ## as one #", () => {
    const hostile = report([waiting("#[fg=red]#{pane_title}#(id)#S fix #12")]);
    expect(statusText(hostile).split("\n")[1]).toBe(
      "#[fg=red]#{pane_title}#(id)#S fix #12  Waiting for permission  1m 00s",
    );
    expect(statusText(hostile, true).split("\n")[1]).toBe(
      "##[fg=red]##{pane_title}##(id)##S fix ##12  Waiting for permission  1m 00s",
    );
  });

  test("count wide letters and emoji as two columns and combining marks as none", () => {
    expect(columns("checkout-flow")).toBe(13);
    expect(columns("数据同步")).toBe(8);
    expect(columns("🚀")).toBe(2);
    expect(columns(`cafe${String.fromCodePoint(0x301)}`)).toBe(4);
  });

  test("a long name is cut to the most columns with an ellipsis, never through a wide letter", () => {
    const long = "mobile-onboarding-".repeat(5);
    const cut = terminalText(long);
    expect(columns(cut)).toBe(MAX_NAME_COLUMNS);
    expect(cut.endsWith("…")).toBe(true);

    const wide = terminalText("数".repeat(30));
    expect(wide).toBe(`${"数".repeat(19)}…`);
    expect(columns(wide)).toBe(MAX_NAME_COLUMNS - 1);
  });

  test("wide names still line up the reason and the wait", () => {
    const lines = statusText(
      report([
        waiting("数据同步", { statusSince: NOW - 3 * SECOND }),
        waiting("docs-site 🚀", { statusSince: NOW - 2 * SECOND }),
        waiting("checkout-flow", { statusSince: NOW - SECOND }),
      ]),
    )
      .trimEnd()
      .split("\n")
      .slice(1);

    expect(lines).toEqual([
      "数据同步       Waiting for permission  3s",
      "docs-site 🚀   Waiting for permission  2s",
      "checkout-flow  Waiting for permission  1s",
    ]);
    // Each reason starts 15 columns in, whatever the name is written in.
    for (const line of lines) expect(columns(line.slice(0, line.indexOf("Waiting")))).toBe(15);
  });

  test("a hostile name leaves nothing in the printed lines a terminal would act on", () => {
    const text = statusText(
      report([
        waiting(
          `${ESC}]2;owned${BEL}${ESC}[2J${CSI_ONE_BYTE}1;1H${RIGHT_TO_LEFT_OVERRIDE}docs\nsite`,
        ),
      ]),
    );
    expect(text).not.toMatch(ACTS_ON_A_TERMINAL);
    expect(text.split("\n")[1]).toBe("docs site  Waiting for permission  1m 00s");
  });

  test("a name that is nothing but escape sequences is shown by its id", () => {
    const text = statusText(report([waiting(`${ESC}[2J${ESC}[H`, { id: "claude-code:7" })]));
    expect(text.split("\n")[1]).toBe("claude-code:7  Waiting for permission  1m 00s");
  });
});

describe("--json", () => {
  test("gives a waiting session's pull request, its number and how its checks stand, only when it has one", () => {
    const json = JSON.parse(
      statusJson(
        report([
          waiting("checkout-flow", {
            id: "claude-code:1",
            git: {
              branch: "checkout-flow",
              pullRequest: {
                number: 51,
                title: "Show the pull request",
                state: "open",
                checks: { state: "pending", passing: 3, failing: 0, pending: 1 },
                url: "https://github.com/example-org/storefront/pull/51",
              },
            },
          }),
          waiting("docs-site", { id: "claude-code:2", git: { branch: "docs-site" } }),
        ]),
      ),
    );

    expect(json.waiting[0].pullRequest).toEqual({ number: 51, checks: "pending" });
    expect(json.waiting[1]).not.toHaveProperty("pullRequest");
    expect(JSON.stringify(json)).not.toContain("Show the pull request");
  });

  test("gives the counts and each waiting session with its id, name, agent, reason and wait", () => {
    const json = JSON.parse(
      statusJson(
        report([
          waiting("checkout-flow", { id: "claude-code:1", statusSince: NOW - 4 * MINUTE }),
          waiting("docs-site", {
            id: "status-files:docs-site.json",
            source: "status-files",
            agent: "Night Shift",
            waitingReason: "question",
            statusSince: null,
          }),
          makeSession({ id: "a", status: "working" }),
        ]),
      ),
    );

    expect(json).toEqual({
      counted: true,
      needsYou: 2,
      working: 1,
      idle: 0,
      stale: 0,
      waiting: [
        {
          id: "claude-code:1",
          name: "checkout-flow",
          agent: "Claude Code",
          machine: null,
          reason: "permission",
          waitingSince: NOW - 4 * MINUTE,
          waitedMs: 4 * MINUTE,
        },
        {
          id: "status-files:docs-site.json",
          name: "docs-site",
          agent: "Night Shift",
          machine: null,
          reason: "question",
          waitingSince: null,
          waitedMs: null,
        },
      ],
    });
  });

  test("keeps a hostile name exactly, written so that printing it changes nothing on screen", () => {
    const name = `${ESC}]0;x${BEL}${CSI_ONE_BYTE}2J${RIGHT_TO_LEFT_OVERRIDE}docs${LINE_SEPARATOR}site${ARABIC_LETTER_MARK}${DELETE}`;
    const printed = statusJson(report([waiting(name)]));

    expect(printed).not.toMatch(ACTS_ON_A_TERMINAL);
    expect(printed).toContain("\\u001b]0;x\\u0007\\u009b2J\\u202edocs\\u2028site\\u061c\\u007f");
    expect(JSON.parse(printed).waiting[0].name).toBe(name);
  });

  test("keeps letters from any script as they are", () => {
    const printed = statusJson(report([waiting("数据同步 🚀")]));
    expect(printed).toContain('"name": "数据同步 🚀"');
  });
});
