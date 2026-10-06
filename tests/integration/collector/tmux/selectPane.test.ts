import { describe, expect, test } from "vitest";

import { readProcessParentsWithPs } from "@collector/processes/processParents";
import { createPaneFinder } from "@collector/tmux/paneFinder";
import { parsePanes, LIST_PANES_ARGS } from "@collector/tmux/panes";
import { findTmuxBinary } from "@collector/tmux/program";
import { selectPane } from "@collector/tmux/selectPane";
import { privateTmux, type PrivateTmux } from "@tests/support/node/tmux";

// The real tmux, on a server of this test's own. It runs only where tmux is
// installed, and never asks or changes the server a person is using: every
// command goes to a socket made for the test, which is killed when the test
// finishes, pass or fail.

const tmux = await findTmuxBinary(process.env);

/**
 * Two sessions. In checkout-flow, window 0 holds two panes: the first runs a
 * shell with a long sleep under it, the stand-in for a session's process, and
 * the second is the selected one. Window 1 is the session's selected window.
 * So the pane to find is neither the selected pane of its window nor in the
 * selected window of its session. docs-site is another session altogether.
 */
async function twoSessions(server: PrivateTmux) {
  await server.ask(
    "new-session",
    "-d",
    "-s",
    "checkout-flow",
    "-x",
    "120",
    "-y",
    "40",
    "sleep 300; true",
  );
  await server.ask("split-window", "-t", "checkout-flow:0", "sleep 300");
  await server.ask("new-window", "-t", "checkout-flow", "sleep 300");
  await server.ask("new-session", "-d", "-s", "docs-site", "sleep 300");

  const panes = parsePanes(await server.ask(...LIST_PANES_ARGS));
  const shell = panes.find((pane) => pane.place === "checkout-flow:0.0");
  if (!shell) throw new Error("The first pane was not listed.");

  // The sleep the shell started: a process inside the pane that is not the pane's own.
  let sleeping: number | undefined;
  for (let tries = 0; tries < 50 && sleeping === undefined; tries += 1) {
    const parents = await readProcessParentsWithPs();
    sleeping = [...parents].find(([, parent]) => parent === shell.pid)?.[0];
    if (sleeping === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (sleeping === undefined) throw new Error("The pane's shell started nothing.");
  return { shell, sleeping };
}

/** Which pane each session shows: its selected window's selected pane. */
async function showing(server: PrivateTmux): Promise<Record<string, string>> {
  const lines = (
    await server.ask(
      "list-panes",
      "-a",
      "-F",
      "#{session_name} #{window_active}#{pane_active} #{window_index}.#{pane_index}",
    )
  ).split("\n");
  const shown: Record<string, string> = {};
  for (const line of lines) {
    const [session, active, place] = line.split(" ");
    if (session && active === "11" && place) shown[session] = place;
  }
  return shown;
}

describe.skipIf(tmux === null)("the real tmux, on a server of the test's own", () => {
  test("finds the pane a process runs in, by its ancestors, and selects it", async () => {
    const server = privateTmux(tmux as string);
    const { shell, sleeping } = await twoSessions(server);
    expect(await showing(server)).toEqual({ "checkout-flow": "1.0", "docs-site": "0.0" });

    const finder = createPaneFinder({ run: server.run });
    await finder.look([sleeping, process.pid]);
    expect(finder.paneOf(sleeping)).toEqual(shell);
    // This test's own process is in no pane of that server.
    expect(finder.paneOf(process.pid)).toBeUndefined();

    expect(await selectPane(shell.id, server.run)).toEqual({
      ok: true,
      place: "checkout-flow:0.0",
    });
    // Its window is the session's selected window, and it is that window's
    // selected pane. The other session is as it was.
    expect(await showing(server)).toEqual({ "checkout-flow": "0.0", "docs-site": "0.0" });
  });

  test("switches a client that is showing another session, and leaves one that is not", async () => {
    const server = privateTmux(tmux as string);
    const { shell } = await twoSessions(server);
    await server.attach("docs-site");
    const clients = () => server.ask("list-clients", "-F", "#{session_name}");
    expect((await clients()).trim()).toBe("docs-site");

    expect((await selectPane(shell.id, server.run)).ok).toBe(true);
    expect((await clients()).trim()).toBe("checkout-flow");
    expect((await showing(server))["checkout-flow"]).toBe("0.0");

    // Selected again, with the client already there: nothing moves.
    expect((await selectPane(shell.id, server.run)).ok).toBe(true);
    expect((await clients()).trim()).toBe("checkout-flow");
  });

  test("says the pane has gone once it has closed, and changes nothing", async () => {
    const server = privateTmux(tmux as string);
    const { shell } = await twoSessions(server);
    await server.ask("kill-pane", "-t", shell.id);
    const before = await showing(server);

    expect(await selectPane(shell.id, server.run)).toEqual({ ok: false, reason: "pane-gone" });
    expect(await showing(server)).toEqual(before);
  });

  test("says tmux has stopped once its server has, and starts no server by asking", async () => {
    const server = privateTmux(tmux as string);
    const { shell, sleeping } = await twoSessions(server);
    await server.ask("kill-server");

    expect(await selectPane(shell.id, server.run)).toEqual({ ok: false, reason: "tmux-stopped" });
    const finder = createPaneFinder({ run: server.run });
    await finder.look([sleeping]);
    expect(finder.paneOf(sleeping)).toBeUndefined();
    expect((await server.run(["list-sessions"])).ok).toBe(false);
  });

  test("a session name with spaces and letters outside ASCII is read whole", async () => {
    const server = privateTmux(tmux as string);
    await server.ask("new-session", "-d", "-s", "búsqueda 索引 v2", "sleep 300");
    const [pane] = parsePanes(await server.ask(...LIST_PANES_ARGS));

    expect(pane?.place).toBe("búsqueda 索引 v2:0.0");
    expect(await selectPane(pane?.id ?? "", server.run)).toEqual({
      ok: true,
      place: "búsqueda 索引 v2:0.0",
    });
  });
});
