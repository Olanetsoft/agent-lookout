import { describe, expect, test } from "vitest";

import { shownAsk } from "@collector/answers/shownAsk";
import type { PermissionAsk } from "@core/sessions/session";
import {
  denyOnlyHere,
  fixUpWindowsStyleLabel,
  MAX_MENU_LINE_CHARS,
  MAX_MENU_LINES,
  MAX_NOTICE_BYTES,
  MAX_NOTICE_COMMAND_CHARS,
  menuLabel,
  menuOffer,
  noticeOffer,
} from "@desktop/answers/answerOffer";

const REQUEST_ID = "0123456789abcdef0123456789abcdef";

/** A request as the collector holds it, made by its own rule for what is shown. */
function held(tool: string, input: Record<string, unknown>, agentId?: string): PermissionAsk {
  const shown = shownAsk(tool, input, agentId);
  if (shown === null) throw new Error(`${tool} is not a request the collector holds`);
  return { requestId: REQUEST_ID, ...shown, until: 1_700_000_300_000 };
}

const bash = (command: string, more: Record<string, unknown> = {}) =>
  held("Bash", { command, ...more });

const WAIT = { title: "checkout-flow", body: "Waiting for permission: Run: npm test" };

describe("the label macOS draws for a menu item", () => {
  test("drops a single &, draws && as one, drops (&x) whole and draws ... as an ellipsis", () => {
    expect(fixUpWindowsStyleLabel("a && b")).toBe("a & b");
    expect(fixUpWindowsStyleLabel("sleep 5 &")).toBe("sleep 5 ");
    expect(fixUpWindowsStyleLabel("File(&F)")).toBe("File");
    expect(fixUpWindowsStyleLabel("ls ...")).toBe("ls …");
    expect(fixUpWindowsStyleLabel("plain words")).toBe("plain words");
  });

  test("an & is doubled so it is drawn, and text that cannot be drawn as written has no label", () => {
    expect(menuLabel("npm test && npm run build")).toBe("npm test &&&& npm run build");
    expect(fixUpWindowsStyleLabel(menuLabel("sleep 5 &") ?? "")).toBe("sleep 5 &");
    expect(fixUpWindowsStyleLabel(menuLabel("echo (&x)") ?? "")).toBe("echo (&x)");
    expect(menuLabel("ls ...")).toBeNull();
    expect(menuLabel("echo (&)")).toBeNull();
  });
});

