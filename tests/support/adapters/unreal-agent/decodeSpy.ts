// Watching what is turned into text while a piece of code runs: every way
// Node turns bytes into a string, and `JSON.parse`. Each is wrapped for the
// call, and each string it makes is noted, with what `JSON.parse` is given.
// The Unreal Agent tests hold the adapter to the IDs, times and folder its
// file holds, so a field, a line or a part of one decoded by any of these
// fails them.

import { StringDecoder } from "node:string_decoder";

type Method = (...args: unknown[]) => unknown;

/** The prototypes and names of every way bytes become a string, and of `JSON.parse`. */
function targets(): [Record<string, unknown>, string][] {
  const buffer = Buffer.prototype as unknown as Record<string, unknown>;
  const slices = [
    "toString",
    "latin1Slice",
    "asciiSlice",
    "utf8Slice",
    "ucs2Slice",
    "hexSlice",
    "base64Slice",
  ]
    .filter((name) => typeof buffer[name] === "function")
    .map((name): [Record<string, unknown>, string] => [buffer, name]);
  return [
    ...slices,
    [TextDecoder.prototype as unknown as Record<string, unknown>, "decode"],
    [StringDecoder.prototype as unknown as Record<string, unknown>, "write"],
    [StringDecoder.prototype as unknown as Record<string, unknown>, "end"],
    [String as unknown as Record<string, unknown>, "fromCharCode"],
    [String as unknown as Record<string, unknown>, "fromCodePoint"],
    [JSON as unknown as Record<string, unknown>, "parse"],
  ];
}

function wrap(seen: string[]): () => void {
  const undo: (() => void)[] = [];
  for (const [owner, name] of targets()) {
    const original = owner[name] as Method;
    owner[name] = function (this: unknown, ...args: unknown[]) {
      if (name === "parse" && typeof args[0] === "string") seen.push(args[0]);
      const made = original.apply(this, args);
      if (typeof made === "string" && made !== "") seen.push(made);
      return made;
    };
    undo.push(() => {
      owner[name] = original;
    });
  }
  return () => {
    for (const step of undo.reverse()) step();
  };
}

/** Every string made from bytes, or given to `JSON.parse`, while `run` runs. */
export function watchDecoding(run: () => void): string[] {
  const seen: string[] = [];
  const undo = wrap(seen);
  try {
    run();
  } finally {
    undo();
  }
  return seen;
}

/** The same, for code that waits. Nothing else should run meanwhile. */
export async function watchDecodingWhile(run: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const undo = wrap(seen);
  try {
    await run();
  } finally {
    undo();
  }
  return seen;
}
