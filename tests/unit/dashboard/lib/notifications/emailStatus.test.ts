import { afterEach, expect, test, vi } from "vitest";

import { NOTIFICATIONS_HEADER, type EmailStatusResponse } from "@core/api";
import { setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";
import { emailWords, fetchEmailStatus } from "@dashboard/lib/notifications/emailStatus";

afterEach(() => {
  setApiHost();
});

/** 14:02 today on this computer's clock. */
const NOW = new Date(2026, 9, 5, 14, 30).getTime();
const AT_1402 = new Date(2026, 9, 5, 14, 2).getTime();

const ON: EmailStatusResponse = {
  on: true,
  to: "n…@example.com",
  events: ["needs-you"],
  afterMs: 60_000,
  problem: null,
  last: null,
  limitedUntil: null,
};

const OFF: EmailStatusResponse = {
  on: false,
  to: null,
  events: null,
  afterMs: null,
  problem: null,
  last: null,
  limitedUntil: null,
};

test("with nothing set, Settings says email is off and how to turn it on", () => {
  expect(emailWords(OFF, NOW)).toEqual({
    state: "Email is off.",
    title: null,
    detail: "Set AGENT_LOOKOUT_EMAIL_TO and AGENT_LOOKOUT_SMTP_URL to turn it on.",
  });
});

test("with a setting that is wrong, it says so in a title, then which, and what to do", () => {
  expect(emailWords({ ...OFF, problem: "AGENT_LOOKOUT_SMTP_URL is not set." }, NOW)).toEqual({
    state: "Email is off.",
    title: "Email is not set up correctly",
    detail: "AGENT_LOOKOUT_SMTP_URL is not set. Correct it and start Agent Lookout again.",
  });
});

test("with email on, it says where emails go and after how long", () => {
  expect(emailWords(ON, NOW)).toEqual({
    state: "Emails go to n…@example.com after a wait of 1 minute.",
    title: null,
    detail: null,
  });
  expect(emailWords({ ...ON, afterMs: 0 }, NOW).state).toBe(
    "Emails go to n…@example.com as soon as a session waits.",
  );
});

test("with other events chosen, it names each one that sends an email", () => {
  expect(emailWords({ ...ON, events: ["needs-you", "finished"] }, NOW).state).toBe(
    "Emails go to n…@example.com when a session has waited 1 minute or finishes.",
  );
  expect(
    emailWords({ ...ON, events: ["needs-you", "finished", "failed", "ended"], afterMs: 0 }, NOW)
      .state,
  ).toBe("Emails go to n…@example.com when a session starts waiting, finishes, fails or ends.");
  expect(emailWords({ ...ON, events: ["failed"] }, NOW).state).toBe(
    "Emails go to n…@example.com when a session fails.",
  );
  expect(emailWords({ ...ON, events: ["finished", "ended"], afterMs: 90_000 }, NOW).state).toBe(
    "Emails go to n…@example.com when a session finishes or ends.",
  );
});

test("it says how the last email went, with a title when it could not be sent", () => {
  expect(emailWords({ ...ON, last: { at: AT_1402, sent: true } }, NOW)).toMatchObject({
    title: null,
    detail: "Last sent at 14:02.",
  });
  expect(
    emailWords(
      {
        ...ON,
        last: { at: AT_1402, sent: false, reason: "the mail server did not answer in time" },
      },
      NOW,
    ),
  ).toMatchObject({
    title: "The last email could not be sent",
    detail: "The mail server did not answer in time.",
  });
  const yesterday = new Date(2026, 9, 4, 9, 15).getTime();
  expect(emailWords({ ...ON, last: { at: yesterday, sent: true } }, NOW).detail).toMatch(
    /^Last sent at 09:15 on \S+ 4\.$/,
  );
});

test("while the hourly limit holds emails back, it says so and when the next can go", () => {
  const until = new Date(2026, 9, 5, 15, 2).getTime();
  expect(
    emailWords({ ...ON, last: { at: AT_1402, sent: true }, limitedUntil: until }, NOW),
  ).toMatchObject({
    title: "Emails are held back",
    detail: "20 emails were tried in the last hour, the most it tries. The next can go at 15:02.",
  });
});

test("while the limit holds and the last email failed, the failure is said, so failed tries never read as sent", () => {
  const until = new Date(2026, 9, 5, 15, 2).getTime();
  const last = {
    at: AT_1402,
    sent: false as const,
    reason: "the mail server did not accept the user name and password",
  };
  expect(emailWords({ ...ON, last, limitedUntil: until }, NOW)).toMatchObject({
    title: "The last email could not be sent",
    detail:
      "The mail server did not accept the user name and password. No more will be tried until 15:02, as 20 were tried in the last hour.",
  });
});

test("the status is read through the app's own seam, with what every request carries", async () => {
  const host = vi.fn<ApiHost>(async () => new Response(JSON.stringify(ON)));
  setApiHost(host);

  expect(await fetchEmailStatus()).toEqual(ON);
  const [path, init] = host.mock.calls[0] ?? [];
  expect(path).toBe("/api/email");
  expect(init?.method).toBeUndefined();
  expect(new Headers(init?.headers).get(NOTIFICATIONS_HEADER)).toBe("off");
  expect(init?.signal).toBeInstanceOf(AbortSignal);
});

test("no answer, an error or an answer of another shape comes back as null", async () => {
  setApiHost(async () => {
    throw new TypeError("Failed to fetch");
  });
  expect(await fetchEmailStatus()).toBeNull();

  setApiHost(async () => new Response(JSON.stringify(ON), { status: 500 }));
  expect(await fetchEmailStatus()).toBeNull();

  setApiHost(async () => new Response("<!doctype html>"));
  expect(await fetchEmailStatus()).toBeNull();

  setApiHost(async () => new Response(JSON.stringify({ error: "x" })));
  expect(await fetchEmailStatus()).toBeNull();
});
