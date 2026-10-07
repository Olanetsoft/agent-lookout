// A mail server for integration tests, on a free port of 127.0.0.1. It speaks
// just enough SMTP for the collector's mail library to hand it an email, and
// writes down everything it was given. Nothing it receives goes any further.
// It can also turn every email away, or say nothing at all, and it can speak
// TLS from the first byte, as an smtps:// server does.

import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { createServer as createTlsServer } from "node:tls";

import { onTestFinished } from "vitest";

/** One email as the server received it. */
export interface ReceivedEmail {
  /** The address after MAIL FROM. */
  from: string;
  /** Every address after RCPT TO, in order. */
  to: string[];
  /** The message as sent, headers and body, with the dot-stuffing undone. */
  data: string;
  /** The user name and password it signed in with, if it did. */
  auth: { user: string; pass: string } | null;
  /** The name it greeted the server with. */
  greeting: string;
}

/**
 * accept   takes every email, from a client that signs in with `auth` when one is given
 * refuse   greets every connection with a refusal and closes it
 * silent   accepts the connection and never says a word
 * trickle  greets, then answers EHLO with a line that says more is coming,
 *          and another every 100 ms, for ever, so the client is never silent
 *          long enough to time out
 */
export type SmtpBehaviour = "accept" | "refuse" | "silent" | "trickle";

export interface TestSmtpServer {
  port: number;
  /** The connections opened to it so far. */
  connections: number;
  received: ReceivedEmail[];
  /** Its address for `AGENT_LOOKOUT_SMTP_URL`, with the user name and password written in when given. */
  url(credentials?: { user: string; pass: string }): string;
}

const decode = (base64: string) => Buffer.from(base64, "base64").toString("utf8");

/** The address inside `MAIL FROM:<...>` or `RCPT TO:<...>`. */
function addressIn(line: string): string {
  return /<([^>]*)>/.exec(line)?.[1] ?? "";
}

function serve(socket: Socket, server: TestSmtpServer, auth: TestSmtpOptions["auth"]): void {
  const say = (line: string) => socket.write(`${line}\r\n`);
  let buffer = "";
  let greeting = "";
  let signedIn: ReceivedEmail["auth"] = null;
  let email: Omit<ReceivedEmail, "data"> | null = null;
  let data: string[] | null = null;
  /** What the next line answers, while a sign-in is under way. */
  let pending: ((line: string) => void) | null = null;

  const signIn = (user: string, pass: string) => {
    if (auth && (user !== auth.user || pass !== auth.pass)) {
      say("535 5.7.8 Authentication credentials invalid");
      return;
    }
    signedIn = { user, pass };
    say("235 2.7.0 Authentication successful");
  };

  const handle = (line: string) => {
    if (data) {
      if (line === ".") {
        server.received.push({
          ...(email as Omit<ReceivedEmail, "data">),
          // The line break before the dot ends the message's last line.
          data: data.map((part) => `${part}\r\n`).join(""),
        });
        data = null;
        email = null;
        say("250 2.0.0 Queued");
      } else {
        data.push(line.startsWith("..") ? line.slice(1) : line);
      }
      return;
    }
    if (pending) {
      const next = pending;
      pending = null;
      next(line);
      return;
    }

    const command = line.slice(0, 4).toUpperCase();
    if (command === "EHLO" || command === "HELO") {
      greeting = line.slice(5);
      socket.write("250-mail.example.test\r\n250-AUTH PLAIN LOGIN\r\n250 HELP\r\n");
    } else if (/^AUTH PLAIN /i.test(line)) {
      const [, user = "", pass = ""] = decode(line.slice(11)).split("\0");
      signIn(user, pass);
    } else if (/^AUTH PLAIN$/i.test(line)) {
      say("334 ");
      pending = (answer) => {
        const [, user = "", pass = ""] = decode(answer).split("\0");
        signIn(user, pass);
      };
    } else if (/^AUTH LOGIN/i.test(line)) {
      say("334 VXNlcm5hbWU6");
      pending = (user) => {
        say("334 UGFzc3dvcmQ6");
        pending = (pass) => signIn(decode(user), decode(pass));
      };
    } else if (command === "MAIL") {
      if (auth && !signedIn) {
        say("530 5.7.0 Authentication required");
        return;
      }
      email = { from: addressIn(line), to: [], auth: signedIn, greeting };
      say("250 2.1.0 OK");
    } else if (command === "RCPT") {
      email?.to.push(addressIn(line));
      say("250 2.1.5 OK");
    } else if (command === "DATA") {
      data = [];
      say("354 End data with <CR><LF>.<CR><LF>");
    } else if (command === "QUIT") {
      say("221 2.0.0 Bye");
      socket.end();
    } else if (command === "RSET" || command === "NOOP") {
      say("250 2.0.0 OK");
    } else {
      say("502 5.5.2 Not implemented");
    }
  };

  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let end = buffer.indexOf("\r\n");
    while (end >= 0) {
      handle(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\r\n");
    }
  });
  socket.on("error", () => {
    // The client went away. There is nobody to tell.
  });
  say("220 mail.example.test ESMTP ready");
}

