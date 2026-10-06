/**
 * What Agent Lookout reads in a repository's `config` file, with
 * `AGENT_LOOKOUT_PULL_REQUESTS=on` only, to tell which repository on
 * github.com a branch's pull request is in. Of the whole file it keeps:
 *
 * - each remote's name and first `url`, in the order the file has them, and
 *   the `gh-resolved` that `gh repo set-default` writes beside one;
 * - each branch's `remote` and `pushRemote`;
 * - `remote.pushDefault`.
 *
 * It reads the file as git does: `[section]` and `[section "subsection"]`
 * heads, `name = value` lines, values in quotation marks with git's escapes,
 * a backslash that runs a value on to the next line, and comments after `#`
 * or `;`. A file git would refuse gives nothing, rather than a guess.
 * `include` and `includeIf` are not followed, and nothing outside the file is
 * read: no global or system configuration.
 */

/** The largest `config` read. A larger one is not read, and gives no remote. */
export const MAX_CONFIG_BYTES = 64 * 1024;

export interface GitRemote {
  /** The first `url`, as written. */
  url?: string;
  /** What `gh repo set-default` wrote: `base`, or the repository chosen as `owner/name`. */
  ghResolved?: string;
}

export interface GitBranch {
  remote?: string;
  pushRemote?: string;
}

export interface GitConfig {
  /** By name, in the order the file has them. */
  remotes: Map<string, GitRemote>;
  /** By name. */
  branches: Map<string, GitBranch>;
  /** `remote.pushDefault`: the remote a branch is pushed to when it names none. */
  pushDefault?: string;
}

interface Entry {
  /** In lower case, as git compares it. */
  section: string;
  /** As written: a subsection's case counts. */
  subsection: string | null;
  /** In lower case. */
  key: string;
  value: string;
}

/** Thrown inside the parser at anything git would refuse. */
class Unreadable extends Error {}

const SECTION_NAME = /[A-Za-z0-9.-]/;
const KEY_START = /[A-Za-z]/;
const KEY_PART = /[A-Za-z0-9-]/;

/** The position just past the end of the line `at` is on. */
function lineEnd(text: string, at: number): number {
  const end = text.indexOf("\n", at);
  return end === -1 ? text.length : end + 1;
}

