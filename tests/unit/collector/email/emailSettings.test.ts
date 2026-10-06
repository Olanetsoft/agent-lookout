import { describe, expect, test } from "vitest";

import {
  emailProblemLine,
  isOneAddress,
  maskAddress,
  readEmailSetup,
  type EmailSetup,
} from "@collector/email/emailSettings";

const TO = "notify@example.com";
/** A password with every character a URL has to escape, and some it does not. */
const PASSWORD = "p@ss:w/rd#?%&+= ü";
const URL_WITH_PASSWORD = `smtps://${encodeURIComponent("name@example.com")}:${encodeURIComponent(PASSWORD)}@smtp.example.com:465`;

const read = (env: Record<string, string>) => readEmailSetup(env);

const URL_UNREADABLE =
  "AGENT_LOOKOUT_SMTP_URL could not be read. Write it as smtps://name:password@server:port, with any @, :, /, ?, # or % in the name or the password written as %40, %3A, %2F, %3F, %23 or %25.";

/** The problem, for a setup that is off. */
function problemOf(setup: EmailSetup): string | null {
  if (setup.on) throw new Error("Expected email to be off.");
  return setup.problem;
}

describe("readEmailSetup", () => {
  test("with nothing set, email is off and there is nothing to say", () => {
    expect(read({})).toEqual({ on: false, problem: null });
    expect(read({ AGENT_LOOKOUT_EMAIL_TO: "  ", AGENT_LOOKOUT_SMTP_URL: "" })).toEqual({
      on: false,
      problem: null,
    });
  });

  test("with the address and the server set, email is on, from the same address, after a minute", () => {
    expect(read({ AGENT_LOOKOUT_EMAIL_TO: TO, AGENT_LOOKOUT_SMTP_URL: URL_WITH_PASSWORD })).toEqual(
      {
        on: true,
        settings: {
          to: TO,
          from: TO,
          events: ["needs-you"],
          afterMs: 60_000,
          asking: false,
          server: {
            host: "smtp.example.com",
            port: 465,
            security: "tls",
            auth: { user: "name@example.com", pass: PASSWORD },
          },
        },
      },
    );
  });

  test("the sender and the delay can be set, and 0 means at once", () => {
    const setup = read({
      AGENT_LOOKOUT_EMAIL_TO: TO,
      AGENT_LOOKOUT_SMTP_URL: "smtps://smtp.example.com",
      AGENT_LOOKOUT_EMAIL_FROM: "lookout@example.com",
      AGENT_LOOKOUT_EMAIL_AFTER: "0",
    });
    expect(setup).toMatchObject({
      on: true,
      settings: { from: "lookout@example.com", afterMs: 0 },
    });
    expect(
      read({
        AGENT_LOOKOUT_EMAIL_TO: TO,
        AGENT_LOOKOUT_SMTP_URL: "smtps://smtp.example.com",
        AGENT_LOOKOUT_EMAIL_AFTER: " 300 ",
      }),
    ).toMatchObject({ settings: { afterMs: 300_000 } });
  });

  test("the events emailed are a wait alone unless AGENT_LOOKOUT_EMAIL_EVENTS names others", () => {
    const base = { AGENT_LOOKOUT_EMAIL_TO: TO, AGENT_LOOKOUT_SMTP_URL: "smtps://smtp.example.com" };
    const events = (value?: string) =>
      read(value === undefined ? base : { ...base, AGENT_LOOKOUT_EMAIL_EVENTS: value });

    expect(events()).toMatchObject({ settings: { events: ["needs-you"] } });
    // Only spaces is the same as leaving it out.
    expect(events("  ")).toMatchObject({ settings: { events: ["needs-you"] } });
    expect(events("finished")).toMatchObject({ settings: { events: ["finished"] } });
    // Spaces, case, order and a name given twice do not matter.
    expect(events(" Ended , needs-you,FAILED,ended ")).toMatchObject({
      settings: { events: ["needs-you", "failed", "ended"] },
    });
    expect(events("needs-you,finished,failed,ended")).toMatchObject({
      settings: { events: ["needs-you", "finished", "failed", "ended"] },
    });
  });

  test.each([
    ",",
    "finished,",
    "finished,,failed",
    "finish",
    "needs you",
    "all",
    "finished;failed",
  ])("a list of events that cannot be read turns email off, and names the setting: %j", (value) => {
    const env = {
      AGENT_LOOKOUT_EMAIL_TO: TO,
      AGENT_LOOKOUT_SMTP_URL: URL_WITH_PASSWORD,
      AGENT_LOOKOUT_EMAIL_EVENTS: value,
    };
    expect(problemOf(read(env))).toBe(
      "AGENT_LOOKOUT_EMAIL_EVENTS must be one or more of needs-you, finished, failed, ended, separated by commas, such as needs-you,finished.",
    );
    expect(emailProblemLine(problemOf(read(env)) as string)).toBe(
      "Email notifications are off: AGENT_LOOKOUT_EMAIL_EVENTS must be one or more of needs-you, finished, failed, ended, separated by commas, such as needs-you,finished.",
    );
  });

  test("what a waiting session is asking is left out unless AGENT_LOOKOUT_EMAIL_ASKING is on", () => {
    const base = { AGENT_LOOKOUT_EMAIL_TO: TO, AGENT_LOOKOUT_SMTP_URL: "smtps://smtp.example.com" };
    const asking = (value?: string) =>
      read(value === undefined ? base : { ...base, AGENT_LOOKOUT_EMAIL_ASKING: value });

    expect(asking()).toMatchObject({ on: true, settings: { asking: false } });
    // Only spaces is the same as leaving it out.
    expect(asking("  ")).toMatchObject({ on: true, settings: { asking: false } });
    expect(asking("off")).toMatchObject({ on: true, settings: { asking: false } });
    expect(asking("on")).toMatchObject({ on: true, settings: { asking: true } });
    // Spaces and case do not matter.
    expect(asking(" ON ")).toMatchObject({ on: true, settings: { asking: true } });
    expect(asking("Off")).toMatchObject({ on: true, settings: { asking: false } });
    // The webhook's setting is the webhook's alone.
    expect(read({ ...base, AGENT_LOOKOUT_WEBHOOK_ASKING: "on" })).toMatchObject({
      settings: { asking: false },
    });
  });

  test.each(["yes", "true", "1", "enabled", "on,off", "o n"])(
    "an AGENT_LOOKOUT_EMAIL_ASKING that is not on or off turns email off, and names the setting: %j",
    (value) => {
      const env = {
        AGENT_LOOKOUT_EMAIL_TO: TO,
        AGENT_LOOKOUT_SMTP_URL: URL_WITH_PASSWORD,
        AGENT_LOOKOUT_EMAIL_ASKING: value,
      };
      expect(problemOf(read(env))).toBe("AGENT_LOOKOUT_EMAIL_ASKING must be on or off.");
      expect(emailProblemLine(problemOf(read(env)) as string)).toBe(
        "Email notifications are off: AGENT_LOOKOUT_EMAIL_ASKING must be on or off.",
      );
    },
  );

  test("smtps:// is TLS from the start, and smtp:// must be upgraded with STARTTLS, on the usual ports", () => {
    const server = (url: string) => {
      const setup = read({ AGENT_LOOKOUT_EMAIL_TO: TO, AGENT_LOOKOUT_SMTP_URL: url });
      return setup.on ? setup.settings.server : null;
    };
    expect(server("smtps://smtp.example.com")).toEqual({
      host: "smtp.example.com",
      port: 465,
      security: "tls",
      auth: null,
    });
    expect(server("smtp://name:secret@SMTP.Example.com")).toEqual({
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      auth: { user: "name", pass: "secret" },
    });
    expect(server("smtp://smtp.example.com:2525")?.port).toBe(2525);
  });

  test("a plain connection is allowed only to a relay on this machine", () => {
    const security = (url: string) => {
      const setup = read({ AGENT_LOOKOUT_EMAIL_TO: TO, AGENT_LOOKOUT_SMTP_URL: url });
      return setup.on ? setup.settings.server.security : null;
    };
    expect(security("smtp://127.0.0.1:2525")).toBe("plain");
    expect(security("smtp://localhost:2525")).toBe("plain");
    expect(security("smtp://LOCALHOST:2525")).toBe("plain");
    // Anywhere else, STARTTLS is required, even on this machine's other names.
    expect(security("smtp://127.0.0.2:2525")).toBe("starttls");
    expect(security("smtp://[::1]:2525")).toBe("starttls");
    expect(security("smtp://localhost.example.com:2525")).toBe("starttls");
    expect(security("smtps://127.0.0.1:465")).toBe("tls");
  });

  test("an address with a path, a query or a fragment cannot be read, so nothing after the port can change a check", () => {
    for (const url of [
      "smtp://smtp.example.com/path?ignoreTLS=true&secure=false",
      "smtp://smtp.example.com?secure=false",
      "smtp://smtp.example.com:587/",
      "smtps://smtp.example.com#more",
    ]) {
      const setup = read({ AGENT_LOOKOUT_EMAIL_TO: TO, AGENT_LOOKOUT_SMTP_URL: url });
      if (url === "smtp://smtp.example.com:587/") {
        expect(setup).toMatchObject({ on: true });
      } else {
        expect(problemOf(setup), url).toBe(URL_UNREADABLE);
      }
    }
  });

  test("without an address email is off with nothing to say, whatever else is still set: that is how it is turned off", () => {
    for (const env of [
      { AGENT_LOOKOUT_SMTP_URL: URL_WITH_PASSWORD } as Record<string, string>,
      { AGENT_LOOKOUT_SMTP_URL: URL_WITH_PASSWORD, AGENT_LOOKOUT_EMAIL_AFTER: "30" },
      { AGENT_LOOKOUT_EMAIL_FROM: TO },
      { AGENT_LOOKOUT_EMAIL_AFTER: "not a number" },
    ]) {
      expect(read(env)).toEqual({ on: false, problem: null });
    }
  });

  test("an address without a mail server is off, and says what is missing", () => {
    expect(read({ AGENT_LOOKOUT_EMAIL_TO: TO })).toEqual({
      on: false,
      problem: "AGENT_LOOKOUT_SMTP_URL is not set.",
    });
  });

  test.each([
    "two@example.com, three@example.com",
    "two@example.com;three@example.com",
    "Someone <someone@example.com>",
    '"quoted"@example.com',
    "someone@example.com\r\nBcc: other@example.test",
    "someone@example.com\nBcc: other@example.test",
    "someone",
    "someone@localhost",
    "someone@example..com",
    "some one@example.com",
    `${"a".repeat(250)}@example.com`,
  ])("an address that is not one address turns email off: %j", (to) => {
    const env = { AGENT_LOOKOUT_EMAIL_TO: to, AGENT_LOOKOUT_SMTP_URL: "smtps://smtp.example.com" };
    expect(problemOf(read(env))).toBe(
      "AGENT_LOOKOUT_EMAIL_TO must be one email address, such as you@example.com.",
    );
    const from = { AGENT_LOOKOUT_EMAIL_TO: TO, AGENT_LOOKOUT_EMAIL_FROM: to };
    expect(problemOf(read({ ...from, AGENT_LOOKOUT_SMTP_URL: "smtps://smtp.example.com" }))).toBe(
      "AGENT_LOOKOUT_EMAIL_FROM must be one email address, such as you@example.com.",
    );
  });

  test.each(["-1", "1.5", "sixty", "1e3", "86401", "9999999"])(
    "a delay that is not a whole number of seconds up to a day turns email off: %j",
    (after) => {
      const env = {
        AGENT_LOOKOUT_EMAIL_TO: TO,
        AGENT_LOOKOUT_SMTP_URL: "smtps://smtp.example.com",
        AGENT_LOOKOUT_EMAIL_AFTER: after,
      };
      expect(problemOf(read(env))).toBe(
        "AGENT_LOOKOUT_EMAIL_AFTER must be a whole number of seconds from 0 to 86400, such as 60.",
      );
    },
  );

  test.each([
    ["https://smtp.example.com", "AGENT_LOOKOUT_SMTP_URL must begin with smtps:// or smtp://."],
    ["smtp.example.com:465", "AGENT_LOOKOUT_SMTP_URL must begin with smtps:// or smtp://."],
    [`smtps://name:${PASSWORD}@smtp.example.com`, URL_UNREADABLE],
    ["smtps://name:bad%zzescape@smtp.example.com", URL_UNREADABLE],
    // A password that begins with digits, with a #, ? or / left unescaped, would
    // otherwise be read as the server "apikey" on port 1234.
    ["smtps://apikey:1234#Secret@smtp.example.com:465", URL_UNREADABLE],
    ["smtps://apikey:1234?Secret@smtp.example.com:465", URL_UNREADABLE],
    ["smtps://apikey:1234/Secret@smtp.example.com:465", URL_UNREADABLE],
    ["smtps://name%40example.com:ab?cd@smtp.example.com:465", URL_UNREADABLE],
    ["smtps://name%40example.com:100%@smtp.example.com:465", URL_UNREADABLE],
    ["smtps://:secret@smtp.example.com", "AGENT_LOOKOUT_SMTP_URL has a password but no user name."],
    [
      "smtps://smtp_example!.com",
      "AGENT_LOOKOUT_SMTP_URL does not name a mail server after the @.",
    ],
    [
      "smtps://smtp.example.com:0",
      "AGENT_LOOKOUT_SMTP_URL has a port that is not a number from 1 to 65535.",
    ],
  ])("a mail server address that cannot be used turns email off: %s", (url, problem) => {
    expect(problemOf(read({ AGENT_LOOKOUT_EMAIL_TO: TO, AGENT_LOOKOUT_SMTP_URL: url }))).toBe(
      problem,
    );
  });

  test("no sentence it says holds a password, a user name or a server, whatever was set", () => {
    const secrets = [PASSWORD, "s3cret-app-password", "name@example.com", "smtp.example.com"];
    const urls = [
      `smtps://name%40example.com:s3cret-app-password@smtp.example.com:99999`,
      `smtps://name%40example.com:s3cret-app-password@smtp.example.com:465 trailing`,
      `ftp://name%40example.com:s3cret-app-password@smtp.example.com`,
      `smtps://name@example.com:${PASSWORD}@smtp.example.com`,
      `smtps://:s3cret-app-password@smtp.example.com`,
      `smtps://name%40example.com:s3cret%zz@smtp.example.com`,
    ];
    for (const url of urls) {
      const envs: Record<string, string>[] = [
        { AGENT_LOOKOUT_EMAIL_TO: TO, AGENT_LOOKOUT_SMTP_URL: url },
        { AGENT_LOOKOUT_SMTP_URL: url },
        { AGENT_LOOKOUT_EMAIL_TO: "not an address", AGENT_LOOKOUT_SMTP_URL: url },
      ];
      for (const env of envs) {
        const setup = read(env);
        const said = setup.on ? "" : emailProblemLine(setup.problem ?? "");
        for (const secret of secrets) expect(said, url).not.toContain(secret);
      }
    }
  });

  test("it never throws, whatever the environment holds", () => {
    for (const value of ["\0", "%", "smtps://[", "smtps://a:b@", "@", "smtps://ü.example"]) {
      expect(() =>
        read({ AGENT_LOOKOUT_EMAIL_TO: value, AGENT_LOOKOUT_SMTP_URL: value }),
      ).not.toThrow();
      expect(() =>
        read({ AGENT_LOOKOUT_EMAIL_TO: TO, AGENT_LOOKOUT_SMTP_URL: value }),
      ).not.toThrow();
    }
  });
});

test("the line printed at start says email is off and why", () => {
  expect(emailProblemLine("AGENT_LOOKOUT_SMTP_URL is not set.")).toBe(
    "Email notifications are off: AGENT_LOOKOUT_SMTP_URL is not set.",
  );
});

test("isOneAddress takes one plain address and nothing more", () => {
  expect(isOneAddress("someone@example.com")).toBe(true);
  expect(isOneAddress("some.one+tag@mail.example.co.uk")).toBe(true);
  expect(isOneAddress("someone@example.com,")).toBe(false);
  expect(isOneAddress("<someone@example.com>")).toBe(false);
});

test("an address is masked to its first letter and its domain", () => {
  expect(maskAddress("notify@example.com")).toBe("n…@example.com");
  expect(maskAddress("n@example.com")).toBe("n…@example.com");
});
