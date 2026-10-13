import { describe, expect, test } from "vitest";

import {
  createSummariesReader,
  findSqlite,
  folderOfUris,
  readFolders,
  RETRY_MS,
  SQLITE_LOCATIONS,
  sqliteArguments,
  SUMMARIES_QUERY,
  summariesUri,
} from "@collector/adapters/antigravity/app/summaries";
import {
  APP_HOME,
  conversationId,
  NOW,
  SECOND,
  sqliteJson,
  summariesPath,
  workspaceUris,
} from "@tests/fixtures/antigravity";
import { memoryFiles, standInSqlite } from "@tests/support/adapters/antigravityAdapter";

const A = conversationId("a1");
const B = conversationId("b2");
const FOLDER = "/Users/example/code/demo-project";
const FILE = summariesPath(APP_HOME);

describe("the question sqlite3 is asked", () => {
  test("opens the file read-only, as one nothing changes, with every awkward letter of its path escaped", () => {
    expect(summariesUri(FILE)).toBe(
      "file:/Users/example/.gemini/antigravity/conversation_summaries.db?mode=ro&immutable=1",
    );
    expect(summariesUri("/Users/example/a b?c#d%e&f=g/conversation_summaries.db")).toBe(
      "file:/Users/example/a%20b%3Fc%23d%25e%26f%3Dg/conversation_summaries.db?mode=ro&immutable=1",
    );
  });

  test("reads no settings of the person's own, prints JSON, and selects two columns of one table", () => {
    expect(sqliteArguments(FILE)).toEqual([
      "-init",
      "/dev/null",
      "-batch",
      "-json",
      summariesUri(FILE),
      "SELECT conversation_id, workspace_uris FROM conversation_summaries",
    ]);
    // Never a column that holds what was written in a chat, nor the text search tables.
    expect(SUMMARIES_QUERY).not.toMatch(/\*|title|preview|raw_summary|fts/i);
  });
});

describe("folderOfUris", () => {
  test("is the first local folder named, its escapes undone", () => {
    expect(folderOfUris(workspaceUris(FOLDER))).toBe(FOLDER);
    expect(folderOfUris(workspaceUris("/Users/example/code/demo project", FOLDER))).toBe(
      "/Users/example/code/demo project",
    );
    expect(folderOfUris('["file:///Users/example/code/demo-project"]')).toBe(FOLDER);
  });

  test("passes over an address that is not a local folder, and takes the next", () => {
    expect(
      folderOfUris(
        JSON.stringify([
          "https://example.com/demo",
          "file://devbox/Users/example/code/demo",
          "file:///Users/example/code/a%2Fb",
          "file:///Users/example/code/%1Bdemo",
          `file://${FOLDER}`,
        ]),
      ),
    ).toBe(FOLDER);
  });

  test("is null for nothing, for no list, and for a list with no local folder", () => {
    for (const value of [
      "",
      "[]",
      "not json",
      '"file:///Users/example"',
      '{"uri":"file:///Users/example"}',
      "[1, null]",
      '["vscode-remote://ssh-remote+devbox/Users/example"]',
      null,
      42,
    ]) {
      expect(folderOfUris(value), String(value)).toBeNull();
    }
  });
});

describe("readFolders", () => {
  test("is each chat's folder by its id, in lower case, leaving out a chat with none", () => {
    const stdout = sqliteJson([
      { conversation_id: A, workspace_uris: workspaceUris(FOLDER) },
      { conversation_id: B.toUpperCase(), workspace_uris: workspaceUris("/Users/example/code/b") },
      { conversation_id: conversationId("c3"), workspace_uris: "" },
    ]);
    expect(readFolders(stdout)).toEqual(
      new Map([
        [A, FOLDER],
        [B, "/Users/example/code/b"],
      ]),
    );
  });

  test("passes over a row whose id is not a conversation's", () => {
    const stdout = sqliteJson([
      { conversation_id: "../../elsewhere", workspace_uris: workspaceUris(FOLDER) },
      { conversation_id: "", workspace_uris: workspaceUris(FOLDER) },
    ]);
    expect(readFolders(stdout)).toEqual(new Map());
    expect(readFolders('[null, 1, "row", {"conversation_id": 7}]')).toEqual(new Map());
  });

  test("is empty for a table with no rows, which sqlite3 prints as nothing, and null for anything else", () => {
    expect(readFolders("")).toEqual(new Map());
    expect(readFolders("\n")).toEqual(new Map());
    expect(readFolders("Error: no such table: conversation_summaries")).toBeNull();
    expect(readFolders('{"conversation_id":"x"}')).toBeNull();
  });
});

describe("findSqlite", () => {
  test("looks only at the fixed places, the system's own first, and never on PATH", async () => {
    const looked: string[] = [];
    const found = await findSqlite(async (candidate) => {
      looked.push(candidate);
      return candidate === "/opt/homebrew/bin/sqlite3";
    });
    expect(found).toBe("/opt/homebrew/bin/sqlite3");
    expect(looked).toEqual(["/usr/bin/sqlite3", "/bin/sqlite3", "/opt/homebrew/bin/sqlite3"]);
    expect(SQLITE_LOCATIONS[0]).toBe("/usr/bin/sqlite3");
    expect(await findSqlite(async () => false)).toBeNull();
  });
});

