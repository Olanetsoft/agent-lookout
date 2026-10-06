import { describe, expect, test } from "vitest";

import { pathCandidates, tildify } from "@collector/files/paths";
import { HOME } from "@tests/fixtures/claudeCode";

describe("tildify", () => {
  test("shortens paths under the home directory and leaves others alone", () => {
    expect(tildify("/Users/example/.claude/sessions", HOME)).toBe("~/.claude/sessions");
    expect(tildify(HOME, HOME)).toBe("~");
    expect(tildify("/Users/example-other/.claude", HOME)).toBe("/Users/example-other/.claude");
    expect(tildify("/opt/homebrew/bin", HOME)).toBe("/opt/homebrew/bin");
    expect(tildify("/opt/homebrew/bin", "")).toBe("/opt/homebrew/bin");
  });
});
describe("pathCandidates", () => {
  test("names the program in each absolute PATH folder, in order, and skips relative ones", () => {
    expect(pathCandidates({ PATH: "/usr/bin:bin::/opt/homebrew/bin" }, "tmux")).toEqual([
      "/usr/bin/tmux",
      "/opt/homebrew/bin/tmux",
    ]);
    expect(pathCandidates({}, "claude")).toEqual([]);
  });
});
