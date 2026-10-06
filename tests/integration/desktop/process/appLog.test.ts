import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createAppLog,
  describeError,
  LOG_FILE,
  logEntry,
  MAX_LOG_BYTES,
  OLD_LOG_FILE,
} from "@desktop/process/appLog";
import { tempDir } from "@tests/support/node/tempFiles";

const AT = Date.UTC(2026, 9, 6, 9, 30, 0);

describe("the app's log", () => {
  test("an entry is the time, then the text, with its later lines indented", () => {
    expect(logEntry("Webhook notifications are off.", AT)).toBe(
      "2026-10-06T09:30:00.000Z Webhook notifications are off.\n",
    );
    expect(logEntry("Error: no\n    at one\n    at two\n", AT)).toBe(
      "2026-10-06T09:30:00.000Z Error: no\n        at one\n        at two\n",
    );
  });

  test("an error is described with where it was thrown, and anything else as it reads", () => {
    const error = new Error("the scheme had no handler");
    expect(describeError(error)).toBe(error.stack);
    expect(describeError(error)).toContain("Error: the scheme had no handler");
    expect(describeError("a reason")).toBe("a reason");
    expect(describeError(42)).toBe("42");
  });

  test("entries are added to main.log in the folder it is given, which it makes, for the person alone", async () => {
    const dir = path.join(await tempDir(), "Logs", "Agent Lookout");
    const echoed: string[] = [];
    const log = createAppLog({ dir: () => dir, echo: (text) => echoed.push(text), now: () => AT });

    log("Email notifications are off: AGENT_LOOKOUT_EMAIL_TO is not an address.");
    log("A second line.");

    expect(await readFile(path.join(dir, LOG_FILE), "utf8")).toBe(
      "2026-10-06T09:30:00.000Z Email notifications are off: AGENT_LOOKOUT_EMAIL_TO is not an address.\n" +
        "2026-10-06T09:30:00.000Z A second line.\n",
    );
    expect((await stat(path.join(dir, LOG_FILE))).mode & 0o777).toBe(0o600);
    expect(echoed).toEqual([
      "Email notifications are off: AGENT_LOOKOUT_EMAIL_TO is not an address.",
      "A second line.",
    ]);
  });

  test("a log grown too long is moved aside, over the one before, and a new one begun", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, OLD_LOG_FILE), "the oldest\n");
    await writeFile(path.join(dir, LOG_FILE), "x".repeat(MAX_LOG_BYTES));
    const log = createAppLog({ dir: () => dir, now: () => AT });

    log("After the move.");

    expect(await readFile(path.join(dir, LOG_FILE), "utf8")).toBe(
      "2026-10-06T09:30:00.000Z After the move.\n",
    );
    expect((await stat(path.join(dir, OLD_LOG_FILE))).size).toBe(MAX_LOG_BYTES);
  });

  test("a folder that cannot be known or written drops the entry and throws nothing", async () => {
    const unknown = createAppLog({
      dir: () => {
        throw new Error("not ready");
      },
    });
    expect(() => unknown("lost")).not.toThrow();

    const file = path.join(await tempDir(), "a-file");
    await writeFile(file, "");
    const blocked = createAppLog({
      dir: () => path.join(file, "inside"),
      echo: () => {
        throw new Error("no terminal");
      },
    });
    expect(() => blocked("lost too")).not.toThrow();
  });
});
