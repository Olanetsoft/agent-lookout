import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { ANTIGRAVITY_APP_CAPABILITIES } from "@collector/adapters/antigravity/app/index";
import { TRUSTED_SCHEMA_OFF } from "@collector/adapters/antigravity/app/summaries";
import { ANTIGRAVITY_CAPABILITIES } from "@collector/adapters/antigravity/cli/index";
import { CLAUDE_CODE_CAPABILITIES } from "@collector/adapters/claude-code/index";
import { CLINE_CAPABILITIES } from "@collector/adapters/cline/index";
import { CODEX_CAPABILITIES } from "@collector/adapters/codex/index";
import { CONTINUE_CAPABILITIES } from "@collector/adapters/continue/index";
import {
  COMMAND_SHOWN as CRUSH_COMMAND,
  CRUSH_CAPABILITIES,
} from "@collector/adapters/crush/index";
import { GEMINI_CLI_CAPABILITIES } from "@collector/adapters/gemini-cli/index";
import {
  COMMAND_SHOWN as GOOSE_COMMAND,
  GOOSE_CAPABILITIES,
} from "@collector/adapters/goose/index";
import {
  COMMAND_SHOWN as HERMES_AGENT_COMMAND,
  HERMES_AGENT_CAPABILITIES,
} from "@collector/adapters/hermes-agent/index";
import { KIMI_CODE_CAPABILITIES } from "@collector/adapters/kimi-code/index";
import { MISTRAL_VIBE_CAPABILITIES } from "@collector/adapters/mistral-vibe/index";
import {
  COMMAND_SHOWN as OPENCODE_COMMAND,
  OPENCODE_CAPABILITIES,
} from "@collector/adapters/opencode/index";
import { PI_CAPABILITIES } from "@collector/adapters/pi/index";
import { QWEN_CODE_CAPABILITIES } from "@collector/adapters/qwen-code/index";
import { STATUS_FILE_CAPABILITIES } from "@collector/adapters/status-files/index";
import {
  CAPABILITIES,
  CAPABILITY_LABEL,
  CAPABILITY_LEVEL_LABEL,
  type SourceCapabilities,
} from "@core/sessions/session";

const GUIDE = fileURLToPath(new URL("../../../../docs/GUIDE.md", import.meta.url));
const README = fileURLToPath(new URL("../../../../README.md", import.meta.url));
const PRIVACY = fileURLToPath(new URL("../../../../PRIVACY.md", import.meta.url));
const CLINE_NOTES = fileURLToPath(new URL("../../../../docs/adapters/cline.md", import.meta.url));
const ANTIGRAVITY_NOTES = fileURLToPath(
  new URL("../../../../docs/adapters/antigravity.md", import.meta.url),
);
const GOOSE_NOTES = fileURLToPath(new URL("../../../../docs/adapters/goose.md", import.meta.url));
const PI_NOTES = fileURLToPath(new URL("../../../../docs/adapters/pi.md", import.meta.url));
const KIMI_CODE_NOTES = fileURLToPath(
  new URL("../../../../docs/adapters/kimi-code.md", import.meta.url),
);
const CONTINUE_NOTES = fileURLToPath(
  new URL("../../../../docs/adapters/continue.md", import.meta.url),
);
const CRUSH_NOTES = fileURLToPath(new URL("../../../../docs/adapters/crush.md", import.meta.url));

const GUIDE_HEADING = "#### What each agent can report";
const README_HEADING = "## Supported agents and systems";

/** Each adapter's row, by the name the guide gives it, in the order the guide lists them. */
const DECLARED: [string, SourceCapabilities][] = [
  ["Claude Code", CLAUDE_CODE_CAPABILITIES],
  ["Codex", CODEX_CAPABILITIES],
  ["Antigravity CLI", ANTIGRAVITY_CAPABILITIES],
  ["Antigravity", ANTIGRAVITY_APP_CAPABILITIES],
  ["Mistral Vibe", MISTRAL_VIBE_CAPABILITIES],
  ["Gemini CLI", GEMINI_CLI_CAPABILITIES],
  ["OpenCode", OPENCODE_CAPABILITIES],
  ["Qwen Code", QWEN_CODE_CAPABILITIES],
  ["Hermes Agent", HERMES_AGENT_CAPABILITIES],
  ["Cline", CLINE_CAPABILITIES],
  ["Goose", GOOSE_CAPABILITIES],
  ["Pi", PI_CAPABILITIES],
  ["Kimi Code", KIMI_CODE_CAPABILITIES],
  ["Continue", CONTINUE_CAPABILITIES],
  ["Crush", CRUSH_CAPABILITIES],
  ["Status files", STATUS_FILE_CAPABILITIES],
];

