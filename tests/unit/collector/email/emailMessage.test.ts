import { describe, expect, test } from "vitest";

import { overEmail, reminderEmail, summaryEmail, waitEmail } from "@collector/email/emailMessage";
import type { SummaryFacts, WaitFacts } from "@collector/outbound/outboundChannel";
import { clockAt, durationInWords } from "@core/duration";
import type { Session } from "@core/sessions/session";
import { MAX_LINE_LENGTH, MAX_WAITING_TEXT_LENGTH, waitingText } from "@core/text";
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
    asking: null,
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
        waitingText: "Run: rm -rf build",
        links: { open: "vscode://anthropic.claude-code/open?session=x" },
      }),
    );
    const all = `${email.subject}\n${email.text}`;
    expect(all).not.toContain("/Users/example");
    expect(all).not.toContain("private");
    expect(all).not.toContain("Bash");
    // Nor, with the setting off, what the session is asking: the session's own text is never read here.
    expect(all).not.toContain("rm -rf");
    expect(all).not.toContain("Run:");
    expect(all).not.toContain("vscode://");
    expect(all).not.toMatch(/https?:|<[a-z]/i);
  });

  const STOP_LINE =
    "Sent by Agent Lookout on your computer. To stop these emails, start it again without AGENT_LOOKOUT_EMAIL_TO.";

  test("with AGENT_LOOKOUT_EMAIL_ASKING on, the body says what the session is asking, first of the facts, and the subject does not", () => {
    const email = waitEmail(facts({ waitingText: "Run: npm test" }, { asking: "Run: npm test" }));
    expect(email).toEqual({
      subject: "checkout-flow is waiting for permission",
      text: [
        "checkout-flow is waiting for permission.",
        "",
        "It has waited 1 minute 5 seconds, since 14:01.",
        "",
        "Asking: Run: npm test",
        "Folder: checkout-flow",
        "App: VS Code",
        "Agent: Claude Code",
        "",
        STOP_LINE,
        "",
      ].join("\n"),
    });
    // A question reads the same way, with how many more there are.
    const question = "Which database should the tests use? (and 2 more)";
    expect(waitEmail(facts({ waitingReason: "question" }, { asking: question })).text).toContain(
      `\nAsking: ${question}\nFolder: checkout-flow\n`,
    );
    // With nothing else known, it stands alone in the facts.
    expect(
      waitEmail(facts({ project: null, surface: "unknown" }, { agent: null, asking: "Use: Grep" }))
        .text,
    ).toBe(
      [
        "checkout-flow is waiting for permission.",
        "",
        "It has waited 1 minute 5 seconds, since 14:01.",
        "",
        "Asking: Use: Grep",
        "",
        STOP_LINE,
        "",
      ].join("\n"),
    );
  });

  test("with it off, the email is the one it always was, though the session is asking something", () => {
    const off = waitEmail(facts({ waitingText: "Run: npm test" }, { asking: null }));
    expect(off).toEqual(waitEmail(facts()));
    expect(`${off.subject}\n${off.text}`).not.toMatch(/Asking|npm test/);
  });

  test("what the session is asking is said as the dashboard shows it: a command, a web address or a full path, not cut to a name's length", () => {
    for (const shown of [
      "Run: ./scripts/release.sh --tag v1 && git push origin main",
      "Fetch: https://example.com/docs/setup?step=2",
      "Edit: /Users/example/.ssh/config",
      // Cut by the collector to 200 characters, as the dashboard has it.
      waitingText(`Run: ${"echo checkout-flow ".repeat(20)}`) as string,
    ]) {
      const { subject, text } = waitEmail(facts({}, { asking: shown }));
      expect(text.split("\n")).toContain(`Asking: ${shown}`);
      expect(subject).toBe("checkout-flow is waiting for permission");
    }
    const long = waitingText(`Run: ${"x".repeat(400)}`) as string;
    expect(Array.from(long)).toHaveLength(MAX_WAITING_TEXT_LENGTH);
    expect(waitEmail(facts({}, { asking: long })).text).toContain(`Asking: ${long}\n`);
  });

  test("text handed in that the channel has not cleaned still cannot add a line of its own", () => {
    const raw = `Run: npm test\nFolder: somewhere-else\r\nApp: Mail\u2028${"y".repeat(300)}`;
    const { text } = waitEmail(facts({}, { asking: raw }));
    const asked = text.split("\n").filter((line) => line.startsWith("Asking: "));
    expect(asked).toEqual([`Asking: ${waitingText(raw)}`]);
    expect(text.split("\n").filter((line) => line.startsWith("Folder: "))).toEqual([
      "Folder: checkout-flow",
    ]);
    expect(text.split("\n").filter((line) => line.startsWith("App: "))).toEqual(["App: VS Code"]);
    // Cleaning what the channel has cleaned leaves it as it was.
    const once = waitingText(raw) as string;
    expect(waitEmail(facts({}, { asking: once })).text).toBe(text);
    // Text that is only spaces once cleaned adds nothing.
    expect(waitEmail(facts({}, { asking: " \n\t " }))).toEqual(waitEmail(facts()));
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
    // The day as the dashboard writes it, in this computer's own words for it.
    expect(text).toMatch(/It has waited 12 hours, since 14:01 on (\S+ 5|5 \S+)\./);
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
      expect(Array.from(shownName).length).toBeLessThanOrEqual(MAX_LINE_LENGTH);

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

  test("never says what a session was asking, whatever the session holds", () => {
    for (const event of ["finished", "failed", "ended"] as const) {
      const email = over(event, { waitingText: "Run: npm test" });
      expect(`${email.subject}\n${email.text}`).not.toMatch(/Asking|npm test/);
      expect(email).toEqual(over(event));
    }
  });
});

