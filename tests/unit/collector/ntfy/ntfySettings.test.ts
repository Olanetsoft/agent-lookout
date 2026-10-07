import { describe, expect, test } from "vitest";

import { ntfyProblemLine, readNtfySetup, type NtfySettings } from "@collector/ntfy/ntfySettings";

const TOPIC = "agent-lookout-3f9c2a7e";
const TOKEN = "tk_0123456789abcdefghijklmnopqr";

/** The settings, or the problem, as the dashboard and the console would be told them. */
function read(env: Record<string, string>) {
  const setup = readNtfySetup(env);
  return setup.on ? setup.settings : setup.problem;
}

describe("readNtfySetup", () => {
  test("with no topic address set, ntfy is off and there is nothing to say, whatever else is set", () => {
    expect(readNtfySetup({})).toEqual({ on: false, problem: null });
    expect(
      readNtfySetup({
        AGENT_LOOKOUT_NTFY_URL: "   ",
        AGENT_LOOKOUT_NTFY_TOKEN: TOKEN,
        AGENT_LOOKOUT_NTFY_ASKING: "on",
      }),
    ).toEqual({ on: false, problem: null });
  });

  test("a topic on ntfy.sh is posted to at the server's root, with the topic beside the push, and the rest as left out", () => {
    expect(read({ AGENT_LOOKOUT_NTFY_URL: `https://ntfy.sh/${TOPIC}` })).toEqual({
      server: new URL("https://ntfy.sh/"),
      topic: TOPIC,
      token: null,
      events: ["needs-you"],
      afterMs: 60_000,
      asking: false,
    } satisfies NtfySettings);
  });

  test("a server of one's own, behind a path, with a port and a slash at the end, keeps its path", () => {
    const settings = read({
      AGENT_LOOKOUT_NTFY_URL: `https://push.example.com:8443/ntfy/${TOPIC}/`,
    }) as NtfySettings;
    expect(settings.server.href).toBe("https://push.example.com:8443/ntfy/");
    expect(settings.topic).toBe(TOPIC);
  });

  test("the token, the events, the delay and what a waiting session is asking are read under ntfy's own names", () => {
    expect(
      read({
        AGENT_LOOKOUT_NTFY_URL: `https://ntfy.sh/${TOPIC}`,
        AGENT_LOOKOUT_NTFY_TOKEN: TOKEN,
        AGENT_LOOKOUT_NTFY_EVENTS: "needs-you,failed",
        AGENT_LOOKOUT_NTFY_AFTER: "0",
        AGENT_LOOKOUT_NTFY_ASKING: "on",
        // The webhook's are not ntfy's.
        AGENT_LOOKOUT_WEBHOOK_ASKING: "off",
        AGENT_LOOKOUT_WEBHOOK_AFTER: "90",
      }),
    ).toMatchObject({ token: TOKEN, events: ["needs-you", "failed"], afterMs: 0, asking: true });
  });

  test("plain http goes only to this computer", () => {
    expect(read({ AGENT_LOOKOUT_NTFY_URL: `http://127.0.0.1:8080/${TOPIC}` })).toMatchObject({
      topic: TOPIC,
    });
    expect(read({ AGENT_LOOKOUT_NTFY_URL: `http://localhost:8080/${TOPIC}` })).toMatchObject({
      topic: TOPIC,
    });
    for (const url of [
      `http://ntfy.sh/${TOPIC}`,
      `http://192.168.1.5/${TOPIC}`,
      `ftp://ntfy.sh/${TOPIC}`,
    ]) {
      expect(read({ AGENT_LOOKOUT_NTFY_URL: url })).toBe(
        "AGENT_LOOKOUT_NTFY_URL must begin with https://, or with http:// for a server on this computer, 127.0.0.1 or localhost.",
      );
    }
  });

  test.each([
    ["no topic", "https://ntfy.sh/", "must end with the topic, up to 64 letters"],
    [
      "a topic of more than 64",
      `https://ntfy.sh/${"a".repeat(65)}`,
      "must end with the topic, up to 64 letters",
    ],
    ["a topic with a dot", "https://ntfy.sh/my.topic", "must end with the topic, up to 64 letters"],
    ["an escaped topic", "https://ntfy.sh/my%20topic", "must end with the topic, up to 64 letters"],
    ["a token in the query", `https://ntfy.sh/${TOPIC}?auth=s3cret`, "with no ? or # after it"],
    ["a fragment", `https://ntfy.sh/${TOPIC}#s3cret`, "with no ? or # after it"],
    [
      "a user and password",
      `https://me:s3cret@ntfy.sh/${TOPIC}`,
      "must not hold a user name or a password",
    ],
    ["a host of other characters", `https://ntfy_sh!/${TOPIC}`, "must name its host in letters"],
    ["no address at all", "ntfy.sh", "could not be read"],
  ])("%s is refused, and the sentence never repeats the address", (_, url, said) => {
    const problem = read({ AGENT_LOOKOUT_NTFY_URL: url });
    expect(typeof problem).toBe("string");
    expect(problem).toContain(said);
    expect(problem).toMatch(/^AGENT_LOOKOUT_NTFY_URL /);
    for (const secret of ["s3cret", TOPIC, "my.topic", "aaaa"]) {
      expect(problem).not.toContain(secret);
    }
  });

  test("a token that a header cannot carry is refused, and never repeated", () => {
    for (const token of ["tk_abc\r\nX-Evil: 1", "tk abc", "tk_é", "t".repeat(129)]) {
      const problem = read({
        AGENT_LOOKOUT_NTFY_URL: `https://ntfy.sh/${TOPIC}`,
        AGENT_LOOKOUT_NTFY_TOKEN: token,
      });
      expect(problem).toBe(
        "AGENT_LOOKOUT_NTFY_TOKEN must be an access token of letters, digits and . _ ~ + / = -, such as one that begins tk_.",
      );
    }
  });

  test("a setting of the others that cannot be read turns ntfy off, and is named", () => {
    expect(
      read({
        AGENT_LOOKOUT_NTFY_URL: `https://ntfy.sh/${TOPIC}`,
        AGENT_LOOKOUT_NTFY_ASKING: "yes",
      }),
    ).toBe("AGENT_LOOKOUT_NTFY_ASKING must be on or off.");
    expect(
      read({
        AGENT_LOOKOUT_NTFY_URL: `https://ntfy.sh/${TOPIC}`,
        AGENT_LOOKOUT_NTFY_EVENTS: "waits",
      }),
    ).toMatch(/^AGENT_LOOKOUT_NTFY_EVENTS must be one or more of /);
    expect(
      read({
        AGENT_LOOKOUT_NTFY_URL: `https://ntfy.sh/${TOPIC}`,
        AGENT_LOOKOUT_NTFY_AFTER: "soon",
      }),
    ).toMatch(/^AGENT_LOOKOUT_NTFY_AFTER must be a whole number of seconds/);
  });

  test("the line printed at start names ntfy and the problem", () => {
    expect(ntfyProblemLine("AGENT_LOOKOUT_NTFY_ASKING must be on or off.")).toBe(
      "ntfy pushes are off: AGENT_LOOKOUT_NTFY_ASKING must be on or off.",
    );
  });
});
