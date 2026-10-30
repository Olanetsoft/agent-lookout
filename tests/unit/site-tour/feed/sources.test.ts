import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

import { ANTIGRAVITY_APP_CAPABILITIES } from "@collector/adapters/antigravity/app/index";
import { ANTIGRAVITY_CAPABILITIES } from "@collector/adapters/antigravity/cli/index";
import { CLAUDE_CODE_CAPABILITIES } from "@collector/adapters/claude-code/index";
import { CODEX_CAPABILITIES, NEEDS_YOU_NOTE } from "@collector/adapters/codex/index";
import { GEMINI_CLI_CAPABILITIES } from "@collector/adapters/gemini-cli/index";
import { HERMES_AGENT_CAPABILITIES } from "@collector/adapters/hermes-agent/index";
import { MISTRAL_VIBE_CAPABILITIES } from "@collector/adapters/mistral-vibe/index";
import { OPENCODE_CAPABILITIES } from "@collector/adapters/opencode/index";
import { QWEN_CODE_CAPABILITIES } from "@collector/adapters/qwen-code/index";
import { STATUS_FILE_CAPABILITIES } from "@collector/adapters/status-files/index";
import { readRemoteSnapshot } from "@collector/remotes/remoteSessions";
import { sshArguments } from "@collector/remotes/sshProgram";
import { SOURCE_STATE_LABEL } from "@core/sessions/session";
import { MACHINE } from "@site-tour/feed/hour";
import * as tour from "@site-tour/feed/sources";
import {
  antigravityAdapterFor,
  antigravityAppAdapterFor,
  memoryFiles,
  standInHub,
  standInProcesses,
} from "@tests/support/adapters/antigravityAdapter";
import { geminiCliAdapterFor } from "@tests/support/adapters/geminiCliAdapter";
import { hermesAgentAdapterFor } from "@tests/support/adapters/hermesAgentAdapter";
import { vibeAdapterFor } from "@tests/support/adapters/mistralVibeAdapter";
import { opencodeAdapterFor } from "@tests/support/adapters/opencodeAdapter";
import { qwenCodeAdapterFor } from "@tests/support/adapters/qwenCodeAdapter";

const readme = readFileSync(new URL("../../../../README.md", import.meta.url), "utf8");
const page = readFileSync(new URL("../../../../site/index.html", import.meta.url), "utf8");

// The landing page's dashboard cannot run the adapters, so it says their words
// itself. These hold it to the adapters' own, so it never says more than they do.

test("each source says what its agent can report in its adapter's own words", () => {
  expect(tour.CLAUDE_CODE_CAPABILITIES).toEqual(CLAUDE_CODE_CAPABILITIES);
  expect(tour.CODEX_CAPABILITIES).toEqual(CODEX_CAPABILITIES);
  expect(tour.ANTIGRAVITY_CAPABILITIES).toEqual(ANTIGRAVITY_CAPABILITIES);
  expect(tour.ANTIGRAVITY_APP_CAPABILITIES).toEqual(ANTIGRAVITY_APP_CAPABILITIES);
  expect(tour.MISTRAL_VIBE_CAPABILITIES).toEqual(MISTRAL_VIBE_CAPABILITIES);
  expect(tour.GEMINI_CLI_CAPABILITIES).toEqual(GEMINI_CLI_CAPABILITIES);
  expect(tour.OPENCODE_CAPABILITIES).toEqual(OPENCODE_CAPABILITIES);
  expect(tour.QWEN_CODE_CAPABILITIES).toEqual(QWEN_CODE_CAPABILITIES);
  expect(tour.HERMES_AGENT_CAPABILITIES).toEqual(HERMES_AGENT_CAPABILITIES);
  expect(tour.STATUS_FILE_CAPABILITIES).toEqual(STATUS_FILE_CAPABILITIES);
});

