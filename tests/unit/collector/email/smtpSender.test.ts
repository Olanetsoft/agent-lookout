import { describe, expect, test } from "vitest";

import type { EmailSettings, MailServer } from "@collector/email/emailSettings";
import {
  failureReason,
  GREETING_NAME,
  MAIL_TIMEOUT_MS,
  subjectOnTheWire,
  transportOptions,
} from "@collector/email/smtpSender";

function settings(server: Partial<MailServer>): EmailSettings {
  return {
    to: "notify@example.com",
    from: "notify@example.com",
    events: ["needs-you"],
    afterMs: 60_000,
    asking: false,
    server: { host: "smtp.example.com", port: 465, security: "tls", auth: null, ...server },
  };
}

describe("transportOptions", () => {
  test("smtps:// is TLS from the first byte, with the user name and password, and short waits", () => {
    expect(
      transportOptions(settings({ auth: { user: "name@example.com", pass: "p@ss:w/rd#" } })),
    ).toEqual({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      requireTLS: false,
      ignoreTLS: false,
      auth: { user: "name@example.com", pass: "p@ss:w/rd#" },
      name: GREETING_NAME,
      connectionTimeout: MAIL_TIMEOUT_MS,
      greetingTimeout: MAIL_TIMEOUT_MS,
      socketTimeout: MAIL_TIMEOUT_MS,
      dnsTimeout: MAIL_TIMEOUT_MS,
      logger: false,
      debug: false,
    });
  });

  test("smtp:// must be upgraded with STARTTLS, so a server that cannot is refused", () => {
    const options = transportOptions(settings({ port: 587, security: "starttls" }));
    expect(options).toMatchObject({ secure: false, requireTLS: true, ignoreTLS: false });
  });

  test("only a relay on this machine is reached without TLS", () => {
    const options = transportOptions(
      settings({ host: "127.0.0.1", port: 2525, security: "plain" }),
    );
    expect(options).toMatchObject({ secure: false, requireTLS: false, ignoreTLS: true });
  });

  test("a certificate is never left unchecked, nothing is logged, and this computer's name is not given", () => {
    for (const security of ["tls", "starttls", "plain"] as const) {
      const options = transportOptions(settings({ security }));
      expect(options).not.toHaveProperty("tls");
      expect(options.logger).toBe(false);
      expect(options.debug).toBe(false);
      expect(options.name).toBe("[127.0.0.1]");
      expect(options).not.toHaveProperty("auth");
    }
  });

  test("the waits can be shortened", () => {
    expect(transportOptions(settings({}), 500)).toMatchObject({
      connectionTimeout: 500,
      greetingTimeout: 500,
      socketTimeout: 500,
      dnsTimeout: 500,
    });
  });
});

describe("failureReason", () => {
  const error = (code: string, more: Record<string, unknown> = {}) =>
    Object.assign(new Error(`Server said: 535 for name@example.com with s3cret`), {
      code,
      ...more,
    });

  test.each([
    ["EAUTH", "the mail server did not accept the user name and password"],
    ["ENOAUTH", "the mail server did not accept the user name and password"],
    ["ETIMEDOUT", "the mail server did not answer in time"],
    ["EDNS", "the mail server's name could not be found"],
    ["ETLS", "the mail server offered no secure connection"],
    ["EENVELOPE", "the mail server refused the email"],
    ["EMESSAGE", "the mail server refused the email"],
    ["ECONNECTION", "the connection to the mail server failed"],
    ["EPROTOCOL", "the mail server's answer could not be understood"],
    ["ESOMETHINGNEW", "the email could not be sent"],
  ])("%s is said as %j", (code, reason) => {
    expect(failureReason(error(code))).toBe(reason);
  });

  test("a refusal at the greeting is said as a refusal", () => {
    expect(failureReason(error("EPROTOCOL", { responseCode: 554 }))).toBe(
      "the mail server refused the connection",
    );
    expect(failureReason(error("EPROTOCOL", { responseCode: 421 }))).toBe(
      "the mail server refused the connection",
    );
    expect(failureReason(error("EPROTOCOL", { responseCode: 250 }))).toBe(
      "the mail server's answer could not be understood",
    );
  });

  test("a refused connection says nothing answered there", () => {
    expect(failureReason(error("ESOCKET", { errno: -61 }))).toBe(
      "nothing answered at the mail server's address",
    );
    expect(failureReason(error("ESOCKET", { errno: "ECONNREFUSED" }))).toBe(
      "nothing answered at the mail server's address",
    );
  });

  test("is never the library's own message, which can repeat what the server said", () => {
    for (const code of ["EAUTH", "EENVELOPE", "EPROTOCOL", "OTHER"]) {
      const reason = failureReason(error(code));
      expect(reason).not.toContain("name@example.com");
      expect(reason).not.toContain("s3cret");
    }
    expect(failureReason(null)).toBe("the email could not be sent");
    expect(failureReason("a string")).toBe("the email could not be sent");
  });
});

describe("subjectOnTheWire", () => {
  /** What a mail program shows for a subject of encoded words. */
  const shown = (wire: string) =>
    wire
      .split(" ")
      .map((word) => Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(word)?.[1] ?? "", "base64"))
      .map((bytes) => bytes.toString("utf8"))
      .join("");

  test("a subject is passed on as it is", () => {
    expect(subjectOnTheWire("checkout-flow is waiting for permission")).toBe(
      "checkout-flow is waiting for permission",
    );
    expect(subjectOnTheWire("café-名前 asked you a question")).toBe(
      "café-名前 asked you a question",
    );
  });

  test("a subject that holds text written as an encoded word is encoded whole, so it shows as written", () => {
    const subject = "=?UTF-8?B?QmNjOiBzb21lb25lQGV4YW1wbGUudGVzdA==?= is waiting for you";
    const wire = subjectOnTheWire(subject);
    expect(wire).toMatch(/^(=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=)( =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=)*$/);
    expect(shown(wire)).toBe(subject);
  });

  test("each encoded word stays under 76 characters, and no letter is split between two", () => {
    const subject = `=?${"名前-🚀-".repeat(30)} is waiting for you`;
    const wire = subjectOnTheWire(subject);
    for (const word of wire.split(" ")) expect(word.length).toBeLessThan(76);
    expect(shown(wire)).toBe(subject);
  });
});
