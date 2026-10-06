import { describe, expect, test } from "vitest";

import { compareVersions, isOffered, parseVersion } from "@desktop/updates/release/version";

describe("parseVersion", () => {
  test("reads a release and a prerelease", () => {
    expect(parseVersion("0.2.1")).toEqual({ major: 0, minor: 2, patch: 1, prerelease: [] });
    expect(parseVersion("1.10.0-beta.2")).toEqual({
      major: 1,
      minor: 10,
      patch: 0,
      prerelease: ["beta", "2"],
    });
    // Build metadata says nothing about which comes first, and is not kept.
    expect(parseVersion("0.2.1+build.5")?.prerelease).toEqual([]);
  });

  test.each([
    "",
    "v0.2.1",
    "0.2",
    "0.2.1.4",
    "00.2.1",
    "0.02.1",
    "0.2.1-",
    "0.2.1-beta.01",
    "0.2.1 ",
    " 0.2.1",
    "0.2.x",
    "9007199254740993.0.0",
    `0.2.1-${"a".repeat(80)}`,
  ])("refuses %j", (text) => {
    expect(parseVersion(text)).toBeNull();
  });
});

describe("compareVersions", () => {
  /** The order semver gives, from its own list of examples. */
  const ORDER = [
    "0.2.0",
    "0.2.1-alpha",
    "0.2.1-alpha.1",
    "0.2.1-alpha.beta",
    "0.2.1-beta",
    "0.2.1-beta.2",
    "0.2.1-beta.11",
    "0.2.1-rc.1",
    "0.2.1",
    "0.2.2",
    "0.2.10",
    "0.3.0",
    "1.0.0",
  ];

  test("puts versions in semver's order, numbers as numbers", () => {
    const versions = ORDER.map((text) => parseVersion(text)!);
    for (let i = 0; i < versions.length; i++) {
      for (let j = 0; j < versions.length; j++) {
        expect(Math.sign(compareVersions(versions[i]!, versions[j]!)), `${ORDER[i]} and ${ORDER[j]}`).toBe(
          Math.sign(i - j),
        );
      }
    }
  });
});

describe("isOffered", () => {
  test("offers a newer release, and only a newer one", () => {
    expect(isOffered("0.2.1", "0.2.0")).toBe(true);
    expect(isOffered("0.2.10", "0.2.9")).toBe(true);
    expect(isOffered("0.2.0", "0.2.0")).toBe(false);
    expect(isOffered("0.1.9", "0.2.0")).toBe(false);
  });

  test("never offers a prerelease, however new", () => {
    expect(isOffered("0.3.0-beta.1", "0.2.0")).toBe(false);
    expect(isOffered("9.0.0-rc.1", "0.2.0")).toBe(false);
  });

  test("offers the release to a copy that is a prerelease of it", () => {
    expect(isOffered("0.2.1", "0.2.1-beta.1")).toBe(true);
  });

  test("offers nothing when either version cannot be read", () => {
    expect(isOffered("v0.2.1", "0.2.0")).toBe(false);
    expect(isOffered("0.2.1", "development")).toBe(false);
  });
});
