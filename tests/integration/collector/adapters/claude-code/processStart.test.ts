import { describe, expect, test } from "vitest";

import {
  compareProcessStart,
  readProcessStartsWithPs,
} from "@collector/adapters/claude-code/processStart";

describe.skipIf(process.platform === "win32")("readProcessStartsWithPs, against real ps", () => {
  test("reports this process, skips one that does not exist, and says the same thing twice", async () => {
    // pid 99998 is above macOS's highest pid and all but certain to be unused elsewhere.
    const first = await readProcessStartsWithPs([process.pid, 99_998]);
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