describe("a notification", () => {
  test("of no held request is the notice as it was, with no buttons", () => {
    expect(noticeOffer(WAIT)).toEqual({
      title: "checkout-flow",
      body: "Waiting for permission: Run: npm test",
      decisions: [],
    });
  });

  test("of a short one-line command is the whole command as its text, with Deny then Allow", () => {
    expect(noticeOffer(WAIT, bash("npm test && npm run build"))).toEqual({
      title: "checkout-flow",
      subtitle: "Asks to run",
      body: "npm test && npm run build",
      decisions: ["deny", "allow"],
    });
    expect(noticeOffer(WAIT, held("Bash", { command: "npm test" }, "agent-1")).subtitle).toBe(
      "A subagent asks to run",
    );
  });

  test.each([
    ["longer than it shows whole", "x".repeat(MAX_NOTICE_COMMAND_CHARS + 1)],
    ["of two lines", "npm test\nrm -rf build"],
    ["with a tab", "printf 'a\tb'"],
    ["with two spaces in a row", "echo a  b"],
    ["with a space at its end", "npm test "],
    ["with a space that is not the plain one", "rm -rf build"],
  ])("of a command %s offers Deny alone, and says to open Agent Lookout", (_, command) => {
    const ask = bash(command);
    expect(ask.allow).toBe(true);
    const offer = noticeOffer(WAIT, ask);
    expect(offer.decisions).toEqual(["deny"]);
    expect(offer.body.startsWith("To allow it, open Agent Lookout, which shows it whole.")).toBe(
      true,
    );
    expect(offer.body).not.toBe(command);
  });

  test("a command at the longest it shows whole still offers Allow, and one of 80 characters does not", () => {
    const command = "x".repeat(MAX_NOTICE_COMMAND_CHARS);
    expect(noticeOffer(WAIT, bash(command)).decisions).toEqual(["deny", "allow"]);
    expect(noticeOffer(WAIT, bash(`npm test -- ${"x".repeat(68)}`)).decisions).toEqual(["deny"]);
  });

  test("of a reminder says how long it has waited before what it asks", () => {
    const reminder = { title: "checkout-flow", body: "Has waited 40 minutes for permission" };
    expect(noticeOffer(reminder, bash("npm test"), 40 * 60_000)).toEqual({
      title: "checkout-flow",
      subtitle: "Has waited 40 minutes. Asks to run",
      body: "npm test",
      decisions: ["deny", "allow"],
    });
    expect(noticeOffer(reminder, bash("npm test\nls"), 40 * 60_000).subtitle).toBe(
      "Has waited 40 minutes. Asks to run",
    );
  });

  test("offers Allow only while the title, subtitle and text fit in the bytes macOS keeps", () => {
    // Four bytes a letter: 60 of them are 240 bytes, which with the rest is past the limit.
    const title = "\u{1f600}".repeat(60);
    const offer = noticeOffer({ title, body: "Waiting for permission" }, bash("npm test"));
    expect(new TextEncoder().encode(`${offer.title}Asks to runnpm test`).length).toBeGreaterThan(
      MAX_NOTICE_BYTES,
    );
    expect(offer.decisions).toEqual(["deny"]);
  });

  test("of a command with another input offers Deny alone, since the input is not in it", () => {
    expect(noticeOffer(WAIT, bash("npm run build", { run_in_background: true })).decisions).toEqual(
      ["deny"],
    );
  });

  test.each([
    ["an edit", held("Edit", { file_path: "/Users/example/code/demo/a.ts", old_string: "a" })],
    ["a new file", held("Write", { file_path: "/Users/example/code/demo/b.ts", content: "b" })],
    ["a plan", held("ExitPlanMode", { plan: "Do it" })],
    ["a question", held("AskUserQuestion", { questions: [] })],
    ["another tool", held("WebFetch", { url: "https://example.com" })],
  ])("of %s offers Deny alone", (_, ask) => {
    const offer = noticeOffer(WAIT, ask);
    expect(offer.decisions).toEqual(["deny"]);
    expect(offer.subtitle).toBe(`Asks to use ${ask.tool}`);
  });

  test("of one the collector offers Deny alone for says why, then what it asks on a line of its own", () => {
    const offer = noticeOffer(WAIT, held("Edit", { file_path: "/Users/example/code/demo/a.ts" }));
    expect(offer.body).toBe(
      "Allow is not offered for a change to a file. Answer in the session to allow it.\nfile_path: /Users/example/code/demo/a.ts",
    );
    expect(noticeOffer(WAIT, bash(`echo ${"x".repeat(5_000)}`)).body).toMatch(
      /^It is too long to show whole, so only Deny is offered\.\necho x+…$/,
    );
  });

  test.each([
    ["of several lines shows its first, and … for the rest", "npm test\nrm -rf build", "npm test…"],
    ["starting on a blank line shows its first that is not", "\nrm -rf build", "rm -rf build…"],
    ["with two spaces in a row ends in …, as it is not shown as written", "echo a  b", "echo a b…"],
    ["of one line that only runs long is cut", `echo ${"y".repeat(200)}`, /^echo y+…$/],
  ])("offering Deny alone, the start of a command %s", (_, command, start) => {
    const [reason, shown, ...more] = noticeOffer(WAIT, bash(command)).body.split("\n");
    expect(reason).toBe("To allow it, open Agent Lookout, which shows it whole.");
    if (typeof start === "string") expect(shown).toBe(start);
    else expect(shown).toMatch(start);
    expect(more).toEqual([]);
  });

  test("never offers Allow for a request the collector does not, whatever it looks like", () => {
    const ask = { ...bash("npm test"), allow: false };
    expect(noticeOffer(WAIT, ask).decisions).toEqual(["deny"]);
    expect(noticeOffer(WAIT, { ...ask, tool: "Write", allow: true }).decisions).toEqual(["deny"]);
  });
});

