import { describe, expect, test } from "vitest";

import {
  isPaneId,
  LIST_PANES_ARGS,
  paneOfProcess,
  parsePanes,
  placeOf,
  type TmuxPane,
} from "@collector/tmux/panes";

describe("LIST_PANES_ARGS", () => {
  test("asks for every pane of the server in one fixed format, with the name last", () => {
    expect(LIST_PANES_ARGS).toEqual([
      "-u",
      "list-panes",
      "-a",
      "-F",
      "#{pane_pid} #{pane_id} #{window_index} #{pane_index} #{session_name}",
    ]);
  });
});

describe("parsePanes", () => {
  test("reads one pane a line: its process, its id and its place", () => {
    const stdout = "4301 %0 0 0 checkout-flow\n4302 %3 2 1 checkout-flow\n4310 %12 0 0 docs-site\n";
    expect(parsePanes(stdout)).toEqual([
      { pid: 4301, id: "%0", place: "checkout-flow:0.0" },
      { pid: 4302, id: "%3", place: "checkout-flow:2.1" },
      { pid: 4310, id: "%12", place: "docs-site:0.0" },
    ]);
  });

  test.each([
    ["spaces", "billing webhooks", "billing webhooks:1.0"],
    ["a colon and a dot", "api:rate.limits", "api:rate.limits:1.0"],
    ["letters outside ASCII", "búsqueda-索引", "búsqueda-索引:1.0"],
    ["a tab, which is shown as a space", "search\tindexing", "search indexing:1.0"],
    ["what looks like another pane's line", "4400 %9 0 0 other", "4400 %9 0 0 other:1.0"],
    ["what looks like an option", "-t %1", "-t %1:1.0"],
    ["nothing at all", "", ":1.0"],
  ])("a session name with %s is the rest of the line", (_what, name, place) => {
    expect(parsePanes(`4301 %5 1 0 ${name}\n`)).toEqual([{ pid: 4301, id: "%5", place }]);
  });

  test("a very long session name is cut for the label", () => {
    const [pane] = parsePanes(`4301 %5 1 0 ${"mobile-onboarding-".repeat(20)}\n`);
    expect(pane?.place).toHaveLength(80 + ":1.0".length);
    expect(pane?.place.endsWith("…:1.0")).toBe(true);
  });

  test("a line that is not in the format is left out, and the rest are read", () => {
    const stdout = [
      "",
      "no server running on /tmp/tmux-501/default",
      "4301 0 0 0 checkout-flow",
      "4301 %x 0 0 checkout-flow",
      "abc %1 0 0 checkout-flow",
      "4301 %1 0 checkout-flow",
      " 4301 %1 0 0 checkout-flow",
      "4302 %2 0 0 infra-terraform",
    ].join("\n");
    expect(parsePanes(stdout)).toEqual([{ pid: 4302, id: "%2", place: "infra-terraform:0.0" }]);
  });

  test("a pane whose process could not be one is left out", () => {
    expect(parsePanes("0 %1 0 0 a\n1 %2 0 0 b\n99999999999999999999 %3 0 0 c\n")).toEqual([]);
  });

  test("a pane listed twice, as one in a window linked into two sessions is, is kept once", () => {
    expect(parsePanes("4301 %1 0 0 email-templates\n4301 %1 3 0 docs-site\n")).toEqual([
      { pid: 4301, id: "%1", place: "email-templates:0.0" },
    ]);
  });

  test("nothing printed is no panes", () => {
    expect(parsePanes("")).toEqual([]);
  });
});

describe("isPaneId", () => {
  test("is a percent sign and digits, and nothing else", () => {
    expect(isPaneId("%0")).toBe(true);
    expect(isPaneId("%4821")).toBe(true);
    for (const value of [
      "",
      "%",
      "0",
      "%-1",
      "%1 ",
      " %1",
      "%1;kill-server",
      "%1\n%2",
      "%1.0",
      "checkout-flow:0.0",
      "@1",
      "$1",
      "%12345678901",
      1,
      null,
      undefined,
    ]) {
      expect([value, isPaneId(value)]).toEqual([value, false]);
    }
  });
});

describe("placeOf", () => {
  test("writes the place as tmux writes a target", () => {
    expect(placeOf("search-indexing", "2", "1")).toBe("search-indexing:2.1");
  });

  test("turns control characters into spaces, so a name cannot break a line of the page", () => {
    expect(placeOf("docs\n-site\u0007", "0", "0")).toBe("docs -site:0.0");
  });
});

describe("paneOfProcess", () => {
  const shell: TmuxPane = { pid: 4301, id: "%1", place: "checkout-flow:0.0" };
  const other: TmuxPane = { pid: 4401, id: "%2", place: "docs-site:0.0" };
  const panes = new Map([
    [shell.pid, shell],
    [other.pid, other],
  ]);

  test("a process started from a pane's shell is in that pane, however many steps down", () => {
    const parents = new Map([
      [5003, 5002],
      [5002, 5001],
      [5001, 4301],
      [4301, 900],
      [900, 1],
    ]);
    expect(paneOfProcess(5001, parents, panes)).toBe(shell);
    expect(paneOfProcess(5003, parents, panes)).toBe(shell);
  });

  test("a process that is itself the pane's process is in that pane", () => {
    expect(paneOfProcess(4401, new Map([[4401, 900]]), panes)).toBe(other);
    // Even when ps said nothing about it.
    expect(paneOfProcess(4401, new Map(), panes)).toBe(other);
  });

  test("the nearest pane wins, as for one tmux started inside another's pane", () => {
    const parents = new Map([
      [5001, 4401],
      [4401, 4301],
      [4301, 1],
    ]);
    expect(paneOfProcess(5001, parents, panes)).toBe(other);
  });

  test("a process with no pane among its ancestors is in none", () => {
    const parents = new Map([
      [6001, 6000],
      [6000, 1],
      [1, 0],
    ]);
    expect(paneOfProcess(6001, parents, panes)).toBeUndefined();
  });

  test("a process ps did not list is in none", () => {
    expect(paneOfProcess(7001, new Map(), panes)).toBeUndefined();
  });

  test("a table that loops ends the walk", () => {
    const loop = new Map([
      [8001, 8002],
      [8002, 8003],
      [8003, 8001],
    ]);
    expect(paneOfProcess(8001, loop, panes)).toBeUndefined();
    expect(paneOfProcess(8001, new Map([[8001, 8001]]), panes)).toBeUndefined();
  });

  test("the walk stops at the first process of the system, even if a pane claimed it", () => {
    const claimed = new Map([[1, { pid: 1, id: "%9", place: "x:0.0" }]]);
    expect(paneOfProcess(6000, new Map([[6000, 1]]), claimed)).toBeUndefined();
    expect(paneOfProcess(0, new Map(), claimed)).toBeUndefined();
  });
});
