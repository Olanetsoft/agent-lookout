import { describe, expect, test } from "vitest";

import { validPid } from "@collector/processes/pids";

describe("validPid", () => {
  test("only positive whole numbers are process ids", () => {
    expect(validPid(4242)).toBe(4242);
    // Signalling pid 0 or a negative pid would address a whole process group.
    expect(validPid(0)).toBeUndefined();
    expect(validPid(-4242)).toBeUndefined();
    expect(validPid(1.5)).toBeUndefined();
    expect(validPid(Number.NaN)).toBeUndefined();
    expect(validPid("4242")).toBeUndefined();
    expect(validPid(null)).toBeUndefined();
  });
});
