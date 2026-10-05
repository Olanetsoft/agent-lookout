import { describe, expect, test } from "vitest";

import { parseProcessParents, PS_PARENTS_ARGS } from "@collector/tmux/processParents";

describe("PS_PARENTS_ARGS", () => {
  test("asks for every process's id and its parent's, and nothing else about it", () => {
    expect(PS_PARENTS_ARGS).toEqual(["-A", "-o", "pid=,ppid="]);
  });
});

describe("parseProcessParents", () => {
  test("reads each line as a process and its parent, whatever the padding", () => {
    const stdout = "    1     0\n  150     1\n 4301   150\n54321 4301\n";
    expect([...parseProcessParents(stdout)]).toEqual([
      [1, 0],
      [150, 1],
      [4301, 150],
      [54321, 4301],
    ]);
  });

  test("a line that is not two numbers is left out", () => {
    const stdout = [
      "  PID  PPID",
      "",
      "4301",
      "4301 150 extra",
      "abc 1",
      "4302 -1",
      " 4303  150 ",
    ].join("\n");
    expect([...parseProcessParents(stdout)]).toEqual([[4303, 150]]);
  });

  test("nothing printed is an empty table", () => {
    expect(parseProcessParents("").size).toBe(0);
  });
});
