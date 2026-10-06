import { describe, expect, test } from "vitest";

import { openCommand, openInBrowser, type RunProgram } from "@cli/start/openBrowser";

// The opener with the program it runs replaced, so no browser is ever opened.
// What it would run is written down instead.

/** A stand-in for running a program: it writes down each run and answers as told. */
function standIn(answer: boolean) {
  const runs: { file: string; args: readonly string[] }[] = [];
  const run: RunProgram = async (file, args) => {
    runs.push({ file, args });
    return answer;
  };
  return { run, runs };
}

describe("the command it runs", () => {
  test("is open by its full path on macOS, and xdg-open on Linux, with the address alone", () => {
    expect(openCommand("darwin", "http://127.0.0.1:4777")).toEqual({
      file: "/usr/bin/open",
      args: ["http://127.0.0.1:4777"],
    });
    expect(openCommand("linux", "http://127.0.0.1:4778")).toEqual({
      file: "xdg-open",
      args: ["http://127.0.0.1:4778"],
    });
    expect(openCommand("linux", "http://[::1]:4777")).toEqual({
      file: "xdg-open",
      args: ["http://[::1]:4777"],
    });
  });

  test("is none on a system with neither", () => {
    expect(openCommand("win32", "http://127.0.0.1:4777")).toBeNull();
    expect(openCommand("freebsd", "http://127.0.0.1:4777")).toBeNull();
  });

  test("is none for any address but Agent Lookout's own on this machine", () => {
    for (const url of [
      "https://127.0.0.1:4777",
      "http://example.com:4777",
      "http://10.0.0.2:4777",
      "file:///etc/passwd",
      "--new-window",
      "",
    ]) {
      expect(openCommand("darwin", url)).toBeNull();
      expect(openCommand("linux", url)).toBeNull();
    }
  });

  test("hands over only the address, never a path, a query or anything after it", () => {
    expect(openCommand("darwin", "http://127.0.0.1:4777/?x=1#y")).toEqual({
      file: "/usr/bin/open",
      args: ["http://127.0.0.1:4777"],
    });
  });
});

describe("opening the browser", () => {
  test("runs the system's opener once, and says it worked when the opener did", async () => {
    const opener = standIn(true);
    expect(
      await openInBrowser("http://127.0.0.1:4777", { platform: "darwin", run: opener.run }),
    ).toBe(true);
    expect(opener.runs).toEqual([{ file: "/usr/bin/open", args: ["http://127.0.0.1:4777"] }]);
  });

  test("says it did not work when the opener failed", async () => {
    const opener = standIn(false);
    expect(
      await openInBrowser("http://127.0.0.1:4777", { platform: "linux", run: opener.run }),
    ).toBe(false);
    expect(opener.runs).toEqual([{ file: "xdg-open", args: ["http://127.0.0.1:4777"] }]);
  });

  test("runs nothing on a system with no opener, or for an address elsewhere", async () => {
    const opener = standIn(true);
    expect(
      await openInBrowser("http://127.0.0.1:4777", { platform: "win32", run: opener.run }),
    ).toBe(false);
    expect(
      await openInBrowser("http://example.com:4777", { platform: "darwin", run: opener.run }),
    ).toBe(false);
    expect(opener.runs).toEqual([]);
  });
});
