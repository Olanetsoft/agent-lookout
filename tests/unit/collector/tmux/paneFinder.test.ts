import { describe, expect, test } from "vitest";

import {
  createPaneFinder,
  PANE_LOOK_INTERVAL_MS,
  PANE_LOOK_SOONEST_MS,
  type PaneFinderOptions,
} from "@collector/tmux/paneFinder";
import { LIST_PANES_ARGS } from "@collector/tmux/panes";
import { fakeTmux } from "@tests/support/node/tmux";

/**
 * A finder over a fake tmux and a table of parents, with a clock the test
 * moves, and one asker of it, as an adapter has. While `held.until` is set,
 * tmux answers only once it has settled.
 */
function finder(
  panes: string[],
  parents: [number, number][] = [],
  more: Pick<PaneFinderOptions, "isInstalled"> = {},
) {
  const tmux = fakeTmux({ panes });
  const clock = { now: 1_700_000_000_000 };
  const ps = { runs: 0, parents: new Map(parents), fails: false };
  const held: { until: Promise<void> | null } = { until: null };
  const shared = createPaneFinder({
    run: async (args) => {
      if (held.until !== null) await held.until;
      return tmux.run(args);
    },
    readParents: async () => {
      ps.runs += 1;
      if (ps.fails) throw new Error("ps could not be run");
      return ps.parents;
    },
    now: () => clock.now,
    ...more,
  });
  return { tmux, clock, ps, held, shared, found: shared.asker() };
}

