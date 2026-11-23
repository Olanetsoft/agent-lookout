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
import {
  COMMAND_SHOWN as KILO_CODE_COMMAND,
  KILO_CODE_CAPABILITIES,
  UNCHECKED_NOTE as KILO_CODE_UNCHECKED_NOTE,
} from "@collector/adapters/kilo-code/index";
import { FX_CAPABILITIES, UNCHECKED_NOTE as FX_UNCHECKED_NOTE } from "@collector/adapters/fx/index";
import {
  UNCHECKED_NOTE as UNREAL_AGENT_UNCHECKED_NOTE,
  UNREAL_AGENT_CAPABILITIES,
} from "@collector/adapters/unreal-agent/index";
import {
  AUTOHAND_CODE_CAPABILITIES,
  UNCHECKED_NOTE as AUTOHAND_CODE_UNCHECKED_NOTE,
} from "@collector/adapters/autohand-code/index";
import {
  DEEPSEEK_HARNESS_CAPABILITIES,
  UNCHECKED_NOTE as DEEPSEEK_HARNESS_UNCHECKED_NOTE,
} from "@collector/adapters/deepseek-harness/index";
import {
  DROID_CAPABILITIES,
  UNCHECKED_NOTE as DROID_UNCHECKED_NOTE,
} from "@collector/adapters/droid/index";
import {
  GROK_BUILD_CAPABILITIES,
  UNCHECKED_NOTE as GROK_BUILD_UNCHECKED_NOTE,
} from "@collector/adapters/grok-build/index";
import {
  OH_MY_PI_CAPABILITIES,
  UNCHECKED_NOTE as OH_MY_PI_UNCHECKED_NOTE,
} from "@collector/adapters/oh-my-pi/index";
import {
  MUSE_CODE_CAPABILITIES,
  UNCHECKED_BUILT as MUSE_CODE_UNCHECKED_BUILT,
  UNCHECKED_NOT as MUSE_CODE_UNCHECKED_NOT,
  UNCHECKED_READERS as MUSE_CODE_UNCHECKED_READERS,
} from "@collector/adapters/muse-code/index";
import {
  KIMCHI_CAPABILITIES,
  UNCHECKED_NOTE as KIMCHI_UNCHECKED_NOTE,
} from "@collector/adapters/kimchi/index";
import { KIMI_CODE_CAPABILITIES } from "@collector/adapters/kimi-code/index";
import {
  PRIME_AGENT_CAPABILITIES,
  UNCHECKED_NOTE as PRIME_AGENT_UNCHECKED_NOTE,
} from "@collector/adapters/prime-agent/index";
import {
  COMMAND_SHOWN as MIMO_CODE_COMMAND,
  MIMO_CODE_CAPABILITIES,
  UNCHECKED_NOTE as MIMO_CODE_UNCHECKED_NOTE,
} from "@collector/adapters/mimo-code/index";
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
const KILO_CODE_NOTES = fileURLToPath(
  new URL("../../../../docs/adapters/kilo-code.md", import.meta.url),
);
const MIMO_CODE_NOTES = fileURLToPath(
  new URL("../../../../docs/adapters/mimo-code.md", import.meta.url),
);
const KIMCHI_NOTES = fileURLToPath(new URL("../../../../docs/adapters/kimchi.md", import.meta.url));
const PRIME_AGENT_NOTES = fileURLToPath(
  new URL("../../../../docs/adapters/prime-agent.md", import.meta.url),
);
const FX_NOTES = fileURLToPath(new URL("../../../../docs/adapters/fx.md", import.meta.url));
const UNREAL_AGENT_NOTES = fileURLToPath(
  new URL("../../../../docs/adapters/unreal-agent.md", import.meta.url),
);
const AUTOHAND_CODE_NOTES = fileURLToPath(
  new URL("../../../../docs/adapters/autohand-code.md", import.meta.url),
);
const DEEPSEEK_HARNESS_NOTES = fileURLToPath(
  new URL("../../../../docs/adapters/deepseek-harness.md", import.meta.url),
);
const DROID_NOTES = fileURLToPath(new URL("../../../../docs/adapters/droid.md", import.meta.url));
const GROK_BUILD_NOTES = fileURLToPath(
  new URL("../../../../docs/adapters/grok-build.md", import.meta.url),
);
const OH_MY_PI_NOTES = fileURLToPath(
  new URL("../../../../docs/adapters/oh-my-pi.md", import.meta.url),
);
const MUSE_CODE_NOTES = fileURLToPath(
  new URL("../../../../docs/adapters/muse-code.md", import.meta.url),
);

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
  ["Kilo Code", KILO_CODE_CAPABILITIES],
  ["MiMo Code", MIMO_CODE_CAPABILITIES],
  ["Kimchi", KIMCHI_CAPABILITIES],
  ["Prime Agent", PRIME_AGENT_CAPABILITIES],
  ["fx", FX_CAPABILITIES],
  ["Unreal Agent", UNREAL_AGENT_CAPABILITIES],
  ["Autohand Code", AUTOHAND_CODE_CAPABILITIES],
  ["DeepSeek Harness", DEEPSEEK_HARNESS_CAPABILITIES],
  ["Droid", DROID_CAPABILITIES],
  ["Grok Build", GROK_BUILD_CAPABILITIES],
  ["Oh My Pi", OH_MY_PI_CAPABILITIES],
  ["Muse Code", MUSE_CODE_CAPABILITIES],
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
    "built from Hermes Agent's source at v0.23.3",
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
  for (const command of [
    OPENCODE_COMMAND,
    HERMES_AGENT_COMMAND,
    GOOSE_COMMAND,
    CRUSH_COMMAND,
    KILO_CODE_COMMAND,
    MIMO_CODE_COMMAND,
  ]) {
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
  expect(goose).toContain("built from Goose's source at v1.60.2");
  expect(goose).not.toContain("Cline");
  expect(goose).toContain("`ps`");
  expect(notes).toContain("v1.60.2");

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
  expect(pi).toContain("built from Pi's source at v1.6.0");
  expect(pi).not.toContain("Goose");
  expect(pi).toContain("`ps`");
  expect(notes).toContain("v1.6.0");

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
  expect(section).toContain("built from Kimi Code's source at 2.7.2");
  expect(notes).toContain("2.7.2");

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

test("PRIVACY.md and the Kilo Code notes name what is read and from which version", async () => {
  const privacy = await readFile(PRIVACY, "utf8");
  const notes = await readFile(KILO_CODE_NOTES, "utf8");
  const line = (start: string) => privacy.split("\n").find((one) => one.startsWith(start)) ?? "";

  const kilo = line("For Kilo Code, Agent Lookout runs");
  expect(kilo).toContain("built from Kilo Code's source at v7.8.27");
  expect(kilo).toContain("`ps`");
  expect(KILO_CODE_UNCHECKED_NOTE).toContain("v7.8.27");
  expect(notes).toContain("v7.8.27");
  expect(notes).toContain("03a6f07");
  expect(notes).toContain("MIT");

  const start = privacy.indexOf("### Kilo Code's files");
  expect(start).toBeGreaterThan(-1);
  const section = privacy.slice(start, privacy.indexOf("\n### ", start));
  for (const text of [section, notes]) {
    for (const field of [
      "~/.local/share/kilo/kilo.db",
      "KILO_DB",
      "account",
      "control_account",
      "credential",
      "ps -A -o comm=",
    ]) {
      expect(text).toContain(field);
    }
  }
});

test("PRIVACY.md and the MiMo Code notes name what is read and from which version", async () => {
  const privacy = await readFile(PRIVACY, "utf8");
  const notes = await readFile(MIMO_CODE_NOTES, "utf8");
  const line = (start: string) => privacy.split("\n").find((one) => one.startsWith(start)) ?? "";

  const mimo = line("For MiMo Code, Agent Lookout runs");
  expect(mimo).toContain("built from MiMo Code's source at v0.1.17");
  expect(mimo).toContain("`ps`");
  expect(MIMO_CODE_UNCHECKED_NOTE).toContain("v0.1.17");
  expect(notes).toContain("v0.1.17");
  expect(notes).toContain("MIT");

  const start = privacy.indexOf("### MiMo Code's files");
  expect(start).toBeGreaterThan(-1);
  const section = privacy.slice(start, privacy.indexOf("\n### ", start));
  for (const text of [section, notes]) {
    for (const field of [
      "~/.local/share/mimocode/mimocode.db",
      "MIMOCODE_HOME",
      "MIMOCODE_DB",
      "agent_id",
      "actor_registry",
      "title_source",
      "title_revision",
      "account",
      "control_account",
      "ps -A -o comm=",
    ]) {
      expect(text, field).toContain(field);
    }
  }
});

test("PRIVACY.md and the Kimchi notes name what is read and from which version", async () => {
  const privacy = await readFile(PRIVACY, "utf8");
  const notes = await readFile(KIMCHI_NOTES, "utf8");
  const line = (start: string) => privacy.split("\n").find((one) => one.startsWith(start)) ?? "";

  const kimchi = line("For Kimchi, Agent Lookout reads");
  expect(kimchi).toContain("built from Kimchi's source at v1.35.0");
  expect(kimchi).toContain("`ps`");
  expect(kimchi).not.toContain("MiMo Code");
  expect(KIMCHI_UNCHECKED_NOTE).toContain("v1.35.0");
  expect(notes).toContain("v1.35.0");
  expect(notes).toContain("Apache-2.0");
  expect(notes).toContain("1.3.0");

  const start = privacy.indexOf("### Kimchi's files");
  expect(start).toBeGreaterThan(-1);
  const section = privacy.slice(start, privacy.indexOf("\n### ", start));
  for (const text of [section, notes]) {
    for (const field of [
      "~/.config/kimchi/harness/sessions",
      "KIMCHI_CODING_AGENT_SESSION_DIR",
      "AGENT_LOOKOUT_KIMCHI_HOME",
      "id",
      "cwd",
      "timestamp",
      "version",
      "kimchi:subagent-session",
      "kimchi:internal-session",
      "session_info",
      "ps -A -o comm=",
    ]) {
      expect(text, field).toContain(field);
    }
  }
});

test("PRIVACY.md and the Prime Agent notes name what is read and from which version", async () => {
  const privacy = await readFile(PRIVACY, "utf8");
  const notes = await readFile(PRIME_AGENT_NOTES, "utf8");
  const line = (start: string) => privacy.split("\n").find((one) => one.startsWith(start)) ?? "";

  const primeAgent = line("For Prime Agent, Agent Lookout reads");
  expect(primeAgent).toContain("built from Prime Agent's source at v0.10.3");
  expect(primeAgent).toContain("`ps`");
  expect(primeAgent).not.toContain("Kimchi");
  expect(PRIME_AGENT_UNCHECKED_NOTE).toContain("v0.10.3");
  expect(notes).toContain("v0.10.3");
  expect(notes).toContain("MIT");

  const start = privacy.indexOf("### Prime Agent's files");
  expect(start).toBeGreaterThan(-1);
  const section = privacy.slice(start, privacy.indexOf("\n### ", start));
  for (const text of [section, notes]) {
    for (const field of [
      "~/.prime/agent/sessions",
      "PRIME_AGENT_SESSION_DIR",
      "PRIME_AGENT_CODING_AGENT_SESSION_DIR",
      "PRIME_AGENT_CODING_AGENT_DIR",
      "AGENT_LOOKOUT_PRIME_AGENT_HOME",
      "session-leases",
      "owner.json",
      "daemon-workers",
      ".recovery.jsonl",
      "session_info",
      "ps -o pid=,lstart=,comm= -p",
      "/proc/<pid>/stat",
    ]) {
      expect(text, field).toContain(field);
    }
  }
});

test("PRIVACY.md and the fx notes name what is read and from which version", async () => {
  const privacy = await readFile(PRIVACY, "utf8");
  const notes = await readFile(FX_NOTES, "utf8");
  const line = (start: string) => privacy.split("\n").find((one) => one.startsWith(start)) ?? "";

  const fx = line("For fx, Agent Lookout reads");
  expect(fx).toContain("built from fx's source at v0.0.17");
  expect(fx).toContain("`ps`");
  expect(fx).toContain("`index.jsonl`");
  expect(fx).not.toContain("Prime Agent");
  expect(FX_UNCHECKED_NOTE).toContain("v0.0.17");
  expect(notes).toContain("v0.0.17");
  expect(notes).toContain("Apache-2.0");

  const start = privacy.indexOf("### fx's files");
  expect(start).toBeGreaterThan(-1);
  const section = privacy.slice(start, privacy.indexOf("\n### ", start));
  for (const text of [section, notes]) {
    for (const field of [
      "~/.fx/sessions/v2",
      "FX_HOME",
      "AGENT_LOOKOUT_FX_HOME",
      "log.jsonl",
      "workspace",
      "forked_from",
      "CRC32C",
      "16 KiB",
      "64 KiB",
      "8 MiB",
      "index.jsonl",
      "history.jsonl",
      "settings.json",
      "auth.json",
      "ps -A -o pid=,comm=",
    ]) {
      expect(text, field).toContain(field);
    }
  }
});

test("PRIVACY.md and the Unreal Agent notes name what is read and from which version", async () => {
  const privacy = await readFile(PRIVACY, "utf8");
  const notes = await readFile(UNREAL_AGENT_NOTES, "utf8");
  const line = (start: string) => privacy.split("\n").find((one) => one.startsWith(start)) ?? "";

  const unrealAgent = line("For Unreal Agent, Agent Lookout reads");
  expect(unrealAgent).toContain("built from Unreal Agent's source at v0.3.1");
  expect(unrealAgent).toContain("`ps`");
  expect(unrealAgent).not.toContain("fx");
  expect(UNREAL_AGENT_UNCHECKED_NOTE).toContain("v0.3.1");
  expect(notes).toContain("v0.3.1");
  expect(notes).toContain("MIT");

  const start = privacy.indexOf("### Unreal Agent's files");
  expect(start).toBeGreaterThan(-1);
  const section = privacy.slice(start, privacy.indexOf("\n### ", start));
  for (const text of [section, notes]) {
    for (const field of [
      "ps -A -o lstart=,comm=",
      "XDG_STATE_HOME",
      "AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR",
      "~/.local/state/unreal-agent/sessions",
      "operations",
      ".session.jsonl",
      ".session-",
      "64 MiB",
      "8 MiB",
      "10 minutes",
    ]) {
      expect(text, field).toContain(field);
    }
  }
});

test("PRIVACY.md and the Autohand Code notes name what is read and from which version", async () => {
  const privacy = await readFile(PRIVACY, "utf8");
  const notes = await readFile(AUTOHAND_CODE_NOTES, "utf8");
  const line = (start: string) => privacy.split("\n").find((one) => one.startsWith(start)) ?? "";

  const autohand = line("For Autohand Code, Agent Lookout reads");
  expect(autohand).toContain("built from Autohand Code's source at v0.9.11");
  expect(autohand).toContain("signal-0");
  expect(autohand).not.toContain("Unreal Agent");
  expect(AUTOHAND_CODE_UNCHECKED_NOTE).toContain("v0.9.11");
  expect(notes).toContain("Apache-2.0");

  const start = privacy.indexOf("### Autohand Code's files");
  expect(start).toBeGreaterThan(-1);
  const section = privacy.slice(start, privacy.indexOf("\n### ", start));
  for (const text of [section, notes]) {
    for (const field of [
      "0.9.3",
      "AUTOHAND_HOME",
      "AGENT_LOOKOUT_AUTOHAND_HOME",
      "active-agents",
      "metadata.json",
      "titleSource",
      "conversation.jsonl",
      "config.json",
      "4 KiB",
      "16 KiB",
      "128 KiB",
      "1 MiB",
    ]) {
      expect(text, field).toContain(field);
    }
  }
  for (const field of ["v0.9.11", "waiting_input", "signal 0", "--ephemeral"]) {
    expect(notes, field).toContain(field);
  }
  // A copy you never resumed has its metadata.json opened and is then left
  // out, so no page says a metadata.json is opened only for a session shown.
  const guide =
    (await readFile(GUIDE, "utf8"))
      .split("\n")
      .find((one) => one.startsWith("For Autohand Code it runs no Autohand Code program")) ?? "";
  expect(guide).toContain("metadata.json");
  for (const text of [section, notes, guide]) {
    expect(text).not.toContain("its session is shown");
  }
});

test("PRIVACY.md and the DeepSeek Harness notes name what is read and from which version", async () => {
  const privacy = await readFile(PRIVACY, "utf8");
  const notes = await readFile(DEEPSEEK_HARNESS_NOTES, "utf8");
  const line = (start: string) => privacy.split("\n").find((one) => one.startsWith(start)) ?? "";

  const dsh = line("For DeepSeek Harness, Agent Lookout reads");
  expect(dsh).toContain("built from DeepSeek Harness's source at dsh-v0.2.2-rc.3");
  expect(dsh).toContain("`node:zlib`");
  expect(dsh).toContain("`ps`");
  expect(dsh).not.toContain("Autohand Code");
  expect(DEEPSEEK_HARNESS_UNCHECKED_NOTE).toContain("dsh-v0.2.2-rc.3");
  expect(notes).toContain("MIT");

  const start = privacy.indexOf("### DeepSeek Harness's files");
  expect(start).toBeGreaterThan(-1);
  const section = privacy.slice(start, privacy.indexOf("\n### ", start));
  for (const text of [section, notes]) {
    for (const field of [
      "~/.dsh/sessions",
      "DSH_HOME",
      "AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME",
      "session.v4.jsonl.zstd",
      "session.lock",
      "session/title",
      "exit_plan_mode",
      "ask_user_question",
      "ps -A -o pid=,lstart=,comm=",
      "/proc/uptime",
      "64 KiB",
      "16 MiB",
      "64 MiB",
      "8 MiB",
      "512 bytes",
    ]) {
      expect(text, field).toContain(field);
    }
  }
  for (const field of ["dsh-v0.2.2-rc.3", "38a6a5c965aa", "dsh-v0.2.0-rc.2", "session/end-seed"]) {
    expect(notes, field).toContain(field);
  }
});

test("PRIVACY.md and the Droid notes name what is read and from which versions", async () => {
  const privacy = await readFile(PRIVACY, "utf8");
  const notes = await readFile(DROID_NOTES, "utf8");
  const line = (start: string) => privacy.split("\n").find((one) => one.startsWith(start)) ?? "";

  const droid = line("For Droid, Agent Lookout reads");
  for (const words of [
    "built from Factory's documentation",
    "droid-sdk 0.5.0",
    "@factory/droid-sdk 0.11.0",
    "`ps`",
  ]) {
    expect(droid, words).toContain(words);
  }
  expect(droid).not.toContain("DeepSeek Harness");
  for (const version of ["droid-sdk 0.5.0", "@factory/droid-sdk 0.11.0"]) {
    expect(DROID_UNCHECKED_NOTE).toContain(version);
    expect(notes).toContain(version);
  }
  expect(notes).toContain("Apache-2.0");

  const start = privacy.indexOf("### Droid's files");
  expect(start).toBeGreaterThan(-1);
  const section = privacy.slice(start, privacy.indexOf("\n### ", start));
  for (const text of [section, notes]) {
    for (const field of [
      "~/.factory/sessions",
      "AGENT_LOOKOUT_DROID_HOME",
      "FACTORY_HOME_OVERRIDE",
      ".jsonl",
      ".settings.json",
      "archivedAt",
      "session_start",
      "cwd",
      "title",
      "owner",
      "4 KiB",
      "64 KiB",
      "16 KiB",
      "ps -A -o comm=",
      "droid-dev",
      ".favorites",
    ]) {
      expect(text, field).toContain(field);
    }
  }
  for (const field of ["e6241cd", "aa6fd94", "a4103054"]) {
    expect(notes, field).toContain(field);
  }
});

test("PRIVACY.md and the Grok Build notes name what is read and from which version", async () => {
  const privacy = await readFile(PRIVACY, "utf8");
  const notes = await readFile(GROK_BUILD_NOTES, "utf8");
  const line = (start: string) => privacy.split("\n").find((one) => one.startsWith(start)) ?? "";

  const grok = line("For Grok Build, Agent Lookout reads");
  for (const words of ["built from Grok Build's source at 1.0.45", "1.0.89", "`ps`", "signal-0"]) {
    expect(grok, words).toContain(words);
  }
  expect(grok).not.toContain("Droid");
  for (const version of ["1.0.45", "1.0.89"]) expect(GROK_BUILD_UNCHECKED_NOTE).toContain(version);
  expect(notes).toContain("Apache-2.0");

  const start = privacy.indexOf("### Grok Build's files");
  expect(start).toBeGreaterThan(-1);
  const section = privacy.slice(start, privacy.indexOf("\n### ", start));
  for (const text of [section, notes]) {
    for (const field of [
      "~/.grok",
      "GROK_HOME",
      "AGENT_LOOKOUT_GROK_HOME",
      "active_sessions.json",
      "active_sessions.lock",
      "active_sessions.json.tmp",
      "events.jsonl",
      "plan_mode.json",
      "summary.json",
      "title_is_manual",
      "generated_title",
      "awaiting_plan_approval",
      "ask_user_question",
      "exit_plan_mode",
      "cancellation_context",
      ".cwd",
      "ps -o pid=,lstart= -p <pids>",
      "1 MiB",
      "64 KiB",
      "8 MiB",
      "512 bytes",
      "1 KiB",
      "2,000",
    ]) {
      expect(text, field).toContain(field);
    }
  }
  for (const field of ["2bdd1d6", "1.0.45", "1.0.89", "xai-grok-active-sessions/src/lib.rs"]) {
    expect(notes, field).toContain(field);
  }
});

test("PRIVACY.md and the Oh My Pi notes name what is read and from which version", async () => {
  const privacy = await readFile(PRIVACY, "utf8");
  const notes = await readFile(OH_MY_PI_NOTES, "utf8");
  const line = (start: string) => privacy.split("\n").find((one) => one.startsWith(start)) ?? "";

  const omp = line("For Oh My Pi, Agent Lookout reads");
  for (const words of ["built from Oh My Pi's source at v19.0.0", "`ps`", "no lock"]) {
    expect(omp, words).toContain(words);
  }
  expect(omp).not.toContain("Grok Build");
  expect(OH_MY_PI_UNCHECKED_NOTE).toContain("v19.0.0");
  expect(notes).toContain("MIT");

  const start = privacy.indexOf("### Oh My Pi's files");
  expect(start).toBeGreaterThan(-1);
  const section = privacy.slice(start, privacy.indexOf("\n### ", start));
  for (const text of [section, notes]) {
    for (const field of [
      "~/.omp",
      "AGENT_LOOKOUT_OMP_HOME",
      "PI_CODING_AGENT_DIR",
      "PI_CODING_AGENT_SESSION_DIR",
      "OMP_PROFILE",
      "PI_PROFILE",
      "PI_CONFIG_DIR",
      "XDG_DATA_HOME",
      "session_exit",
      "tool_execution_start",
      "provider_refusal",
      "session-owners",
      "agent.db",
      "codex-",
      "256 bytes",
      "64 KiB",
      "8 MiB",
      "1 KiB",
      "ps -A -o pid=,lstart=,comm=",
    ]) {
      expect(text, field).toContain(field);
    }
  }
  for (const field of ["57771ae", "v19.0.0", "session-title-slot.ts", "agent-session.ts"]) {
    expect(notes, field).toContain(field);
  }
});

test("PRIVACY.md and the Muse Code notes name what is read and from which version", async () => {
  const privacy = await readFile(PRIVACY, "utf8");
  const notes = await readFile(MUSE_CODE_NOTES, "utf8");
  const line = (start: string) => privacy.split("\n").find((one) => one.startsWith(start)) ?? "";

  const muse = line("For Muse Code, Agent Lookout reads");
  for (const words of [
    "built from Meta's documentation",
    "protocol schema at 1.4.24",
    "open-source readers",
    "`ps`",
    "locks, databases and sockets",
  ]) {
    expect(muse, words).toContain(words);
  }
  expect(muse).not.toContain("Oh My Pi");
  expect(MUSE_CODE_UNCHECKED_BUILT).toContain("1.4.24");
  expect(MUSE_CODE_UNCHECKED_READERS).toContain("not on Muse Code's own program");
  expect(MUSE_CODE_UNCHECKED_NOT).toContain("so a status can be wrong");
  expect(notes).toContain("MIT");

  const start = privacy.indexOf("### Muse Code's files");
  expect(start).toBeGreaterThan(-1);
  const section = privacy.slice(start, privacy.indexOf("\n### ", start));
  for (const text of [section, notes]) {
    for (const field of [
      "~/.local/share/muse",
      "AGENT_LOOKOUT_MUSE_CODE_HOME",
      "XDG_DATA_HOME",
      "MUSE_DATA_DIR",
      "session.jsonl",
      ".session.lock",
      "session-index.db",
      "subagent/",
      "runtime.session.metadata",
      "workspace_root",
      "session.end",
      "session.resumed",
      "retained_frame",
      "presentation_phase",
      "64 KiB",
      "8 MiB",
      "1 MiB",
      "16 KiB",
      "4,096",
      "ps -A -o pid=,lstart=,comm=",
    ]) {
      expect(text, field).toContain(field);
    }
  }
  for (const field of ["5d8ba2e", "281239e", "3512269", "1.4.24", "user_input_prompt_requested"]) {
    expect(notes, field).toContain(field);
  }
  // The notes name no reader that is not used.
  for (const name of [
    "doubleagent",
    "system_prompts_leaks",
    "coding_agent_session_search",
    "ccmux",
    "agentworks",
  ]) {
    expect(notes, name).not.toContain(name);
  }
});