describe("the menu", () => {
  test("shows a command of several lines whole, a line each, and offers Allow", () => {
    expect(menuOffer(bash("npm test\nnpm run build"))).toEqual({
      heading: "Asks to run",
      lines: ["npm test", "npm run build"],
      inputs: [],
      allow: true,
      note: null,
    });
  });

  test("doubles each & so it is drawn as written", () => {
    const offer = menuOffer(bash("npm test && npm run build &"));
    expect(offer.allow).toBe(true);
    expect(offer.lines).toEqual(["npm test &&&& npm run build &&"]);
    expect(offer.lines.map(fixUpWindowsStyleLabel)).toEqual(["npm test && npm run build &"]);
  });

  test("shows each other input as name: value on a line of its own, apart from the command", () => {
    const offer = menuOffer(bash("npm run build", { run_in_background: true, timeout: 600000 }));
    expect(offer).toMatchObject({
      lines: ["npm run build"],
      inputs: ["run_in_background: true", "timeout: 600000"],
      allow: true,
    });
    const fetch = menuOffer(held("WebFetch", { url: "https://example.com", prompt: "Summarise" }));
    expect(fetch).toMatchObject({
      heading: "Asks to use WebFetch",
      lines: [],
      inputs: ["url: https://example.com", "prompt: Summarise"],
      allow: true,
    });
  });

  test("a command's line is never shown as an input, nor an input as a line of the command", () => {
    const withInput = menuOffer(bash("npm test", { dangerouslyDisableSandbox: true }));
    const twoLines = menuOffer(bash("npm test\ndangerouslyDisableSandbox: true"));
    expect(withInput).toMatchObject({
      lines: ["npm test"],
      inputs: ["dangerouslyDisableSandbox: true"],
      allow: true,
    });
    expect(twoLines).toMatchObject({
      lines: ["npm test", "dangerouslyDisableSandbox: true"],
      inputs: [],
      allow: true,
    });
    expect(withInput).not.toEqual(twoLines);
  });

  test("offers Deny alone for an input whose name holds a colon, which would hide where the name ends", () => {
    expect(menuOffer(held("mcp__docs__find", { "a: b": "c" })).allow).toBe(false);
    expect(menuOffer(held("mcp__docs__find", { a: "b: c" })).allow).toBe(true);
  });

  test("offers Allow only while the heading is shown whole too, and cuts a longer one", () => {
    const longest = `mcp__${"x".repeat(MAX_MENU_LINE_CHARS - "Asks to use mcp__".length)}`;
    expect(menuOffer(held(longest, {}))).toMatchObject({
      allow: true,
      heading: `Asks to use ${longest}`,
    });
    const offer = menuOffer(held(`mcp__${"x".repeat(190)}`, {}));
    expect(offer.allow).toBe(false);
    expect(Array.from(offer.heading)).toHaveLength(MAX_MENU_LINE_CHARS);
    expect(offer.heading.endsWith("…")).toBe(true);
    expect(offer.note).toBe("To allow it, open Agent Lookout, which shows it whole.");
  });

  test.each([
    ["three dots, drawn as an ellipsis", "ls ..."],
    ["(&) in it, which is taken out", "echo (&)"],
    ["two spaces in a row", "echo a  b"],
    ["a tab", "printf 'a\tb'"],
    ["a line indented", "for f in *; do\n  echo $f\ndone"],
    ["a blank line", "npm test\n\nnpm run build"],
    ["a line longer than it shows whole", "x".repeat(MAX_MENU_LINE_CHARS + 1)],
    [
      "more lines than it shows",
      Array.from({ length: MAX_MENU_LINES + 1 }, (_, i) => `echo ${i}`).join("\n"),
    ],
  ])("offers Deny alone for a command with %s, and says to open Agent Lookout", (_, command) => {
    const ask = bash(command);
    expect(ask.allow).toBe(true);
    const offer = menuOffer(ask);
    expect(offer.allow).toBe(false);
    expect(offer.note).toBe("To allow it, open Agent Lookout, which shows it whole.");
  });

  test("at the most lines and the longest line it shows whole, it still offers Allow", () => {
    const lines = Array.from({ length: MAX_MENU_LINES }, () => "x".repeat(MAX_MENU_LINE_CHARS));
    expect(menuOffer(bash(lines.join("\n"))).allow).toBe(true);
  });

  test("offering Deny alone, shows at most its lines, cut, and counts the rest", () => {
    const command = Array.from({ length: MAX_MENU_LINES + 3 }, (_, i) => `echo ${i}`).join("\n");
    const offer = menuOffer(bash(command));
    expect(offer.lines).toHaveLength(MAX_MENU_LINES + 1);
    expect(offer.lines.at(-1)).toBe("And 3 more lines");
    const long = menuOffer(bash(`echo ${"y".repeat(200)}`)).lines[0] ?? "";
    expect(Array.from(long)).toHaveLength(MAX_MENU_LINE_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });

  test("a tool with no input is shown whole by its heading alone", () => {
    expect(menuOffer(held("mcp__docs__list", {}))).toEqual({
      heading: "Asks to use mcp__docs__list",
      lines: [],
      inputs: [],
      allow: true,
      note: null,
    });
  });

  test("offering Deny alone, counts the lines left out after the last it shows", () => {
    const command = Array.from({ length: MAX_MENU_LINES - 1 }, (_, i) => `echo ${i}`).join("\n");
    const offer = menuOffer(bash(`${command}\nls ...`, { timeout: 5, run_in_background: true }));
    expect(offer.allow).toBe(false);
    expect(offer.lines).toHaveLength(MAX_MENU_LINES + 1);
    expect(offer.lines.at(-1)).toBe("And 2 more lines");
    expect(offer.inputs).toEqual([]);
    // The command's lines and the inputs count together.
    expect(menuOffer(bash(command, { timeout: 5 }))).toMatchObject({
      allow: true,
      inputs: ["timeout: 5"],
    });
    expect(menuOffer(bash(command, { timeout: 5, run_in_background: true }))).toMatchObject({
      allow: false,
      inputs: ["timeout: 5", "And 1 more line"],
    });
    const fewer = menuOffer(bash("ls ...", { timeout: 5 }));
    expect(fewer).toMatchObject({ lines: ["ls ..."], inputs: ["timeout: 5"], allow: false });
  });

  test("offers Deny alone for an input whose value runs over lines", () => {
    const offer = menuOffer(held("WebFetch", { url: "https://example.com", prompt: "one\ntwo" }));
    expect(offer.allow).toBe(false);
  });

  test.each([
    ["an edit", held("Edit", { file_path: "/Users/example/code/demo/a.ts" }), "edit"],
    ["a plan", held("ExitPlanMode", { plan: "Do it" }), "not-yes-or-no"],
    ["a question", held("AskUserQuestion", { questions: [] }), "not-yes-or-no"],
    ["a command too long for the page", bash(`echo ${"x".repeat(5_000)}`), "too-long"],
  ])("offers Deny alone for %s, with the collector's reason", (_, ask, reason) => {
    expect(ask.denyOnly).toBe(reason);
    const offer = menuOffer(ask);
    expect(offer.allow).toBe(false);
    expect(offer.note).toBe(denyOnlyHere(ask));
    expect(offer.note).not.toContain("open Agent Lookout");
  });
});
