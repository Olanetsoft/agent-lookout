import { afterEach, expect, test, vi } from "vitest";

import { NOTIFICATIONS_HEADER, type NtfyStatusResponse } from "@core/api";
import { setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";
import { fetchNtfyStatus, ntfyWords } from "@dashboard/lib/phone/ntfyStatus";

afterEach(() => {
  setApiHost();
});

const NOW = new Date(2026, 9, 5, 14, 30).getTime();
const AT_1402 = new Date(2026, 9, 5, 14, 2).getTime();
const UNTIL_1502 = new Date(2026, 9, 5, 15, 2).getTime();

const ON: NtfyStatusResponse = {
  on: true,
  host: "ntfy.sh",
  tokenSet: false,
  events: ["needs-you"],
  afterMs: 60_000,
  asking: false,
  problem: null,
  last: null,
  limitedUntil: null,
};

const OFF: NtfyStatusResponse = {
  on: false,
  host: null,
  tokenSet: null,
  events: null,
  afterMs: null,
  asking: null,
  problem: null,
  last: null,
  limitedUntil: null,
};

test("with nothing set, Settings says ntfy is off and how to turn it on", () => {
  expect(ntfyWords(OFF, NOW)).toEqual({
    state: "ntfy is off.",
    asking: null,
    title: null,
    detail: "Set AGENT_LOOKOUT_NTFY_URL to turn it on.",
  });
});

test("with a setting that is wrong, it says which, and what to do", () => {
  const problem = "AGENT_LOOKOUT_NTFY_ASKING must be on or off.";
  expect(ntfyWords({ ...OFF, problem }, NOW)).toEqual({
    state: "ntfy is off.",
    asking: null,
    title: "ntfy is not set up correctly",
    detail: `${problem} Correct it and start Agent Lookout again.`,
  });
});

test("with it on, it names the server's host, when, whether a wait says what is asked, and whether a token guards the topic", () => {
  expect(ntfyWords(ON, NOW)).toEqual({
    state: "Pushes go to ntfy.sh after a wait of 1 minute.",
    asking: "Pushes leave out what a waiting session is asking.",
    note: "No access token is set, so the topic alone guards the pushes: keep it secret.",
    title: null,
    detail: null,
  });
  expect(ntfyWords({ ...ON, tokenSet: true, asking: true }, NOW)).toMatchObject({
    asking: "Pushes for a wait say what the session is asking.",
    note: "An access token is set.",
  });
  expect(ntfyWords({ ...ON, events: ["needs-you", "finished"], afterMs: 0 }, NOW).state).toBe(
    "Pushes go to ntfy.sh when a session starts waiting or finishes.",
  );
});

test("it says how the last push went, and when the hourly limit holds them back", () => {
  expect(ntfyWords({ ...ON, last: { at: AT_1402, sent: true } }, NOW)).toMatchObject({
    title: null,
    detail: "Last sent at 14:02.",
  });
  expect(
    ntfyWords(
      {
        ...ON,
        last: {
          at: AT_1402,
          sent: false,
          reason: "the ntfy server refused the access token or the topic (status 403)",
        },
      },
      NOW,
    ),
  ).toMatchObject({
    title: "The last push failed",
    detail: "The ntfy server refused the access token or the topic (status 403).",
  });
  expect(
    ntfyWords({ ...ON, last: { at: AT_1402, sent: true }, limitedUntil: UNTIL_1502 }, NOW),
  ).toMatchObject({
    title: "Pushes are held back",
    detail: "20 pushes were tried in the last hour, the most it tries. The next can go at 15:02.",
  });
});

test("the status is read through the app's own seam, and anything else comes back as null", async () => {
  const host = vi.fn<ApiHost>(async () => new Response(JSON.stringify(ON)));
  setApiHost(host);
  expect(await fetchNtfyStatus()).toEqual(ON);
  const [path, init] = host.mock.calls[0] ?? [];
  expect(path).toBe("/api/ntfy");
  expect(init?.method).toBeUndefined();
  expect(new Headers(init?.headers).get(NOTIFICATIONS_HEADER)).toBe("off");

  setApiHost(async () => {
    throw new TypeError("Failed to fetch");
  });
  expect(await fetchNtfyStatus()).toBeNull();
  setApiHost(async () => new Response(JSON.stringify(ON), { status: 500 }));
  expect(await fetchNtfyStatus()).toBeNull();
});
