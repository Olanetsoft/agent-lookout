import { describe, expect, test } from "vitest";

import type { SummaryFacts, WaitFacts } from "@collector/outbound/outboundChannel";
import {
  MAX_SUMMARY_ITEMS,
  overPost,
  reminderPost,
  slackSafe,
  summaryPost,
  waitPost,
} from "@collector/webhook/webhookMessage";
import { MAX_LINE_LENGTH, waitingText } from "@core/text";
import type { Session } from "@core/sessions/session";
import { makeSession } from "@tests/fixtures/session";

const BEGUN = Date.UTC(2026, 9, 5, 14, 1, 5);

function facts(overrides: Partial<Session> = {}, more: Partial<WaitFacts> = {}): WaitFacts {
  return {
    session: makeSession({
      name: "checkout-flow",
      cwd: "/Users/example/code/storefront",
      project: "storefront",
      surface: "vscode",
      status: "needs-you",
      waitingReason: "permission",
      waitingDetail: "permission prompt",
      ...overrides,
    }),
    agent: "Claude Code",
    asking: null,
    begunAt: BEGUN,
    // Four minutes and twelve seconds later.
    now: BEGUN + 252_000,
    ...more,
  };
}

describe("waitPost", () => {
  test("says in one line who waits, why, for how long, where and in what, and the same for a program", () => {
    expect(waitPost(facts())).toEqual({
      text: "checkout-flow is waiting for permission (4m 12s, storefront, VS Code, Claude Code)",
      event: "needs-you",
      reason: "permission",
      session: {
        name: "checkout-flow",
        agent: "Claude Code",
        folder: "storefront",
        app: "VS Code",
      },
      at: "2026-10-05T14:01:05.000Z",
      waitedSeconds: 252,
    });
  });

  test("its fields come in a fixed order, so the JSON reads the same each time", () => {
    expect(Object.keys(waitPost(facts()))).toEqual([
      "text",
      "event",
      "reason",
      "session",
      "at",
      "waitedSeconds",
    ]);
  });

  test("each reason has the dashboard's own words", () => {
    expect(waitPost(facts({ waitingReason: "question" })).text).toMatch(
      /^checkout-flow asked you a question \(/,
    );
    const other = waitPost(facts({ waitingReason: undefined }));
    expect(other.text).toMatch(/^checkout-flow is waiting for you \(/);
    expect(other.reason).toBe("other");
  });

  test("leaves out what is not known, and a name of spaces gives way to the folder", () => {
    const post = waitPost(
      facts(
        { name: "   ", project: null, surface: "unknown" },
        { agent: null, now: BEGUN + 42_000 },
      ),
    );
    expect(post.text).toBe(
      "claude-code:00000000-0000-4000-8000-000000000001 is waiting for permission (42s)",
    );
    expect(post.session).toEqual({
      name: "claude-code:00000000-0000-4000-8000-000000000001",
      agent: null,
      folder: null,
      app: null,
    });
    expect(waitPost(facts({ name: "   " })).session.name).toBe("storefront");
  });

  test("holds no path, none of the agent's own words and nothing else from the session", () => {
    const said = JSON.stringify(
      waitPost(
        facts({ pid: 4242, links: { open: "vscode://x" }, waitingText: "Run: rm -rf build" }),
      ),
    );
    // With the setting off, what the session is asking stays on the machine: the session's own text is never read here.
    for (const absent of [
      "/Users/example",
      "permission prompt",
      "4242",
      "vscode://",
      "cwd",
      "rm -rf",
      "Run:",
    ]) {
      expect(said).not.toContain(absent);
    }
  });
});

describe("what a waiting session is asking", () => {
  test("with AGENT_LOOKOUT_WEBHOOK_ASKING on, it follows the reason in the line, and has a field of its own", () => {
    const post = waitPost(facts({ waitingText: "Run: npm test" }, { asking: "Run: npm test" }));
    expect(post).toEqual({
      text: "checkout-flow is waiting for permission: Run: npm test (4m 12s, storefront, VS Code, Claude Code)",
      event: "needs-you",
      reason: "permission",
      asking: "Run: npm test",
      session: {
        name: "checkout-flow",
        agent: "Claude Code",
        folder: "storefront",
        app: "VS Code",
      },
      at: "2026-10-05T14:01:05.000Z",
      waitedSeconds: 252,
    });
    expect(Object.keys(post)).toEqual([
      "text",
      "event",
      "reason",
      "asking",
      "session",
      "at",
      "waitedSeconds",
    ]);
    const question = waitPost(
      facts({ waitingReason: "question" }, { asking: "Which database should the tests use?" }),
    );
    expect(question.text).toBe(
      "checkout-flow asked you a question: Which database should the tests use? (4m 12s, storefront, VS Code, Claude Code)",
    );
  });

  test("with it off, the post is the one it always was, and has no field for it", () => {
    const off = waitPost(facts({ waitingText: "Run: npm test" }, { asking: null }));
    expect(off).toEqual(waitPost(facts()));
    expect(Object.keys(off)).not.toContain("asking");
    expect(JSON.stringify(off)).not.toMatch(/asking|npm test/);
  });

  test("it is said as the dashboard shows it, a command, a web address or a full path, and made safe for Slack in the line alone", () => {
    const shown = "Fetch: https://example.com/a?b=1&c=<2> @everyone <!channel>";
    const post = waitPost(facts({}, { asking: shown }));
    expect(post.asking).toBe(shown);
    expect(post.text).toBe(
      "checkout-flow is waiting for permission: Fetch: https://example.com/a?b=1&amp;c=&lt;2&gt; @\u200beveryone &lt;!channel&gt; (4m 12s, storefront, VS Code, Claude Code)",
    );
    expect(post.text).not.toMatch(/[<>]|@[A-Za-z]/);

    for (const line of [
      "Edit: /Users/example/code/demo/src/app.ts",
      waitingText(`Run: ${"npm run build && ".repeat(30)}`) as string,
    ]) {
      const posted = waitPost(facts({}, { asking: line }));
      // Not cut again to a name's length: the whole line the dashboard shows.
      expect(posted.asking).toBe(line);
      expect(posted.text).toContain(`: ${slackSafe(line)} (4m 12s,`);
      expect(JSON.parse(JSON.stringify(posted))).toEqual(posted);
    }
  });

  test("text handed in that the channel has not cleaned still cannot break the line", () => {
    const raw = `Run: npm test\n<!channel>\r\nsecond line\u2028${"y".repeat(300)}`;
    const post = waitPost(facts({}, { asking: raw }));
    const once = waitingText(raw) as string;
    expect(post.asking).toBe(once);
    expect(post.text).not.toMatch(/[\r\n\u2028]/);
    expect(post.text).toContain(`: ${slackSafe(once)} (4m 12s,`);
    // Cleaning what the channel has cleaned leaves it as it was.
    expect(waitPost(facts({}, { asking: once }))).toEqual(post);
    // Text that is only spaces once cleaned adds nothing.
    expect(waitPost(facts({}, { asking: " \n\t " }))).toEqual(waitPost(facts()));
  });
});

describe("overPost", () => {
  test("says the session finished, failed or ended, when that was seen, and nothing of a wait", () => {
    const session = makeSession({
      name: "billing-webhooks",
      project: "billing-webhooks",
      surface: "terminal",
      status: "finished",
    });
    const seenAt = Date.UTC(2026, 9, 5, 9, 30);
    expect(
      overPost({ event: "finished", session, agent: "Claude Code", seenAt, now: seenAt }),
    ).toEqual({
      text: "billing-webhooks finished (billing-webhooks, Terminal, Claude Code)",
      event: "finished",
      session: {
        name: "billing-webhooks",
        agent: "Claude Code",
        folder: "billing-webhooks",
        app: "Terminal",
      },
      at: "2026-10-05T09:30:00.000Z",
    });
    for (const event of ["failed", "ended"] as const) {
      expect(overPost({ event, session, agent: null, seenAt, now: seenAt }).text).toBe(
        `billing-webhooks ${event} (billing-webhooks, Terminal)`,
      );
    }
  });

  test("never says what a session was asking, whatever the session holds", () => {
    const session = makeSession({ name: "billing-webhooks", waitingText: "Run: npm test" });
    const seenAt = Date.UTC(2026, 9, 5, 9, 30);
    for (const event of ["finished", "failed", "ended"] as const) {
      const post = overPost({ event, session, agent: "Claude Code", seenAt, now: seenAt });
      expect(JSON.stringify(post)).not.toMatch(/asking|npm test/);
    }
  });
});

describe("a session whose app is not known", () => {
  test("its line names the folder and the agent and leaves the app out, and its field is null", () => {
    const post = waitPost(facts({ surface: "unknown" }, { agent: "my-agent" }));
    expect(post.text).toBe(
      "checkout-flow is waiting for permission (4m 12s, storefront, my-agent)",
    );
    expect(post.session).toEqual({
      name: "checkout-flow",
      agent: "my-agent",
      folder: "storefront",
      app: null,
    });
    expect(Object.keys(post.session)).toEqual(["name", "agent", "folder", "app"]);
    expect(JSON.stringify(post)).not.toMatch(/unknown/i);
  });

  test("so does the line of one that finished, failed or ended", () => {
    const session = makeSession({
      name: "billing-webhooks",
      project: "billing-webhooks",
      surface: "unknown",
      status: "finished",
    });
    const seenAt = Date.UTC(2026, 9, 5, 9, 30);
    for (const event of ["finished", "failed", "ended"] as const) {
      const post = overPost({ event, session, agent: "my-agent", seenAt, now: seenAt });
      expect(post.text).toBe(`billing-webhooks ${event} (billing-webhooks, my-agent)`);
      expect(post.session.app).toBeNull();
      expect(JSON.stringify(post)).not.toMatch(/unknown/i);
    }
  });
});

describe("a session name that tries to change the post", () => {
  const HOSTILE = [
    'say "hi" \\ and {"text": "injected"}',
    "line one\nline two\r\nline three\ttabbed\u2028separated",
    "<!channel> deploy now",
    "<!here|here> and <!everyone>",
    "ping <@U123> and <#C123>",
    "<https://example.test/login|Open the report>",
    "fish & chips &amp; &lt;b&gt;",
    "@everyone @here @channel",
    `${"long-name-".repeat(60)}end`,
    "日本語のセッション 🚀 café naïve",
    "\u202eevil reversed\u202c",
    "lone \ud800 surrogate",
  ];

  test.each(HOSTILE)("%j stays one line of plain text, and the JSON stays valid", (name) => {
    const post = waitPost(facts({ name, project: name }, { agent: name }));
    const body = JSON.stringify(post);
    expect(JSON.parse(body)).toEqual(post);
    expect(Object.keys(JSON.parse(body))).toEqual(Object.keys(post));
    expect(Object.keys(JSON.parse(body).session)).toEqual(["name", "agent", "folder", "app"]);
    // A lone surrogate is written as an escape, so the body is valid UTF-8 too.
    expect(Buffer.from(body, "utf8").toString("utf8")).toBe(body);

    const { text } = post;
    expect(text).not.toMatch(/[\r\n\t\u2028\u2029\u202e]/);
    // Slack reads nothing in it as markup: no angle bracket, and every & begins an entity it wrote.
    expect(text).not.toMatch(/[<>]/);
    expect(text.replace(/&(amp|lt|gt);/g, "")).not.toContain("&");
    // No @ is followed straight by a name, so no channel can be pinged.
    expect(text).not.toMatch(/@[A-Za-z]/);

    for (const part of [post.session.name, post.session.folder, post.session.agent]) {
      expect(part).not.toMatch(/[\r\n\t]/);
      expect(Array.from(part ?? "").length).toBeLessThanOrEqual(MAX_LINE_LENGTH);
    }
  });

  test("a mention or a link in a name is shown as written, never acted on", () => {
    expect(waitPost(facts({ name: "<!channel>" })).text).toMatch(/^&lt;!channel&gt; is waiting/);
    expect(waitPost(facts({ name: "<https://example.test|Open>" })).text).toMatch(
      /^&lt;https:\/\/example\.test\|Open&gt; is waiting/,
    );
    // The fields for a program keep the name as it is, cleaned to one line.
    expect(waitPost(facts({ name: "<!channel>" })).session.name).toBe("<!channel>");
  });

  test("a very long name is cut to its length, between letters", () => {
    const post = waitPost(facts({ name: "🚀".repeat(200) }));
    expect(post.session.name).toBe(`${"🚀".repeat(MAX_LINE_LENGTH - 1)}…`);
    expect(post.text.startsWith(`${"🚀".repeat(MAX_LINE_LENGTH - 1)}… is waiting`)).toBe(true);
  });
});

describe("slackSafe", () => {
  test("writes Slack's three markup characters as entities, and breaks every @ from what follows", () => {
    expect(slackSafe("a < b > c & d @e")).toBe("a &lt; b &gt; c &amp; d @\u200be");
    expect(slackSafe("&lt;")).toBe("&amp;lt;");
    expect(slackSafe("plain words")).toBe("plain words");
  });
});

describe("reminderPost", () => {
  test("is the post of a wait, with a line that says how long it has waited and reminder: true", () => {
    const post = reminderPost({
      ...facts({}, { now: BEGUN + 10 * 60_000 + 4_000, asking: "Run: npm test" }),
      thresholdMs: 10 * 60_000,
    });
    expect(post).toEqual({
      // How long is said once, in the words: waitedSeconds has it to the second.
      text: "checkout-flow has waited 10 minutes for permission: Run: npm test (storefront, VS Code, Claude Code)",
      event: "needs-you",
      reason: "permission",
      asking: "Run: npm test",
      session: {
        name: "checkout-flow",
        agent: "Claude Code",
        folder: "storefront",
        app: "VS Code",
      },
      at: "2026-10-05T14:01:05.000Z",
      waitedSeconds: 604,
      reminder: true,
    });
  });

  test("a name meant to ping a channel is made safe", () => {
    const post = reminderPost({ ...facts({ name: "<!channel> @here" }), thresholdMs: 60_000 });
    expect(post.text).toMatch(/^&lt;!channel&gt; @\u200bhere has waited/);
  });
});

describe("summaryPost", () => {
  const FROM = Date.UTC(2026, 9, 5, 22, 0);
  const TO = Date.UTC(2026, 9, 6, 8, 0);
  const session = (name: string) =>
    makeSession({ name, project: "storefront", surface: "terminal" });

  function summary(items: SummaryFacts["items"]): SummaryFacts {
    return { from: FROM, to: TO, items, now: TO };
  }

  test("says it in one line, and each item in fields of its own", () => {
    const post = summaryPost(
      summary([
        {
          event: "needs-you",
          session: session("checkout-flow"),
          at: FROM + 70 * 60_000,
          waitedMs: 31 * 60_000,
          times: 2,
          then: { event: "ended", at: FROM + 300 * 60_000 },
          agent: "Claude Code",
        },
        {
          event: "finished",
          session: session("billing-webhooks"),
          at: FROM + 192 * 60_000,
          agent: null,
        },
      ]),
    );
    expect(post).toEqual({
      text: "While quiet: checkout-flow waited 31 minutes over 2 waits then ended and billing-webhooks finished",
      event: "quiet-summary",
      from: "2026-10-05T22:00:00.000Z",
      to: "2026-10-06T08:00:00.000Z",
      items: [
        {
          event: "needs-you",
          session: {
            name: "checkout-flow",
            agent: "Claude Code",
            folder: "storefront",
            app: "Terminal",
          },
          at: "2026-10-05T23:10:00.000Z",
          waitedSeconds: 1_860,
          times: 2,
          then: { event: "ended", at: "2026-10-06T03:00:00.000Z" },
        },
        {
          event: "finished",
          session: { name: "billing-webhooks", agent: null, folder: "storefront", app: "Terminal" },
          at: "2026-10-06T01:12:00.000Z",
        },
      ],
    });
  });

  test("holds at most a hundred items, and says how many more there were", () => {
    const items = Array.from({ length: MAX_SUMMARY_ITEMS + 5 }, (_, index) => ({
      event: "ended" as const,
      session: session(`session-${index + 1}`),
      at: FROM + index * 1_000,
      agent: null,
    }));
    const post = summaryPost(summary(items));
    expect(post.items).toHaveLength(MAX_SUMMARY_ITEMS);
    expect(post.more).toBe(5);
    expect(post.text).toBe(
      `While quiet: session-1 ended, session-2 ended, session-3 ended, session-4 ended and ${MAX_SUMMARY_ITEMS + 1} more`,
    );
  });

  test("a name meant to ping a channel is made safe in the line", () => {
    const post = summaryPost(
      summary([{ event: "ended", session: session("<!channel>"), at: FROM, agent: null }]),
    );
    expect(post.text).toBe("While quiet: &lt;!channel&gt; ended");
    expect(post).not.toHaveProperty("more");
  });
});
