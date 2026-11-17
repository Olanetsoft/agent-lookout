import { expect, test } from "vitest";

import { createFolderLister } from "@collector/adapters/prime-agent/folders";
import { NOW, SECOND, WORKERS_DIR } from "@tests/fixtures/prime-agent/primeAgent";
import { primeAgentFiles } from "@tests/support/adapters/prime-agent/primeAgentAdapter";

test("lists a folder in name order, and again only when its time moves or a minute has gone", async () => {
  const files = primeAgentFiles();
  files.mkdir(`${WORKERS_DIR}/b`);
  files.mkdir(`${WORKERS_DIR}/a`);
  const lister = createFolderLister(WORKERS_DIR, files.io);
  expect(await lister.list(NOW)).toEqual({ state: "listed", names: ["a", "b"] });
  expect(await lister.list(NOW + 2 * SECOND)).toEqual({ state: "listed", names: ["a", "b"] });
  expect(files.count("readdir")).toBe(1);
  expect(files.count("lstat")).toBe(2);
  files.touch(WORKERS_DIR, NOW + 3 * SECOND);
  await lister.list(NOW + 4 * SECOND);
  await lister.list(NOW + 64 * SECOND);
  // A clock set back counts as time enough.
  await lister.list(NOW);
  expect(files.count("readdir")).toBe(4);
});

test("says a folder is missing, and never lists a link or anything but a folder", async () => {
  const files = primeAgentFiles();
  const lister = createFolderLister(WORKERS_DIR, files.io);
  expect(await lister.list(NOW)).toEqual({ state: "missing" });
  files.special(WORKERS_DIR);
  expect(await lister.list(NOW)).toEqual({ state: "unlistable" });
  expect(files.count("readdir")).toBe(0);
});

test("a folder that cannot be looked up or listed is unlistable, and listed afresh once it can be", async () => {
  const files = primeAgentFiles();
  files.mkdir(`${WORKERS_DIR}/a`);
  const lister = createFolderLister(WORKERS_DIR, files.io);
  files.fail(WORKERS_DIR, "EACCES");
  expect(await lister.list(NOW)).toEqual({ state: "unlistable" });
  files.heal(WORKERS_DIR);
  expect(await lister.list(NOW + SECOND)).toEqual({ state: "listed", names: ["a"] });
});
