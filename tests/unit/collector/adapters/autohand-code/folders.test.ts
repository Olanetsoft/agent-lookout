import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  autohandHomeFor,
  autohandHomeOf,
  isHeartbeatName,
  isSessionFolderName,
  isTrusted,
  nameIsSessions,
} from "@collector/adapters/autohand-code/folders";
import type { FileInfo } from "@collector/files/readOnlyIo";
import { INSTANCE_ID, SESSION_ID } from "@tests/fixtures/autohand-code/autohandCode";

const HOME = "/Users/example";

describe("the folder read", () => {
  test("is Agent Lookout's own setting first, then AUTOHAND_HOME, then ~/.autohand", () => {
    expect(
      autohandHomeOf(
        { AGENT_LOOKOUT_AUTOHAND_HOME: " /Users/example/lookout ", AUTOHAND_HOME: "/data" },
        HOME,
        "darwin",
      ),
    ).toEqual({ home: path.resolve("/Users/example/lookout"), from: "agent-lookout" });
    expect(autohandHomeOf({ AUTOHAND_HOME: " /data/autohand " }, HOME, "linux")).toEqual({
      home: path.resolve("/data/autohand"),
      from: "autohand",
    });
    expect(autohandHomeOf({}, HOME, "darwin")).toEqual({
      home: path.join(HOME, ".autohand"),
      from: "default",
    });
  });

  test("passes over an empty setting, and a relative AUTOHAND_HOME, which Autohand Code reads from its own folder", () => {
    for (const value of ["", "   ", "relative/autohand", "~/autohand", "~", "./autohand"]) {
      expect(autohandHomeFor({ AUTOHAND_HOME: value }, HOME, "darwin"), value).toBe(
        path.join(HOME, ".autohand"),
      );
    }
    expect(autohandHomeFor({ AGENT_LOOKOUT_AUTOHAND_HOME: "  " }, HOME, "darwin")).toBe(
      path.join(HOME, ".autohand"),
    );
    // Agent Lookout's own is taken from where it runs, as every such setting is.
    expect(
      autohandHomeFor({ AGENT_LOOKOUT_AUTOHAND_HOME: "relative/lookout" }, HOME, "darwin"),
    ).toBe(path.resolve("relative/lookout"));
  });

  test("on Windows passes over the Windows folder and anything in it, as Autohand Code does", () => {
    for (const value of [
      "C:\\Windows",
      "c:\\windows\\System32\\config\\systemprofile",
      "C:/Windows/x",
      "\\Windows\\x",
      "D:\\WINDOWS",
    ]) {
      expect(
        autohandHomeOf({ AUTOHAND_HOME: value }, "C:\\Users\\example", "win32"),
        value,
      ).toEqual({ home: path.join("C:\\Users\\example", ".autohand"), from: "default" });
    }
    for (const value of ["D:\\a", "C:\\Windows-old\\a", "C:\\Users\\example\\windows"]) {
      expect(
        autohandHomeOf({ AUTOHAND_HOME: value }, "C:\\Users\\example", "win32"),
        value,
      ).toEqual({ home: path.resolve(value), from: "autohand" });
    }
    // A drive with no folder after it is not a whole path.
    expect(autohandHomeOf({ AUTOHAND_HOME: "D:a" }, "C:\\Users\\example", "win32").from).toBe(
      "default",
    );
    // Elsewhere a folder named so is anyone's.
    expect(autohandHomeOf({ AUTOHAND_HOME: "/windows" }, HOME, "linux").from).toBe("autohand");
  });
});

