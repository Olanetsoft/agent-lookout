import { expect, test } from "vitest";

import { isMissing, isRefused } from "@collector/files/readOnlyIo";

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
