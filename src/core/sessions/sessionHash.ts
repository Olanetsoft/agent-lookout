// The address of one session's details in the dashboard: a fragment of the
// page's URL, `#overview/session/claude-code:1234`, which opens them over the
// Overview. The page writes and reads it, and the Mac app opens it when a
// session is chosen in its menu bar, so both keep to this one rule.

const PREFIX = "#overview/session/";

/**
 * The fragment that opens a session's details. The id is written so that any
 * character a status file's name can hold survives the trip; the colon after
 * the source is left as it is, so the address stays readable.
 */
export function sessionHash(sessionId: string): string {
  return `${PREFIX}${encodeURIComponent(sessionId).replace(/%3A/gi, ":")}`;
}

/** The session a URL fragment names, or null when it names none. */
export function sessionIdFromHash(hash: string): string | null {
  if (!hash.startsWith(PREFIX)) return null;
  const written = hash.slice(PREFIX.length);
  if (written === "") return null;
  try {
    return decodeURIComponent(written);
  } catch {
    // A fragment typed by hand can be badly escaped. It is read as written.
    return written;
  }
}
