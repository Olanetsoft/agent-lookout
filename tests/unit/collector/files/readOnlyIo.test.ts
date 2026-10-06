import { expect, test } from "vitest";

import { isMissing } from "@collector/files/readOnlyIo";

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
