import { describe, expect, test } from "vitest";

import { isProcessAlive } from "@collector/processes/pids";
import { compareProcessStart, readProcessStartsWithPs } from "@collector/processes/processStart";

/**
 * A pid no process has: 99998, which is above macOS's highest, or the nearest
 * free one below it. Linux gives out pids far higher, so 99998 can be taken there.
 */
function unusedPid(): number {
  for (let pid = 99_998; pid > 1; pid -= 1) if (!isProcessAlive(pid)) return pid;
  throw new Error("Every pid below 99998 is in use.");
}

// Windows has no ps.
describe.skipIf(process.platform === "win32")("readProcessStartsWithPs, against real ps", () => {
  test("reports this process, skips one that does not exist, and says the same thing twice", async () => {
    const first = await readProcessStartsWithPs([process.pid, unusedPid()]);
    const second = await readProcessStartsWithPs([process.pid]);
    expect([...first.keys()]).toEqual([process.pid]);
    expect(first.get(process.pid)).toMatch(
      /^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d\d:\d\d:\d\d \d{4}$/,
    );
    expect(compareProcessStart(first.get(process.pid), second.get(process.pid))).toBe("same");
    // A leftover file naming this pid with some other start time is caught.
    expect(compareProcessStart("Tue Nov 14 22:13:20 2023", first.get(process.pid))).toBe(
      "different",
    );
  });

  test("an empty list runs nothing and finds nothing", async () => {
    expect((await readProcessStartsWithPs([])).size).toBe(0);
  });
});
