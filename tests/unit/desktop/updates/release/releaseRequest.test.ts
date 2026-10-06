import { describe, expect, test } from "vitest";

import {
  GITHUB_RELEASE_HOSTS,
  isGitHubReleaseAddress,
  redirectTarget,
} from "@desktop/updates/release/releaseRequest";

const allowed = (url: string) => isGitHubReleaseAddress(new URL(url));

describe("isGitHubReleaseAddress", () => {
  test("allows GitHub and the two hosts it sends a release's downloads to, over HTTPS", () => {
    expect(GITHUB_RELEASE_HOSTS).toEqual([
      "github.com",
      "release-assets.githubusercontent.com",
      "objects.githubusercontent.com",
    ]);
    expect(
      allowed("https://github.com/Olanetsoft/agent-lookout/releases/latest/download/latest-mac.yml"),
    ).toBe(true);
    expect(
      allowed(
        "https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sp=r&sig=x",
      ),
    ).toBe(true);
    expect(allowed("https://objects.githubusercontent.com/github-production-release-asset-2e65be/1")).toBe(
      true,
    );
  });

  test.each([
    ["plain HTTP", "http://github.com/Olanetsoft/agent-lookout/releases"],
    ["another host", "https://example.com/latest-mac.yml"],
    ["a host that ends like GitHub's", "https://evilgithub.com/latest-mac.yml"],
    ["a host under GitHub's", "https://gist.github.com/latest-mac.yml"],
    ["a host that starts like GitHub's", "https://github.com.example.com/latest-mac.yml"],
    ["GitHub's API", "https://api.github.com/repos/x/y/releases/latest"],
    ["raw files", "https://raw.githubusercontent.com/x/y/main/latest-mac.yml"],
    ["another port", "https://github.com:8443/latest-mac.yml"],
    ["a user name", "https://someone@github.com/latest-mac.yml"],
    ["a password", "https://someone:secret@github.com/latest-mac.yml"],
    ["a file", "file:///etc/hosts"],
  ])("refuses %s", (_what, url) => {
    expect(allowed(url)).toBe(false);
  });
});

describe("redirectTarget", () => {
  const from = new URL("https://github.com/Olanetsoft/agent-lookout/releases/latest/download/latest-mac.yml");

  test("follows a redirect to an allowed address, resolving one given relative to the last", () => {
    expect(
      redirectTarget(
        from,
        "/Olanetsoft/agent-lookout/releases/download/v0.2.1/latest-mac.yml",
        isGitHubReleaseAddress,
      ),
    ).toEqual(new URL("https://github.com/Olanetsoft/agent-lookout/releases/download/v0.2.1/latest-mac.yml"));
    expect(
      redirectTarget(
        from,
        "https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sig=x",
        isGitHubReleaseAddress,
      ),
    ).toEqual(new URL("https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sig=x"));
  });

  test("refuses a redirect anywhere else, plain HTTP included", () => {
    expect(redirectTarget(from, "https://example.com/latest-mac.yml", isGitHubReleaseAddress)).toBe(
      "refused",
    );
    expect(redirectTarget(from, "http://github.com/latest-mac.yml", isGitHubReleaseAddress)).toBe(
      "refused",
    );
    expect(redirectTarget(from, "//example.com/x", isGitHubReleaseAddress)).toBe("refused");
  });

  test("a redirect that says nowhere is a status that cannot be followed", () => {
    expect(redirectTarget(from, undefined, isGitHubReleaseAddress)).toBe("status");
    expect(redirectTarget(from, "", isGitHubReleaseAddress)).toBe("status");
    expect(redirectTarget(from, "http://[::1", isGitHubReleaseAddress)).toBe("status");
  });
});
