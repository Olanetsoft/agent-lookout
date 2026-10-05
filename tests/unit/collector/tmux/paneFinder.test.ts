import { describe, expect, test } from "vitest";

import {
  createPaneFinder,
  PANE_LOOK_INTERVAL_MS,
  PANE_LOOK_SOONEST_MS,
} from "@collector/tmux/paneFinder";
import { LIST_PANES_ARGS } from "@collector/tmux/panes";
import { fakeTmux } from "@tests/support/node/tmux";

/** A finder over a fake tmux and a table of parents, with a clock the test moves. */
function finder(panes: string[], parents: [number, number][] = []) {
  const tmux = fakeTmux({ panes });
  const clock = { now: 1_700_000_000_000 };
  const ps = { runs: 0, parents: new Map(parents), fails: false };
  const found = createPaneFinder({
    run: tmux.run,
    readParents: async () => {
      ps.runs += 1;
      if (ps.fails) throw new Error("ps could not be run");
      return ps.parents;
    },
    now: () => clock.now,
  });
  return { tmux, clock, ps, found };
}

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
    const { tmux, clock, found } = finder(PANES, PARENTS);
    await found.look([5001]);
    clock.now += 2_000;
    found.lookAgain();
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
});
