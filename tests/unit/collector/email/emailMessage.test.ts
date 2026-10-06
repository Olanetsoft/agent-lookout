import { describe, expect, test } from "vitest";

import { clockTime, overEmail, waitEmail, waitedInWords } from "@collector/email/emailMessage";
import type { WaitFacts } from "@collector/outbound/outboundChannel";
import { MOST_NAME_LENGTH, oneLine } from "@collector/outbound/outboundText";
import type { Session } from "@core/sessions/session";
import { makeSession } from "@tests/fixtures/session";

/** 14:01:05 on this computer's clock, whatever its time zone. */
const BEGUN = new Date(2026, 9, 5, 14, 1, 5).getTime();

function facts(overrides: Partial<Session> = {}, more: Partial<WaitFacts> = {}): WaitFacts {
  return {
    session: makeSession({
      name: "checkout-flow",
      cwd: "/Users/example/code/checkout-flow",
      project: "checkout-flow",
      surface: "vscode",
      status: "needs-you",
      waitingReason: "permission",
      waitingDetail: "permission prompt",
      ...overrides,
    }),
    agent: "Claude Code",
    begunAt: BEGUN,
    now: BEGUN + 65_000,
    ...more,
  };
}

describe("waitEmail", () => {
  test("names the session and what happened, says how long and since when, where it runs, and how to stop", () => {
    expect(waitEmail(facts())).toEqual({
      subject: "checkout-flow is waiting for permission",
      text: [
        "checkout-flow is waiting for permission.",
        "",
        "It has waited 1 minute 5 seconds, since 14:01.",
        "",
        "Folder: checkout-flow",
        "App: VS Code",
        "Agent: Claude Code",
        "",
        "Sent by Agent Lookout on your computer. To stop these emails, start it again without AGENT_LOOKOUT_EMAIL_TO.",
        "",
      ].join("\n"),
    });
  });

  test("says each reason in the words the app uses everywhere", () => {
    expect(waitEmail(facts({ waitingReason: "question" })).subject).toBe(
      "checkout-flow asked you a question",
    );
    expect(waitEmail(facts({ waitingReason: "other" })).subject).toBe(
      "checkout-flow is waiting for you",
    );
    expect(waitEmail(facts({ waitingReason: undefined })).subject).toBe(
      "checkout-flow is waiting for you",
    );
  });

  test("holds no path, none of the agent's own words, no link and no markup", () => {
    const email = waitEmail(
      facts({
        name: "api-rate-limits",
        cwd: "/Users/example/private/api-rate-limits",
        project: "api-rate-limits",
        waitingDetail: "Allow Bash(rm -rf build)?",
        links: { open: "vscode://anthropic.claude-code/open?session=x" },
      }),
    );
    const all = `${email.subject}\n${email.text}`;
    expect(all).not.toContain("/Users/example");
    expect(all).not.toContain("private");
    expect(all).not.toContain("Bash");
    expect(all).not.toContain("vscode://");
    expect(all).not.toMatch(/https?:|<[a-z]/i);
  });

  test("a session with no name is called by its folder, then by its id", () => {
    expect(waitEmail(facts({ name: " " })).subject).toBe("checkout-flow is waiting for permission");
    expect(waitEmail(facts({ name: "", project: null, id: "claude-code:4242" })).subject).toBe(
      "claude-code:4242 is waiting for permission",
    );
  });

  test("a line it cannot fill is left out", () => {
    const text = waitEmail(facts({ project: null, surface: "unknown" }, { agent: null })).text;
    expect(text).not.toMatch(/Folder:|App:|Agent:/);
    expect(text).toContain("It has waited 1 minute 5 seconds, since 14:01.");
  });

  test("a session whose app is not known has no App line, and the folder and the agent keep theirs", () => {
    const email = waitEmail(facts({ surface: "unknown" }, { agent: "my-agent" }));
    expect(email.text).toBe(
      [
        "checkout-flow is waiting for permission.",
        "",
        "It has waited 1 minute 5 seconds, since 14:01.",
        "",
        "Folder: checkout-flow",
        "Agent: my-agent",
        "",
        "Sent by Agent Lookout on your computer. To stop these emails, start it again without AGENT_LOOKOUT_EMAIL_TO.",
        "",
      ].join("\n"),
    );
    expect(`${email.subject}\n${email.text}`).not.toMatch(/unknown|App:/i);
    const over = overEmail({
      event: "finished",
      session: facts({ surface: "unknown" }).session,
      agent: "my-agent",
      seenAt: BEGUN,
      now: BEGUN,
    });
    expect(over.text).toContain("Folder: checkout-flow\nAgent: my-agent\n");
    expect(over.text).not.toMatch(/unknown|App:/i);
  });

  test("a wait that began on another day says the day", () => {
    const text = waitEmail(facts({}, { now: BEGUN + 12 * 3_600_000 })).text;
    expect(text).toContain("It has waited 12 hours, since Oct 5, 14:01.");
  });

  const HOSTILE_NAMES = [
    "checkout-flow\r\nBcc: someone@example.test",
    "checkout-flow\nBcc: someone@example.test",
    "checkout-flow\rTo: someone@example.test",
    'checkout-flow" <someone@example.test>, "x',
    "Bcc: someone@example.test",
    "checkout-flow\u2028Bcc: someone@example.test",
    "checkout-flow\u0085Cc: someone@example.test",
    "checkout-flow\u0000\u001b[31m\u007f",
    "checkout-flow\u202egnp.exe",
    "=?UTF-8?B?QmNjOiBzb21lb25lQGV4YW1wbGUudGVzdA==?=",
    `docs-site ${"very-long-name-".repeat(40)}`,
    "café-ünïcode-名前-🚀",
  ];

  test.each(HOSTILE_NAMES)(
    "a hostile name stays one short line in the subject and in the body: %j",
    (name) => {
      const email = waitEmail(facts({ name, project: name }));

      // Nothing that ends a line or steers the text is left in the subject.
      expect(email.subject).not.toMatch(
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/,
      );
      expect(email.subject.endsWith(" is waiting for permission")).toBe(true);
      const shownName = email.subject.slice(0, -" is waiting for permission".length);
      expect(Array.from(shownName).length).toBeLessThanOrEqual(MOST_NAME_LENGTH);

      // The body keeps its shape: the same lines, and the name never begins one of its own.
      expect(email.text.split("\n")).toEqual([
        `${shownName} is waiting for permission.`,
        "",
        "It has waited 1 minute 5 seconds, since 14:01.",
        "",
        `Folder: ${shownName}`,
        "App: VS Code",
        "Agent: Claude Code",
        "",
        "Sent by Agent Lookout on your computer. To stop these emails, start it again without AGENT_LOOKOUT_EMAIL_TO.",
        "",
      ]);
    },
  );

  test("a name in another script is kept as it is", () => {
    expect(waitEmail(facts({ name: "café-ünïcode-名前-🚀" })).subject).toBe(
      "café-ünïcode-名前-🚀 is waiting for permission",
    );
  });
});

