/**
 * The Zstandard frames of a DeepSeek Harness log. Built from DeepSeek
 * Harness's source at dsh-v0.2.2-rc.3 and not yet checked on a computer
 * running it.
 *
 * A compressed log is a run of independent Zstandard frames: its first line
 * in one, then one for each batch of lines written at once (session-
 * persistence-jsonl/src/index.ts:1374-1394). Each is made with Node's
 * `zstdCompress`, with a checksum and no dictionary (zstd.ts:18-20,
 * :111-113). Where each frame ends is found from its headers alone, as
 * DeepSeek Harness itself finds it (zstd.ts:48-104), so a frame is undone
 * only once it is whole, and alone.
 *
 * Node.js reads Zstandard from 22.15, in `node:zlib`, still marked
 * experimental. It is imported whole, never by name: a name this Node.js
 * does not have would stop the collector from loading. Whether it is there is
 * asked once, with `zstdOf`.
 */

/** The most that may come out of one frame. A frame past it is passed over, not kept. */
export const FRAME_TEXT_MAX = 8 * 1024 * 1024;

/** The largest window a frame may ask for, 8 MiB, as `2^23`. */
export const WINDOW_LOG_MAX = 23;

/** The largest block a frame may hold (RFC 8878, 3.1.1.2.3). */
const BLOCK_MAX = 128 * 1024;

const MAGIC = 0xfd2fb528;

/** The few members of `node:zlib` this needs, which this project's Node.js types do not yet list. */
interface ZstdZlib {
  zstdDecompress(
    data: Uint8Array,
    options: { maxOutputLength: number; params: Record<number, number> },
    callback: (error: Error | null, result: Buffer) => void,
  ): void;
  constants: { ZSTD_d_windowLogMax: number };
}

/** What undoes one whole frame. */
export interface ZstdDecoder {
  /**
   * The text of one frame. Rejects with the code `ERR_BUFFER_TOO_LARGE` when
   * more than `maxOutputLength` bytes would come out of it, and otherwise when
   * it is not a frame that can be undone.
   */
  frame(data: Uint8Array, maxOutputLength: number): Promise<Buffer>;
}

/**
 * A decoder made from `node:zlib`, or from anything shaped like it, or null
 * when it cannot read Zstandard. Each frame may ask for a window of at most
 * 8 MiB.
 */
export function zstdOf(zlibLike: unknown): ZstdDecoder | null {
  const zlib = zlibLike as Partial<ZstdZlib> | null | undefined;
  const windowLogMax = zlib?.constants?.ZSTD_d_windowLogMax;
  if (typeof zlib?.zstdDecompress !== "function" || windowLogMax === undefined) return null;
  const decompress = zlib.zstdDecompress.bind(zlib);
  return {
    frame: (data, maxOutputLength) =>
      new Promise((resolve, reject) => {
        decompress(
          data,
          { maxOutputLength, params: { [windowLogMax]: WINDOW_LOG_MAX } },
          (error, result) => (error ? reject(error) : resolve(result)),
        );
      }),
  };
}

/** Whether a decode failed because the frame would give more than was allowed. */
export function isTooLarge(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ERR_BUFFER_TOO_LARGE";
}

/** What is at a place in a log's bytes. */
export type FrameAt =
  /** A whole frame, ending at `end`, which says how much comes out of it when its header does. */
  | { kind: "frame"; end: number; contentSize: number | null }
  /** Bytes that end before a frame does: one still being written, or none at all. */
  | { kind: "torn" }
  /** Not a frame as DeepSeek Harness writes one. */
  | { kind: "foreign" };

function uintAt(data: Uint8Array, at: number, bytes: number): number {
  let value = 0;
  for (let i = bytes - 1; i >= 0; i--) value = value * 256 + (data[at + i] as number);
  return value;
}

/**
 * The frame that starts at `at`, found from its headers alone:
 *
 * 1. Four bytes of Zstandard's magic number.
 * 2. Its header's first byte, which must say there is a checksum, no
 *    dictionary and nothing reserved, as DeepSeek Harness writes it; then a
 *    window byte, unless it is one segment, and the size of what comes out of
 *    it, in 0, 1, 2, 4 or 8 bytes.
 * 3. Blocks, each with a 3-byte header, up to the last. A block of the
 *    reserved type, or larger than 128 KiB, is not Zstandard's.
 * 4. The 4-byte checksum.
 *
 * Running out of bytes anywhere is a frame still being written. A frame that
 * would give more than 2^53 bytes says so as more than any limit here.
 */
export function frameAt(data: Uint8Array, at: number): FrameAt {
  const length = data.byteLength;
  let offset = at;
  if (length - offset < 5) {
    if (length - offset >= 4 && uintAt(data, offset, 4) !== MAGIC) return { kind: "foreign" };
    return { kind: "torn" };
  }
  if (uintAt(data, offset, 4) !== MAGIC) return { kind: "foreign" };
  offset += 4;
  const descriptor = data[offset] as number;
  offset += 1;
  if ((descriptor & 0x18) !== 0 || (descriptor & 0x07) !== 0x04) return { kind: "foreign" };
  const singleSegment = (descriptor & 0x20) !== 0;
  const sizeFlag = descriptor >>> 6;
  const sizeBytes = sizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << sizeFlag;
  const headerBytes = (singleSegment ? 0 : 1) + sizeBytes;
  if (length - offset < headerBytes) return { kind: "torn" };
  offset += singleSegment ? 0 : 1;
  let contentSize: number | null = null;
  if (sizeBytes > 0) {
    contentSize = uintAt(data, offset, sizeBytes) + (sizeBytes === 2 ? 256 : 0);
    if (!Number.isSafeInteger(contentSize)) contentSize = Number.MAX_SAFE_INTEGER;
  }
  offset += sizeBytes;
  for (;;) {
    if (length - offset < 3) return { kind: "torn" };
    const block = uintAt(data, offset, 3);
    offset += 3;
    const last = (block & 1) !== 0;
    const type = (block >>> 1) & 0x03;
    const size = block >>> 3;
    if (type === 0x03 || size > BLOCK_MAX) return { kind: "foreign" };
    const payload = type === 0x01 ? 1 : size;
    if (length - offset < payload) return { kind: "torn" };
    offset += payload;
    if (last) break;
  }
  if (length - offset < 4) return { kind: "torn" };
  return { kind: "frame", end: offset + 4, contentSize };
}

/** Whether the four bytes at `at` begin a frame, for telling a log that went on as it was written. */
export function startsFrame(data: Uint8Array, at: number): boolean {
  return data.byteLength - at >= 4 && uintAt(data, at, 4) === MAGIC;
}
