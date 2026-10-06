// Version numbers as semver writes them, `0.2.1`, and the one rule the app
// offers an update by: a release that is newer than this copy, and is not a
// prerelease.
//
// It imports nothing, so it is tested in plain Node.

/** A version number read as semver reads it. */
export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** What follows a `-`, such as `beta.1`, split at its dots. Empty for a release. */
  prerelease: readonly string[];
}

/** Far longer than any version number this project writes. */
const MAX_VERSION_LENGTH = 64;

const NUMBER = "(0|[1-9]\\d*)";
const IDENTIFIERS = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
const SEMVER = new RegExp(
  `^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-(${IDENTIFIERS}))?(?:\\+(${IDENTIFIERS}))?$`,
);

/**
 * A version read from its text, such as `0.2.1` or `0.3.0-beta.1`, or null
 * when it is not one. A tag's `v`, as in `v0.2.1`, makes it not a version.
 */
export function parseVersion(text: string): Version | null {
  if (text.length === 0 || text.length > MAX_VERSION_LENGTH) return null;
  const match = SEMVER.exec(text);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const prerelease = match[4] === undefined ? [] : match[4].split(".");
  // A number in a prerelease has no leading zero, as in the version itself.
  if (prerelease.some((part) => /^0\d+$/.test(part))) return null;
  return { major, minor, patch, prerelease };
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  // A number comes before a word.
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Which of two versions comes first, by semver's rules: negative when `a`
 * does, positive when `b` does, and zero when they are the same version. A
 * prerelease comes before the release of the same number.
 */
export function compareVersions(a: Version, b: Version): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return Math.sign(a[key] - b[key]);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const order = compareIdentifiers(left, right);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * Whether a release's version is one to offer this copy: a release and not a
 * prerelease, and newer than this copy. A version that cannot be read on
 * either side is never offered.
 */
export function isOffered(offered: string, current: string): boolean {
  const release = parseVersion(offered);
  const running = parseVersion(current);
  if (release === null || running === null) return false;
  if (release.prerelease.length > 0) return false;
  return compareVersions(release, running) > 0;
}