/** The cells of one Markdown table row, trimmed. */
function cells(line: string): string[] {
  return line
    .slice(1, line.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * One section of a Markdown file, from its heading to the next heading: each
 * table in it, as rows of cells without the line under the heads, and its list
 * of reasons.
 */
async function section(
  file: string,
  heading: string,
): Promise<{ tables: string[][][]; reasons: string[] }> {
  const text = await readFile(file, "utf8");
  const start = text.indexOf(`\n${heading}\n`);
  expect(start, `${file} has no "${heading}"`).toBeGreaterThan(-1);
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(/\n#{1,4} /);
  const lines = (end === -1 ? rest : rest.slice(0, end)).split("\n");

  const tables: string[][][] = [];
  let open = false;
  for (const line of lines) {
    if (!line.startsWith("|")) {
      open = false;
      continue;
    }
    const row = cells(line);
    // The line under the heads is only dashes.
    if (row.every((cell) => /^:?-+:?$/.test(cell))) continue;
    if (!open) tables.push([]);
    open = true;
    tables[tables.length - 1].push(row);
  }
  const reasons = lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
  return { tables, reasons };
}

test("the table in docs/GUIDE.md says what each adapter declares, cell for cell", async () => {
  const { tables } = await section(GUIDE, GUIDE_HEADING);
  const [heads, ...rows] = tables[0];

  expect(heads).toEqual([
    "Agent",
    ...CAPABILITIES.map((capability) => CAPABILITY_LABEL[capability]),
  ]);
  expect(rows).toEqual(
    DECLARED.map(([agent, declared]) => [
      agent,
      ...CAPABILITIES.map((capability) => CAPABILITY_LEVEL_LABEL[declared[capability].level]),
    ]),
  );
});

test("the list under it gives each declared reason in the adapter's own words, and no other", async () => {
  const { reasons } = await section(GUIDE, GUIDE_HEADING);

  const declared = DECLARED.flatMap(([agent, capabilities]) =>
    CAPABILITIES.flatMap((capability) => {
      const cell = capabilities[capability];
      return cell.level === "yes"
        ? []
        : [`${agent}, ${CAPABILITY_LABEL[capability]}: ${cell.reason}`];
    }),
  );
  expect(reasons).toEqual(declared);
});

test("the agent table in README.md says what each adapter declares, in each column it has", async () => {
  const { tables } = await section(README, README_HEADING);
  const [heads, ...rows] = tables[0];
  const [first, ...columns] = heads;

  expect(first).toBe("Agent");
  // Each column is one capability, by the label the Sources view gives it.
  const capabilities = columns.map((column) =>
    CAPABILITIES.find((capability) => CAPABILITY_LABEL[capability] === column),
  );
  expect(capabilities, "a column of README.md names no capability").not.toContain(undefined);
  expect(new Set(capabilities).size).toBe(capabilities.length);
  expect(rows).toEqual(
    DECLARED.map(([agent, declared]) => [
      agent,
      ...capabilities.map((capability) =>
        capability === undefined ? "" : CAPABILITY_LEVEL_LABEL[declared[capability].level],
      ),
    ]),
  );
});

test("PRIVACY.md and the Cline notes name what is read and from which version", async () => {
  const privacy = await readFile(PRIVACY, "utf8");
  const notes = await readFile(CLINE_NOTES, "utf8");
  const line = (start: string) => privacy.split("\n").find((one) => one.startsWith(start)) ?? "";

  const cline = line("For Cline, Agent Lookout reads");
  expect(cline).toContain("built from Cline's source at cli-v3.0.74");
  expect(cline).not.toContain("Hermes Agent");
  expect(line("For Hermes Agent, Agent Lookout runs")).toContain(
    "built from Hermes Agent's source at v0.22.5",
  );
  expect(notes).toContain("cli-v3.0.74");

  for (const text of [privacy, notes]) {
    expect(text).toContain("~/.cline/data/sessions");
    for (const field of ["session_id", "pid", "started_at", "ended_at", "status", "cwd"]) {
      expect(text).toContain(field);
    }
  }
});

test("every read Agent Lookout runs with sqlite3 that a card, PRIVACY.md or the Antigravity notes print keeps the schema from being trusted", async () => {
  for (const command of [OPENCODE_COMMAND, HERMES_AGENT_COMMAND, GOOSE_COMMAND, CRUSH_COMMAND]) {
    expect(command).toContain(`-cmd "${TRUSTED_SCHEMA_OFF}" <database>`);
  }
  for (const file of [PRIVACY, ANTIGRAVITY_NOTES]) {
    const printed = (await readFile(file, "utf8"))
      .split("\n")
      .filter((line) => line.startsWith("sqlite3 -init "));
    expect(printed).not.toEqual([]);
    for (const command of printed) {
      expect(command).toContain(`-cmd '${TRUSTED_SCHEMA_OFF}' `);
    }
  }
});

test("PRIVACY.md and the Goose notes name what is read and from which version", async () => {
  const privacy = await readFile(PRIVACY, "utf8");
  const notes = await readFile(GOOSE_NOTES, "utf8");
  const line = (start: string) => privacy.split("\n").find((one) => one.startsWith(start)) ?? "";

  const goose = line("For Goose, Agent Lookout runs");
  expect(goose).toContain("built from Goose's source at v1.57.0");
  expect(goose).not.toContain("Cline");
  expect(goose).toContain("`ps`");
  expect(notes).toContain("v1.57.0");

  const start = privacy.indexOf("### Goose's files");
  const section = privacy.slice(start, privacy.indexOf("\n### ", start));
  for (const text of [section, notes]) {
    expect(text).toContain("~/.local/share/goose/sessions/sessions.db");
    for (const field of [
      "working_dir",
      "user_set_name",
      "created_at",
      "updated_at",
      "session_type",
      "archived_at",
      "messages",
      "ps -A -o comm=",
    ]) {
      expect(text).toContain(field);
    }
  }
});

test("PRIVACY.md and the Pi notes name what is read and from which version", async () => {
  const privacy = await readFile(PRIVACY, "utf8");
  const notes = await readFile(PI_NOTES, "utf8");
  const line = (start: string) => privacy.split("\n").find((one) => one.startsWith(start)) ?? "";

  const pi = line("For Pi, Agent Lookout reads");
  expect(pi).toContain("built from Pi's source at v1.5.0");
  expect(pi).not.toContain("Goose");
  expect(pi).toContain("`ps`");
  expect(notes).toContain("v1.5.0");

  const start = privacy.indexOf("### Pi's files");
  const section = privacy.slice(start, privacy.indexOf("\n### ", start));
  for (const text of [section, notes]) {
    expect(text).toContain("~/.pi/agent/sessions");
    for (const field of ["id", "cwd", "timestamp", "version", "session_info", "ps -A -o comm="]) {
      expect(text).toContain(field);
    }
  }
});

test("PRIVACY.md and the Kimi Code notes name what is read and from which version", async () => {
  const privacy = await readFile(PRIVACY, "utf8");
  const notes = await readFile(KIMI_CODE_NOTES, "utf8");
  const start = privacy.indexOf("### Kimi Code's files");
  const section = privacy.slice(start, privacy.indexOf("\n### ", start));
  expect(start).toBeGreaterThan(-1);
  expect(section).toContain("built from Kimi Code's source at 2.4.1");
  expect(notes).toContain("2.4.1");

  for (const text of [section, notes]) {
    for (const field of [
      "~/.kimi-code",
      "session_index.jsonl",
      "locks/sessions",
      "state.json",
      "wire.jsonl",
      "sessionId",
      "sessionDir",
      "workDir",
      "startedAt",
      "cwd",
      "createdAt",
      "updatedAt",
      "lastTurnReason",
      "archived",
      "titleKind",
      "isCustomTitle",
      "interaction.request",
      "interaction.resolved",
      "ps -o pid=,lstart= -p <pids>",
    ]) {
      expect(text).toContain(field);
    }
  }
});

test("PRIVACY.md and the Continue notes name what is read and from which version", async () => {
  const privacy = await readFile(PRIVACY, "utf8");
  const notes = await readFile(CONTINUE_NOTES, "utf8");
  const start = privacy.indexOf("### Continue's files");
  const section = privacy.slice(start, privacy.indexOf("\n### ", start));
  expect(start).toBeGreaterThan(-1);
  expect(section).toContain("built from Continue's source at v1.5.45");
  expect(notes).toContain("v1.5.45");

  for (const text of [section, notes]) {
    for (const field of [
      "~/.continue/sessions",
      "sessions.json",
      "sessionId",
      "workspaceDirectory",
      "dateCreated",
      "title",
      "CONTINUE_GLOBAL_DIR",
      "generated",
    ]) {
      expect(text).toContain(field);
    }
  }
});

test("PRIVACY.md and the Crush notes name what is read and from which version", async () => {
  const privacy = await readFile(PRIVACY, "utf8");
  const notes = await readFile(CRUSH_NOTES, "utf8");
  const line = (start: string) => privacy.split("\n").find((one) => one.startsWith(start)) ?? "";

  const crush = line("For Crush, Agent Lookout reads");
  expect(crush).toContain("built from Crush's source at v0.99.0");
  expect(crush).toContain("`ps`");
  expect(notes).toContain("v0.99.0");
  expect(notes).toContain("FSL-1.1-MIT");

  const start = privacy.indexOf("### Crush's files");
  expect(start).toBeGreaterThan(-1);
  const section = privacy.slice(start, privacy.indexOf("\n### ", start));
  for (const text of [section, notes]) {
    for (const field of [
      "~/.local/share/crush/projects.json",
      ".crush/crush.db",
      "parent_session_id",
      "message_count",
      "created_at",
      "updated_at",
      "ps -A -o comm=",
    ]) {
      expect(text).toContain(field);
    }
  }
});
