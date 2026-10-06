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

const HEADING = "#### What each agent can report";

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

/** The guide's section on what each agent can report: its table, and its list of reasons. */
async function guideSection(): Promise<{ table: string[][]; reasons: string[] }> {
  const text = await readFile(GUIDE, "utf8");
  const start = text.indexOf(`\n${HEADING}\n`);
  expect(start, `docs/GUIDE.md has no "${HEADING}"`).toBeGreaterThan(-1);
  const rest = text.slice(start + HEADING.length + 2);
  const end = rest.search(/\n#{1,4} /);
  const lines = (end === -1 ? rest : rest.slice(0, end)).split("\n");

  const table = lines
    .filter((line) => line.startsWith("|"))
    .map(cells)
    // The line under the heads is only dashes.
    .filter((row) => !row.every((cell) => /^:?-+:?$/.test(cell)));
  const reasons = lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
  return { table, reasons };
}

test("the table in docs/GUIDE.md says what each adapter declares, cell for cell", async () => {
  const { table } = await guideSection();
  const [heads, ...rows] = table;

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
  const { reasons } = await guideSection();

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