/** A section head from the `[` at `at`: its name, its subsection, and where it ends. */
function readHead(
  text: string,
  at: number,
): { section: string; subsection: string | null; end: number } {
  let pos = at + 1;
  let name = "";
  while (pos < text.length && SECTION_NAME.test(text[pos] as string)) name += text[pos++];
  if (name === "") throw new Unreadable();
  if (text[pos] === "]") {
    // The old form, `[remote.origin]`, has its subsection in lower case.
    const dot = name.indexOf(".");
    return dot === -1
      ? { section: name.toLowerCase(), subsection: null, end: pos + 1 }
      : {
          section: name.slice(0, dot).toLowerCase(),
          subsection: name.slice(dot + 1).toLowerCase(),
          end: pos + 1,
        };
  }
  while (text[pos] === " " || text[pos] === "\t") pos += 1;
  if (text[pos] !== '"') throw new Unreadable();
  pos += 1;
  let subsection = "";
  for (;;) {
    const character = text[pos];
    if (character === undefined || character === "\n") throw new Unreadable();
    if (character === '"') break;
    if (character === "\\") {
      // A backslash keeps the character after it, and is itself dropped.
      const next = text[pos + 1];
      if (next === undefined || next === "\n") throw new Unreadable();
      subsection += next;
      pos += 2;
      continue;
    }
    subsection += character;
    pos += 1;
  }
  pos += 1;
  if (text[pos] !== "]") throw new Unreadable();
  return { section: name.toLowerCase(), subsection, end: pos + 1 };
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", b: "\b", "\\": "\\", '"': '"' };

/** A value from just after its `=`: as git reads it, and where it ends. */
function readValue(text: string, at: number): { value: string; end: number } {
  let pos = at;
  while (text[pos] === " " || text[pos] === "\t") pos += 1;
  let value = "";
  // Spaces outside quotation marks count only when more follows them.
  let spaces = "";
  let quoted = false;
  for (;;) {
    const character = text[pos];
    if (character === undefined) break;
    if (character === "\n" || (character === "\r" && text[pos + 1] === "\n")) {
      if (quoted) throw new Unreadable();
      break;
    }
    if (!quoted && (character === "#" || character === ";")) {
      pos = lineEnd(text, pos) - 1;
      break;
    }
    if (character === "\\") {
      const next = text[pos + 1];
      if (next === "\n") {
        pos += 2;
        continue;
      }
      if (next === "\r" && text[pos + 2] === "\n") {
        pos += 3;
        continue;
      }
      const escaped = next === undefined ? undefined : ESCAPES[next];
      if (escaped === undefined) throw new Unreadable();
      value += spaces + escaped;
      spaces = "";
      pos += 2;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      value += spaces;
      spaces = "";
      pos += 1;
      continue;
    }
    if (!quoted && (character === " " || character === "\t")) {
      spaces += character;
      pos += 1;
      continue;
    }
    value += spaces + character;
    spaces = "";
    pos += 1;
  }
  if (quoted) throw new Unreadable();
  return { value, end: pos };
}

/** Every setting in the file, in order. Throws `Unreadable` at anything git would refuse. */
function entriesOf(text: string): Entry[] {
  const entries: Entry[] = [];
  let section: { section: string; subsection: string | null } | null = null;
  let pos = 0;
  while (pos < text.length) {
    const character = text[pos] as string;
    if (character === " " || character === "\t" || character === "\r" || character === "\n") {
      pos += 1;
      continue;
    }
    if (character === "#" || character === ";") {
      pos = lineEnd(text, pos);
      continue;
    }
    if (character === "[") {
      const head = readHead(text, pos);
      section = { section: head.section, subsection: head.subsection };
      pos = head.end;
      continue;
    }
    if (!KEY_START.test(character)) throw new Unreadable();
    let key = "";
    while (pos < text.length && KEY_PART.test(text[pos] as string)) key += text[pos++];
    while (text[pos] === " " || text[pos] === "\t") pos += 1;
    let value: string;
    if (text[pos] === "=") {
      const read = readValue(text, pos + 1);
      value = read.value;
      pos = read.end;
    } else if (
      pos >= text.length ||
      text[pos] === "\n" ||
      text[pos] === "\r" ||
      text[pos] === "#" ||
      text[pos] === ";"
    ) {
      // A name alone is a setting that is true.
      value = "true";
    } else {
      throw new Unreadable();
    }
    // A setting before any section head is one git refuses.
    if (section === null) throw new Unreadable();
    entries.push({ ...section, key: key.toLowerCase(), value });
  }
  return entries;
}

/**
 * The remotes and branches a repository's `config` names, or null when git
 * would refuse the file. It never throws.
 */
export function parseGitConfig(text: string): GitConfig | null {
  let entries: Entry[];
  try {
    entries = entriesOf(text);
  } catch {
    return null;
  }
  const config: GitConfig = { remotes: new Map(), branches: new Map() };
  for (const { section, subsection, key, value } of entries) {
    if (section === "remote" && subsection === null) {
      if (key === "pushdefault") config.pushDefault = value;
      continue;
    }
    if (subsection === null) continue;
    if (section === "remote") {
      const remote = config.remotes.get(subsection) ?? {};
      config.remotes.set(subsection, remote);
      // The first `url` is the one git fetches from.
      if (key === "url" && remote.url === undefined) remote.url = value;
      if (key === "gh-resolved") remote.ghResolved = value;
    } else if (section === "branch") {
      const branch = config.branches.get(subsection) ?? {};
      config.branches.set(subsection, branch);
      if (key === "remote") branch.remote = value;
      if (key === "pushremote") branch.pushRemote = value;
    }
  }
  return config;
}
