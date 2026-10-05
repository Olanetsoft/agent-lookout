import { describe, expect, test } from "vitest";

import { createTabFinder, TAB_LOOK_SOONEST_MS } from "@collector/terminal/tabFinder";
import { HOME } from "@tests/fixtures/claudeCode";
import {
  fakeProcesses,
  inTab,
  ITERM_PATH,
  TERMINAL_PATH,
  type ProcessRow,
} from "@tests/support/node/terminal";

const IN_TERMINAL = 5001;
const IN_ITERM = 5002;
const IN_WARP = 5003;

const ROWS: ProcessRow[] = [
  ...inTab(TERMINAL_PATH, IN_TERMINAL, "ttys004", 600),
  ...inTab(ITERM_PATH, IN_ITERM, "ttys007", 700),
  ...inTab("/Applications/Warp.app/Contents/MacOS/stable", IN_WARP, "ttys009", 800),
];

/** A finder over a table of processes, with a clock the test moves. */
function finder(env: NodeJS.ProcessEnv = {}) {
  const ps = fakeProcesses(ROWS);
  const clock = { now: 1_700_000_000_000 };
  const found = createTabFinder({
    env,
    homeDir: HOME,
    readProcesses: ps.read,
    now: () => clock.now,
  });
  return { ps, clock, found };
}

describe("createTabFinder", () => {
  test("finds the tab each process runs in, with one ps for them all", async () => {
    const { ps, found } = finder();
    await found.look([IN_TERMINAL, IN_ITERM, IN_WARP]);

    expect(found.tabOf(IN_TERMINAL)).toEqual({ app: "Terminal", tty: "/dev/ttys004" });
    expect(found.tabOf(IN_ITERM)).toEqual({ app: "iTerm2", tty: "/dev/ttys007" });
    expect(found.tabOf(IN_WARP)).toBeUndefined();
    expect(ps.runs).toBe(1);
  });

  test("with no process to ask about, ps is not run", async () => {
    const { ps, found } = finder();
    await found.look([]);
    await found.look([]);

    expect(ps.runs).toBe(0);
  });

  test("a process is looked for once: a poll every two seconds runs ps no more", async () => {
    const { ps, clock, found } = finder();
    for (let polls = 0; polls < 60; polls += 1) {
      await found.look([IN_TERMINAL, IN_WARP]);
      clock.now += 2_000;
    }

    expect(ps.runs).toBe(1);
    expect(found.tabOf(IN_TERMINAL)?.app).toBe("Terminal");
  });

  test("a process that turns up is looked for, though never within 5 seconds of the last look", async () => {
    const { ps, clock, found } = finder();
    await found.look([IN_TERMINAL]);

    clock.now += 2_000;
    await found.look([IN_TERMINAL, IN_ITERM]);
    expect(ps.runs).toBe(1);
    expect(found.tabOf(IN_ITERM)).toBeUndefined();

    clock.now = 1_700_000_000_000 + TAB_LOOK_SOONEST_MS;
    await found.look([IN_TERMINAL, IN_ITERM]);
    expect(ps.runs).toBe(2);
    expect(found.tabOf(IN_ITERM)?.app).toBe("iTerm2");
    // What was found before is kept.
    expect(found.tabOf(IN_TERMINAL)?.app).toBe("Terminal");
  });

  test("a process that has gone is forgotten, and one that is forgotten is looked for again", async () => {
    const { ps, clock, found } = finder();
    await found.look([IN_TERMINAL, IN_ITERM]);
    await found.look([IN_ITERM]);
    expect(found.tabOf(IN_TERMINAL)).toBeUndefined();

    found.forget(IN_ITERM);
    expect(found.tabOf(IN_ITERM)).toBeUndefined();
    clock.now += TAB_LOOK_SOONEST_MS;
    await found.look([IN_ITERM]);
    expect(ps.runs).toBe(2);
    expect(found.tabOf(IN_ITERM)?.app).toBe("iTerm2");
  });

  test("when ps fails, or does not list a process, it is looked for again later", async () => {
    const { ps, clock, found } = finder();
    ps.fails = true;
    await expect(found.look([IN_TERMINAL])).resolves.toBeUndefined();
    expect(found.tabOf(IN_TERMINAL)).toBeUndefined();

    ps.fails = false;
    ps.rows = ROWS.filter(([pid]) => pid !== IN_TERMINAL);
    clock.now += TAB_LOOK_SOONEST_MS;
    await found.look([IN_TERMINAL]);
    expect(found.tabOf(IN_TERMINAL)).toBeUndefined();

    ps.rows = ROWS;
    clock.now += TAB_LOOK_SOONEST_MS;
    await found.look([IN_TERMINAL]);
    expect(found.tabOf(IN_TERMINAL)?.app).toBe("Terminal");
    expect(ps.runs).toBe(3);
  });

  test("a clock set back does not hold a look back", async () => {
    const { ps, clock, found } = finder();
    await found.look([IN_TERMINAL]);
    clock.now -= 60_000;
    await found.look([IN_TERMINAL, IN_ITERM]);

    expect(ps.runs).toBe(2);
  });

  test.each([
    ["AGENT_LOOKOUT_TERMINAL_JUMP is off", { AGENT_LOOKOUT_TERMINAL_JUMP: "off" }],
    ["it is said in capitals and spaces", { AGENT_LOOKOUT_TERMINAL_JUMP: " OFF " }],
  ] as const)("when %s, ps is never run and no tab is found", async (_what, env) => {
    const { ps, found } = finder(env);
    await found.look([IN_TERMINAL, IN_ITERM]);

    expect(ps.runs).toBe(0);
    expect(found.tabOf(IN_TERMINAL)).toBeUndefined();
  });
});
