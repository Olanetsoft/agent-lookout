import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { findClaudeBinary } from "@collector/adapters/claude-code/findBinary";
import { isExecutableFile } from "@collector/files/paths";
import { HOME } from "@tests/fixtures/claudeCode";
import { tempDir, writeStub } from "@tests/support/node/tempFiles";

describe("findClaudeBinary", () => {
  test("on a real disk, the named binary is found and run-checked for real", async () => {
    const stub = await writeStub("echo '[]'");
    expect(
      await findClaudeBinary({ env: { AGENT_LOOKOUT_CLAUDE_BIN: stub }, homeDir: HOME }),
    ).toEqual({ found: true, path: stub });

    await chmod(stub, 0o644);
    expect(
      await findClaudeBinary({ env: { AGENT_LOOKOUT_CLAUDE_BIN: stub }, homeDir: HOME }),
    ).toMatchObject({ found: false });
  });
});

describe("isExecutableFile", () => {
  test("a file must be executable, must exist and must not be a directory", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "claude");
    await writeFile(file, "#!/bin/sh\necho '[]'\n");

    await chmod(file, 0o644);
    expect(await isExecutableFile(file)).toBe(false);

    await chmod(file, 0o755);
    expect(await isExecutableFile(file)).toBe(true);

    expect(await isExecutableFile(path.join(dir, "missing"))).toBe(false);

    await mkdir(path.join(dir, "folder"));
    expect(await isExecutableFile(path.join(dir, "folder"))).toBe(false);
  });
});