export interface TestSmtpOptions {
  behaviour?: SmtpBehaviour;
  /** The user name and password a client must sign in with. Left out, it may send without. */
  auth?: { user: string; pass: string };
  /** A key and certificate to speak TLS with from the first byte. Its `url` is then smtps://. */
  tls?: { key: string; cert: string };
}

/** Starts the server and closes it, and every connection to it, when the test finishes. */
export async function startSmtpServer(options: TestSmtpOptions = {}): Promise<TestSmtpServer> {
  const behaviour = options.behaviour ?? "accept";
  const sockets = new Set<Socket>();
  const state: TestSmtpServer = {
    port: 0,
    connections: 0,
    received: [],
    url(credentials) {
      const login = credentials
        ? `${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.pass)}@`
        : "";
      return `${options.tls ? "smtps" : "smtp"}://${login}127.0.0.1:${state.port}`;
    },
  };

  const onConnection = (socket: Socket) => {
    state.connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (behaviour === "silent") return;
    if (behaviour === "refuse") {
      socket.end("554 5.7.1 No thanks\r\n");
      return;
    }
    if (behaviour === "trickle") {
      socket.write("220 mail.example.test ESMTP ready\r\n");
      socket.once("data", () => {
        const timer = setInterval(() => socket.write("250-still here\r\n"), 100);
        socket.on("close", () => clearInterval(timer));
      });
      socket.on("error", () => {});
      return;
    }
    serve(socket, state, options.auth);
  };
  const server: Server = options.tls
    ? createTlsServer(options.tls, onConnection)
    : createServer(onConnection);
  // A client that refuses the certificate ends the handshake. There is nobody to tell.
  server.on("tlsClientError", () => {});

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  state.port = (server.address() as AddressInfo).port;
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return state;
}

/** The headers of a received message, unfolded, as name and value in order. */
export function headersOf(data: string): [string, string][] {
  const head = data.slice(0, data.indexOf("\r\n\r\n"));
  const unfolded = head.replace(/\r\n[ \t]+/g, " ");
  return unfolded.split("\r\n").map((line) => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon), line.slice(colon + 1).trim()];
  });
}

/** Every value of one header, by name in any case. */
export function headerValues(data: string, name: string): string[] {
  return headersOf(data)
    .filter(([header]) => header.toLowerCase() === name.toLowerCase())
    .map(([, value]) => value);
}

/** Undoes quoted-printable: the soft line breaks, then each `=XX` byte. */
function fromQuotedPrintable(text: string): string {
  const flat = text.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let index = 0; index < flat.length; index += 1) {
    const hex = flat.slice(index + 1, index + 3);
    if (flat[index] === "=" && /^[0-9A-F]{2}$/i.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(...Buffer.from(flat[index] as string, "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** A header's value with its encoded words decoded, as a mail program shows it. */
export function decodedHeader(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?UTF-8\?([QB])\?([^?]*)\?=/gi, (_, kind: string, text: string) =>
      kind.toUpperCase() === "B"
        ? Buffer.from(text, "base64").toString("utf8")
        : fromQuotedPrintable(text.replace(/_/g, " ")),
    );
}

/** The text of a received message, decoded as its headers say, with plain line breaks. */
export function textOf(data: string): string {
  const body = data.slice(data.indexOf("\r\n\r\n") + 4);
  const encoding = headerValues(data, "Content-Transfer-Encoding")[0]?.toLowerCase();
  const text =
    encoding === "quoted-printable"
      ? fromQuotedPrintable(body)
      : encoding === "base64"
        ? Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8")
        : body;
  return text.replace(/\r\n/g, "\n");
}
