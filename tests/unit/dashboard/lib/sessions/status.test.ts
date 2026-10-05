import { expect, test } from "vitest";

import {
  eventPhrase,
  safeJumpLink,
  waitingDetail,
  waitingLabel,
} from "@dashboard/lib/sessions/status";

test("a waiting reason is said in plain words", () => {
  expect(waitingLabel({ waitingReason: "permission" })).toBe("Waiting for permission");
  expect(waitingLabel({ waitingReason: "question" })).toBe("Asked you a question");
  expect(waitingLabel({ waitingReason: "other" })).toBe("Waiting for you");
  expect(waitingLabel({})).toBe("Waiting for you");
});

test("the vendor's wording is kept only when it adds something", () => {
  // These two say nothing the plain label has not already said.
  expect(
    waitingDetail({ waitingReason: "permission", waitingDetail: "permission prompt" }),
  ).toBeNull();
  expect(waitingDetail({ waitingReason: "question", waitingDetail: "input needed" })).toBeNull();
  // Anything else is shown as it came.
  expect(waitingDetail({ waitingReason: "other", waitingDetail: "sandbox request" })).toBe(
    "sandbox request",
  );
  expect(waitingDetail({ waitingReason: "other" })).toBeNull();
});

test("an event reads as what happened to the session", () => {
  expect(eventPhrase({ kind: "appeared", to: "working" })).toBe("appeared");
  expect(eventPhrase({ kind: "ended" })).toBe("ended");
  expect(eventPhrase({ kind: "status-changed", to: "needs-you" })).toBe("started waiting");
  expect(eventPhrase({ kind: "status-changed", to: "working" })).toBe("started working");
  expect(eventPhrase({ kind: "status-changed", to: "idle" })).toBe("went idle");
  expect(eventPhrase({ kind: "status-changed", to: "finished" })).toBe("finished");
  expect(eventPhrase({ kind: "status-changed", to: "failed" })).toBe("failed");
  expect(eventPhrase({ kind: "status-changed", to: "unknown" })).toBe("changed status");
});

test("a wait that ended says how long it lasted, when its start is held", () => {
  const answered = {
    kind: "status-changed" as const,
    from: "needs-you" as const,
    to: "working" as const,
  };

  expect(eventPhrase(answered, 100_000)).toBe("stopped waiting after 1m 40s");
  // Without the event that began it, the length was not seen, so it is not said.
  expect(eventPhrase(answered)).toBe("started working");
  expect(eventPhrase(answered, null)).toBe("started working");
  // An ending says it ended, however long the wait before it.
  expect(eventPhrase({ kind: "ended", from: "needs-you" }, 100_000)).toBe("ended");
  // A length given for any other move is not used.
  expect(eventPhrase({ kind: "status-changed", from: "idle", to: "working" }, 100_000)).toBe(
    "started working",
  );
});

const JUMP = "vscode://anthropic.claude-code/open?session=00000000-0000-4000-8000-000000000001";
const linked = (open: string | undefined) => ({ source: "claude-code" as const, links: { open } });

test("the address the Claude Code source builds is followed", () => {
  expect(safeJumpLink(linked(JUMP))).toBe(JUMP);
  // A session id with characters that had to be escaped is still that address.
  const escaped = "vscode://anthropic.claude-code/open?session=a%20b%22c";
  expect(safeJumpLink(linked(escaped))).toBe(escaped);
});

test.each([
  // Script.
  "javascript:alert(1)",
  " JavaScript:alert(1)",
  "java\tscript:alert(1)",
  "\u0001javascript:alert(1)",
  "data:text/html,x",
  "vbscript:x",
  // Another machine, or this machine's files.
  "https://evil.example/collect?leak=1",
  "http://169.254.169.254/latest/meta-data/",
  "file:///etc/passwd",
  "//evil.example/x",
  "blob:http://127.0.0.1:4777/abc",
  // Other apps.
  "ssh://evil.example",
  "ms-msdt:/id PCWDiagnostic",
  "x-apple.systempreferences:com.apple.preference.security",
  "tel:+10000000000",
  "intent://evil#Intent;end",
  // The same editor, but not the address this source builds.
  "vscode://evil.publisher.ext/run?cmd=x",
  "vscode-insiders://anthropic.claude-code/open?session=abc",
  "vscode://anthropic.claude-code/open?session=abc&cmd=x",
  "vscode://anthropic.claude-code/open?session=abc#fragment",
  "vscode://anthropic.claude-code/run?session=abc",
  "vscode://anthropic.claude-code.evil/open?session=abc",
  "vscode://anthropic.claude-code/open?session=",
  "VSCODE://anthropic.claude-code/open?session=abc",
  ` ${JUMP}`,
  `${JUMP}\n`,
])("%j is never turned into a link", (link) => {
  expect(safeJumpLink(linked(link))).toBeNull();
});

test("a missing or malformed link is no link", () => {
  expect(safeJumpLink(linked(undefined))).toBeNull();
  expect(safeJumpLink(linked(""))).toBeNull();
  expect(safeJumpLink(linked("/relative/path"))).toBeNull();
  // A value of the wrong kind, as a careless source might send.
  expect(
    safeJumpLink({ source: "claude-code", links: { open: 42 as unknown as string } }),
  ).toBeNull();
});

test("a source with no known address gets no link, whatever it sends", () => {
  const stranger = { source: "another-tool" as "claude-code", links: { open: JUMP } };
  expect(safeJumpLink(stranger)).toBeNull();
  // A name that exists on every object is not a source either.
  const inherited = { source: "constructor" as "claude-code", links: { open: JUMP } };
  expect(safeJumpLink(inherited)).toBeNull();
});

test.each([
  JUMP,
  "codex://threads/00000000-0000-4000-8000-0000000000c1",
  "vscode://openai.chatgpt/open?thread=00000000-0000-4000-8000-0000000000c1",
])("a Codex session gets no Jump, even with %j", (link) => {
  expect(safeJumpLink({ source: "codex", links: { open: link } })).toBeNull();
});
