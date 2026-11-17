import { describe, expect, test } from "vitest";

import {
  frameAt,
  FRAME_TEXT_MAX,
  isTooLarge,
  startsFrame,
  WINDOW_LOG_MAX,
  zstdOf,
} from "@collector/adapters/deepseek-harness/zstdFrames";
import { batch, headerLine, line, NOW } from "@tests/fixtures/deepseek-harness/deepseekHarness";
import { ZSTD } from "@tests/support/adapters/deepseek-harness/deepseekHarnessAdapter";
import {
  frame,
  HAS_ZSTD,
  joined,
  NO_ZSTD_REASON,
  skippableFrame,
  streamedFrame,
  withDescriptor,
} from "@tests/support/adapters/deepseek-harness/frames";

const text = batch(line.turnStart(0, NOW), line.turnEnd(1, NOW, "completed"));

describe("zstdOf", () => {
  test("is null for anything that cannot undo Zstandard", () => {
    expect(zstdOf(null)).toBeNull();
    expect(zstdOf({})).toBeNull();
    expect(zstdOf({ constants: {} })).toBeNull();
    expect(zstdOf({ zstdDecompress: () => {}, constants: {} })).toBeNull();
    expect(zstdOf({ zstdDecompress: "no", constants: { ZSTD_d_windowLogMax: 100 } })).toBeNull();
  });

  test("hands each frame over alone, with at most what may come out of it and a window of 8 MiB", async () => {
    const calls: { data: Uint8Array; options: unknown }[] = [];
    const decoder = zstdOf({
      zstdDecompress(
        data: Uint8Array,
        options: unknown,
        callback: (e: Error | null, r: Buffer) => void,
      ) {
        calls.push({ data, options });
        callback(null, Buffer.from("x\n"));
      },
      constants: { ZSTD_d_windowLogMax: 100 },
    });
    expect(decoder).not.toBeNull();
    const data = new Uint8Array([1, 2, 3]);
    await expect(decoder!.frame(data, FRAME_TEXT_MAX)).resolves.toEqual(Buffer.from("x\n"));
    expect(calls).toEqual([
      { data, options: { maxOutputLength: 8 * 1024 * 1024, params: { 100: WINDOW_LOG_MAX } } },
    ]);
    expect(WINDOW_LOG_MAX).toBe(23);
  });

  test("passes a failure on", async () => {
    const decoder = zstdOf({
      zstdDecompress(_data: Uint8Array, _options: unknown, callback: (e: Error | null) => void) {
        callback(Object.assign(new Error("too big"), { code: "ERR_BUFFER_TOO_LARGE" }));
      },
      constants: { ZSTD_d_windowLogMax: 100 },
    });
    const error = await decoder!.frame(new Uint8Array(), 1).catch((caught: unknown) => caught);
    expect(isTooLarge(error)).toBe(true);
    expect(isTooLarge(new Error("other"))).toBe(false);
  });
});

describe.skipIf(!HAS_ZSTD)(`frames, as Node.js makes them (${NO_ZSTD_REASON} otherwise)`, () => {
  test("a frame is found whole, with what comes out of it, from its headers alone", () => {
    const one = frame(text);
    expect(frameAt(one, 0)).toEqual({
      kind: "frame",
      end: one.byteLength,
      contentSize: new TextEncoder().encode(text).byteLength,
    });
    const two = joined(frame(headerLine()), one);
    const first = frameAt(two, 0);
    expect(first.kind).toBe("frame");
    if (first.kind === "frame")
      expect(frameAt(two, first.end)).toMatchObject({ kind: "frame", end: two.byteLength });
  });

  test("a frame made by a stream, which says nothing of its size, is found whole, and the empty one a stream can end with", async () => {
    const streamed = await streamedFrame([text, text, text]);
    const first = frameAt(streamed, 0);
    expect(first).toMatchObject({ kind: "frame", contentSize: null });
    if (first.kind !== "frame") return;
    const decoded = await ZSTD!.frame(streamed.subarray(0, first.end), FRAME_TEXT_MAX);
    expect(decoded.toString()).toBe(text.repeat(3));
    // What follows, if anything, is whole frames that hold nothing.
    for (let at = first.end; at < streamed.byteLength;) {
      const next = frameAt(streamed, at);
      expect(next.kind).toBe("frame");
      if (next.kind !== "frame") return;
      expect((await ZSTD!.frame(streamed.subarray(at, next.end), FRAME_TEXT_MAX)).byteLength).toBe(
        0,
      );
      at = next.end;
    }
  });

  test("a frame cut anywhere is one still being written", () => {
    const one = frame(text.repeat(50));
    for (let cut = 0; cut < one.byteLength; cut++) {
      expect(frameAt(one.subarray(0, cut), 0), String(cut)).toEqual({ kind: "torn" });
    }
  });

  test("a frame with no checksum, a dictionary, a reserved bit, or a skippable one, is not DeepSeek Harness's", () => {
    const one = frame(text);
    const descriptor = one[4] as number;
    expect(frameAt(withDescriptor(one, descriptor & ~0x04), 0)).toEqual({ kind: "foreign" });
    expect(frameAt(withDescriptor(one, descriptor | 0x01), 0)).toEqual({ kind: "foreign" });
    expect(frameAt(withDescriptor(one, descriptor | 0x08), 0)).toEqual({ kind: "foreign" });
    expect(frameAt(withDescriptor(one, descriptor | 0x10), 0)).toEqual({ kind: "foreign" });
    expect(frameAt(skippableFrame(), 0)).toEqual({ kind: "foreign" });
    expect(frameAt(new Uint8Array([1, 2, 3, 4, 5]), 0)).toEqual({ kind: "foreign" });
    expect(frameAt(new Uint8Array([1, 2, 3, 4]), 0)).toEqual({ kind: "foreign" });
  });

  test("a block of the reserved type, or over 128 KiB, is not Zstandard's", () => {
    // The fixture's frame is one segment with a one-byte size: its first block's header is at byte 6.
    const one = new Uint8Array(frame("x\n"));
    expect(one[4]).toBe(0x24);
    const reserved = new Uint8Array(one);
    reserved[6] = ((reserved[6] as number) & ~0x06) | 0x06;
    expect(frameAt(reserved, 0)).toEqual({ kind: "foreign" });
    const huge = new Uint8Array(one);
    const block = (128 * 1024 + 1) << 3;
    huge[6] = (block & 0xff) | ((huge[6] as number) & 0x07);
    huge[7] = (block >>> 8) & 0xff;
    huge[8] = (block >>> 16) & 0xff;
    expect(frameAt(huge, 0)).toEqual({ kind: "foreign" });
  });

  test("a frame's start is its magic number", () => {
    const one = frame(text);
    expect(startsFrame(one, 0)).toBe(true);
    expect(startsFrame(one, 1)).toBe(false);
    expect(startsFrame(one.subarray(0, 3), 0)).toBe(false);
  });

  test("Node.js's own decoder stops a frame past what may come out of it", async () => {
    const big = frame("x".repeat(64 * 1024));
    const error = await ZSTD!.frame(big, 1024).catch((caught: unknown) => caught);
    expect(isTooLarge(error)).toBe(true);
    await expect(ZSTD!.frame(frame(text), FRAME_TEXT_MAX)).resolves.toEqual(Buffer.from(text));
  });
});
