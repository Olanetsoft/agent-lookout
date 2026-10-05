import { describe, expect, test } from "vitest";

import { waitEmail, type EmailContent } from "@collector/email/emailMessage";
import { readEmailSetup, type EmailSettings } from "@collector/email/emailSettings";
import { createSmtpSender } from "@collector/email/smtpSender";
import { makeSession } from "@tests/fixtures/session";
import {
  decodedHeader,
  headersOf,
  headerValues,
  startSmtpServer,
  textOf,
} from "@tests/support/node/smtp";

const TO = "notify@example.test";
/** A password with every character a URL has to escape, and some it does not. */
const CREDENTIALS = { user: "name@example.test", pass: "p@ss:w/rd#?%&+= ü" };

/** The settings the collector reads from an environment that names this server. */
function settingsFor(url: string, more: Record<string, string> = {}): EmailSettings {
  const setup = readEmailSetup({
    AGENT_LOOKOUT_EMAIL_TO: TO,
    AGENT_LOOKOUT_SMTP_URL: url,
    ...more,
  });
  if (!setup.on) throw new Error(`Email is off: ${setup.problem}`);
  return setup.settings;
}

const BEGUN = new Date(2026, 9, 5, 14, 1, 5).getTime();

function emailFor(name: string): EmailContent {
  return waitEmail({
    session: makeSession({
      name,
      project: name,
      surface: "terminal",
      status: "needs-you",
      waitingReason: "question",
    }),
    agent: "Claude Code",
    begunAt: BEGUN,
    now: BEGUN + 90_000,
  });
}

/** The headers a sent email has, and no others. */
const HEADERS = [
  "Content-Transfer-Encoding",
  "Content-Type",
  "Date",
  "From",
  "MIME-Version",
  "Message-ID",
  "Subject",
  "To",
];

