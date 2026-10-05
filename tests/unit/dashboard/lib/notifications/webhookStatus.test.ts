import { afterEach, expect, test, vi } from "vitest";

import { NOTIFICATIONS_HEADER, type WebhookStatusResponse } from "@core/api";
import { setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";
import { fetchWebhookStatus, webhookWords } from "@dashboard/lib/notifications/webhookStatus";

afterEach(() => {
  setApiHost();
});

const NOW = new Date(2026, 9, 5, 14, 30).getTime();
const AT_1402 = new Date(2026, 9, 5, 14, 2).getTime();
const UNTIL_1502 = new Date(2026, 9, 5, 15, 2).getTime();

const ON: WebhookStatusResponse = {
  on: true,
  host: "hooks.slack.com",
  events: ["needs-you"],
  afterMs: 60_000,
  problem: null,
  last: null,
  limitedUntil: null,
};

const OFF: WebhookStatusResponse = {
  on: false,
  host: null,
  events: null,
  afterMs: null,
  problem: null,
  last: null,
  limitedUntil: null,
};

test("with nothing set, Settings says the webhook is off and how to turn it on", () => {
  expect(webhookWords(OFF, NOW)).toEqual({
    state: "The webhook is off.",
    detail: "Set AGENT_LOOKOUT_WEBHOOK_URL to turn it on.",
  });
});

test("with a setting that is wrong, it says which, and what to do", () => {
  const problem =
    "AGENT_LOOKOUT_WEBHOOK_URL must begin with https://, or with http:// for an address on this computer, 127.0.0.1 or localhost.";
  expect(webhookWords({ ...OFF, problem }, NOW)).toEqual({
    state: "The webhook is off.",
    detail: `${problem} Correct it and start Agent Lookout again.`,
  });
});

test("with it on, it names the host the posts go to, when, and for which events", () => {
  expect(webhookWords(ON, NOW)).toEqual({
    state: "Posts go to hooks.slack.com after a wait of 1 minute.",
    detail: null,
  });
  expect(webhookWords({ ...ON, afterMs: 0 }, NOW).state).toBe(
    "Posts go to hooks.slack.com as soon as a session waits.",
  );
  expect(webhookWords({ ...ON, events: ["needs-you", "finished", "failed"] }, NOW).state).toBe(
    "Posts go to hooks.slack.com when a session has waited 1 minute, finishes or fails.",
  );
});

test("it says how the last post went", () => {
  expect(webhookWords({ ...ON, last: { at: AT_1402, sent: true } }, NOW).detail).toBe(
    "Last posted at 14:02.",
  );
  expect(
    webhookWords(
      { ...ON, last: { at: AT_1402, sent: false, reason: "the address did not answer in time" } },
      NOW,
    ).detail,
  ).toBe("The last post failed: the address did not answer in time.");
});

test("while the hourly limit holds posts back, it says when the next can go, a failure first", () => {
  expect(
    webhookWords({ ...ON, last: { at: AT_1402, sent: true }, limitedUntil: UNTIL_1502 }, NOW)
      .detail,
  ).toBe("20 posts were tried in the last hour, the most it tries. The next can go at 15:02.");
  expect(
    webhookWords(
      {
        ...ON,
        last: { at: AT_1402, sent: false, reason: "the address refused the post (status 403)" },
        limitedUntil: UNTIL_1502,
      },
      NOW,
    ).detail,
  ).toBe(
    "The last post failed: the address refused the post (status 403). No more will be tried until 15:02, as 20 were tried in the last hour.",
  );
});

test("the status is read through the app's own seam, and anything else comes back as null", async () => {
  const host = vi.fn<ApiHost>(async () => new Response(JSON.stringify(ON)));
  setApiHost(host);
  expect(await fetchWebhookStatus()).toEqual(ON);
  const [path, init] = host.mock.calls[0] ?? [];
  expect(path).toBe("/api/webhook");
  expect(init?.method).toBeUndefined();
  expect(new Headers(init?.headers).get(NOTIFICATIONS_HEADER)).toBe("off");

  setApiHost(async () => {
    throw new TypeError("Failed to fetch");
  });
  expect(await fetchWebhookStatus()).toBeNull();
  setApiHost(async () => new Response(JSON.stringify(ON), { status: 500 }));
  expect(await fetchWebhookStatus()).toBeNull();
  setApiHost(async () => new Response("<!doctype html>"));
  expect(await fetchWebhookStatus()).toBeNull();
});
