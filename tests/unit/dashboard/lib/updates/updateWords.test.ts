import { describe, expect, test } from "vitest";

import type { AppUpdateStatus, UpdatePhase } from "@core/appUpdate";
import { lastCheckedWords, updateWords } from "@dashboard/lib/updates/updateWords";

const RELEASES = "https://github.com/Olanetsoft/agent-lookout/releases";
const NOTES = `${RELEASES}/tag/v0.2.1`;

function status(update: UpdatePhase, change: Partial<AppUpdateStatus> = {}): AppUpdateStatus {
  return {
    version: "0.2.0",
    automatic: true,
    lastCheckedAt: null,
    releasesUrl: RELEASES,
    update,
    ...change,
  };
}

describe("updateWords", () => {
  test("before a check, says how the app checks", () => {
    expect(updateWords(status({ phase: "idle" })).state).toBe(
      "Agent Lookout checks about once a day.",
    );
    expect(updateWords(status({ phase: "idle" }, { automatic: false })).state).toBe(
      "Agent Lookout checks only when you ask.",
    );
  });

  test("while checking, the button waits", () => {
    const words = updateWords(status({ phase: "checking" }));
    expect(words.state).toBe("Checking for updates…");
    expect(words.canCheck).toBe(false);
  });

  test("up to date, and no Mac app in the latest release, are answers and none has a note", () => {
    const upToDate = updateWords(status({ phase: "up-to-date" }));
    expect(upToDate.state).toBe("You're up to date.");
    expect(upToDate.note).toBeNull();
    const noRelease = updateWords(status({ phase: "no-release" }));
    expect(noRelease.state).toBe("The latest release has no Mac app yet.");
    expect(noRelease.note).toBeNull();
    expect(noRelease.canCheck).toBe(true);
    const notHere = updateWords(status({ phase: "not-for-this-mac" }));
    expect(notHere.state).toBe("The latest release has no app for this kind of Mac.");
    expect(notHere.note).toBeNull();
    expect(notHere.canCheck).toBe(true);
  });

  test("a version found says so, with its release notes, and its progress while it downloads", () => {
    const words = updateWords(
      status({
        phase: "downloading",
        version: "0.2.1",
        notesUrl: NOTES,
        received: 34 * 1024 * 1024,
        total: 101 * 1024 * 1024,
      }),
    );
    expect(words.state).toBe("Version 0.2.1 is available.");
    expect(words.detail).toBe("Downloading it: 34 MB of 101 MB.");
    expect(words.notesUrl).toBe(NOTES);
    expect(words.install).toBe(false);
  });

  test("once downloaded and checked, offers Install and Restart", () => {
    const words = updateWords(status({ phase: "ready", version: "0.2.1", notesUrl: NOTES }));
    expect(words.state).toBe("Version 0.2.1 is available.");
    expect(words.detail).toBe("Downloaded and checked.");
    expect(words.install).toBe(true);
  });

  test("a version that cannot be installed here says why and links its release page", () => {
    const words = updateWords(
      status({
        phase: "cannot-install",
        version: "0.2.1",
        notesUrl: NOTES,
        refusal: "translocated",
      }),
    );
    expect(words.state).toBe("Version 0.2.1 is available.");
    expect(words.install).toBe(false);
    expect(words.note?.title).toBe("Agent Lookout cannot update itself here");
    expect(words.note?.detail).toContain("Move Agent Lookout to the Applications folder");
    // The note links the release page, so nothing else says it or links it again.
    expect(words.note?.detail).not.toMatch(/release page/i);
    expect(words.note?.link).toBe(NOTES);
    expect(words.notesUrl).toBeNull();
  });

  test("a check that did not work says why, in a note", () => {
    const words = updateWords(
      status({
        phase: "failed",
        step: "check",
        reason: "GitHub did not answer in time",
        version: null,
        notesUrl: null,
      }),
    );
    expect(words.state).toBe("The last check did not work.");
    expect(words.note).toEqual({
      title: "Agent Lookout could not check for updates",
      detail: "GitHub did not answer in time. Check again in a while.",
      link: RELEASES,
    });
  });

  test("a download that did not work names the version, and offers its page", () => {
    const words = updateWords(
      status({
        phase: "failed",
        step: "download",
        reason: "the download did not match the SHA-512 the release gives",
        version: "0.2.1",
        notesUrl: NOTES,
      }),
    );
    expect(words.state).toBe("Version 0.2.1 is available.");
    expect(words.note).toEqual({
      title: "Version 0.2.1 could not be downloaded",
      detail:
        "The download did not match the SHA-512 the release gives. Check again to try once more.",
      link: NOTES,
    });
    expect(words.notesUrl).toBeNull();
  });

  test("an install that did not work names the version", () => {
    const words = updateWords(
      status({
        phase: "failed",
        step: "install",
        reason: "the new version could not be moved into this copy's place",
        version: "0.2.1",
        notesUrl: NOTES,
      }),
    );
    expect(words.note?.title).toBe("Version 0.2.1 could not be installed");
    expect(words.note?.detail).toBe(
      "The new version could not be moved into this copy's place. Check again to try once more.",
    );
  });
});

describe("lastCheckedWords", () => {
  test("says when, with the day once it was not today, or that it has not yet", () => {
    const now = new Date(2026, 9, 6, 15, 0).getTime();
    expect(lastCheckedWords(status({ phase: "idle" }), now)).toBe("Not yet");
    expect(
      lastCheckedWords(
        status({ phase: "idle" }, { lastCheckedAt: new Date(2026, 9, 6, 14, 2).getTime() }),
        now,
      ),
    ).toBe("14:02");
    expect(
      lastCheckedWords(
        status({ phase: "idle" }, { lastCheckedAt: new Date(2026, 9, 4, 9, 5).getTime() }),
        now,
      ),
    ).toBe("09:05 on Oct 4");
  });
});
