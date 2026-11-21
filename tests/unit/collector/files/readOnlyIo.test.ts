import { expect, test } from "vitest";

import { inoOf, isMissing, isRefused, msOf } from "@collector/files/readOnlyIo";

const errno = (code: string) => Object.assign(new Error(code), { code });

test("only an error that says the thing is not there counts as missing", () => {
  expect(isMissing(errno("ENOENT"))).toBe(true);
  // A path through a file, as when ~/.codex is a file.
  expect(isMissing(errno("ENOTDIR"))).toBe(true);

  expect(isMissing(errno("EACCES"))).toBe(false);
  expect(isMissing(errno("EIO"))).toBe(false);
  expect(isMissing(errno("ELOOP"))).toBe(false);
  expect(isMissing(new Error("no code"))).toBe(false);
  expect(isMissing(undefined)).toBe(false);
  expect(isMissing(null)).toBe(false);
  expect(isMissing("ENOENT")).toBe(false);
});

test("only an error that says this user may not look counts as refused", () => {
  expect(isRefused(errno("EACCES"))).toBe(true);
  // Windows, and a Mac's privacy settings, say no this way.
  expect(isRefused(errno("EPERM"))).toBe(true);

  expect(isRefused(errno("ENOENT"))).toBe(false);
  expect(isRefused(errno("EIO"))).toBe(false);
  expect(isRefused(new Error("no code"))).toBe(false);
  expect(isRefused(undefined)).toBe(false);
  expect(isRefused(null)).toBe(false);
  expect(isRefused("EACCES")).toBe(false);
});

test("a file's ID past 2^53, as NTFS's often are, keeps apart two files a plain number would merge", () => {
  // Two IDs that Node's ordinary stats give as the same number (nodejs/node#12115).
  const first = 57420895249767887n;
  const second = 57420895249767888n;
  expect(Number(first)).toBe(Number(second));
  expect(inoOf(first)).not.toBe(inoOf(second));
  for (const id of [first, second, 2n ** 64n - 1n])
    expect(Number.isSafeInteger(inoOf(id))).toBe(true);
});

test("a file's ID below 2^53, as on macOS and Linux, is left as it is", () => {
  expect(inoOf(0n)).toBe(0);
  expect(inoOf(12_345_678n)).toBe(12_345_678);
  expect(inoOf(2n ** 53n - 1n)).toBe(Number.MAX_SAFE_INTEGER);
});

test("a time in nanoseconds comes out in milliseconds as Node's ordinary stats give it", () => {
  expect(msOf(1_790_000_000_123_456_789n)).toBe(1_790_000_000 * 1e3 + 123_456_789 / 1e6);
  expect(msOf(0n)).toBe(0);
  // Before 1970 the nanoseconds still count up from the second before.
  expect(msOf(-1_500_000_000n)).toBe(-2 * 1e3 + 500_000_000 / 1e6);
});
