/**
 * The last segment of a working directory, or null when there is none. Every
 * adapter names a session's project this way, and falls back to it for a
 * session that has no name of its own.
 */
export function projectOf(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const segments = cwd.split(/[\\/]+/).filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? null;
}
