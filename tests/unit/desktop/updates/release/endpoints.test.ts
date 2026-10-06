import { describe, expect, test } from "vitest";

import { GITHUB_RELEASES, REPOSITORY, tagOf } from "@desktop/updates/release/endpoints";

describe("the project's releases on GitHub", () => {
  test("the latest release's manifest, a version's files and its notes", () => {
    expect(REPOSITORY).toBe("Olanetsoft/agent-lookout");
    expect(GITHUB_RELEASES.manifest).toBe(
      "https://github.com/Olanetsoft/agent-lookout/releases/latest/download/latest-mac.yml",
    );
    expect(GITHUB_RELEASES.download("0.2.1", "Agent-Lookout-0.2.1-mac-arm64.zip")).toBe(
      "https://github.com/Olanetsoft/agent-lookout/releases/download/v0.2.1/Agent-Lookout-0.2.1-mac-arm64.zip",
    );
    expect(GITHUB_RELEASES.notes("0.2.1")).toBe(
      "https://github.com/Olanetsoft/agent-lookout/releases/tag/v0.2.1",
    );
    expect(GITHUB_RELEASES.releases).toBe("https://github.com/Olanetsoft/agent-lookout/releases");
    expect(tagOf("0.2.1")).toBe("v0.2.1");
  });

  test("every address it names is one it may ask for", () => {
    for (const url of [
      GITHUB_RELEASES.manifest,
      GITHUB_RELEASES.download("0.2.1", "Agent-Lookout-0.2.1-mac-x64.zip"),
    ]) {
      expect(GITHUB_RELEASES.allow(new URL(url))).toBe(true);
    }
  });
});
