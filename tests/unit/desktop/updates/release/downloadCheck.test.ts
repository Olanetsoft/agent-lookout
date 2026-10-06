import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { createDownloadCheck } from "@desktop/updates/release/downloadCheck";

const BYTES = Buffer.from("the bytes of a made-up release file");
const expected = {
  size: BYTES.byteLength,
  sha512: createHash("sha512").update(BYTES).digest("base64"),
};

describe("createDownloadCheck", () => {
  test("passes the file whose size and SHA-512 the release gives, however it arrives", () => {
    const check = createDownloadCheck(expected);
    expect(check.add(BYTES.subarray(0, 5))).toBe(true);
    expect(check.add(BYTES.subarray(5, 6))).toBe(true);
    expect(check.add(BYTES.subarray(6))).toBe(true);
    expect(check.received).toBe(BYTES.byteLength);
    expect(check.verdict()).toBe("ok");
    // Asked again, it says the same.
    expect(check.verdict()).toBe("ok");
  });

  test("a file that ends short is the wrong size", () => {
    const check = createDownloadCheck(expected);
    check.add(BYTES.subarray(0, 10));
    expect(check.verdict()).toBe("wrong-size");
  });

  test("stops at the first byte past the size the release gives", () => {
    const check = createDownloadCheck(expected);
    expect(check.add(BYTES)).toBe(true);
    expect(check.add(Buffer.from("!"))).toBe(false);
    expect(check.verdict()).toBe("wrong-size");
  });

  test("a file of the right size with one byte changed does not match", () => {
    const changed = Buffer.from(BYTES);
    changed[3] = changed[3]! ^ 1;
    const check = createDownloadCheck(expected);
    check.add(changed);
    expect(check.verdict()).toBe("wrong-hash");
  });

  test("compares with the hash the release gives, not one of another file", () => {
    const check = createDownloadCheck({
      size: BYTES.byteLength,
      sha512: createHash("sha512").update("another file").digest("base64"),
    });
    check.add(BYTES);
    expect(check.verdict()).toBe("wrong-hash");
  });
});
