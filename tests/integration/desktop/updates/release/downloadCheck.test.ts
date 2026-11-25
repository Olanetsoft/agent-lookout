import { createHash } from "node:crypto";
import { mkdir, rm, truncate, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { isStillWhole } from "@desktop/updates/release/downloadCheck";
import { tempDir } from "@tests/support/node/tempFiles";

/** Every file that was opened. */
const opened = vi.hoisted((): FileHandle[] => []);

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const open: typeof real.open = async (...args) => {
    const handle = await real.open(...args);
    opened.push(handle);
    return handle;
  };
  return { ...real, open };
});

describe("isStillWhole", () => {
  // More than is read at a time.
  const BYTES = Buffer.alloc(3_000_000, "a made-up release zip, ");
  const expected = {
    size: BYTES.byteLength,
    sha512: createHash("sha512").update(BYTES).digest("base64"),
  };

  const CASES: [string, boolean, (file: string) => Promise<void>][] = [
    ["is as it was downloaded", true, async () => {}],
    ["is cut short", false, (file) => truncate(file, 2_000_000)],
    ["is longer", false, (file) => writeFile(file, "!", { flag: "a" })],
    ["has one other byte", false, (file) => writeFile(file, "!", { flag: "r+" })],
    ["is gone", false, (file) => rm(file)],
    [
      "is a folder",
      false,
      async (file) => {
        await rm(file);
        await mkdir(file);
      },
    ],
  ];

  test.each(CASES)("a file that %s: %s, and it is not left open", async (_what, whole, change) => {
    const file = path.join(await tempDir(), "Agent-Lookout-0.2.1-mac-arm64.zip");
    await writeFile(file, BYTES);
    await change(file);
    opened.length = 0;
    expect(await isStillWhole(file, expected)).toBe(whole);
    // A handle that is closed has no descriptor.
    for (const handle of opened) expect(handle.fd).toBe(-1);
    if (whole) expect(opened).toHaveLength(1);
  });
});
