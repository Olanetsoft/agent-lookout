// Checks a download against what the release says of it: its size, and the
// SHA-512 that `latest-mac.yml` gives in base64. It is fed the bytes as they
// arrive, so a file is hashed once, while it is written, and a download that
// runs past its size is stopped there. A file that has waited since is read
// whole and checked the same way.

import { createHash, type Hash } from "node:crypto";
import { open } from "node:fs/promises";

import type { ReleaseFile } from "./manifest.ts";

/** How much of a file is read at a time, so the app goes on meanwhile. */
const READ_BYTES = 1024 * 1024;

/** How a finished download compares with what the release says of it. */
export type DownloadVerdict = "ok" | "wrong-size" | "wrong-hash";

export interface DownloadCheck {
  /** Adds the next bytes. False once there are more of them than the release says. */
  add(chunk: Uint8Array): boolean;
  /** The bytes so far. */
  readonly received: number;
  /** Whether every byte matches, once the download has ended. */
  verdict(): DownloadVerdict;
}

export function createDownloadCheck(expected: Pick<ReleaseFile, "size" | "sha512">): DownloadCheck {
  const hash: Hash = createHash("sha512");
  let received = 0;
  let digest: string | null = null;
  return {
    add(chunk) {
      if (digest !== null) return false;
      received += chunk.byteLength;
      if (received > expected.size) return false;
      hash.update(chunk);
      return true;
    },
    get received() {
      return received;
    },
    verdict() {
      if (received !== expected.size) return "wrong-size";
      // A hash gives its digest once, so it is kept for a second look.
      digest ??= hash.digest("base64");
      return digest === expected.sha512 ? "ok" : "wrong-hash";
    },
  };
}

/** Whether a file is there and still all the release says it is. It never rejects. */
export async function isStillWhole(
  file: string,
  expected: Pick<ReleaseFile, "size" | "sha512">,
): Promise<boolean> {
  const check = createDownloadCheck(expected);
  const handle = await open(file).catch(() => null);
  if (handle === null) return false;
  try {
    const buffer = Buffer.allocUnsafe(READ_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, READ_BYTES, null);
      if (bytesRead === 0) return check.verdict() === "ok";
      if (!check.add(buffer.subarray(0, bytesRead))) return false;
    }
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => {});
  }
}
