import { describe, expect, test } from "vitest";

import {
  readWebhookSetup,
  webhookProblemLine,
  type WebhookSetup,
} from "@collector/webhook/webhookSettings";

/** An address shaped like a Slack incoming webhook's, with an invented token. */
const SLACK_LIKE = "https://hooks.example.com/services/T0000/B0000/s3cret-webhook-token";

const read = (env: Record<string, string>) => readWebhookSetup(env);

/** The problem, for a setup that is off. */
function problemOf(setup: WebhookSetup): string | null {
  if (setup.on) throw new Error("Expected the webhook to be off.");
  return setup.problem;
}

describe("readWebhookSetup", () => {
  test("with nothing set, the webhook is off and there is nothing to say", () => {
    expect(read({})).toEqual({ on: false, problem: null });
    expect(read({ AGENT_LOOKOUT_WEBHOOK_URL: "   " })).toEqual({ on: false, problem: null });
  });

  test("without an address it stays off, whatever else is set, so unsetting the address turns it off", () => {
    expect(
      read({ AGENT_LOOKOUT_WEBHOOK_EVENTS: "finished", AGENT_LOOKOUT_WEBHOOK_AFTER: "nonsense" }),
    ).toEqual({ on: false, problem: null });
  });

  test("an https:// address turns it on, for a wait alone after a minute unless told otherwise", () => {
    const setup = read({ AGENT_LOOKOUT_WEBHOOK_URL: ` ${SLACK_LIKE} ` });
    if (!setup.on) throw new Error("Expected the webhook to be on.");
    expect(setup.settings.url.href).toBe(SLACK_LIKE);
    expect(setup.settings.events).toEqual(["needs-you"]);
    expect(setup.settings.afterMs).toBe(60_000);
  });

  test("the events and the delay are read as email reads its own", () => {
    const setup = read({
      AGENT_LOOKOUT_WEBHOOK_URL: SLACK_LIKE,
      AGENT_LOOKOUT_WEBHOOK_EVENTS: " Finished, needs-you ,finished",
      AGENT_LOOKOUT_WEBHOOK_AFTER: "0",
    });
    if (!setup.on) throw new Error("Expected the webhook to be on.");
    expect(setup.settings.events).toEqual(["needs-you", "finished"]);
    expect(setup.settings.afterMs).toBe(0);
  });

  test("http:// is taken only for an address on this computer", () => {
    for (const url of ["http://127.0.0.1:8123/hook", "http://localhost/relay?channel=ops"]) {
      expect(read({ AGENT_LOOKOUT_WEBHOOK_URL: url }).on).toBe(true);
    }
    for (const url of [
      "http://hooks.example.com/services/T0000/B0000/s3cret-webhook-token",
      "http://192.168.1.20/hook",
      "http://[::1]:8123/hook",
    ]) {
      expect(problemOf(read({ AGENT_LOOKOUT_WEBHOOK_URL: url }))).toBe(
        "AGENT_LOOKOUT_WEBHOOK_URL must begin with https://, or with http:// for an address on this computer, 127.0.0.1 or localhost.",
      );
    }
  });

  test("an address that is not one, or not a web address, is refused", () => {
    const unreadable =
      "AGENT_LOOKOUT_WEBHOOK_URL could not be read. Copy the whole address, beginning https://.";
    for (const url of [
      "hooks.example.com/services/T0000/B0000/s3cret-webhook-token",
      "https://",
      `https://hooks.example.com/${"x".repeat(2_100)}`,
    ]) {
      expect(problemOf(read({ AGENT_LOOKOUT_WEBHOOK_URL: url }))).toBe(unreadable);
    }
    for (const url of [
      "ftp://hooks.example.com/s3cret",
      "javascript:alert(1)",
      "file:///etc/hosts",
    ]) {
      expect(problemOf(read({ AGENT_LOOKOUT_WEBHOOK_URL: url }))).toMatch(
        /^AGENT_LOOKOUT_WEBHOOK_URL must begin with https:\/\//,
      );
    }
  });

  test("a host the page could not show is refused, so the page never says off while posts go out", () => {
    for (const url of [
      "https://relay_one.example.test/hook",
      "https://hooks.example.com./services/T0000/B0000/s3cret-webhook-token",
    ]) {
      expect(read({ AGENT_LOOKOUT_WEBHOOK_URL: url }).on, url).toBe(true);
    }
    for (const url of [
      "https://a*b.example.com/services/T0000/B0000/s3cret-webhook-token",
      "https://a~b.example.com/hook",
      `https://${"a".repeat(300)}.example.com/hook`,
    ]) {
      const problem = problemOf(read({ AGENT_LOOKOUT_WEBHOOK_URL: url }));
      expect(problem).toBe(
        "AGENT_LOOKOUT_WEBHOOK_URL must name its host in letters, digits, dots and dashes, such as hooks.slack.com.",
      );
      expect(problem).not.toContain("example.com");
    }
  });

  test("an address with a user name or a password in it is refused", () => {
    expect(
      problemOf(read({ AGENT_LOOKOUT_WEBHOOK_URL: "https://name:s3cret@hooks.example.com/hook" })),
    ).toBe("AGENT_LOOKOUT_WEBHOOK_URL must not hold a user name or a password.");
  });

  test("a delay or a list of events that cannot be read turns it off, naming the setting", () => {
    expect(
      problemOf(
        read({ AGENT_LOOKOUT_WEBHOOK_URL: SLACK_LIKE, AGENT_LOOKOUT_WEBHOOK_AFTER: "a minute" }),
      ),
    ).toBe(
      "AGENT_LOOKOUT_WEBHOOK_AFTER must be a whole number of seconds from 0 to 86400, such as 60.",
    );
    expect(
      problemOf(
        read({ AGENT_LOOKOUT_WEBHOOK_URL: SLACK_LIKE, AGENT_LOOKOUT_WEBHOOK_AFTER: "86401" }),
      ),
    ).toMatch(/^AGENT_LOOKOUT_WEBHOOK_AFTER must be/);
    for (const events of ["sometimes", "finished,sometimes", ","]) {
      expect(
        problemOf(
          read({ AGENT_LOOKOUT_WEBHOOK_URL: SLACK_LIKE, AGENT_LOOKOUT_WEBHOOK_EVENTS: events }),
        ),
      ).toBe(
        "AGENT_LOOKOUT_WEBHOOK_EVENTS must be one or more of needs-you, finished, failed, ended, separated by commas, such as needs-you,finished.",
      );
    }
  });

  test("no line it gives ever holds any part of the address", () => {
    const secrets = ["s3cret", "T0000", "B0000", "hooks.example.com", "services", "name:"];
    const wrong: Record<string, string>[] = [
      { AGENT_LOOKOUT_WEBHOOK_URL: SLACK_LIKE.replace("https", "http") },
      { AGENT_LOOKOUT_WEBHOOK_URL: SLACK_LIKE.replace("https://", "") },
      { AGENT_LOOKOUT_WEBHOOK_URL: SLACK_LIKE.replace("https", "ftp") },
      { AGENT_LOOKOUT_WEBHOOK_URL: "https://name:s3cret@hooks.example.com/services/T0000" },
      { AGENT_LOOKOUT_WEBHOOK_URL: SLACK_LIKE.replace("hooks.", "hooks*") },
      { AGENT_LOOKOUT_WEBHOOK_URL: `${SLACK_LIKE}${"%".repeat(3_000)}` },
      { AGENT_LOOKOUT_WEBHOOK_URL: SLACK_LIKE, AGENT_LOOKOUT_WEBHOOK_AFTER: SLACK_LIKE },
      { AGENT_LOOKOUT_WEBHOOK_URL: SLACK_LIKE, AGENT_LOOKOUT_WEBHOOK_EVENTS: SLACK_LIKE },
    ];
    for (const env of wrong) {
      const problem = problemOf(read(env));
      expect(problem).not.toBeNull();
      const line = webhookProblemLine(problem as string);
      expect(line).toMatch(/^Webhook notifications are off: AGENT_LOOKOUT_WEBHOOK_/);
      for (const secret of secrets) expect(line).not.toContain(secret);
    }
  });
});