describe("overEmail", () => {
  const over = (event: "finished" | "failed" | "ended", overrides: Partial<Session> = {}) =>
    overEmail({
      event,
      session: makeSession({
        name: "billing-webhooks",
        cwd: "/Users/example/code/billing-webhooks",
        project: "billing-webhooks",
        surface: "terminal",
        ...overrides,
      }),
      agent: "Claude Code",
      seenAt: BEGUN,
      now: BEGUN + 2_000,
    });

  test("names the session and what happened, says when it was seen, where it ran, and how to stop", () => {
    expect(over("finished")).toEqual({
      subject: "billing-webhooks finished",
      text: [
        "billing-webhooks finished.",
        "",
        "Agent Lookout saw this at 14:01.",
        "",
        "Folder: billing-webhooks",
        "App: Terminal",
        "Agent: Claude Code",
        "",
        "Sent by Agent Lookout on your computer. To stop these emails, start it again without AGENT_LOOKOUT_EMAIL_TO.",
        "",
      ].join("\n"),
    });
  });

  test("says each event in the words the app uses everywhere", () => {
    expect(over("failed").subject).toBe("billing-webhooks failed");
    expect(over("ended").subject).toBe("billing-webhooks ended");
    expect(over("ended").text.startsWith("billing-webhooks ended.\n")).toBe(true);
  });

  test("holds no path and no link, and a name cannot begin another line", () => {
    const email = over("failed", { name: "docs-site\r\nBcc: other@example.test" });
    expect(email.subject).toBe("docs-site Bcc: other@example.test failed");
    expect(`${email.subject}\n${email.text}`).not.toContain("/Users/example");
  });
});

describe("oneLine", () => {
  test("turns line breaks and control characters into single spaces", () => {
    expect(oneLine("a\r\nb\tc\u0000d   e")).toBe("a b c d e");
    expect(oneLine("  padded  ")).toBe("padded");
  });

  test("cuts a long name with an ellipsis, between letters", () => {
    expect(oneLine("abcdefghij", 5)).toBe("abcd…");
    expect(oneLine("abcde", 5)).toBe("abcde");
    // Four letters outside the basic plane, each two UTF-16 units, are never split.
    expect(oneLine("🚀🚀🚀🚀🚀🚀", 4)).toBe("🚀🚀🚀…");
  });
});

test("a length of time is said to the second under an hour, and to the minute after", () => {
  expect(waitedInWords(0)).toBe("0 seconds");
  expect(waitedInWords(1_000)).toBe("1 second");
  expect(waitedInWords(59_999)).toBe("59 seconds");
  expect(waitedInWords(60_000)).toBe("1 minute");
  expect(waitedInWords(65_000)).toBe("1 minute 5 seconds");
  expect(waitedInWords(3_599_000)).toBe("59 minutes 59 seconds");
  expect(waitedInWords(3_600_000)).toBe("1 hour");
  expect(waitedInWords(7_380_000)).toBe("2 hours 3 minutes");
});

test("a time is on this computer's 24-hour clock, with the day when it is not today", () => {
  const evening = new Date(2026, 9, 4, 23, 59, 30).getTime();
  expect(clockTime(evening, evening + 1_000)).toBe("23:59");
  expect(clockTime(evening, new Date(2026, 9, 5, 0, 0, 30).getTime())).toBe("Oct 4, 23:59");
  expect(clockTime(new Date(2026, 0, 2, 7, 5).getTime(), BEGUN)).toBe("Jan 2, 07:05");
});
