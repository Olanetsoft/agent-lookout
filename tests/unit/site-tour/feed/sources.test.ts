import { expect, test } from "vitest";

import { CLAUDE_CODE_CAPABILITIES } from "@collector/adapters/claude-code/index";
import { CODEX_CAPABILITIES, NEEDS_YOU_NOTE } from "@collector/adapters/codex/index";
import { STATUS_FILE_CAPABILITIES } from "@collector/adapters/status-files/index";
import { readRemoteSnapshot } from "@collector/remotes/remoteSessions";
import { sshArguments } from "@collector/remotes/sshProgram";
import { MACHINE } from "@site-tour/feed/hour";
import * as tour from "@site-tour/feed/sources";

// The landing page's dashboard cannot run the adapters, so it says their words
// itself. These hold it to the adapters' own, so it never says more than they do.

test("each source says what its agent can report in its adapter's own words", () => {
  expect(tour.CLAUDE_CODE_CAPABILITIES).toEqual(CLAUDE_CODE_CAPABILITIES);
  expect(tour.CODEX_CAPABILITIES).toEqual(CODEX_CAPABILITIES);
  expect(tour.STATUS_FILE_CAPABILITIES).toEqual(STATUS_FILE_CAPABILITIES);
});

test("Codex says, as its adapter does, that its sessions cannot be seen waiting", () => {
  expect(tour.CODEX_NEEDS_YOU_NOTE).toBe(NEEDS_YOU_NOTE);
  const codex = tour.sourcesAt(0, 1, "0.2.6").find((source) => source.id === "codex");
  expect(codex?.detail).toContain(NEEDS_YOU_NOTE);
  expect(codex?.capabilities?.["needs-you"].level).toBe("no");
});

test("Claude Code on the other machine reports what this computer's reader makes of it", () => {
  const read = readRemoteSnapshot(
    {
      sources: [
        {
          id: "claude-code",
          label: "Claude Code",
          state: "ok",
          capabilities: CLAUDE_CODE_CAPABILITIES,
        },
      ],
      sessions: [],
    },
    MACHINE.name,
    0,
  );
  const machine = tour.sourcesAt(0, 1, "0.2.6").find((source) => source.machine === MACHINE.name);
  expect(machine?.agents).toEqual(read?.agents);
});

test("the other machine's card names the ssh command the tunnel runs, as it runs it", () => {
  const command = tour.MACHINE_COMMAND.split(" ");
  const port = Number(/127\.0\.0\.1:(\d+):/.exec(tour.MACHINE_COMMAND)?.[1]);
  expect(command.slice(1)).toEqual(
    sshArguments({ localPort: port, remotePort: MACHINE.port, target: MACHINE.target }),
  );
});