describe("createSmtpSender", () => {
  test("hands the mail server one plain-text email, signed in with a password full of special characters", async () => {
    const server = await startSmtpServer({ auth: CREDENTIALS });
    const sender = createSmtpSender(settingsFor(server.url(CREDENTIALS)));

    expect(await sender.send(emailFor("checkout-flow"))).toEqual({ sent: true });

    expect(server.received).toHaveLength(1);
    const [email] = server.received;
    expect(email?.auth).toEqual(CREDENTIALS);
    expect(email?.from).toBe(TO);
    expect(email?.to).toEqual([TO]);
    // It greets the server without giving this computer's name.
    expect(email?.greeting).toBe("[127.0.0.1]");

    const data = email?.data ?? "";
    expect(
      headersOf(data)
        .map(([name]) => name)
        .sort(),
    ).toEqual(HEADERS);
    expect(headerValues(data, "From")).toEqual([`Agent Lookout <${TO}>`]);
    expect(headerValues(data, "To")).toEqual([TO]);
    expect(headerValues(data, "Subject")).toEqual(["checkout-flow asked you a question"]);
    expect(headerValues(data, "Content-Type")).toEqual(["text/plain; charset=utf-8"]);
    expect(textOf(data)).toBe(emailFor("checkout-flow").text);
    expect(server.connections).toBe(1);
  });

  test("the sender can be another address, and the email still goes to the one address set", async () => {
    const server = await startSmtpServer();
    const sender = createSmtpSender(
      settingsFor(server.url(), { AGENT_LOOKOUT_EMAIL_FROM: "lookout@example.test" }),
    );

    expect(await sender.send(emailFor("docs-site"))).toEqual({ sent: true });
    expect(server.received[0]?.from).toBe("lookout@example.test");
    expect(server.received[0]?.to).toEqual([TO]);
    expect(headerValues(server.received[0]?.data ?? "", "From")).toEqual([
      "Agent Lookout <lookout@example.test>",
    ]);
  });

  test.each([
    "checkout-flow\r\nBcc: someone@example.test",
    "checkout-flow\nBcc: someone@example.test\n\nA body of its own",
    "checkout-flow\rCc: someone@example.test",
    'checkout-flow" <someone@example.test>, "x',
    "Bcc: someone@example.test",
    "To: someone@example.test",
    "checkout-flow\u2028Bcc: someone@example.test",
    "=?UTF-8?B?QmNjOiBzb21lb25lQGV4YW1wbGUudGVzdA==?=",
    `api-rate-limits ${"very-long-name-".repeat(40)}`,
    "café-ünïcode-名前-🚀",
  ])(
    "a session named %j adds no header and no recipient, and its subject is one line",
    async (name) => {
      const server = await startSmtpServer();
      const sender = createSmtpSender(settingsFor(server.url()));
      const content = emailFor(name);

      expect(await sender.send(content)).toEqual({ sent: true });

      const [email] = server.received;
      expect(email?.to).toEqual([TO]);
      const data = email?.data ?? "";
      expect(
        headersOf(data)
          .map(([header]) => header)
          .sort(),
      ).toEqual(HEADERS);
      expect(headerValues(data, "To")).toEqual([TO]);
      const subjects = headerValues(data, "Subject");
      expect(subjects).toHaveLength(1);
      const subject = decodedHeader(subjects[0] ?? "");
      expect(subject).toBe(content.subject);
      expect(subject).not.toMatch(/[\r\n]/);
      expect(textOf(data)).toBe(content.text);
    },
  );

  test("a wrong password is said as such, and nothing is sent", async () => {
    const server = await startSmtpServer({ auth: CREDENTIALS });
    const sender = createSmtpSender(
      settingsFor(server.url({ user: CREDENTIALS.user, pass: "not-the-password" })),
    );

    expect(await sender.send(emailFor("billing-webhooks"))).toEqual({
      sent: false,
      reason: "the mail server did not accept the user name and password",
    });
    expect(server.received).toEqual([]);
  });

  test("a server that refuses and one that never answers each come back as a reason, soon", async () => {
    const refusing = await startSmtpServer({ behaviour: "refuse" });
    expect(await createSmtpSender(settingsFor(refusing.url())).send(emailFor("x"))).toEqual({
      sent: false,
      reason: "the mail server refused the connection",
    });

    const silent = await startSmtpServer({ behaviour: "silent" });
    const started = Date.now();
    expect(
      await createSmtpSender(settingsFor(silent.url()), { timeoutMs: 300 }).send(emailFor("x")),
    ).toEqual({ sent: false, reason: "the mail server did not answer in time" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a server that keeps talking and never gets on with it is given up on, soon", async () => {
    const trickling = await startSmtpServer({ behaviour: "trickle" });
    const started = Date.now();
    expect(
      await createSmtpSender(settingsFor(trickling.url()), { timeoutMs: 300 }).send(emailFor("x")),
    ).toEqual({ sent: false, reason: "the mail server did not answer in time" });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(trickling.received).toEqual([]);
  });

  test("an address where nothing listens says nothing answered there", async () => {
    // Port 1 on this machine: nothing listens there, and connecting is refused at once.
    const sender = createSmtpSender(settingsFor("smtp://127.0.0.1:1"));
    expect(await sender.send(emailFor("x"))).toEqual({
      sent: false,
      reason: "nothing answered at the mail server's address",
    });
  });

  test("a server that does not offer STARTTLS is refused when TLS is required, before anything is sent", async () => {
    const server = await startSmtpServer();
    const plain = settingsFor(server.url());
    const sender = createSmtpSender({
      ...plain,
      server: { ...plain.server, security: "starttls" },
    });

    expect(await sender.send(emailFor("infra-terraform"))).toEqual({
      sent: false,
      reason: "the mail server offered no secure connection",
    });
    expect(server.received).toEqual([]);
  });

  test("each email opens its own connection, which is closed after it", async () => {
    const server = await startSmtpServer();
    const sender = createSmtpSender(settingsFor(server.url()));
    await sender.send(emailFor("search-indexing"));
    await sender.send(emailFor("mobile-onboarding"));
    expect(server.connections).toBe(2);
    expect(server.received.map((email) => headerValues(email.data, "Subject")[0])).toEqual([
      "search-indexing asked you a question",
      "mobile-onboarding asked you a question",
    ]);
  });
});
