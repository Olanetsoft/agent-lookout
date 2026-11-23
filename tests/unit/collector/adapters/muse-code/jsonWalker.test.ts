import { describe, expect, test } from "vitest";

import {
  MAX_DEPTH,
  walkLine,
  type Token,
  type WantedKey,
} from "@collector/adapters/muse-code/jsonWalker";

const key = (name: string, leaf?: number, children?: WantedKey[]): WantedKey => ({
  key: Buffer.from(name),
  ...(leaf === undefined ? {} : { leaf }),
  ...(children === undefined ? {} : { children }),
});

const WANTED = [key("a", 1), key("b", undefined, [key("c", 2), key("d", 3)]), key("e", 4)];

/** Walks a line and gives each wanted leaf's bytes, as text for the test alone. */
function walk(text: string, whole = true, stopAt: number[] = []) {
  const line = Buffer.from(text);
  const got: [number, string, Token["type"]][] = [];
  const end = walkLine(line, whole, WANTED, (leaf, token) => {
    const bytes =
      token.type === "string" || token.type === "number"
        ? line.subarray(token.start, token.end).toString("latin1")
        : token.type;
    got.push([leaf, bytes, token.type]);
    return stopAt.includes(leaf);
  });
  return { end, got };
}

describe("walking a line", () => {
  test("gives the value at each wanted path, in the order they come, and steps over the rest", () => {
    expect(
      walk('{"x":[1,{"a":"no"}],"e":true,"b":{"d":-1.5e3,"c":"word","a":"no"},"a":"yes"}'),
    ).toEqual({
      end: "end",
      got: [
        [4, "true", "true"],
        [3, "-1.5e3", "number"],
        [2, "word", "string"],
        [1, "yes", "string"],
      ],
    });
  });

  test("steps over whitespace at every gap between tokens, and gives the same values as a compact line", () => {
    const compact = walk(
      '{"x":[1,{"a":"no"}],"e":true,"b":{"d":-1.5e3,"c":"word","a":"no"},"a":"yes"}',
    );
    expect(
      walk(
        ' {\t"x" : [ 1 , { "a" : "no" } ] , "e" : true , "b" : { "d" : -1.5e3 , "c" : "word" , "a" : "no" } , "a" : "yes" }\r',
      ),
    ).toEqual(compact);
  });

  test("gives a string's bytes between its quotes, and says when they hold an escape", () => {
    const line = Buffer.from('{"a":"x\\"y\\u00e9"}');
    let token: Token | undefined;
    walkLine(line, true, WANTED, (_leaf, found) => {
      token = found;
      return false;
    });
    expect(token).toMatchObject({ type: "string", escaped: true });
    if (token?.type !== "string") throw new Error("not a string");
    expect(line.subarray(token.start, token.end).toString("latin1")).toBe('x\\"y\\u00e9');
  });

  test("never matches a key that holds an escape, nor one inside a value it steps over", () => {
    expect(walk('{"\\u0061":"x","n":{"a":"y"},"s":"\\"a\\":"}').got).toEqual([]);
  });

  test("stops where the caller says it has what it needs, and looks at nothing after", () => {
    // The rest is not JSON, and is never looked at.
    expect(walk('{"a":"x","e":1,  not json', true, [1])).toEqual({
      end: "stopped",
      got: [[1, "x", "string"]],
    });
  });

  test("a value that is an object or an array where a value is wanted is given as such, and stepped over", () => {
    expect(walk('{"a":{"c":"x"},"e":[1,2]}').got).toEqual([
      [1, "object", "object"],
      [4, "array", "array"],
    ]);
  });

  test("an array where a value is wanted says whether it holds anything", () => {
    const empties: boolean[] = [];
    for (const text of ['{"e":[]}', '{"e":[ \t]}', '{"e":[{}]}', '{"e":[ 1 ,2]}']) {
      walkLine(Buffer.from(text), true, WANTED, (_leaf, token) => {
        if (token.type === "array") empties.push(token.empty);
        return false;
      });
    }
    expect(empties).toEqual([true, true, false, false]);
  });

  test("goes into a wanted object only, and not into one at another path", () => {
    expect(walk('{"z":{"b":{"c":"x"}},"b":"flat"}').got).toEqual([]);
  });
});

describe("a line that is not JSON, or is past what is walked", () => {
  test("a syntax error is an error", () => {
    for (const bad of [
      '{"a":"x",}',
      '{"a" "x"}',
      '{"a":01}',
      '{"a":-}',
      '{"a":1.}',
      '{"a":1e}',
      '{"a":tru}',
      '{"a":"\\x"}',
      '{"a":"\\u00g0"}',
      '{"a":"x"} y',
      '{"a":"x"',
      "",
      `{"a":"x${String.fromCharCode(1)}"}`,
    ]) {
      expect(walk(bad).end, bad).toBe("error");
    }
  });

  test("a wanted path met twice is an error, and one that is not wanted is not", () => {
    expect(walk('{"a":"x","a":"y"}').end).toBe("error");
    expect(walk('{"b":{"c":"x"},"b":{"d":1}}').end).toBe("error");
    expect(walk('{"b":{"c":"x","c":"y"}}').end).toBe("error");
    expect(walk('{"z":1,"z":2}').end).toBe("end");
  });

  test(`a depth past ${MAX_DEPTH} is an error, and ${MAX_DEPTH} is not`, () => {
    const nested = (depth: number) => `${"[".repeat(depth - 1)}${"]".repeat(depth - 1)}`;
    expect(walk(`{"x":${nested(MAX_DEPTH)}}`).end).toBe("end");
    expect(walk(`{"x":${nested(MAX_DEPTH + 1)}}`).end).toBe("error");
  });

  test("bytes that end inside a line longer than them are a line cut short, not an error, and a value past them is missing", () => {
    expect(walk('{"a":"x","e":"cut', false)).toEqual({ end: "cut", got: [[1, "x", "string"]] });
    expect(walk('{"a":"x","e":12', false).end).toBe("cut");
    expect(walk('{"a":"x","e":tr', false).end).toBe("cut");
    expect(walk('{"a":"x"}', false).end).toBe("cut");
    // The same bytes as a whole line are an error.
    expect(walk('{"a":"x","e":"cut', true).end).toBe("error");
  });
});
