import { describe, expect, test } from "vitest";

import type { AppUpdateStatus, UpdatePhase } from "@core/appUpdate";
import { foundNotice, updateDialog } from "@desktop/updates/updateDialog";

const RELEASES = "https://github.com/Olanetsoft/agent-lookout/releases";
const NOTES = `${RELEASES}/tag/v0.2.1`;

function status(update: UpdatePhase): AppUpdateStatus {
  return { version: "0.2.0", automatic: true, lastCheckedAt: null, releasesUrl: RELEASES, update };
}

const labels = (update: UpdatePhase) =>
  updateDialog(status(update)).buttons.map((button) => [button.label, button.choice]);

describe("the dialog Check for Updates… shows with the window closed", () => {
  test("says it is up to date", () => {
    const dialog = updateDialog(status({ phase: "up-to-date" }));
    expect(dialog.message).toBe("You're up to date");
    expect(dialog.detail).toBe("Agent Lookout 0.2.0 is the newest version.");
    expect(labels({ phase: "up-to-date" })).toEqual([["OK", "close"]]);
  });

  test("says a latest release with no Mac app has none yet, not an error", () => {
    const dialog = updateDialog(status({ phase: "no-release" }));
    expect(dialog.message).toBe("The latest release has no Mac app yet");
    expect(dialog.detail).toBe("There is nothing to update to. This copy is version 0.2.0.");
    expect(labels({ phase: "no-release" })).toEqual([["OK", "close"]]);
  });

  test("says a latest release with no app for this kind of Mac is an answer too", () => {
    const dialog = updateDialog(status({ phase: "not-for-this-mac" }));
    expect(dialog.message).toBe("The latest release has no app for this kind of Mac");
    expect(dialog.detail).toBe("There is nothing to update to. This copy is version 0.2.0.");
    expect(labels({ phase: "not-for-this-mac" })).toEqual([["OK", "close"]]);
  });

  test("offers Install and Restart once a version is downloaded and checked, and Later", () => {
    const update: UpdatePhase = { phase: "ready", version: "0.2.1", notesUrl: NOTES };
    const dialog = updateDialog(status(update));
    expect(dialog.message).toBe("Version 0.2.1 is available");
    expect(labels(update)).toEqual([
      ["Install and Restart", "install"],
      ["Later", "close"],
    ]);
    expect(dialog.releaseUrl).toBe(NOTES);
  });

  test("while it downloads, offers Settings", () => {
    const update: UpdatePhase = {
      phase: "downloading",
      version: "0.2.1",
      notesUrl: NOTES,
      received: 0,
      total: 10,
    };
    expect(labels(update)).toEqual([
      ["Open Settings", "settings"],
      ["OK", "close"],
    ]);
  });

  test("where it cannot install, says why and offers the release page", () => {
    const update: UpdatePhase = {
      phase: "cannot-install",
      version: "0.2.1",
      notesUrl: NOTES,
      refusal: "disk-image",
    };
    const dialog = updateDialog(status(update));
    expect(dialog.detail).toContain("runs from its disk image");
    expect(dialog.detail).toContain("Applications");
    expect(labels(update)[0]).toEqual(["Open Release Page", "release"]);
    expect(dialog.releaseUrl).toBe(NOTES);
  });

  test("a check that did not work says why, and offers the list of releases", () => {
    const update: UpdatePhase = {
      phase: "failed",
      step: "check",
      reason: "GitHub could not be reached",
      version: null,
      notesUrl: null,
    };
    const dialog = updateDialog(status(update));
    expect(dialog.message).toBe("Agent Lookout could not check for updates");
    expect(dialog.detail).toBe("GitHub could not be reached. Check again later.");
    expect(dialog.releaseUrl).toBe(RELEASES);
  });

  test("a download that did not work names the version, and offers its release page", () => {
    const update: UpdatePhase = {
      phase: "failed",
      step: "download",
      reason: "GitHub could not be reached",
      version: "0.2.1",
      notesUrl: NOTES,
    };
    const dialog = updateDialog(status(update));
    expect(dialog.message).toBe("Version 0.2.1 could not be downloaded");
    expect(dialog.detail).toBe(
      "GitHub could not be reached. Try again later, or download it from the release page.",
    );
    expect(dialog.releaseUrl).toBe(NOTES);
  });
});

describe("the notification of a version the daily check found", () => {
  test("names the version and says it is being downloaded", () => {
    expect(foundNotice("0.2.1", null)).toEqual({
      title: "Agent Lookout 0.2.1 is available",
      body: "Agent Lookout is downloading it. Settings will offer Install and Restart.",
    });
  });

  test("where it cannot be installed, sends the person to Settings to see how", () => {
    expect(foundNotice("0.2.1", "translocated")).toEqual({
      title: "Agent Lookout 0.2.1 is available",
      body: "Open Settings to see how to install it.",
    });
  });
});
