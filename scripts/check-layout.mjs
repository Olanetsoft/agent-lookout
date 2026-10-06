// Checks the rules of the project layout that nothing else would catch:
//
//   1. Every test file lives under tests/, in the folder of the Vitest project
//      that runs it: tests/unit, tests/integration or tests/component.
//   2. A test is named for a module at its mirrored path, with tests/<group>/ in
//      place of src/: tests/unit/core/sessions/diff.test.ts covers src/core/sessions/diff.ts. It
//      ends in .test.tsx when that module is a .tsx file, and .test.ts otherwise.
//   3. Those three folders hold tests and nothing else. A helper goes in
//      tests/support/ and shared data in tests/fixtures/.
//   4. Nothing under src/ is test material: no fixture, mock, stub, snapshot,
//      test setup or test helper, and no folder named for one.
//   5. Nothing under src/ imports from tests/, or from a test library.
//   6. No folder under src/, and not tests/support/, holds a long flat list of
//      code files. Related modules are grouped into a folder named for what they
//      are about, as src/dashboard/lib/api/ and src/dashboard/lib/charts/ are.
//
// `npm run check` runs this first. It needs nothing but Node.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Folders that hold no code of this project. */
const SKIPPED_FOLDERS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".claude",
  ".reference",
  ".artifacts",
]);

const CODE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Where each Vitest project looks, and the file name endings it runs. */
const TEST_PROJECTS = [
  { folder: "tests/unit/", endings: [".test.ts"] },
  { folder: "tests/integration/", endings: [".test.ts"] },
  { folder: "tests/component/", endings: [".test.ts", ".test.tsx"] },
];

/** Folders whose name says they hold test material. */
const TEST_FOLDERS = new Set([
  "fixtures",
  "__fixtures__",
  "mocks",
  "__mocks__",
  "__tests__",
  "__snapshots__",
  "__screenshots__",
  "test",
  "tests",
  "testing",
]);

/** File names that say they are test material: a fixture, a mock, a stub or a snapshot. */
const TEST_MATERIAL_NAME = /\.(fixtures?|mocks?|stubs?)\.|\.snap(\.|$)/i;

/** File names of test setup and test helpers, such as setupTests.ts, test-utils.ts or vitest.setup.ts. */
const TEST_HELPER_NAME =
  /^((setup|global)[-_.]?(tests?|files?|vitest|jest)|(tests?|component|browser|vitest|jest|playwright)[-_.]?(setup|utils?|helpers?|support)|.+\.setup)\.[cm]?[jt]sx?$/i;

/** Libraries that only test code uses. */
const TEST_LIBRARIES = /^(vitest|@vitest\/.+|vitest-browser-react|playwright)(\/|$)/;

/** Every import, re-export, dynamic import and require in a source text. */
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'])([^"'\n]+)\1/g;

