import { afterEach, describe, expect, test, vi } from "vitest";

import { ACTION_HEADER, NOTIFICATIONS_HEADER } from "@core/api";
import type { AppUpdateStatus } from "@core/appUpdate";
import { setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";
import {
  fetchUpdateStatus,
  readUpdateStatus,
  requestAutomaticUpdates,
  requestUpdateCheck,
  requestUpdateInstall,
} from "@dashboard/lib/updates/appUpdate";

afterEach(() => {
  setApiHost();
});

const RELEASES = "https://github.com/Olanetsoft/agent-lookout/releases";
const NOTES = `${RELEASES}/tag/v0.2.1`;

const STATUS: AppUpdateStatus = {
  version: "0.2.0",
  automatic: true,
  lastCheckedAt: 1_790_000_000_000,
  releasesUrl: RELEASES,
  update: { phase: "ready", version: "0.2.1", notesUrl: NOTES },
};

function answering(status: number, body: unknown) {
  const host = vi.fn<ApiHost>(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  setApiHost(host);
  return host;
}

describe("readUpdateStatus", () => {
  test("reads each phase the app can give", () => {
    for (const update of [
      { phase: "idle" },
      { phase: "checking" },
      { phase: "up-to-date" },
      { phase: "no-release" },
      { phase: "downloading", version: "0.2.1", notesUrl: NOTES, received: 10, total: 100 },
      { phase: "ready", version: "0.2.1", notesUrl: NOTES },
      { phase: "installing", version: "0.2.1", notesUrl: NOTES },
      { phase: "cannot-install", version: "0.2.1", notesUrl: NOTES, refusal: "translocated" },
      {
        phase: "failed",
        step: "check",
        reason: "GitHub could not be reached",
        version: null,
        notesUrl: null,
      },
    ] as const) {
      expect(readUpdateStatus({ ...STATUS, update })?.update, update.phase).toEqual(update);
    }
  });

  test.each([
    ["no version", { ...STATUS, version: "" }],
    ["a switch that is not one", { ...STATUS, automatic: "yes" }],
    [
      "a page of releases that is not an https: address",
      { ...STATUS, releasesUrl: "javascript:alert(1)" },
    ],
    ["a phase it does not know", { ...STATUS, update: { phase: "exploded" } }],
    [
      "release notes at another kind of address",
      { ...STATUS, update: { phase: "ready", version: "0.2.1", notesUrl: "file:///etc" } },
    ],
    [
      "a reason it does not know",
      {
        ...STATUS,
        update: { phase: "cannot-install", version: "0.2.1", notesUrl: NOTES, refusal: "?" },
      },
    ],
    [
      "a download with no progress",
      { ...STATUS, update: { phase: "downloading", version: "0.2.1", notesUrl: NOTES } },
    ],
    ["nothing", null],
  ])("reads nothing from an answer with %s", (_what, value) => {
    expect(readUpdateStatus(value)).toBeNull();
  });

  test("a time of the last check that cannot be one is not known", () => {
    expect(readUpdateStatus({ ...STATUS, lastCheckedAt: -1 })?.lastCheckedAt).toBeNull();
    expect(readUpdateStatus({ ...STATUS, lastCheckedAt: "today" })?.lastCheckedAt).toBeNull();
  });
});

describe("the requests", () => {
  test("the status is a GET through the page's own seam", async () => {
    const host = answering(200, STATUS);
    expect(await fetchUpdateStatus()).toEqual(STATUS);
    const [path, init] = host.mock.calls[0] ?? [];
    expect(path).toBe("/api/app/update");
    expect(init?.method).toBeUndefined();
    expect(new Headers(init?.headers).has(NOTIFICATIONS_HEADER)).toBe(true);
  });

  test.each([
    ["a check", requestUpdateCheck, "/api/app/update/check", "check-for-updates", "{}"],
    ["an install", requestUpdateInstall, "/api/app/update/install", "install-update", "{}"],
    [
      "the switch",
      () => requestAutomaticUpdates(false),
      "/api/app/update/setting",
      "update-setting",
      '{"automatic":false}',
    ],
  ] as const)(
    "%s is a POST of JSON with its own action, and nothing more",
    async (_what, ask, path, action, body) => {
      const host = answering(200, STATUS);
      expect(await ask()).toEqual(STATUS);
      const [asked, init] = host.mock.calls[0] ?? [];
      expect(asked).toBe(path);
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get(ACTION_HEADER)).toBe(action);
      expect(headers.get("content-type")).toBe("application/json");
      expect(init?.body).toBe(body);
    },
  );

  test("an install refused with 409 still says where updates stand", async () => {
    answering(409, { error: "No version is ready to install here.", status: STATUS });
    expect(await requestUpdateInstall()).toEqual(STATUS);
  });

  test("no answer, or one that is not a status, is null", async () => {
    setApiHost(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await fetchUpdateStatus()).toBeNull();
    expect(await requestUpdateCheck()).toBeNull();
    answering(404, { error: "There is nothing at that address." });
    expect(await fetchUpdateStatus()).toBeNull();
    expect(await requestUpdateCheck()).toBeNull();
  });
});
