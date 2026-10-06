// Where the app's window may go, and which links it hands to the system.
//
// The window shows the app's own pages and nothing else. A link the page opens
// that leads anywhere else is either handed to the system, which opens it in
// the right app, or dropped:
//
// - an `https:` address, which opens in the default browser;
// - the deep link to a Claude Code session in VS Code, in the one exact shape
//   the collector builds (`claudeCodeOpenLink`), which opens VS Code there.
//
// Everything else is dropped: `http:`, `file:`, `javascript:`, another app's
// scheme, an address with a user name or password in it. A URL from the page
// reaches nothing but `shell.openExternal`, and only after this check.
//
// It imports nothing from Electron, so it is tested in plain Node.

import { APP_HOST, APP_PROTOCOL } from "../../core/appAddress.ts";
import { CLAUDE_CODE_OPEN_LINK } from "../../core/mapping/claudeCodeMapping.ts";

/** The longest address handed to the system. A real one is far shorter. */
export const MAX_EXTERNAL_LINK_LENGTH = 2048;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Whether an address is one of the app's own pages, which the window may show. */
export function isAppAddress(url: string): boolean {
  const parsed = parse(url);
  return (
    parsed !== null &&
    parsed.protocol === APP_PROTOCOL &&
    parsed.host === APP_HOST &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

/**
 * The address to hand to the system for a link the page opened, or null to
 * drop it. An `https:` address is given back as the URL parser writes it, so
 * what is opened is what was checked.
 */
export function externalLinkFor(url: string): string | null {
  if (url.length > MAX_EXTERNAL_LINK_LENGTH) return null;
  if (CLAUDE_CODE_OPEN_LINK.test(url)) return url;
  const parsed = parse(url);
  if (parsed === null || parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "" || parsed.hostname === "") return null;
  return parsed.href;
}
