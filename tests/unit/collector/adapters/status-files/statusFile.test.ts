import { describe, expect, test } from "vitest";

import {
  isStatusFileName,
  MAX_AGENT_LENGTH,
  MAX_CWD_LENGTH,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_NAME_LENGTH,
  parseStatusFile,
} from "@collector/adapters/status-files/statusFile";
import { statusFile } from "@tests/fixtures/statusFiles";

describe("the limits", () => {
  test("are 200 files of 16 KB each", () => {
    expect(MAX_FILES).toBe(200);
    expect(MAX_FILE_BYTES).toBe(16 * 1024);
  });
});

describe("which names are read", () => {
  test("a name ending in .json is read", () => {
    for (const name of ["night-shift.json", "a.json", "checkout flow.json", "café.json"]) {
      expect(isStatusFileName(name), name).toBe(true);
    }
  });

  test("anything else is left alone, and so is a hidden name, so a file can be written under one and renamed", () => {
    for (const name of [
      "night-shift.json.tmp",
      "night-shift.JSON",
      "night-shift.jsonl",
      "night-shift",
      ".json",
      ".night-shift.json",
      "README.md",
    ]) {
      expect(isStatusFileName(name), name).toBe(false);
    }
  });
});

describe("a file with every field", () => {
  test("keeps each one", () => {
    expect(
      parseStatusFile(
        statusFile({
          status: "waiting",
          reason: "permission",
          since: "2026-10-05T11:58:00Z",
          pid: 4242,
        }),
      ),
    ).toEqual({
      agent: "Night Shift",
      name: "checkout-flow",
      cwd: "/Users/example/code/checkout-flow",
      status: "waiting",
      reason: "permission",
      since: Date.UTC(2026, 9, 5, 11, 58, 0),
      pid: 4242,
    });
  });

  test("needs only an agent and a status", () => {
    expect(parseStatusFile('{"agent":"my-agent","status":"idle"}')).toEqual({
      agent: "my-agent",
      status: "idle",
    });
  });

  test("ignores fields the format does not have", () => {
    expect(
      parseStatusFile(statusFile({ model: "large", tokens: 1200, links: { open: "https://x" } })),
    ).toEqual({
      agent: "Night Shift",
      name: "checkout-flow",
      cwd: "/Users/example/code/checkout-flow",
      status: "working",
    });
  });
});

describe("what is not a status file", () => {
  test("text that is not JSON, or is cut short, as a file caught half written is", () => {
    const whole = statusFile();
    for (const content of ["", " ", "agent: Night Shift", whole.slice(0, whole.length - 1), "{"]) {
      expect(parseStatusFile(content), JSON.stringify(content)).toBeNull();
    }
  });

  test("JSON that is not an object", () => {
    for (const content of ["null", "42", '"working"', "[]", `[${statusFile()}]`, "true"]) {
      expect(parseStatusFile(content), content).toBeNull();
    }
  });

  test("an object with no agent, or an agent that is not text or is only spaces", () => {
    for (const agent of [undefined, "", "   ", 7, null, ["Night Shift"], { name: "x" }]) {
      expect(parseStatusFile(statusFile({ agent })), String(agent)).toBeNull();
    }
  });

  test("an object with no status, or a status that is not a word", () => {
    for (const status of [undefined, "", "  ", 1, null, true, ["working"], "w".repeat(41)]) {
      expect(parseStatusFile(statusFile({ status })), String(status)).toBeNull();
    }
  });
});

