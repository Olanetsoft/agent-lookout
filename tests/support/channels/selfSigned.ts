// A certificate that names itself as its own issuer, made fresh for each test
// run, so no key is kept in the repository. A client that checks certificates
// refuses it, and one that does not check takes it.

import { generateKeyPairSync, sign } from "node:crypto";

/** One DER value: its tag, its length, then its contents. */
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const length =
    body.length < 0x80
      ? [body.length]
      : body.length < 0x100
        ? [0x81, body.length]
        : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

const sequence = (...parts: Buffer[]) => der(0x30, ...parts);

/** ecdsa-with-SHA256, 1.2.840.10045.4.3.2, with no parameters. */
const ECDSA_SHA256 = sequence(
  der(0x06, Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])),
);

/** The name `CN=localhost`, for both the subject and the issuer. */
const LOCALHOST = sequence(
  der(
    0x31,
    sequence(der(0x06, Buffer.from([0x55, 0x04, 0x03])), der(0x0c, Buffer.from("localhost"))),
  ),
);

/** A time as UTCTime, `YYMMDDHHMMSSZ`. */
function utcTime(at: Date): Buffer {
  const text = at.toISOString().replace(/[-:T]/g, "").slice(2, 14);
  return der(0x17, Buffer.from(`${text}Z`));
}

/** A key and a certificate for it, in PEM, good from a day ago to a day from now. */
export function selfSignedCertificate(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const day = 24 * 60 * 60 * 1000;
  const toBeSigned = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    ECDSA_SHA256,
    LOCALHOST,
    sequence(utcTime(new Date(Date.now() - day)), utcTime(new Date(Date.now() + day))),
    LOCALHOST,
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = sign("sha256", toBeSigned, privateKey);
  const certificate = sequence(toBeSigned, ECDSA_SHA256, der(0x03, Buffer.from([0]), signature));
  const lines = certificate.toString("base64").match(/.{1,64}/g) ?? [];
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`,
  };
}
