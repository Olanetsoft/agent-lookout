import { execFile } from "node:child_process";

import { describe, expect, test, vi } from "vitest";

import { runPs } from "@collector/processes/ps";

// No `ps` is run here: a stand-in for Node's execFile records how it was
// asked to start one, and answers at once.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

/** Makes the stand-in answer with this table, and hands back the end of the stdin it gave. */
function standInPs(stdout: string) {
  const end = vi.fn();
  vi.mocked(execFile).mockImplementation(((
    _file: string,
    _args: string[],
    _options: object,
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    callback(null, stdout);
    return { stdin: { end } };
  }) as unknown as typeof execFile);
  return { end };
}

// It is never run on Windows, so nothing is started there to check.
describe.skipIf(process.platform === "win32")("runPs", () => {
  test("starts ps directly, with stdin closed, a fixed search path and the C locale", async () => {
    const { end } = standInPs("  1\n");
    expect(await runPs(["-A", "-o", "pid="])).toEqual({ ok: true, stdout: "  1\n" });
    expect(end).toHaveBeenCalledTimes(1);
    const [file, args, options] = vi.mocked(execFile).mock.calls.at(-1) as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(file).toBe("ps");
    expect(args).toEqual(["-A", "-o", "pid="]);
    expect(options.env).toEqual({ PATH: "/usr/bin:/bin", LC_ALL: "C" });
    expect(options.shell).toBeUndefined();
  });

  test("in UTC when asked", async () => {
    standInPs("");
    await runPs(["-o", "lstart="], { utc: true });
    const options = vi.mocked(execFile).mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(options.env).toEqual({ PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" });
  });
});
