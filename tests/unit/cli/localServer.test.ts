import { describe, expect, test } from "vitest";

import {
  addressesToTry,
  asSnapshot,
  DEFAULT_ADDRESSES,
  loopbackAddress,
  URL_ENV,
} from "@cli/localServer";
import { makeSession } from "@tests/fixtures/session";

describe("an address on this machine", () => {
  test.each([
    ["http://127.0.0.1:4777", "http://127.0.0.1:4777"],
    ["http://localhost:5173/", "http://localhost:5173"],
    ["http://LOCALHOST:5180", "http://localhost:5180"],
    ["http://[::1]:4777", "http://[::1]:4777"],
    ["  http://127.0.0.1:4778/api/sessions?x=1  ", "http://127.0.0.1:4778"],
    ["http://localhost", "http://localhost"],
  ])("%s is asked as %s", (given, address) => {
    expect(loopbackAddress(given)).toBe(address);
  });

  test.each([
    "https://127.0.0.1:4777",
    "http://example.com:4777",
    "http://192.168.1.20:4777",
    "http://0.0.0.0:4777",
    "http://127.0.0.2:4777",
    "http://localhost.example.com:4777",
    "http://localhost.:4777",
    "127.0.0.1:4777",
    "localhost:4777",
    "file:///tmp/sessions.json",
    "not an address",
    "",
  ])("%j is refused", (given) => {
    expect(loopbackAddress(given)).toBeNull();
  });
});

describe("which addresses are tried", () => {
  test("with nothing named, where npm start listens and then where npm run dev does", () => {
    expect(addressesToTry(null, {})).toEqual({
      addresses: ["http://127.0.0.1:4777", "http://localhost:5173"],
      named: false,
    });
    expect(DEFAULT_ADDRESSES).toEqual(["http://127.0.0.1:4777", "http://localhost:5173"]);
  });

  test("the address --url names, and that one only", () => {
    expect(addressesToTry("http://127.0.0.1:4778", {})).toEqual({
      addresses: ["http://127.0.0.1:4778"],
      named: true,
    });
  });

  test("the address the setting names when --url names none, and --url when both do", () => {
    const env = { [URL_ENV]: "http://localhost:5180" };
    expect(addressesToTry(null, env)).toEqual({
      addresses: ["http://localhost:5180"],
      named: true,
    });
    expect(addressesToTry("http://127.0.0.1:4778", env)).toEqual({
      addresses: ["http://127.0.0.1:4778"],
      named: true,
    });
  });

  test("a setting left blank names nothing", () => {
    expect(addressesToTry(null, { [URL_ENV]: "  " })).toMatchObject({ named: false });
  });

  test("an address elsewhere is refused, saying which was wrong, and nothing else is tried", () => {
    expect(addressesToTry("http://example.com", {})).toEqual({
      refusal:
        "--url must be an http address on this machine, at localhost, 127.0.0.1 or [::1], such as http://127.0.0.1:4777. Session names are read from this machine only.",
    });
    expect(addressesToTry(null, { [URL_ENV]: "http://192.168.1.20:4777" })).toEqual({
      refusal: expect.stringMatching(/^AGENT_LOOKOUT_URL must be an http address on this machine/),
    });
  });

  test("a refusal never repeats what was given", () => {
    const given = "http://example.com/\u001b[2J";
    const refusal = addressesToTry(given, {});
    expect(JSON.stringify(refusal)).not.toContain("example.com");
  });
});

describe("an answer of /api/sessions", () => {
  const sources = [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: 1 }];

  test("is read when it has the sessions and the sources, as the collector sends them", () => {
    const answer = {
      generatedAt: 1,
      sources,
      sessions: [makeSession(), makeSession({ id: "b", project: null, agent: "Night Shift" })],
    };
    expect(asSnapshot(answer)).toBe(answer);
  });

  test.each([
    ["nothing", null],
    ["a list", []],
    ["no sessions", { sources }],
    ["no sources", { sessions: [] }],
    ["a session without an id", { sources, sessions: [{ ...makeSession(), id: 7 }] }],
    [
      "a session whose start is text",
      { sources, sessions: [makeSession({ statusSince: "x" as never })] },
    ],
    ["a session without stale", { sources, sessions: [{ ...makeSession(), stale: undefined }] }],
    ["a source without a label", { sources: [{ id: "codex", state: "ok" }], sessions: [] }],
    ["an error", { error: "This address only answers requests made to localhost." }],
  ])("is not read when it holds %s", (_label, answer) => {
    expect(asSnapshot(answer)).toBeNull();
  });
});
