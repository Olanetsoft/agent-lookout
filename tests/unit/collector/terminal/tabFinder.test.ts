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

/**
 * A finder over a table of processes, with a clock the test moves, and one
 * asker of it, as an adapter has. While `held.until` is set, the table is read
 * only once it has settled.
 */
function finder(env: NodeJS.ProcessEnv = {}) {
  const ps = fakeProcesses(ROWS);
  const clock = { now: 1_700_000_000_000 };
  const held: { until: Promise<void> | null } = { until: null };
  const shared = createTabFinder({
    env,
    homeDir: HOME,
    readProcesses: async () => {
      if (held.until !== null) await held.until;
      return ps.read();
    },
    now: () => clock.now,
  });
  return { ps, clock, held, shared, found: shared.asker() };
}

/** Lets every promise that can settle now do so. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    const { ps, clock, shared, found } = finder();
    await found.look([IN_TERMINAL, IN_ITERM]);
    await found.look([IN_ITERM]);
    expect(found.tabOf(IN_TERMINAL)).toBeUndefined();

    shared.forget(IN_ITERM);
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

// Two adapters, such as Claude Code's and Qwen Code's, share one finder, each
// through an asker of its own.
describe("a tab finder two askers share", () => {
  test("each asker keeps its tabs when the other looks", async () => {
    const { ps, clock, shared } = finder();
    const claude = shared.asker();
    const qwen = shared.asker();
    await claude.look([IN_TERMINAL]);
    clock.now += TAB_LOOK_SOONEST_MS;
    await qwen.look([IN_ITERM]);

    for (let polls = 0; polls < 10; polls += 1) {
      clock.now += 2_000;
      await claude.look([IN_TERMINAL]);
      await qwen.look([IN_ITERM]);
    }
    expect(claude.tabOf(IN_TERMINAL)?.app).toBe("Terminal");
    expect(qwen.tabOf(IN_ITERM)?.app).toBe("iTerm2");
    // Each process was looked for once.
    expect(ps.runs).toBe(2);
  });

  test("one ps covers the new processes of both askers", async () => {
    const { ps, clock, shared } = finder();
    const claude = shared.asker();
    const qwen = shared.asker();
    await claude.look([IN_TERMINAL]);

    // Within 5 seconds of that look, neither asker's new process is looked for.
    clock.now += 2_000;
    await qwen.look([IN_ITERM]);
    await claude.look([IN_TERMINAL, IN_WARP]);
    expect(ps.runs).toBe(1);

    clock.now += TAB_LOOK_SOONEST_MS;
    await claude.look([IN_TERMINAL, IN_WARP]);
    await qwen.look([IN_ITERM]);
    expect(ps.runs).toBe(2);
    expect(qwen.tabOf(IN_ITERM)?.app).toBe("iTerm2");
    expect(claude.tabOf(IN_WARP)).toBeUndefined();
  });

  test("an asker with no process left drops only its own", async () => {
    const { clock, shared } = finder();
    const claude = shared.asker();
    const qwen = shared.asker();
    await claude.look([IN_TERMINAL]);
    clock.now += TAB_LOOK_SOONEST_MS;
    await qwen.look([IN_ITERM]);

    await qwen.look([]);
    expect(shared.tabOf(IN_ITERM)).toBeUndefined();
    expect(shared.tabOf(IN_TERMINAL)?.app).toBe("Terminal");
  });

  test("an asker that looks while another's look is under way waits for it", async () => {
    const { ps, held, shared } = finder();
    const claude = shared.asker();
    const qwen = shared.asker();

    let answer: () => void = () => {};
    held.until = new Promise<void>((resolve) => (answer = resolve));
    const first = claude.look([IN_TERMINAL, IN_ITERM]);
    let waited = false;
    const second = qwen.look([IN_ITERM]).then(() => (waited = true));
    await settle();
    expect(waited).toBe(false);

    held.until = null;
    answer();
    await Promise.all([first, second]);
    expect(qwen.tabOf(IN_ITERM)?.app).toBe("iTerm2");
    expect(ps.runs).toBe(1);
  });

  test("with AGENT_LOOKOUT_TERMINAL_JUMP off, no asker's process is looked for", async () => {
    const { ps, shared } = finder({ AGENT_LOOKOUT_TERMINAL_JUMP: "off" });
    await shared.asker().look([IN_TERMINAL]);
    await shared.asker().look([IN_ITERM]);

    expect(ps.runs).toBe(0);
    expect(shared.tabOf(IN_ITERM)).toBeUndefined();
  });
});
