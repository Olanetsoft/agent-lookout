// Where the app looks for a newer version of itself: the project's releases on
// GitHub. A release is tagged `v` and its version, such as `v0.2.1`, and the
// release workflow attaches the app's zips and `latest-mac.yml` to it.
//
// "Latest" is GitHub's own: the newest release that is published, and neither
// a draft nor a prerelease. A release still in draft is never seen.
//
// Tests hand the updater endpoints of their own, aimed at a server on
// 127.0.0.1, so no test asks GitHub for anything.

import { isGitHubReleaseAddress, type AllowAddress } from "./releaseRequest.ts";

/** The project on GitHub. */
export const REPOSITORY = "Olanetsoft/agent-lookout";

export interface ReleaseEndpoints {
  /** The latest release's `latest-mac.yml`. */
  manifest: string;
  /** A file of the release of this version. */
  download(version: string, name: string): string;
  /** The page of the release of this version, with its notes. */
  notes(version: string): string;
  /** The page that lists every release. */
  releases: string;
  /** Which addresses may be asked for, the first and each a redirect leads to. */
  allow: AllowAddress;
}

const RELEASES = `https://github.com/${REPOSITORY}/releases`;

/** The tag of a version's release. */
export function tagOf(version: string): string {
  return `v${version}`;
}

export const GITHUB_RELEASES: ReleaseEndpoints = {
  manifest: `${RELEASES}/latest/download/latest-mac.yml`,
  download: (version, name) =>
    `${RELEASES}/download/${encodeURIComponent(tagOf(version))}/${encodeURIComponent(name)}`,
  notes: (version) => `${RELEASES}/tag/${encodeURIComponent(tagOf(version))}`,
  releases: RELEASES,
  allow: isGitHubReleaseAddress,
};