test("a length of time and a time on the clock are written as the dashboard writes them", () => {
  const begun = BEGUN - 90_000_000;
  const email = waitEmail(facts({}, { begunAt: begun, now: BEGUN }));
  expect(email.text).toContain(
    `It has waited ${durationInWords(90_000_000)}, since ${clockAt(begun, BEGUN)}.`,
  );
  expect(email.text).toContain("It has waited 1 day 1 hour, since ");
});

describe("reminderEmail", () => {
  test("says how long the session has waited in the subject, and the rest as a wait's email does", () => {
    const email = reminderEmail({
      ...facts({}, { now: BEGUN + 10 * 60_000 + 4_000, asking: "Run: npm test" }),
      thresholdMs: 10 * 60_000,
    });
    expect(email).toEqual({
      subject: "checkout-flow has waited 10 minutes for permission",
      text: [
        "checkout-flow has waited 10 minutes for permission.",
        "",
        "It has waited since 14:01. Agent Lookout reminds you once a wait lasts 10 minutes, as Time rules in Settings says.",
        "",
        "Asking: Run: npm test",
        "Folder: checkout-flow",
        "App: VS Code",
        "Agent: Claude Code",
        "",
        "Sent by Agent Lookout on your computer. To stop these emails, start it again without AGENT_LOOKOUT_EMAIL_TO.",
        "",
      ].join("\n"),
    });
  });
});

describe("summaryEmail", () => {
  /** 22:00 to 08:00 the next morning, on this computer's clock. */
  const FROM = new Date(2026, 9, 5, 22, 0).getTime();
  const TO = new Date(2026, 9, 6, 8, 0).getTime();
  const session = (name: string) => makeSession({ name, project: "storefront" });

  function summary(items: SummaryFacts["items"]): SummaryFacts {
    return { from: FROM, to: TO, items, now: TO };
  }

  test("names the first few in the subject, and each on a line of its own with when", () => {
    const email = summaryEmail(
      summary([
        {
          event: "needs-you",
          session: session("checkout-flow"),
          at: FROM + 70 * 60_000,
          waitedMs: 25 * 60_000,
          times: 1,
          agent: "Claude Code",
        },
        {
          event: "needs-you",
          session: session("docs-site"),
          at: FROM + 80 * 60_000,
          waitedMs: 65 * 60_000,
          times: 2,
          then: { event: "ended", at: FROM + 300 * 60_000 },
          agent: "Claude Code",
        },
        {
          event: "finished",
          session: session("billing-webhooks"),
          at: FROM + 192 * 60_000,
          agent: "Claude Code",
        },
      ]),
    );
    expect(email.subject).toBe(
      "While quiet: checkout-flow waited 25 minutes, docs-site waited 1 hour 5 minutes over 2 waits then ended and billing-webhooks finished",
    );
    expect(email.text).toBe(
      [
        `During quiet hours, from ${clockAt(FROM, TO)} to 08:00:`,
        "",
        `checkout-flow waited 25 minutes, from ${clockAt(FROM + 70 * 60_000, TO)}.`,
        `docs-site waited 1 hour 5 minutes over 2 waits, from ${clockAt(FROM + 80 * 60_000, TO)}, then ended at 03:00.`,
        "billing-webhooks finished at 01:12.",
        "",
        "Quiet hours are set under Time rules in Settings. A session still waiting when they ended has an email of its own.",
        "",
        "Sent by Agent Lookout on your computer. To stop these emails, start it again without AGENT_LOOKOUT_EMAIL_TO.",
        "",
      ].join("\n"),
    );
  });

  test("lists fifty one by one, and counts the rest", () => {
    const items = Array.from({ length: 53 }, (_, index) => ({
      event: "ended" as const,
      session: session(`session-${index + 1}`),
      at: FROM + index * 60_000,
      agent: null,
    }));
    const email = summaryEmail(summary(items));
    expect(email.subject).toBe(
      "While quiet: session-1 ended, session-2 ended, session-3 ended and 50 more",
    );
    expect(email.text).toContain("session-50 ended at");
    expect(email.text).not.toContain("session-51 ended");
    expect(email.text).toContain("And 3 more.");
  });

  test("a name that tries to add a line or a header is one line", () => {
    const email = summaryEmail(
      summary([
        {
          event: "failed",
          session: session("api\r\nBcc: someone@example.com"),
          at: FROM,
          agent: null,
        },
      ]),
    );
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.text.split("\n")).toContain(
      `api Bcc: someone@example.com failed at ${clockAt(FROM, TO)}.`,
    );
  });
});
