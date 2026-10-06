import { describe, expect, test } from "vitest";

import { claudeCodeOpenLink } from "@core/mapping/claudeCodeMapping";
import { externalLinkFor, isAppAddress, MAX_EXTERNAL_LINK_LENGTH } from "@desktop/navigation/links";

describe("the window's own pages", () => {
  test.each([
    "agent-lookout://app/",
    "agent-lookout://app/#sources",
    "agent-lookout://app/?session=abc#overview",
    "agent-lookout://app/assets/index.js",
  ])("%s is one of the app's pages", (url) => {
    expect(isAppAddress(url)).toBe(true);
  });

  test.each([
    "agent-lookout://other/",
    "agent-lookout://APP/",
    "agent-lookout://user:secret@app/",
    "agent-lookout://app:8080/",
    "agent-lookout:app",
    "https://app/",
    "http://127.0.0.1:4777/",
    "file:///Applications/",
    "about:blank",
    "javascript:alert(1)",
    "data:text/html,hello",
    "not a url",
    "",
  ])("%j is not", (url) => {
    expect(isAppAddress(url)).toBe(false);
  });
});

describe("links handed to the system", () => {
  test("an https address is handed over as the parser writes it", () => {
    expect(externalLinkFor("https://github.com/Olanetsoft/agent-lookout")).toBe(
      "https://github.com/Olanetsoft/agent-lookout",
    );
    expect(externalLinkFor("HTTPS://Example.com/a b")).toBe("https://example.com/a%20b");
  });

  test("the deep link to a Claude Code session in VS Code, in the shape the collector builds, is handed over", () => {
    const link = claudeCodeOpenLink("vscode", "00000000-0000-4000-8000-000000000001");
    expect(link).toBeDefined();
    expect(externalLinkFor(link!)).toBe(link);
    // An id with characters that need encoding, encoded as the collector encodes them.
    const odd = claudeCodeOpenLink("vscode", "a b/c?d");
    expect(externalLinkFor(odd!)).toBe(odd);
  });

  test.each([
    ["http", "http://example.com/"],
    ["a file", "file:///etc/passwd"],
    ["a script", "javascript:alert(1)"],
    ["data", "data:text/html,<script>alert(1)</script>"],
    ["another app's scheme", "ssh://example.com"],
    ["another app's scheme", "x-apple.systempreferences:com.apple.preference.security"],
    ["another VS Code extension", "vscode://other.extension/open?session=abc"],
    ["VS Code opening a file", "vscode://file/etc/passwd"],
    ["the session link with more after it", `${claudeCodeOpenLink("vscode", "abc")}&cmd=x`],
    ["the session link with a fragment", `${claudeCodeOpenLink("vscode", "abc")}#x`],
    ["the session link with an empty id", "vscode://anthropic.claude-code/open?session="],
    ["a user name in an https address", "https://user@example.com/"],
    ["a password in an https address", "https://user:secret@example.com/"],
    ["the app's own page", "agent-lookout://app/"],
    ["nothing", ""],
    ["no address at all", "not a url"],
  ])("%s is dropped: %s", (_what, url) => {
    expect(externalLinkFor(url)).toBeNull();
  });

  test("an address too long to be a real link is dropped", () => {
    expect(
      externalLinkFor(`https://example.com/${"a".repeat(MAX_EXTERNAL_LINK_LENGTH)}`),
    ).toBeNull();
  });
});
