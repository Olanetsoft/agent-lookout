import { describe, expect, test } from "vitest";

import {
  claudeCodeSessionId,
  resumeCommand,
  sessionResumeCommand,
  shellQuoted,
} from "@core/mapping/claudeCodeResume";
import { makeSession } from "@tests/fixtures/session";

const ID = "00000000-0000-4000-8000-000000000001";
const FOLDER = "/Users/example/code/demo";

/**
 * What a shell reads one quoted word back as, by its own rules. In a POSIX
 * shell every character inside single quotes stands for itself. Fish reads
 * two escapes there, `\'` for a quote and `\\` for a backslash. Outside the
 * quotes, in both, a backslash takes the next character as it is.
 */
function unquoted(word: string, shell: "posix" | "fish" = "posix"): string {
  let out = "";
  let quoted = false;
  for (let at = 0; at < word.length; at++) {
    const character = word[at];
    if (quoted) {
      const next = word[at + 1];
      if (shell === "fish" && character === "\\" && (next === "'" || next === "\\")) {
        out += next;
        at++;
      } else if (character === "'") quoted = false;
      else out += character;
    } else if (character === "'") {
      quoted = true;
    } else if (character === "\\") {
      at++;
      out += word[at];
    } else {
      throw new Error(`An unquoted ${character} would mean something to the shell.`);
    }
  }
  if (quoted) throw new Error("The quotes are never closed.");
  return out;
}

/** The folder a command goes to, read back as the shell reads it. */
function folderOf(command: string, shell: "posix" | "fish" = "posix"): string {
  const match = /^cd (.+) && claude --resume ([0-9a-f-]+)$/s.exec(command);
  if (!match) throw new Error(`Not a resume command: ${command}`);
  return unquoted(match[1], shell);
}