/** Every file under a folder, as paths relative to the project root, with forward slashes. */
function filesUnder(folder) {
  const found = [];
  for (const entry of readdirSync(path.join(root, folder), { withFileTypes: true })) {
    const relative = folder === "" ? entry.name : `${folder}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDERS.has(entry.name)) found.push(...filesUnder(relative));
    } else if (entry.isFile()) {
      found.push(relative);
    }
  }
  return found;
}

/** Whether a path relative to the project root is a folder. */
function isFolder(relative) {
  const absolute = path.join(root, relative);
  return existsSync(absolute) && statSync(absolute).isDirectory();
}

/**
 * The module a test file is named for: a file in the mirrored folder whose name,
 * without its extension, is the test's name without `.test.ts` or `.test.tsx`.
 * Any kind of file counts, so the stylesheet index.css has index.test.ts.
 */
function moduleFor(mirroredFolder, testName) {
  if (!isFolder(mirroredFolder)) return null;
  const match = readdirSync(path.join(root, mirroredFolder), { withFileTypes: true }).find(
    (entry) => entry.isFile() && entry.name.slice(0, entry.name.lastIndexOf(".")) === testName,
  );
  return match ? `${mirroredFolder}/${match.name}` : null;
}

/** Where a piece of test material found under src/ belongs instead. */
function homeFor(file) {
  if (/screenshot/i.test(file)) return "tests/.artifacts/, where the browser tests write them";
  if (/snap/i.test(file)) return "tests/, beside the test that wrote it";
  if (/fixture/i.test(file)) return "tests/fixtures/";
  return "tests/support/";
}

const problems = [];
const files = filesUnder("");
const testFiles = files.filter((file) => TEST_FILE.test(file));

for (const file of testFiles) {
  if (!file.startsWith("tests/")) {
    problems.push(
      `${file}: a test file outside tests/. Move it to tests/unit, tests/integration or tests/component.`,
    );
    continue;
  }
  const project = TEST_PROJECTS.find(({ folder }) => file.startsWith(folder));
  if (!project) {
    problems.push(
      `${file}: not in tests/unit, tests/integration or tests/component, so no project runs it.`,
    );
    continue;
  }

  const rest = file.slice(project.folder.length);
  const ending = /\.test\.tsx$/.test(rest)
    ? ".test.tsx"
    : /\.test\.ts$/.test(rest)
      ? ".test.ts"
      : null;
  if (ending === null) {
    problems.push(
      `${file}: tests are named <module>.test.ts, or <Component>.test.tsx for a .tsx module. No project runs this file.`,
    );
    continue;
  }

  const mirroredFolder = path.posix.dirname(`src/${rest}`);
  const testName = path.posix.basename(rest).slice(0, -ending.length);
  const covered = moduleFor(mirroredFolder, testName);
  if (covered === null) {
    problems.push(
      `${file}: names no module. A test is named for the module it covers, at the mirrored path, and there is no ${mirroredFolder}/${testName}.* to cover.`,
    );
    continue;
  }

  const wanted = covered.endsWith(".tsx") ? ".test.tsx" : ".test.ts";
  if (ending !== wanted) {
    problems.push(
      `${file}: covers ${covered}, so it is named ${testName}${wanted}. A test ends .test.tsx only when its module is a .tsx file.`,
    );
  } else if (!project.endings.includes(ending)) {
    problems.push(
      `${file}: covers ${covered}, a component, which is rendered in tests/component/. ${project.folder} runs only *.test.ts.`,
    );
  }
}

// The three test folders hold tests and nothing else.
for (const file of files) {
  const project = TEST_PROJECTS.find(({ folder }) => file.startsWith(folder));
  if (project && CODE_FILE.test(file) && !TEST_FILE.test(file)) {
    problems.push(
      `${file}: not a test, in ${project.folder}. A helper goes in tests/support/ and shared data in tests/fixtures/.`,
    );
  }
}

// Nothing under src/ is test material.
for (const file of files.filter((candidate) => candidate.startsWith("src/"))) {
  const folders = file.split("/").slice(1, -1);
  const name = path.posix.basename(file);
  const testFolder = folders.find((folder) => TEST_FOLDERS.has(folder.toLowerCase()));
  if (TEST_FILE.test(name)) continue; // Reported above, as a test file outside tests/.
  if (testFolder) {
    problems.push(
      `${file}: inside a folder named ${testFolder}/, which holds test material. It belongs in ${homeFor(file)}, and src/ holds product code only.`,
    );
  } else if (TEST_MATERIAL_NAME.test(name)) {
    problems.push(
      `${file}: named as a fixture, mock, stub or snapshot. It belongs in ${homeFor(file)}, and product code never uses one.`,
    );
  } else if (TEST_HELPER_NAME.test(name)) {
    problems.push(
      `${file}: named as a test setup or helper file. It belongs in tests/support/, and src/ holds product code only.`,
    );
  }
}

const sourceFiles = files.filter((file) => file.startsWith("src/") && CODE_FILE.test(file));

for (const file of sourceFiles) {
  const text = readFileSync(path.join(root, file), "utf8");
  for (const [, , specifier] of text.matchAll(IMPORT)) {
    const target = targetOf(file, specifier);
    if (
      specifier === "@tests" ||
      specifier.startsWith("@tests/") ||
      target === "tests" ||
      target?.startsWith("tests/")
    ) {
      problems.push(`${file}: imports "${specifier}". Production code never imports from tests/.`);
    } else if (TEST_LIBRARIES.test(specifier)) {
      problems.push(
        `${file}: imports "${specifier}", a test library. Test helpers and fixtures live under tests/.`,
      );
    }
  }
}

/** The most code files one folder holds before they are grouped into folders by area. */
const MAX_LOOSE_FILES = 8;

const looseFiles = new Map();
for (const file of files) {
  if (!CODE_FILE.test(file)) continue;
  if (!file.startsWith("src/") && !file.startsWith("tests/support/")) continue;
  const folder = path.posix.dirname(file);
  looseFiles.set(folder, (looseFiles.get(folder) ?? 0) + 1);
}
for (const [folder, count] of looseFiles) {
  if (count > MAX_LOOSE_FILES) {
    problems.push(
      `${folder}/: holds ${count} code files side by side. Group the related ones into folders named for what they are about, and move each test to the mirrored path.`,
    );
  }
}

/** The path an import points at, relative to the project root, or null for a package. */
function targetOf(importer, specifier) {
  if (!specifier.startsWith(".")) return null;
  const absolute = path.resolve(root, path.dirname(importer), specifier);
  return path.relative(root, absolute).split(path.sep).join("/");
}

if (problems.length > 0) {
  console.error(
    `The layout check found ${problems.length === 1 ? "1 problem" : `${problems.length} problems`}:\n`,
  );
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("\ntests/README.md says what goes where.");
  process.exit(1);
}

console.log(
  `Layout is in order: ${testFiles.length} test files under tests/, each named for the module it covers, and none of the ${sourceFiles.length} files under src/ is test material or imports from tests/.`,
);
