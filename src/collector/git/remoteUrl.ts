import { isGitHubRepository, type GitHubRepository } from "../../core/sessions/pullRequest.ts";

/**
 * Which repository on github.com a remote's address names, from the address
 * alone. Only the owner and the name are kept: never the address, and never a
 * user name or password written in it.
 *
 * Git writes a remote in one of these shapes, and each is read:
 *
 * - `https://github.com/owner/name.git`, with or without `.git`, a slash at the
 *   end, or a user name and password before the host; `http://` too
 * - `ssh://git@github.com/owner/name.git`, with or without a port, and
 *   `ssh://git@ssh.github.com:443/owner/name.git`, GitHub's SSH over 443
 * - `git@github.com:owner/name.git`, the short form SSH takes
 * - `git://github.com/owner/name.git`
 *
 * Any other host is passed over, a GitHub Enterprise server's among them, as
 * is a host name an SSH configuration stands in for github.com, a folder on
 * this computer, and an address with a query, a fragment or an escape in it.
 */

/** The hosts that are github.com. */
const GITHUB_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "www.github.com",
  "ssh.github.com",
]);

/** The schemes git reaches github.com by. */
const SCHEMES: ReadonlySet<string> = new Set(["https", "http", "ssh", "git", "git+ssh", "ssh+git"]);

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;

/** The short form SSH takes: `[user@]host:path`, with no slash before the colon. */
const SCP_LIKE = /^(?:[^@/:]+@)?([^@/:]+):(.+)$/;

/** The host, in lower case, and the path of an address, or null when it is neither shape. */
function hostAndPath(address: string): { host: string; path: string } | null {
  const scheme = SCHEME.exec(address);
  if (scheme !== null) {
    if (!SCHEMES.has((scheme[1] as string).toLowerCase())) return null;
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return null;
    }
    if (url.search !== "" || url.hash !== "") return null;
    return { host: url.hostname.toLowerCase(), path: url.pathname };
  }
  const short = SCP_LIKE.exec(address);
  return short === null
    ? null
    : { host: (short[1] as string).toLowerCase(), path: short[2] as string };
}

/** The repository on github.com a remote's address names, or null for any other. */
export function gitHubRepositoryOf(address: string): GitHubRepository | null {
  const text = address.trim();
  if (text === "" || /[\s\p{Cc}]/u.test(text)) return null;
  const found = hostAndPath(text);
  // An escape in the path is not one git writes for a repository on github.com.
  if (found === null || !GITHUB_HOSTS.has(found.host) || found.path.includes("%")) return null;
  const parts = found.path.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
  if (parts.length !== 2) return null;
  const [owner = "", written = ""] = parts;
  const name = written.toLowerCase().endsWith(".git") ? written.slice(0, -".git".length) : written;
  return isGitHubRepository(owner, name) ? { owner, name } : null;
}