describe("names", () => {
  test("a heartbeat's name ends .json and starts with no dot", () => {
    expect(isHeartbeatName(`${SESSION_ID}.json`)).toBe(true);
    expect(isHeartbeatName(`${SESSION_ID}.${INSTANCE_ID}.json`)).toBe(true);
    for (const name of [
      `.${SESSION_ID}.json.4242.0b5d6c1e.tmp`,
      `.${SESSION_ID}.json.4242.0b5d6c1e.tombstone`,
      `${SESSION_ID}.json.lock`,
      `${SESSION_ID}.json.lock.reaper`,
      ".json",
      "a b.json",
      `${"a".repeat(252)}.json`,
    ]) {
      expect(isHeartbeatName(name), name).toBe(false);
    }
  });

  test("a heartbeat's name must be its own session's", () => {
    expect(nameIsSessions(`${SESSION_ID}.json`, SESSION_ID)).toBe(true);
    expect(nameIsSessions(`${SESSION_ID}.${INSTANCE_ID}.json`, SESSION_ID)).toBe(true);
    expect(nameIsSessions(`${SESSION_ID}.json`, "other")).toBe(false);
    expect(nameIsSessions(`${SESSION_ID}.a.b.json`, SESSION_ID)).toBe(false);
    expect(nameIsSessions(`${SESSION_ID}..json`, SESSION_ID)).toBe(false);
    expect(nameIsSessions(`${SESSION_ID}.${"a".repeat(129)}.json`, SESSION_ID)).toBe(false);
    expect(nameIsSessions(`${SESSION_ID}x.json`, SESSION_ID)).toBe(false);
  });

  test("a session's folder has no dot, so index.json, its lock and copies and a transfer's folder are passed over", () => {
    expect(isSessionFolderName(SESSION_ID)).toBe(true);
    for (const name of [
      "index.json",
      "index.json.lock",
      ".index.json.4242.0b5d.tmp",
      "index.json.corrupt-1762776000000-0b5d",
      "index.0b5d6c1e.tmp",
      `${SESSION_ID}.import-a1b2c3`,
      "-leading-dash",
      "",
      "a".repeat(201),
    ]) {
      expect(isSessionFolderName(name), name).toBe(false);
    }
  });
});

describe("what is read", () => {
  const file = (info: Partial<FileInfo> = {}): FileInfo => ({
    kind: "file",
    size: 10,
    mtimeMs: 0,
    ino: 1,
    uid: 501,
    mode: 0o100600,
    nlink: 1,
    ...info,
  });
  const folder = (info: Partial<FileInfo> = {}) =>
    file({ kind: "directory", mode: 0o40700, ...info });

  test("on macOS and Linux, only what is the user's own, as Autohand Code requires", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(isTrusted(file(), "heartbeat", platform, 501)).toBe(true);
      expect(isTrusted(file({ uid: 502 }), "heartbeat", platform, 501)).toBe(false);
      expect(isTrusted(file({ mode: 0o100644 }), "heartbeat", platform, 501)).toBe(false);
      expect(isTrusted(file({ mode: 0o100610 }), "heartbeat", platform, 501)).toBe(false);
      expect(isTrusted(file({ mode: 0o100601 }), "heartbeat", platform, 501)).toBe(false);
      expect(isTrusted(file({ mode: undefined }), "heartbeat", platform, 501)).toBe(false);
      // A metadata.json Autohand Code imported is written readable by others.
      expect(isTrusted(file({ mode: 0o100644 }), "metadata", platform, 501)).toBe(true);
      expect(isTrusted(file({ uid: 502 }), "metadata", platform, 501)).toBe(false);
      expect(isTrusted(folder(), "heartbeats-folder", platform, 501)).toBe(true);
      expect(isTrusted(folder({ uid: 0 }), "heartbeats-folder", platform, 501)).toBe(false);
      expect(isTrusted(folder({ uid: 502 }), "session-folder", platform, 501)).toBe(false);
      expect(isTrusted(file({ uid: undefined }), "metadata", platform, 501)).toBe(false);
      expect(isTrusted(file(), "metadata", platform, null)).toBe(false);
    }
  });

  test("on every system, never a link, nor a file with a second name", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      for (const what of ["heartbeat", "metadata"] as const) {
        expect(isTrusted(file({ nlink: 2 }), what, platform, 501), what).toBe(false);
        expect(isTrusted(file({ nlink: undefined }), what, platform, 501), what).toBe(false);
        expect(isTrusted(file({ kind: "other" }), what, platform, 501), what).toBe(false);
        expect(isTrusted(folder(), what, platform, 501), what).toBe(false);
      }
      for (const what of ["heartbeats-folder", "session-folder"] as const) {
        expect(isTrusted(file(), what, platform, 501), what).toBe(false);
        expect(isTrusted(folder({ kind: "other" }), what, platform, 501), what).toBe(false);
      }
    }
  });

  test("on Windows, the owner and the permission bits are not asked", () => {
    expect(isTrusted(file({ uid: 0, mode: 0o100666 }), "heartbeat", "win32", null)).toBe(true);
    expect(isTrusted(folder({ uid: 0 }), "heartbeats-folder", "win32", null)).toBe(true);
  });
});
