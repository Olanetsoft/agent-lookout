import { expect, test } from "vitest";

import { ANTIGRAVITY_CAPABILITIES } from "@collector/adapters/antigravity/index";
import { CLAUDE_CODE_CAPABILITIES } from "@collector/adapters/claude-code/index";
import { CODEX_CAPABILITIES, NEEDS_YOU_NOTE } from "@collector/adapters/codex/index";
import { STATUS_FILE_CAPABILITIES } from "@collector/adapters/status-files/index";
import { readRemoteSnapshot } from "@collector/remotes/remoteSessions";
import { sshArguments } from "@collector/remotes/sshProgram";
import { SOURCE_STATE_LABEL } from "@core/sessions/session";
import { MACHINE } from "@site-tour/feed/hour";
import * as tour from "@site-tour/feed/sources";
import {
  antigravityAdapterFor,
  memoryFiles,
  standInProcesses,
} from "@tests/support/adapters/antigravityAdapter";

// The landing page's dashboard cannot run the adapters, so it says their words
// itself. These hold it to the adapters' own, so it never says more than they do.

test("each source says what its agent can report in its adapter's own words", () => {
  expect(tour.CLAUDE_CODE_CAPABILITIES).toEqual(CLAUDE_CODE_CAPABILITIES);
  expect(tour.CODEX_CAPABILITIES).toEqual(CODEX_CAPABILITIES);
  expect(tour.ANTIGRAVITY_CAPABILITIES).toEqual(ANTIGRAVITY_CAPABILITIES);
  expect(tour.STATUS_FILE_CAPABILITIES).toEqual(STATUS_FILE_CAPABILITIES);
});

test("this computer's sources come in the collector's order", () => {
  const local = tour.sourcesAt(0, 1, "0.2.6").filter((source) => source.machine === undefined);
  expect(local.map((source) => source.id)).toEqual([
    "claude-code",
    "codex",
    "antigravity-cli",
    "status-files",
  ]);
});

test("Codex says, as its adapter does, that its sessions cannot be seen waiting", () => {
  expect(tour.CODEX_NEEDS_YOU_NOTE).toBe(NEEDS_YOU_NOTE);
  const codex = tour.sourcesAt(0, 1, "0.2.6").find((source) => source.id === "codex");
  expect(codex?.detail).toContain(NEEDS_YOU_NOTE);
  expect(codex?.capabilities?.["needs-you"].level).toBe("no");
});

test("the Antigravity CLI's card is the one its adapter shows on a computer without agy", async () => {
  const adapter = antigravityAdapterFor(memoryFiles(), standInProcesses());
  const { health, sessions } = await adapter.poll();
  const { capabilities, ...card } = tour
    .sourcesAt(0, 1, "0.2.6")
    .find((source) => source.id === "antigravity-cli")!;
  // The poller adds what the adapter can report to each health it gives.
  expect(card).toEqual({ ...health, checkedAt: card.checkedAt });
  expect(capabilities).toEqual(adapter.capabilities);
  expect(sessions).toEqual([]);
});

test("the other machine's agents and its row for each source are what this computer's reader makes of them", () => {
  const read = readRemoteSnapshot(
    {
      sources: [
        {
          id: "claude-code",
          label: "Claude Code",
          state: "ok",
          capabilities: CLAUDE_CODE_CAPABILITIES,
        },
        { id: "codex", label: "Codex", state: "unavailable", capabilities: CODEX_CAPABILITIES },
        {
          id: "antigravity-cli",
          label: "Antigravity CLI",
          state: "unavailable",
          capabilities: ANTIGRAVITY_CAPABILITIES,
        },
        {
          id: "status-files",
          label: "Status files",
          state: "not-set-up",
          capabilities: STATUS_FILE_CAPABILITIES,
        },
      ],
      sessions: [],
    },
    MACHINE.name,
    0,
  );
  const machine = tour.sourcesAt(0, 1, "0.2.6").find((source) => source.machine === MACHINE.name);
  expect(machine?.agents).toEqual(read?.agents);
  // Each of its sources is a row of its own, as the remote adapter writes them.
  const there = machine?.watching?.filter(
    (fact) => fact.label.endsWith(" there") && fact.label !== "Agent Lookout there",
  );
  expect(there).toEqual(
    read?.sources.map((source) => ({
      label: `${source.label} there`,
      value: SOURCE_STATE_LABEL[source.state],
    })),
  );
});

test("the other machine's card names the ssh command the tunnel runs, as it runs it", () => {
  const command = tour.MACHINE_COMMAND.split(" ");
  const port = Number(/127\.0\.0\.1:(\d+):/.exec(tour.MACHINE_COMMAND)?.[1]);
  expect(command.slice(1)).toEqual(
    sshArguments({ localPort: port, remotePort: MACHINE.port, target: MACHINE.target }),
  );
});