describe("resumeCommand", () => {
  test("goes to the session's folder, then resumes its conversation by its ID", () => {
    expect(resumeCommand(ID, FOLDER)).toBe(`cd '${FOLDER}' && claude --resume ${ID}`);
  });

  test("an ID in capitals is still a UUID, and is written as it was given", () => {
    const upper = ID.toUpperCase();
    expect(resumeCommand(upper, FOLDER)).toBe(`cd '${FOLDER}' && claude --resume ${upper}`);
  });

  test.each([
    ["spaces", "/Users/example/My Projects/demo app"],
    ["a single quote", "/Users/example/code/it's-mine"],
    ["several quotes in a row", "/Users/example/code/'''"],
    ["a quote at each end", "/'demo'"],
    ["a dollar sign and a variable", "/Users/example/$HOME/${PATH}/$(whoami)"],
    ["backticks", "/Users/example/`rm -rf ~`/demo"],
    ["a semicolon, an ampersand and a pipe", "/Users/example/a; b && c | d"],
    ["double quotes", '/Users/example/"quoted"/"demo"'],
    ["globs and a tilde inside", "/Users/example/*/?/[ab]/~demo"],
    ["a hash and an exclamation mark", "/Users/example/#1/!!/demo"],
    ["letters of other scripts", "/Users/example/código/デモ/проект"],
    ["an emoji", "/Users/example/code/🚀-launch"],
    ["a right-to-left script's letters", "/Users/example/code/مشروع"],
    ["a leading dash after the slash", "/-n/--help"],
  ])(
    "a folder with %s reads back exactly as it is, in sh, bash and zsh and in fish",
    (_name, folder) => {
      const command = resumeCommand(ID, folder);
      expect(command).not.toBeNull();
      expect(folderOf(command!)).toBe(folder);
      expect(folderOf(command!, "fish")).toBe(folder);
      expect(command!.endsWith(` && claude --resume ${ID}`)).toBe(true);
    },
  );

  test("each single quote is written as '\\'' and nothing else is changed", () => {
    expect(resumeCommand(ID, "/a'b")).toBe(`cd '/a'\\''b' && claude --resume ${ID}`);
    expect(resumeCommand(ID, "/$x `y`")).toBe(`cd '/$x \`y\`' && claude --resume ${ID}`);
  });

  test("the root folder is a folder like any other", () => {
    expect(resumeCommand(ID, "/")).toBe(`cd '/' && claude --resume ${ID}`);
  });

  test.each([
    ["no folder", null],
    ["a folder left out", undefined],
    ["an empty folder", ""],
    ["a relative folder", "code/demo"],
    ["a folder from the current one", "./demo"],
    ["a home folder written with a tilde", "~/code/demo"],
    ["a folder with spaces before it", "  /Users/example/code/demo"],
  ])("gives no command for %s", (_name, folder) => {
    expect(resumeCommand(ID, folder)).toBeNull();
  });

  test.each([
    ["a newline", "/Users/example/code/demo\n"],
    ["a newline in the middle", "/Users/example/code\nrm -rf ~"],
    ["a carriage return", "/Users/example/code/demo\r"],
    ["NUL", "/Users/example/code/demo\u0000"],
    ["a tab", "/Users/example/code/demo\there"],
    ["an escape sequence", "/Users/example/\u001b[201~demo"],
    ["DEL", "/Users/example/code/demo\u007f"],
    ["a C1 control", "/Users/example/code/demo\u0085"],
    ["a line separator", "/Users/example/code/demo\u2028"],
    ["a paragraph separator", "/Users/example/code/demo\u2029"],
    ["a right-to-left override", "/Users/example/code/\u202edemo"],
    ["a right-to-left isolate", "/Users/example/code/\u2067demo\u2069"],
    ["a right-to-left mark", "/Users/example/code/demo\u200f"],
    ["an Arabic letter mark", "/Users/example/code/demo\u061c"],
    ["a backslash", "/Users/example/back\\slash"],
    ["a backslash at its end", "/Users/example/code/demo\\"],
    ["a backslash before a quote", "/Users/example/a\\'b"],
    ["what fish would run after a backslash and a quote", "/Users/example/a\\'; touch pwned; #"],
  ])("gives no command for a folder holding %s", (_name, folder) => {
    expect(resumeCommand(ID, folder)).toBeNull();
  });

  test.each([
    ["an empty ID", ""],
    ["a background job's own short id", "job-0001"],
    ["a process ID", "4241"],
    ["a UUID without its dashes", ID.replaceAll("-", "")],
    ["a UUID in braces", `{${ID}}`],
    ["a UUID with a letter that is not hexadecimal", "g0000000-0000-4000-8000-000000000001"],
    ["a UUID one digit short", ID.slice(0, -1)],
    ["a UUID one digit long", `${ID}0`],
    ["a UUID with a newline after it", `${ID}\n`],
    ["a UUID with a newline before it", `\n${ID}`],
    ["a UUID with NUL after it", `${ID}\u0000`],
    ["a UUID with a command after it", `${ID}; rm -rf ~`],
    ["a UUID with a space before it", ` ${ID}`],
    ["a UUID with spaces in it", "00000000 0000 4000 8000 000000000001"],
    ["a UUID written in full-width digits", "\uff100000000-0000-4000-8000-000000000001"],
  ])("gives no command for %s", (_name, id) => {
    expect(resumeCommand(id, FOLDER)).toBeNull();
  });

  test("a backslash is refused because fish would read the quotes otherwise, and run the rest of the name", () => {
    const folder = "/Users/example/a\\'; touch pwned; #";
    // The quoting sh, bash and zsh read as the folder...
    expect(unquoted(shellQuoted(folder))).toBe(folder);
    // ...ends early in fish, leaving `; touch pwned; #` to run.
    expect(() => unquoted(shellQuoted(folder), "fish")).toThrow("An unquoted ; would mean");
    expect(() => unquoted(shellQuoted("/Users/example/demo\\"), "fish")).toThrow(
      "The quotes are never closed.",
    );
    expect(resumeCommand(ID, folder)).toBeNull();
  });

  test("a folder that is fine with an ID that is not gives nothing, and the other way round", () => {
    expect(resumeCommand("job-0001", FOLDER)).toBeNull();
    expect(resumeCommand(ID, "demo")).toBeNull();
  });
});