describe("each optional field", () => {
  test("a status is kept in lower case, and one this version does not know is kept as written", () => {
    expect(parseStatusFile(statusFile({ status: " Waiting " }))?.status).toBe("waiting");
    expect(parseStatusFile(statusFile({ status: "paused" }))?.status).toBe("paused");
  });

  test("a name of the wrong kind, or only spaces, is no name", () => {
    for (const name of [undefined, "", "   ", 12, null, ["checkout-flow"]]) {
      expect(parseStatusFile(statusFile({ name })), String(name)).not.toHaveProperty("name");
    }
  });

  test("a folder of the wrong kind is no folder, and one too long to be real is not cut but dropped", () => {
    expect(parseStatusFile(statusFile({ cwd: 3 }))).not.toHaveProperty("cwd");
    expect(parseStatusFile(statusFile({ cwd: "" }))).not.toHaveProperty("cwd");
    const longest = `/${"a".repeat(MAX_CWD_LENGTH - 1)}`;
    expect(parseStatusFile(statusFile({ cwd: longest }))?.cwd).toBe(longest);
    expect(parseStatusFile(statusFile({ cwd: `${longest}b` }))).not.toHaveProperty("cwd");
  });

  test("a reason is kept in lower case", () => {
    expect(parseStatusFile(statusFile({ status: "waiting", reason: "Question" }))?.reason).toBe(
      "question",
    );
    expect(parseStatusFile(statusFile({ reason: 1 }))).not.toHaveProperty("reason");
  });

  test("since is epoch milliseconds or an ISO 8601 time", () => {
    const at = Date.UTC(2026, 9, 5, 11, 58, 0);
    const since = (value: unknown) => parseStatusFile(statusFile({ since: value }))?.since;
    expect(since(at)).toBe(at);
    expect(since("2026-10-05T11:58:00Z")).toBe(at);
    expect(since("2026-10-05T11:58:00.000Z")).toBe(at);
    expect(since("2026-10-05T12:58:00+01:00")).toBe(at);
    expect(since("2026-10-05T12:58:00+0100")).toBe(at);
    expect(since("2026-10-05 11:58Z")).toBe(at);
    // With no zone it is local time, as JavaScript and Python write it.
    expect(since("2026-10-05T11:58:00")).toBe(new Date(2026, 9, 5, 11, 58, 0).getTime());
  });

  test("since in any other shape is no time", () => {
    for (const value of [
      "yesterday",
      "2026-10-05",
      "Mon, 05 Oct 2026 11:58:00 GMT",
      "1791223080000",
      "2026-13-45T11:58:00Z",
      1.5,
      Number.MAX_VALUE,
      null,
      [2026],
    ]) {
      expect(parseStatusFile(statusFile({ since: value })), String(value)).not.toHaveProperty(
        "since",
      );
    }
  });

  test("since in the future or in 1970 is kept here: whether it could be right is decided with the clock", () => {
    expect(parseStatusFile(statusFile({ since: 0 }))?.since).toBe(0);
    expect(parseStatusFile(statusFile({ since: "1970-01-01T00:00:00Z" }))?.since).toBe(0);
    expect(parseStatusFile(statusFile({ since: "2099-01-01T00:00:00Z" }))?.since).toBe(
      Date.UTC(2099, 0, 1),
    );
  });

  test("a pid is a whole number above zero", () => {
    expect(parseStatusFile(statusFile({ pid: 4242 }))?.pid).toBe(4242);
    for (const pid of [0, -1, 1.5, "4242", null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseStatusFile(statusFile({ pid })), String(pid)).not.toHaveProperty("pid");
    }
  });
});

describe("odd text", () => {
  test("markup is kept as plain text, to be shown as text", () => {
    const file = parseStatusFile(
      statusFile({
        agent: "<img src=x onerror=alert(1)>",
        name: '<script>alert("checkout-flow")</script>',
      }),
    );
    expect(file?.agent).toBe("<img src=x onerror=alert(1)>");
    expect(file?.name).toBe('<script>alert("checkout-flow")</script>');
  });

  test("text is trimmed, and control characters and text-direction marks become spaces", () => {
    const file = parseStatusFile(
      statusFile({
        agent: "  Night\u0000Shift\n",
        name: "checkout‮wolf-⁦flow\u0007",
        cwd: "/Users/example/code/a‏b‎c؜d",
      }),
    );
    expect(file?.agent).toBe("Night Shift");
    expect(file?.name).toBe("checkout wolf- flow");
    expect(file?.cwd).toBe("/Users/example/code/a b c d");
  });

  test("names in any script are kept as they are", () => {
    const file = parseStatusFile(
      statusFile({
        agent: "夜勤 エージェント",
        name: "café-déploiement 🚀",
        cwd: "/Users/example/コード",
      }),
    );
    expect(file).toMatchObject({
      agent: "夜勤 エージェント",
      name: "café-déploiement 🚀",
      cwd: "/Users/example/コード",
    });
  });

  test("a very long agent or session name is cut, never inside a character", () => {
    const file = parseStatusFile(
      statusFile({ agent: "Night Shift ".repeat(20), name: "🚀".repeat(MAX_NAME_LENGTH + 50) }),
    );
    expect(Array.from(file?.agent ?? "").length).toBeLessThanOrEqual(MAX_AGENT_LENGTH);
    expect(file?.agent.startsWith("Night Shift Night Shift")).toBe(true);
    // Cut at a space, the end is trimmed.
    expect(file?.agent.endsWith(" ")).toBe(false);
    expect(file?.name).toBe("🚀".repeat(MAX_NAME_LENGTH));
  });
});