test("this computer's sources come in the collector's order", () => {
  const local = tour.sourcesAt(0, 1, "0.2.6").filter((source) => source.machine === undefined);
  expect(local.map((source) => source.id)).toEqual([
    "claude-code",
    "codex",
    "antigravity-cli",
    "antigravity-app",
    "mistral-vibe",
    "gemini-cli",
    "opencode",
    "qwen-code",
    "hermes-agent",
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

test("Antigravity's card is the one its adapter shows on a computer without the app", async () => {
  const adapter = antigravityAppAdapterFor(memoryFiles(), standInHub());
  const { health, sessions } = await adapter.poll();
  const { capabilities, ...card } = tour
    .sourcesAt(0, 1, "0.2.6")
    .find((source) => source.id === "antigravity-app")!;
  // The poller adds what the adapter can report to each health it gives.
  expect(card).toEqual({ ...health, checkedAt: card.checkedAt });
  expect(capabilities).toEqual(adapter.capabilities);
  expect(sessions).toEqual([]);
});

test("Mistral Vibe's card is the one its adapter shows on a computer without Vibe", async () => {
  const adapter = vibeAdapterFor(memoryFiles());
  const { health, sessions } = await adapter.poll();
  const { capabilities, ...card } = tour
    .sourcesAt(0, 1, "0.2.6")
    .find((source) => source.id === "mistral-vibe")!;
  // The poller adds what the adapter can report to each health it gives.
  expect(card).toEqual({ ...health, checkedAt: card.checkedAt });
  expect(capabilities).toEqual(adapter.capabilities);
  expect(sessions).toEqual([]);
});

test("Gemini CLI's card is the one its adapter shows on a computer without it", async () => {
  const adapter = geminiCliAdapterFor(memoryFiles());
  const { health, sessions } = await adapter.poll();
  const { capabilities, ...card } = tour
    .sourcesAt(0, 1, "0.2.6")
    .find((source) => source.id === "gemini-cli")!;
  // The poller adds what the adapter can report to each health it gives.
  expect(card).toEqual({ ...health, checkedAt: card.checkedAt });
  expect(capabilities).toEqual(adapter.capabilities);
  expect(sessions).toEqual([]);
});

test("OpenCode's card is the one its adapter shows on a computer without it", async () => {
  const adapter = opencodeAdapterFor(memoryFiles());
  const { health, sessions } = await adapter.poll();
  const { capabilities, ...card } = tour
    .sourcesAt(0, 1, "0.2.6")
    .find((source) => source.id === "opencode")!;
  // The poller adds what the adapter can report to each health it gives.
  expect(card).toEqual({ ...health, checkedAt: card.checkedAt });
  expect(capabilities).toEqual(adapter.capabilities);
  expect(sessions).toEqual([]);
});

test("Qwen Code's card is the one its adapter shows on a computer without it", async () => {
  const adapter = qwenCodeAdapterFor(memoryFiles());
  const { health, sessions } = await adapter.poll();
  const { capabilities, ...card } = tour
    .sourcesAt(0, 1, "0.2.6")
    .find((source) => source.id === "qwen-code")!;
  // The poller adds what the adapter can report to each health it gives.
  expect(card).toEqual({ ...health, checkedAt: card.checkedAt });
  expect(capabilities).toEqual(adapter.capabilities);
  expect(sessions).toEqual([]);
});

test("Hermes Agent's card is the one its adapter shows on a computer without it", async () => {
  const adapter = hermesAgentAdapterFor(memoryFiles());
  const { health, sessions } = await adapter.poll();
  const { capabilities, ...card } = tour
    .sourcesAt(0, 1, "0.2.6")
    .find((source) => source.id === "hermes-agent")!;
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
          id: "antigravity-app",
          label: "Antigravity",
          state: "unavailable",
          capabilities: ANTIGRAVITY_APP_CAPABILITIES,
        },
        {
          id: "mistral-vibe",
          label: "Mistral Vibe",
          state: "unavailable",
          capabilities: MISTRAL_VIBE_CAPABILITIES,
        },
        {
          id: "gemini-cli",
          label: "Gemini CLI",
          state: "unavailable",
          capabilities: GEMINI_CLI_CAPABILITIES,
        },
        {
          id: "opencode",
          label: "OpenCode",
          state: "unavailable",
          capabilities: OPENCODE_CAPABILITIES,
        },
        {
          id: "qwen-code",
          label: "Qwen Code",
          state: "unavailable",
          capabilities: QWEN_CODE_CAPABILITIES,
        },
        {
          id: "hermes-agent",
          label: "Hermes Agent",
          state: "unavailable",
          capabilities: HERMES_AGENT_CAPABILITIES,
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

/**
 * The agents whose support is not released yet. The landing page goes live as
 * soon as it changes, so it names an agent at the release that ships it, and
 * the agent leaves this list then.
 */
const NOT_ON_THE_PAGE_YET = new Set(["Hermes Agent"]);

test("the page's Works with names every agent the tour's Sources reads", () => {
  const works = /<div class="works">([\s\S]*?)<\/div\s*>/.exec(page)?.[1] ?? "";
  const named = [...works.matchAll(/<li>([\s\S]*?)<\/li\s*>/g)]
    .map(([, name]) => name.replace(/\s+/g, " ").trim())
    .filter((name) => name !== "your own agents");
  const read = tour
    .sourcesAt(0, 1, "0.2.6")
    .filter((source) => source.machine === undefined)
    .map((source) => source.label)
    .filter((label) => label !== "Status files" && !NOT_ON_THE_PAGE_YET.has(label));
  // The agent column of the README's table of what each agent can report.
  const table = readme.slice(readme.indexOf("| Agent "));
  const rows = table.slice(0, table.indexOf("\n\n")).split("\n").slice(2);
  const inReadme = rows
    .map((row) => row.split("|")[1].trim())
    .filter((agent) => agent !== "Status files" && !NOT_ON_THE_PAGE_YET.has(agent));
  expect(named).toHaveLength(8);
  expect(new Set(named)).toEqual(new Set(read));
  expect(new Set(named)).toEqual(new Set(inReadme));
});