describe("shellQuoted", () => {
  test.each(["", "plain", "it's", "''", "a b\tc", "$(x)", "\\"])(
    "%j reads back as itself",
    (text) => {
      expect(unquoted(shellQuoted(text))).toBe(text);
    },
  );
});

describe("claudeCodeSessionId", () => {
  test("is the ID after the source, for a Claude Code session only", () => {
    expect(claudeCodeSessionId(makeSession({ id: `claude-code:${ID}` }))).toBe(ID);
    expect(claudeCodeSessionId(makeSession({ id: "claude-code:job-0001" }))).toBe("job-0001");
    expect(claudeCodeSessionId(makeSession({ id: `codex:${ID}`, source: "codex" }))).toBeNull();
    expect(
      claudeCodeSessionId(makeSession({ id: `claude-code:${ID}`, source: "status-files" })),
    ).toBeNull();
    expect(claudeCodeSessionId(makeSession({ id: ID }))).toBeNull();
  });
});

describe("sessionResumeCommand", () => {
  const over = (overrides: Parameters<typeof makeSession>[0] = {}) =>
    makeSession({ id: `claude-code:${ID}`, cwd: FOLDER, status: "finished", ...overrides });

  test("a Claude Code session that finished or failed, with no process left, can be resumed", () => {
    const command = `cd '${FOLDER}' && claude --resume ${ID}`;
    expect(sessionResumeCommand(over())).toBe(command);
    expect(sessionResumeCommand(over({ alive: false }))).toBe(command);
    expect(sessionResumeCommand(over({ status: "failed" }))).toBe(command);
  });

  test.each(["working", "idle", "needs-you", "unknown"] as const)(
    "a %s session cannot, its process still running",
    (status) => {
      expect(sessionResumeCommand(over({ status, alive: true, pid: 4241 }))).toBeNull();
      expect(sessionResumeCommand(over({ status }))).toBeNull();
    },
  );

  test("a finished session whose process is still running cannot, since that would start a second copy", () => {
    expect(sessionResumeCommand(over({ alive: true, pid: 4241 }))).toBeNull();
  });

  test("a session whose process Agent Lookout saw end can, whatever it last said", () => {
    const command = `cd '${FOLDER}' && claude --resume ${ID}`;
    expect(sessionResumeCommand(over({ status: "idle", alive: true }), true)).toBe(command);
    expect(sessionResumeCommand(over({ status: "finished" }), false)).toBeNull();
  });

  test("a session on another machine never can, since the command would run on this computer", () => {
    expect(sessionResumeCommand(over({ machine: "devbox" }), true)).toBeNull();
    expect(
      sessionResumeCommand(
        over({ id: `remote:devbox:claude-code:${ID}`, source: "remote:devbox", machine: "devbox" }),
        true,
      ),
    ).toBeNull();
  });

  test("a Codex session and a session from a status file never can", () => {
    expect(sessionResumeCommand(over({ id: `codex:${ID}`, source: "codex" }), true)).toBeNull();
    expect(
      sessionResumeCommand(over({ id: `status-files:${ID}`, source: "status-files" }), true),
    ).toBeNull();
  });

  test("a session with no UUID, or no folder that can be given, cannot", () => {
    expect(sessionResumeCommand(over({ id: "claude-code:job-0001" }))).toBeNull();
    expect(sessionResumeCommand(over({ id: "claude-code:4241" }))).toBeNull();
    expect(sessionResumeCommand(over({ cwd: null }))).toBeNull();
    expect(sessionResumeCommand(over({ cwd: "~/code/demo" }))).toBeNull();
    expect(sessionResumeCommand(over({ cwd: "/Users/example/code\ndemo" }))).toBeNull();
  });
});
