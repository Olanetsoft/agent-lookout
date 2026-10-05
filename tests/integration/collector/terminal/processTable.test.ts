import { describe, expect, test } from "vitest";

import { readProcessTableWithPs } from "@collector/terminal/processTable";

// `ps` only reads, so the real one is asked. Nothing here drives a terminal.

describe.skipIf(process.platform !== "darwin")("readProcessTableWithPs on macOS", () => {
  test("lists this process with its parent and its program, in one run", async () => {
    const table = await readProcessTableWithPs();

    expect(table.get(process.pid)?.ppid).toBe(process.ppid);
    expect(table.get(process.pid)?.path).not.toBe("");
    expect(table.get(1)).toMatchObject({ ppid: 0, tty: "??", path: "/sbin/launchd" });
  });
});

describe.skipIf(process.platform === "darwin")("readProcessTableWithPs elsewhere", () => {
  test("asks nothing, since only macOS has a Terminal or an iTerm2", async () => {
    expect((await readProcessTableWithPs()).size).toBe(0);
  });
});
