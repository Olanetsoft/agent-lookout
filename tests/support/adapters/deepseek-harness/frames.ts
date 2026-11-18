// Making DeepSeek Harness's compressed logs for the tests: each batch of lines
// in one Zstandard frame, with a checksum and no dictionary, as DeepSeek
// Harness writes one with `zlib.zstdCompress` (session-persistence-jsonl/src/
// zstd.ts:18-20, :111-113), and one fed in several writes to a stream, as its
// migration from format 3 writes all of a session's lines (generation.ts:
// 747-765). Node.js makes them, from 22.15; a test that needs them is
// skipped, with a reason, on a Node.js without Zstandard. The byte builders
// make what DeepSeek Harness never writes: a frame cut short, one with no
// checksum, one with a dictionary, a skippable frame.

import zlib from "node:zlib";

/** The members of `node:zlib` this needs, which this project's Node.js types do not yet list. */
interface ZstdZlib {
  zstdCompressSync(data: Uint8Array, options: { params: Record<number, number> }): Buffer;
  createZstdCompress(options: { params: Record<number, number> }): NodeJS.ReadWriteStream;
  constants: { ZSTD_c_checksumFlag: number; ZSTD_c_contentSizeFlag: number };
}

const z = zlib as unknown as Partial<ZstdZlib>;

/** Whether this Node.js can make and read Zstandard frames. */
export const HAS_ZSTD = typeof z.zstdCompressSync === "function";

/** Why a test that needs Zstandard is skipped. */
export const NO_ZSTD_REASON = "this Node.js cannot make Zstandard frames, which came in 22.15";

const encoder = new TextEncoder();

function params(contentSize = true): Record<number, number> {
  const constants = z.constants as ZstdZlib["constants"];
  return {
    [constants.ZSTD_c_checksumFlag]: 1,
    ...(contentSize ? {} : { [constants.ZSTD_c_contentSizeFlag]: 0 }),
  };
}

/** One frame of these lines, as DeepSeek Harness writes a batch. */
export function frame(
  text: string | Uint8Array,
  options: { contentSize?: boolean } = {},
): Uint8Array {
  const data = typeof text === "string" ? encoder.encode(text) : text;
  return new Uint8Array(
    (z as ZstdZlib).zstdCompressSync(data, { params: params(options.contentSize) }),
  );
}

/** One frame made by a stream fed each piece in turn, which says nothing of its size. */
export async function streamedFrame(pieces: (string | Uint8Array)[]): Promise<Uint8Array> {
  const stream = (z as ZstdZlib).createZstdCompress({ params: params() });
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise<void>((resolve, reject) => {
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  for (const piece of pieces)
    stream.write(typeof piece === "string" ? encoder.encode(piece) : piece);
  stream.end();
  await ended;
  return new Uint8Array(Buffer.concat(chunks));
}

/** Frames one after another, as a log holds them. */
export function joined(...frames: Uint8Array[]): Uint8Array {
  const length = frames.reduce((sum, one) => sum + one.byteLength, 0);
  const out = new Uint8Array(length);
  let at = 0;
  for (const one of frames) {
    out.set(one, at);
    at += one.byteLength;
  }
  return out;
}

/** A compressed log: its header in a frame of its own, then each batch in one. */
export const compressedLog = (header: string, ...batches: string[]) =>
  joined(frame(header), ...batches.map((text) => frame(text)));

/** A frame with its header's first byte set to this, as DeepSeek Harness never writes one. */
export function withDescriptor(made: Uint8Array, descriptor: number): Uint8Array {
  const copy = new Uint8Array(made);
  copy[4] = descriptor;
  return copy;
}

/** A skippable frame, which DeepSeek Harness never writes: its magic, its length and that many bytes. */
export function skippableFrame(length = 4): Uint8Array {
  const out = new Uint8Array(8 + length);
  new DataView(out.buffer).setUint32(0, 0x184d2a50, true);
  new DataView(out.buffer).setUint32(4, length, true);
  return out;
}