describe("createSummariesReader", () => {
  function setUp(platform: NodeJS.Platform = "darwin") {
    const files = memoryFiles(() => NOW);
    files.write(FILE, "SQLite format 3\u0000", { mtimeMs: NOW - 60 * SECOND });
    const sqlite = standInSqlite([{ conversation_id: A, workspace_uris: workspaceUris(FOLDER) }]);
    const reader = createSummariesReader({
      home: APP_HOME,
      io: files.io,
      platform,
      run: sqlite.run,
      find: sqlite.find,
    });
    return { files, sqlite, reader };
  }

  test("reads the folders once, and again only when the file's size or modified time changes", async () => {
    const { files, sqlite, reader } = setUp();
    expect(await reader.read(NOW)).toEqual({ state: "read", folders: new Map([[A, FOLDER]]) });
    expect(sqlite.runs).toEqual([{ binary: "/usr/bin/sqlite3", args: sqliteArguments(FILE) }]);

    await reader.read(NOW + 2 * SECOND);
    await reader.read(NOW + 10 * RETRY_MS);
    expect(sqlite.runs).toHaveLength(1);

    sqlite.set([
      { conversation_id: A, workspace_uris: workspaceUris(FOLDER) },
      { conversation_id: B, workspace_uris: workspaceUris("/Users/example/code/b") },
    ]);
    files.rewrite(FILE, "SQLite format 3\u0000 and more", { mtimeMs: NOW });
    expect((await reader.read(NOW + 4 * SECOND)).folders.get(B)).toBe("/Users/example/code/b");
    expect(sqlite.runs).toHaveLength(2);
    // Only ever looked at with lstat: the file is never opened by the adapter itself.
    expect(files.calls.every((call) => call.method === "lstat" && call.path === FILE)).toBe(true);
  });

  test("with no file, or something that is not an ordinary file in its place, runs nothing", async () => {
    const { files, sqlite, reader } = setUp();
    files.remove(FILE);
    expect(await reader.read(NOW)).toEqual({ state: "missing", folders: new Map() });
    files.special(FILE);
    expect(await reader.read(NOW + SECOND)).toEqual({ state: "missing", folders: new Map() });
    expect(sqlite.runs).toEqual([]);
  });

  test("with no sqlite3 to be found, says so, and looks again only a minute later, even if the file changes sooner", async () => {
    const { files, sqlite, reader } = setUp();
    sqlite.there(false);
    expect(await reader.read(NOW)).toEqual({ state: "no-sqlite", folders: new Map() });
    sqlite.there(true);
    files.rewrite(FILE, "SQLite format 3\u0000 changed", { mtimeMs: NOW });
    expect((await reader.read(NOW + RETRY_MS - SECOND)).state).toBe("no-sqlite");
    expect((await reader.read(NOW + RETRY_MS)).state).toBe("read");
    sqlite.there(false);
    files.rewrite(FILE, "SQLite format 3\u0000 changed again", { mtimeMs: NOW + RETRY_MS });
    expect((await reader.read(NOW + RETRY_MS + SECOND)).state).toBe("no-sqlite");
  });

  test("a read that fails shows no folders, and is tried again only a minute later, even if the file changes sooner", async () => {
    const { files, sqlite, reader } = setUp();
    sqlite.fail();
    expect(await reader.read(NOW)).toEqual({ state: "failed", folders: new Map() });
    sqlite.fail(false);
    await reader.read(NOW + 30 * SECOND);
    expect(sqlite.runs).toHaveLength(1);
    expect((await reader.read(NOW + RETRY_MS)).state).toBe("read");
    expect(sqlite.runs).toHaveLength(2);

    // A sqlite3 that can never read it, such as one too old to know -json, is
    // not started again on each change the app makes to the file.
    sqlite.fail();
    files.rewrite(FILE, "SQLite format 3\u0000 changed", { mtimeMs: NOW });
    expect((await reader.read(NOW + RETRY_MS + SECOND)).state).toBe("failed");
    expect(sqlite.runs).toHaveLength(3);
    for (const seconds of [3, 5, 7]) {
      const written = NOW + RETRY_MS + seconds * SECOND;
      files.rewrite(FILE, `SQLite format 3\u0000 ${seconds}`, { mtimeMs: written });
      expect((await reader.read(written)).state).toBe("failed");
    }
    expect(sqlite.runs).toHaveLength(3);
    sqlite.fail(false);
    expect((await reader.read(NOW + 2 * RETRY_MS + SECOND)).state).toBe("read");
    expect(sqlite.runs).toHaveLength(4);
  });

  test("an answer that is not sqlite3's JSON counts as a failed read", async () => {
    const files = memoryFiles(() => NOW);
    files.write(FILE, "SQLite format 3\u0000");
    const reader = createSummariesReader({
      home: APP_HOME,
      io: files.io,
      platform: "darwin",
      run: async () => ({ ok: true, stdout: "Error: file is not a database" }),
      find: async () => "/usr/bin/sqlite3",
    });
    expect(await reader.read(NOW)).toEqual({ state: "failed", folders: new Map() });
  });

  test("on Windows looks at nothing and runs nothing", async () => {
    const { files, sqlite, reader } = setUp("win32");
    expect(await reader.read(NOW)).toEqual({ state: "not-on-windows", folders: new Map() });
    expect(files.calls).toEqual([]);
    expect(sqlite.runs).toEqual([]);
  });

  test("never throws", async () => {
    const files = memoryFiles(() => NOW);
    files.write(FILE, "SQLite format 3\u0000");
    const reader = createSummariesReader({
      home: APP_HOME,
      io: files.io,
      platform: "darwin",
      run: () => {
        throw new Error("sqlite3 broke");
      },
      find: async () => "/usr/bin/sqlite3",
    });
    expect(await reader.read(NOW)).toEqual({ state: "failed", folders: new Map() });
  });
});