/** Lets every promise that can settle now do so. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const PANES = ["4301 %1 0 0 checkout-flow", "4401 %2 1 0 docs-site"];
const PARENTS: [number, number][] = [
  [5001, 4301],
  [5002, 4401],
  [6001, 900],
  [900, 1],
];

describe("createPaneFinder", () => {
  test("finds the pane each process runs in, with one tmux and one ps", async () => {
    const { tmux, ps, found } = finder(PANES, PARENTS);
    await found.look([5001, 5002, 6001]);

    expect(found.paneOf(5001)).toEqual({ pid: 4301, id: "%1", place: "checkout-flow:0.0" });
    expect(found.paneOf(5002)).toEqual({ pid: 4401, id: "%2", place: "docs-site:1.0" });
    expect(found.paneOf(6001)).toBeUndefined();
    expect(tmux.ran).toEqual([[...LIST_PANES_ARGS]]);
    expect(ps.runs).toBe(1);
  });

  test("with no process to ask about, nothing is run", async () => {
    const { tmux, ps, found } = finder(PANES, PARENTS);
    await found.look([]);
    await found.look([]);

    expect(tmux.ran).toEqual([]);
    expect(ps.runs).toBe(0);
  });

  test("a poll every two seconds asks tmux once in 30 seconds", async () => {
    const { tmux, clock, ps, found } = finder(PANES, PARENTS);
    for (let at = 0; at < PANE_LOOK_INTERVAL_MS; at += 2_000) {
      await found.look([5001]);
      clock.now += 2_000;
    }
    expect(tmux.ran).toHaveLength(1);
    expect(ps.runs).toBe(1);
    // In between, the answer is the remembered one.
    expect(found.paneOf(5001)?.id).toBe("%1");

    await found.look([5001]);
    expect(tmux.ran).toHaveLength(2);
  });

  test("a process that turns up is asked about sooner, though never within 5 seconds of the last look", async () => {
    const { tmux, clock, found } = finder(PANES, PARENTS);
    await found.look([5001]);

    clock.now += 2_000;
    await found.look([5001, 5002]);
    expect(tmux.ran).toHaveLength(1);
    expect(found.paneOf(5002)).toBeUndefined();

    clock.now += PANE_LOOK_SOONEST_MS - 2_000;
    await found.look([5001, 5002]);
    expect(tmux.ran).toHaveLength(2);
    expect(found.paneOf(5002)?.id).toBe("%2");

    // Asked about now, whether or not a pane was found for it, so not again until the beat.
    clock.now += PANE_LOOK_SOONEST_MS;
    await found.look([5001, 5002]);
    expect(tmux.ran).toHaveLength(2);
  });

  test("a process with no pane does not bring a look forward a second time", async () => {
    const { tmux, clock, found } = finder(PANES, PARENTS);
    await found.look([6001]);
    clock.now += 10_000;
    await found.look([6001]);
    clock.now += 10_000;
    await found.look([6001]);

    expect(tmux.ran).toHaveLength(1);
  });

  test("when tmux lists no pane, ps is not run", async () => {
    const { ps, found } = finder([], PARENTS);
    await found.look([5001]);

    expect(ps.runs).toBe(0);
    expect(found.paneOf(5001)).toBeUndefined();
  });

  test.each([
    ["has no server running", "no server running on /tmp/tmux-501/default"],
    ["has left no socket", "error connecting to /tmp/tmux-501/default (No such file or directory)"],
    ["says nothing at all", ""],
  ])("when tmux %s, no pane is known and nothing is thrown", async (_what, stderr) => {
    const { tmux, ps, found } = finder(PANES, PARENTS);
    tmux.down = stderr;
    await expect(found.look([5001])).resolves.toBeUndefined();

    expect(found.paneOf(5001)).toBeUndefined();
    expect(ps.runs).toBe(0);
  });

  test("a tmux that stops takes its panes with it at the next look", async () => {
    const { tmux, clock, found } = finder(PANES, PARENTS);
    await found.look([5001]);
    expect(found.paneOf(5001)?.id).toBe("%1");

    tmux.down = "no server running on /tmp/tmux-501/default";
    clock.now += PANE_LOOK_INTERVAL_MS;
    await found.look([5001]);
    expect(found.paneOf(5001)).toBeUndefined();
  });

  test("when ps cannot be run, no pane is known and nothing is thrown", async () => {
    const { ps, found } = finder(PANES, PARENTS);
    ps.fails = true;
    await expect(found.look([5001])).resolves.toBeUndefined();

    expect(found.paneOf(5001)).toBeUndefined();
  });

  test("a pane that moved is found where it is now", async () => {
    const { tmux, clock, found } = finder(PANES, PARENTS);
    await found.look([5001]);

    tmux.panes = ["4301 %1 3 2 billing-webhooks"];
    clock.now += PANE_LOOK_INTERVAL_MS;
    await found.look([5001]);
    expect(found.paneOf(5001)).toEqual({ pid: 4301, id: "%1", place: "billing-webhooks:3.2" });
  });

  test("lookAgain makes the next look due at once", async () => {
    const { tmux, clock, shared, found } = finder(PANES, PARENTS);
    await found.look([5001]);
    clock.now += 2_000;
    shared.lookAgain();
    await found.look([5001]);

    expect(tmux.ran).toHaveLength(2);
  });

  test("a clock that was set back starts the beat again", async () => {
    const { tmux, clock, found } = finder(PANES, PARENTS);
    await found.look([5001]);
    clock.now -= 60 * 60_000;
    await found.look([5001]);

    expect(tmux.ran).toHaveLength(2);
  });

  test("once every process has gone, the panes are forgotten", async () => {
    const { found } = finder(PANES, PARENTS);
    await found.look([5001]);
    await found.look([]);

    expect(found.paneOf(5001)).toBeUndefined();
  });

  test("a process left out of one look is looked for again soon when it is named again", async () => {
    const { tmux, clock, found } = finder(PANES, PARENTS);
    await found.look([5001, 5002]);
    expect(found.paneOf(5002)?.id).toBe("%2");

    // One poll leaves it out, as when its session was not listed for a moment.
    clock.now += 2_000;
    await found.look([5001]);
    expect(found.paneOf(5002)).toBeUndefined();
    expect(found.paneOf(5001)?.id).toBe("%1");

    clock.now += 2_000;
    await found.look([5001, 5002]);
    expect(tmux.ran).toHaveLength(1);

    // It counts as one that has turned up, so the first poll 5 seconds after the last look finds it.
    clock.now += 2_000;
    await found.look([5001, 5002]);
    expect(tmux.ran).toHaveLength(2);
    expect(found.paneOf(5002)?.id).toBe("%2");
  });
});

// Two adapters, such as Claude Code's and Qwen Code's, share one finder, each
// through an asker of its own.
describe("a finder two askers share", () => {
  test("each asker keeps its panes when the other looks", async () => {
    const { tmux, clock, shared } = finder(PANES, PARENTS);
    const claude = shared.asker();
    const qwen = shared.asker();
    await claude.look([5001]);
    clock.now += PANE_LOOK_SOONEST_MS;
    await qwen.look([5002]);

    expect(claude.paneOf(5001)?.id).toBe("%1");
    expect(qwen.paneOf(5002)?.id).toBe("%2");

    // At the beat, each names only its own processes, and neither loses the other's.
    clock.now += PANE_LOOK_INTERVAL_MS;
    await claude.look([5001]);
    expect(qwen.paneOf(5002)?.id).toBe("%2");
    await qwen.look([5002]);
    expect(claude.paneOf(5001)?.id).toBe("%1");
    expect(tmux.names()).toEqual(["list-panes", "list-panes", "list-panes"]);
  });

  test("one look covers both askers' processes, with one tmux and one ps", async () => {
    const { tmux, ps, clock, shared } = finder(PANES, PARENTS);
    const claude = shared.asker();
    const qwen = shared.asker();
    await claude.look([5001]);
    await qwen.look([5002]);
    expect(shared.paneOf(5002)).toBeUndefined();

    // The second asker's new process brings the next look forward, and it is for both.
    clock.now += PANE_LOOK_SOONEST_MS;
    await claude.look([5001]);
    await qwen.look([5002]);
    expect(shared.paneOf(5001)?.id).toBe("%1");
    expect(shared.paneOf(5002)?.id).toBe("%2");
    expect(tmux.ran).toHaveLength(2);
    expect(ps.runs).toBe(2);

    for (let polls = 0; polls < 10; polls += 1) {
      clock.now += 2_000;
      await claude.look([5001]);
      await qwen.look([5002]);
    }
    expect(tmux.ran).toHaveLength(2);
  });

  test("an asker with no process left drops only its own", async () => {
    const { clock, shared } = finder(PANES, PARENTS);
    const claude = shared.asker();
    const qwen = shared.asker();
    await claude.look([5001]);
    clock.now += PANE_LOOK_SOONEST_MS;
    await qwen.look([5002]);
    expect(shared.paneOf(5002)?.id).toBe("%2");

    await qwen.look([]);
    expect(shared.paneOf(5002)).toBeUndefined();
    expect(shared.paneOf(5001)?.id).toBe("%1");

    await claude.look([]);
    expect(shared.paneOf(5001)).toBeUndefined();
  });

  test("an asker that names nothing for one poll gets its pane back soon, while the other still names its own", async () => {
    const { tmux, clock, shared } = finder(PANES, PARENTS);
    const claude = shared.asker();
    const qwen = shared.asker();
    await claude.look([5001]);
    clock.now += PANE_LOOK_SOONEST_MS;
    await qwen.look([5002]);
    expect(qwen.paneOf(5002)?.id).toBe("%2");
    expect(tmux.ran).toHaveLength(2);

    // A poll that fails names no process.
    clock.now += 2_000;
    await claude.look([5001]);
    await qwen.look([]);
    expect(qwen.paneOf(5002)).toBeUndefined();

    clock.now += 2_000;
    await claude.look([5001]);
    await qwen.look([5002]);
    expect(tmux.ran).toHaveLength(2);

    clock.now += 2_000;
    await claude.look([5001]);
    await qwen.look([5002]);
    expect(tmux.ran).toHaveLength(3);
    expect(qwen.paneOf(5002)?.id).toBe("%2");
    expect(claude.paneOf(5001)?.id).toBe("%1");
  });

  test("an asker that looks while another's look is under way waits for it, and knows what it found", async () => {
    const { tmux, clock, held, shared } = finder(PANES, PARENTS);
    const claude = shared.asker();
    const qwen = shared.asker();
    await claude.look([5001]);
    await qwen.look([5002]);
    clock.now += PANE_LOOK_SOONEST_MS;

    let answer: () => void = () => {};
    held.until = new Promise<void>((resolve) => (answer = resolve));
    const first = claude.look([5001]);
    let waited = false;
    const second = qwen.look([5002]).then(() => (waited = true));
    await settle();
    expect(waited).toBe(false);

    held.until = null;
    answer();
    await Promise.all([first, second]);
    expect(qwen.paneOf(5002)?.id).toBe("%2");
    // No look of its own was made: the one under way was for both.
    expect(tmux.ran).toHaveLength(2);
  });
});

describe("what an asker says for Sources", () => {
  const says = (asker: { asked(): boolean; parentsAsked(): boolean }) => ({
    tmux: asker.asked(),
    ps: asker.parentsAsked(),
  });
  const NOT_ASKED = { tmux: false, ps: false };
  const BOTH_ASKED = { tmux: true, ps: true };

  test("nothing has been asked until a look runs tmux and ps, and reading that runs nothing", async () => {
    const { tmux, ps, found } = finder(PANES, PARENTS);

    expect(says(found)).toEqual(NOT_ASKED);
    expect(found.installed()).toBe(true);
    expect(tmux.ran).toEqual([]);
    expect(ps.runs).toBe(0);

    await found.look([5001]);
    expect(says(found)).toEqual(BOTH_ASKED);

    for (let read = 0; read < 5; read += 1) says(found);
    expect(tmux.ran).toHaveLength(1);
    expect(ps.runs).toBe(1);
  });

  test("a look with no process asks nothing", async () => {
    const { tmux, found } = finder(PANES, PARENTS);
    await found.look([]);

    expect(says(found)).toEqual(NOT_ASKED);
    expect(tmux.ran).toEqual([]);
  });

  test("with no tmux server running tmux has been asked, and ps has not", async () => {
    const { tmux, ps, found } = finder(PANES, PARENTS);
    tmux.down = "no server running on /tmp/tmux-501/default";
    await found.look([5001]);

    expect(says(found)).toEqual({ tmux: true, ps: false });
    expect(tmux.ran).toHaveLength(1);
    expect(ps.runs).toBe(0);
  });

  test("a server with no panes leaves ps not asked too", async () => {
    const { found } = finder([], PARENTS);
    await found.look([5001]);

    expect(says(found)).toEqual({ tmux: true, ps: false });
  });

  test("a look made for one asker's process says nothing for another that named none", async () => {
    const { tmux, shared, found } = finder(PANES, PARENTS);
    const other = shared.asker();
    await other.look([]);
    await found.look([5001]);

    expect(tmux.ran).toHaveLength(1);
    expect(says(found)).toEqual(BOTH_ASKED);
    expect(says(other)).toEqual(NOT_ASKED);
  });

  test("an asker that has yet to look gets no credit for another's", async () => {
    const { shared, found } = finder(PANES, PARENTS);
    await found.look([5001]);

    expect(says(shared.asker())).toEqual(NOT_ASKED);
  });

  test("one look for both askers' processes counts for both, with one tmux and one ps", async () => {
    const { tmux, ps, clock, shared, found } = finder(PANES, PARENTS);
    const other = shared.asker();
    await found.look([5001]);
    await other.look([5002]);

    // Too soon after the first look to look again, so tmux has not been asked about it.
    expect(says(other)).toEqual(NOT_ASKED);

    clock.now += PANE_LOOK_SOONEST_MS;
    await other.look([5002]);
    expect(says(other)).toEqual(BOTH_ASKED);
    expect(tmux.ran).toHaveLength(2);
    expect(ps.runs).toBe(2);
  });

  test("stays said once the processes have gone", async () => {
    const { clock, found } = finder(PANES, PARENTS);
    await found.look([5001]);

    clock.now += PANE_LOOK_INTERVAL_MS;
    await found.look([]);
    expect(says(found)).toEqual(BOTH_ASKED);
  });

  test("a look that fails to read ps has still asked it", async () => {
    const { ps, found } = finder(PANES, PARENTS);
    ps.fails = true;
    await found.look([5001]);

    expect(says(found)).toEqual(BOTH_ASKED);
    expect(found.paneOf(5001)).toBeUndefined();
  });

  describe("whether tmux is there", () => {
    /** A search for tmux's program that says what a test sets, and counts each time it is made. */
    function search(there: boolean) {
      const searches = {
        there,
        made: 0,
        isInstalled: async () => {
          searches.made += 1;
          return searches.there;
        },
      };
      return searches;
    }

    test("is not said until a look has searched, and the first look's card can say it", async () => {
      const searches = search(true);
      const { found } = finder(PANES, PARENTS, searches);

      expect(found.installed()).toBe(false);
      await found.look([]);
      expect(found.installed()).toBe(true);
      expect(searches.made).toBe(1);
    });

    test("without it, nothing counts as asked, though the runner was handed the look", async () => {
      const searches = search(false);
      const { ps, found } = finder([], PARENTS, searches);
      await found.look([5001]);

      expect(found.installed()).toBe(false);
      expect(says(found)).toEqual(NOT_ASKED);
      expect(ps.runs).toBe(0);
    });

    test("is searched for once every 30 seconds with no process to ask about, and for every asker", async () => {
      const searches = search(true);
      const { tmux, clock, shared, found } = finder(PANES, PARENTS, searches);
      const other = shared.asker();

      await Promise.all([found.look([]), other.look([])]);
      expect(other.installed()).toBe(true);
      expect(searches.made).toBe(1);

      clock.now += PANE_LOOK_INTERVAL_MS - 1;
      await found.look([]);
      expect(searches.made).toBe(1);

      clock.now += 1;
      await found.look([]);
      expect(searches.made).toBe(2);
      expect(tmux.ran).toEqual([]);
    });

    test("a run goes by a search of its own, so tmux installed since the last one counts as asked", async () => {
      const searches = search(false);
      const { tmux, clock, found } = finder(PANES, PARENTS, searches);
      await found.look([]);

      searches.there = true;
      clock.now += PANE_LOOK_SOONEST_MS;
      await found.look([5001]);
      expect(tmux.ran).toHaveLength(1);
      expect(searches.made).toBe(2);
      expect(found.installed()).toBe(false);
      expect(says(found)).toEqual(BOTH_ASKED);

      clock.now += PANE_LOOK_INTERVAL_MS;
      await found.look([5001]);
      expect(found.installed()).toBe(true);
      expect(says(found)).toEqual(BOTH_ASKED);
    });

    test("and tmux removed since the last search does not count as asked", async () => {
      const searches = search(true);
      const { tmux, clock, ps, found } = finder(PANES, PARENTS, searches);
      await found.look([]);

      searches.there = false;
      tmux.down = "";
      clock.now += PANE_LOOK_SOONEST_MS;
      await found.look([5001]);
      expect(found.installed()).toBe(true);
      expect(says(found)).toEqual(NOT_ASKED);
      expect(ps.runs).toBe(0);
    });

    test("a clock set back searches again", async () => {
      const searches = search(true);
      const { clock, found } = finder(PANES, PARENTS, searches);
      await found.look([]);

      clock.now -= 1_000;
      await found.look([]);
      expect(searches.made).toBe(2);
    });

    test("notices tmux installed or removed while the collector runs", async () => {
      const searches = search(false);
      const { clock, found } = finder(PANES, PARENTS, searches);
      await found.look([]);
      expect(found.installed()).toBe(false);

      searches.there = true;
      clock.now += PANE_LOOK_INTERVAL_MS;
      await found.look([]);
      expect(found.installed()).toBe(true);

      searches.there = false;
      clock.now += PANE_LOOK_INTERVAL_MS;
      await found.look([]);
      expect(found.installed()).toBe(false);
    });

    test("a search that fails says it is not there, and the look still answers", async () => {
      const { found } = finder(PANES, PARENTS, {
        isInstalled: async () => {
          throw new Error("could not look");
        },
      });

      await expect(found.look([5001])).resolves.toBeUndefined();
      expect(found.installed()).toBe(false);
    });
  });
});
