import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { CLAUDE_CODE_CAPABILITIES } from "@collector/adapters/claude-code/index";
import { CODEX_CAPABILITIES } from "@collector/adapters/codex/index";
import { STATUS_FILE_CAPABILITIES } from "@collector/adapters/status-files/index";
import {
  CAPABILITIES,
  CAPABILITY_LABEL,
  CAPABILITY_LEVEL_LABEL,
  type SourceCapabilities,
} from "@core/sessions/session";

const GUIDE = fileURLToPath(new URL("../../../../docs/GUIDE.md", import.meta.url));
const README = fileURLToPath(new URL("../../../../README.md", import.meta.url));

const GUIDE_HEADING = "#### What each agent can report";
const README_HEADING = "## Supported agents and systems";

/** Each adapter's row, by the name the guide gives it, in the order the guide lists them. */
const DECLARED: [string, SourceCapabilities][] = [
  ["Claude Code", CLAUDE_CODE_CAPABILITIES],
  ["Codex", CODEX_CAPABILITIES],
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
