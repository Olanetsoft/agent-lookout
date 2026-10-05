import { describe, expect, test } from "vitest";

import {
  clientsElsewhere,
  describePaneArgs,
  failureOf,
  LIST_CLIENTS_ARGS,
  selectPane,
  selectPaneArgs,
  selectWindowArgs,
  switchClientArgs,
} from "@collector/tmux/selectPane";
import { fakeTmux } from "@tests/support/node/tmux";

describe("the commands", () => {
  test("each is fixed but for the pane's id, and a client's name", () => {
    expect(selectWindowArgs("%7")).toEqual(["select-window", "-t", "%7"]);
    expect(selectPaneArgs("%7")).toEqual(["select-pane", "-t", "%7"]);
    expect(describePaneArgs("%7")).toEqual([
      "-u",
      "display-message",
      "-p",
      "-t",
      "%7",
      "#{session_id} #{window_index} #{pane_index} #{session_name}",
    ]);
    expect(LIST_CLIENTS_ARGS).toEqual(["list-clients", "-F", "#{session_id} #{client_name}"]);
    expect(switchClientArgs("/dev/ttys003", "%7")).toEqual([
      "switch-client",
      "-c",
      "/dev/ttys003",
      "-t",
      "%7",
    ]);
  });
});

describe("failureOf", () => {
  const failure = (stderr: string) => failureOf({ ok: false, stderr });

  test("tmux saying it cannot find the pane means the pane has gone", () => {
    expect(failure("can't find pane: %7")).toBe("pane-gone");
    expect(failure("can't find window: %7")).toBe("pane-gone");
    expect(failure("can't find session: %7")).toBe("pane-gone");
  });

  test("tmux saying it has no server means tmux has stopped", () => {
    expect(failure("no server running on /private/tmp/tmux-501/default")).toBe("tmux-stopped");
    expect(
      failure("error connecting to /private/tmp/tmux-501/default (No such file or directory)"),
    ).toBe("tmux-stopped");
    expect(failure("lost server")).toBe("tmux-stopped");
    expect(failure("server exited unexpectedly")).toBe("tmux-stopped");
  });

  test("anything else, and nothing at all, is a failure with no known reason", () => {
    expect(failure("")).toBe("failed");
    expect(failure("unknown command: select-pan")).toBe("failed");
  });
});

describe("clientsElsewhere", () => {
  test("names the clients showing another session, and leaves the ones already there", () => {
    const stdout = "$0 /dev/ttys003\n$2 /dev/ttys004\n$2 client-4821\n$0 /dev/pts/7\n";
    expect(clientsElsewhere(stdout, "$0")).toEqual(["/dev/ttys004", "client-4821"]);
    expect(clientsElsewhere(stdout, "$2")).toEqual(["/dev/ttys003", "/dev/pts/7"]);
  });

  test("a line that is not a session id and a client's name is left out", () => {
    const stdout = [
      "",
      "/dev/ttys003",
      "0 /dev/ttys003",
      "$1 ",
      "$1 /dev/ttys003 extra",
      "$1 -t",
      "$1 $(reboot)",
      "$1 /dev/ttys009",
    ].join("\n");
    expect(clientsElsewhere(stdout, "$0")).toEqual(["/dev/ttys009"]);
  });

  test("with no client attached there is nobody to switch", () => {
    expect(clientsElsewhere("", "$0")).toEqual([]);
  });
});

describe("selectPane", () => {
  const PANES = ["4301 %7 2 1 checkout-flow", "4401 %8 0 0 docs-site"];

  test("selects the window, then the pane, asks where it is, and switches only the clients elsewhere", async () => {
    const tmux = fakeTmux({
      panes: PANES,
      where: "$0 2 1 checkout-flow",
      clients: ["$0 /dev/ttys003", "$3 /dev/ttys004", "$3 client-4821"],
    });

    expect(await selectPane("%7", tmux.run)).toEqual({ ok: true, place: "checkout-flow:2.1" });
    expect(tmux.ran).toEqual([
      ["select-window", "-t", "%7"],
      ["select-pane", "-t", "%7"],
      describePaneArgs("%7"),
      [...LIST_CLIENTS_ARGS],
      ["switch-client", "-c", "/dev/ttys004", "-t", "%7"],
      ["switch-client", "-c", "client-4821", "-t", "%7"],
    ]);
  });

  test("with every client already on the session, none is switched", async () => {
    const tmux = fakeTmux({ panes: PANES, clients: ["$0 /dev/ttys003"] });
    await selectPane("%7", tmux.run);

    expect(tmux.names()).toEqual([
      "select-window",
      "select-pane",
      "display-message",
      "list-clients",
    ]);
  });

  test("with no client attached, the pane is selected all the same", async () => {
    const tmux = fakeTmux({ panes: PANES });
    expect(await selectPane("%7", tmux.run)).toEqual({ ok: true, place: "checkout-flow:0.0" });
  });

  test("a pane that has gone stops at the first command, and nothing else is run", async () => {
    const tmux = fakeTmux({ panes: ["4401 %8 0 0 docs-site"], clients: ["$3 /dev/ttys004"] });

    expect(await selectPane("%7", tmux.run)).toEqual({ ok: false, reason: "pane-gone" });
    expect(tmux.ran).toEqual([["select-window", "-t", "%7"]]);
  });

  test("a tmux that has stopped is said to have stopped", async () => {
    const tmux = fakeTmux({ panes: PANES });
    tmux.down = "no server running on /private/tmp/tmux-501/default";

    expect(await selectPane("%7", tmux.run)).toEqual({ ok: false, reason: "tmux-stopped" });
    expect(tmux.names()).toEqual(["select-window"]);
  });

  test("a tmux that was never started, because there is none, is a plain failure", async () => {
    const ran: string[][] = [];
    const outcome = await selectPane("%7", async (args) => {
      ran.push([...args]);
      return { ok: false, stderr: "" };
    });

    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(ran).toHaveLength(1);
  });

  test.each([
    "",
    "7",
    "%",
    "checkout-flow:0.0",
    "%7;kill-server",
    "%7 -t %8",
    "-t",
    "%7\n",
    "$(tmux kill-server)",
  ])("for %j, which is not a pane id, nothing is run at all", async (id) => {
    const tmux = fakeTmux({ panes: PANES });

    expect(await selectPane(id, tmux.run)).toEqual({ ok: false, reason: "failed" });
    expect(tmux.ran).toEqual([]);
  });

  test("when tmux does not say where the pane is, it is still selected, and no client is switched", async () => {
    const tmux = fakeTmux({ panes: PANES, where: "nonsense", clients: ["$3 /dev/ttys004"] });

    expect(await selectPane("%7", tmux.run)).toEqual({ ok: true, place: null });
    expect(tmux.names()).toEqual(["select-window", "select-pane", "display-message"]);
  });

  test("a client that cannot be switched does not undo the selection", async () => {
    const tmux = fakeTmux({ panes: PANES, clients: ["$3 /dev/ttys004"] });
    const run: typeof tmux.run = async (args) =>
      args[0] === "switch-client"
        ? { ok: false, stderr: "can't find client: /dev/ttys004" }
        : tmux.run(args);

    expect(await selectPane("%7", run)).toEqual({ ok: true, place: "checkout-flow:0.0" });
  });
});
