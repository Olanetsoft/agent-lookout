// A type-only import, which is gone before the code runs. The library itself
// is loaded by `createSmtpSender`, and only when email has been set up.
import type { SMTPTransportOptions } from "nodemailer";

import type { EmailContent } from "./emailMessage.ts";
import type { EmailSettings } from "./emailSettings.ts";

/** How one email went: sent, or not sent, with a short reason in plain words. */
export type SendOutcome = { sent: true } | { sent: false; reason: string };

/**
 * The one seam between the collector and a mail server. `send` never rejects:
 * whatever goes wrong comes back as an outcome. Tests pass one that sends
 * nothing.
 */
export interface EmailSender {
  send(content: EmailContent): Promise<SendOutcome>;
}

export type CreateEmailSender = (settings: EmailSettings) => EmailSender;

/**
 * How long each step with the mail server may take: connecting, its greeting,
 * finding its address, and any silence after that. A server that does not
 * answer costs one email this long, and never holds up a poll.
 */
export const MAIL_TIMEOUT_MS = 10_000;

/**
 * How many steps' time one email may take in all. The library's own limits
 * count only silence, so a server that keeps sending lines and never gets on
 * with it would otherwise hold every later email back for good.
 */
const MAIL_DEADLINE_STEPS = 3;

/**
 * The name the collector gives itself when it greets the mail server. Left to
 * the library, it is this computer's name. This is the stand-in the library
 * itself uses when it has no name to give, and mail servers take it.
 */
export const GREETING_NAME = "[127.0.0.1]";

/**
 * What the mail library is told. TLS is required except to a relay on this
 * machine, a certificate is always checked, the library writes no log, and
 * every wait is short.
 */
export function transportOptions(
  settings: EmailSettings,
  timeoutMs = MAIL_TIMEOUT_MS,
): SMTPTransportOptions {
  const { host, port, security, auth } = settings.server;
  return {
    host,
    port,
    secure: security === "tls",
    requireTLS: security === "starttls",
    ignoreTLS: security === "plain",
    ...(auth ? { auth: { user: auth.user, pass: auth.pass } } : {}),
    name: GREETING_NAME,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    dnsTimeout: timeoutMs,
    logger: false,
    debug: false,
  };
}

/**
 * Why an email was not sent, in a few words the dashboard can show. It is
 * chosen from the error's code alone. The library's own message can repeat
 * what the server said, and the dashboard is never shown that.
 */
export function failureReason(error: unknown): string {
  const { code, errno } = (error ?? {}) as { code?: unknown; errno?: unknown };
  switch (code) {
    case "EAUTH":
    case "ENOAUTH":
      return "the mail server did not accept the user name and password";
    case "ETIMEDOUT":
      return "the mail server did not answer in time";
    case "EDNS":
      return "the mail server's name could not be found";
    case "ETLS":
    case "EREQUIRETLS":
      return "the mail server offered no secure connection";
    case "EENVELOPE":
    case "EMESSAGE":
      return "the mail server refused the email";
    case "ECONNECTION":
    case "ESOCKET":
      if (errno === "ECONNREFUSED" || errno === -61 || errno === -111) {
        return "nothing answered at the mail server's address";
      }
      return "the connection to the mail server failed";
    case "EPROTOCOL": {
      // A refusal at the greeting, such as 554 from a server that blocks this
      // address, comes back here with the code the server gave.
      const { responseCode } = error as { responseCode?: unknown };
      return typeof responseCode === "number" && responseCode >= 400
        ? "the mail server refused the connection"
        : "the mail server's answer could not be understood";
    }
    default:
      return "the email could not be sent";
  }
}

/** The most bytes of text in one encoded word, which keeps each word under 76 characters. */
const ENCODED_WORD_BYTES = 45;

/**
 * The subject as it goes to the mail server. A mail program decodes text
 * written as an encoded word, `=?UTF-8?B?...?=`, and would show a session
 * named that way as something else. The library leaves such text as it is, so
 * a subject with `=?` in it is sent encoded as a whole, and shows as written.
 */
export function subjectOnTheWire(subject: string): string {
  if (!subject.includes("=?")) return subject;
  const words: string[] = [];
  let word = "";
  for (const character of subject) {
    if (Buffer.byteLength(word + character) > ENCODED_WORD_BYTES) {
      words.push(word);
      word = "";
    }
    word += character;
  }
  if (word !== "") words.push(word);
  return words.map((text) => `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`).join(" ");
}

/** The part of the library this file uses. */
interface Mailer {
  sendMail(message: {
    from: { name: string; address: string };
    to: string;
    subject: string;
    text: string;
  }): Promise<unknown>;
}

/**
 * Sends email through the mail server in the settings. The mail library is
 * loaded on the first email, so a collector with email off never loads it. A
 * connection is opened for each email and closed after it.
 *
 * An email that has not gone within its deadline counts as not sent, and the
 * next one may go. The library gives no way to close that connection from
 * here, so it is left to end when the server stops or falls silent.
 */
export function createSmtpSender(
  settings: EmailSettings,
  options: { timeoutMs?: number } = {},
): EmailSender {
  const timeoutMs = options.timeoutMs ?? MAIL_TIMEOUT_MS;
  let mailer: Promise<Mailer> | null = null;
  const load = (): Promise<Mailer> => {
    mailer ??= import("nodemailer").then(({ default: nodemailer }) =>
      nodemailer.createTransport(transportOptions(settings, timeoutMs)),
    );
    return mailer;
  };

  return {
    async send(content) {
      let loaded: Mailer;
      try {
        loaded = await load();
      } catch {
        return { sent: false, reason: "the mail library could not be loaded" };
      }
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<SendOutcome>((resolve) => {
        timer = setTimeout(
          () => resolve({ sent: false, reason: failureReason({ code: "ETIMEDOUT" }) }),
          MAIL_DEADLINE_STEPS * timeoutMs,
        );
      });
      const sending = loaded
        .sendMail({
          from: { name: "Agent Lookout", address: settings.from },
          to: settings.to,
          subject: subjectOnTheWire(content.subject),
          text: content.text,
        })
        .then(
          (): SendOutcome => ({ sent: true }),
          (error: unknown): SendOutcome => ({ sent: false, reason: failureReason(error) }),
        );
      try {
        return await Promise.race([sending, deadline]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
