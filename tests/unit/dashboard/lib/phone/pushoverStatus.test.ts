import { afterEach, expect, test, vi } from "vitest";

import type { PushoverStatusResponse } from "@core/api";
import { setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";
import { fetchPushoverStatus, pushoverWords } from "@dashboard/lib/phone/pushoverStatus";

afterEach(() => {
  setApiHost();
});

const NOW = new Date(2026, 9, 5, 14, 30).getTime();
const AT_1402 = new Date(2026, 9, 5, 14, 2).getTime();

const ON: PushoverStatusResponse = {
  on: true,
  events: ["needs-you"],
  afterMs: 60_000,
  asking: false,
  problem: null,
  last: null,
  limitedUntil: null,
};

const OFF: PushoverStatusResponse = {
  on: false,
  events: null,
  afterMs: null,
  asking: null,
  problem: null,
  last: null,
  limitedUntil: null,
};

test("with nothing set, Settings says Pushover is off and which two settings turn it on", () => {
  expect(pushoverWords(OFF, NOW)).toEqual({
    state: "Pushover is off.",
    asking: null,
    title: null,
    detail: "Set AGENT_LOOKOUT_PUSHOVER_TOKEN and AGENT_LOOKOUT_PUSHOVER_USER to turn it on.",
  });
});

test("with one key missing, it says which, and what to do", () => {
  expect(
    pushoverWords({ ...OFF, problem: "AGENT_LOOKOUT_PUSHOVER_USER is not set." }, NOW),
  ).toEqual({
    state: "Pushover is off.",
    asking: null,
    title: "Pushover is not set up correctly",
    detail: "AGENT_LOOKOUT_PUSHOVER_USER is not set. Correct it and start Agent Lookout again.",
  });
});

test("with it on, it says pushes go to Pushover, when, and how the last went", () => {
  expect(pushoverWords(ON, NOW)).toEqual({
    state: "Pushes go to Pushover after a wait of 1 minute.",
    asking: "Pushes leave out what a waiting session is asking.",
    title: null,
    detail: null,
  });
  expect(pushoverWords({ ...ON, asking: true, last: { at: AT_1402, sent: true } }, NOW)).toEqual({
    state: "Pushes go to Pushover after a wait of 1 minute.",
    asking: "Pushes for a wait say what the session is asking.",
    title: null,
    detail: "Last sent at 14:02.",
  });
});

test("the status is read through the app's own seam, and anything else comes back as null", async () => {
  const host = vi.fn<ApiHost>(async () => new Response(JSON.stringify(ON)));
  setApiHost(host);
  expect(await fetchPushoverStatus()).toEqual(ON);
  expect(host.mock.calls[0]?.[0]).toBe("/api/pushover");
  setApiHost(async () => new Response("<!doctype html>"));
  expect(await fetchPushoverStatus()).toBeNull();
});
