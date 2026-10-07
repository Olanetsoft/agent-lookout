/**
 * How a shell command is read as words, for the permission rules. Pure.
 *
 * An allow rule may answer only a command whose words are exactly what runs,
 * so `plainCommandWords` takes one plain command and nothing else: words of
 * letters, digits and a few marks that no shell gives a meaning, separated
 * by single spaces. Anything that would let the words read here differ from
 * what the shell runs makes it no plain command: a second command after `;`,
 * `&`, `|`, `&&`, `||` or a line break, a backtick, `$( )`, `$VAR` or `${ }`,
 * a redirection, a subshell, a here-document, a glob, a quote, a backslash, a
 * tab, a space at either end or two in a row, a `~` the shell turns into a
 * folder, a `{ }` it expands, a `!` or `^` it reads as history, a `#` that
 * starts a comment, an `=` that starts a word, which zsh expands, a first
 * word that sets a variable, and any letter outside plain ASCII, such as a
 * Cyrillic "е" that looks like a Latin "e". Such a command is left to the
 * person.
 *
 * A deny or an ask rule only ever holds a command back, so it is matched more
 * loosely, by `looseCommandWords` and `looselyMatches`: every command in the
 * line, split at the shell's separators, each read as its words with quotes,
 * backslashes and the `$` of `$'…'` taken out, and leading variable settings,
 * `!` and the shell's words that begin a clause, such as `then` and `do`,
 * passed over. The program is compared by its name alone, whatever its
 * capitals and its folder, so `RM` and `/bin/rm` are `rm`; the rule's other
 * words must follow in order, with any words between them, so an option
 * written before them does not step around the rule; and a command that
 * begins with a program that runs another, such as `sudo`, `xargs` or
 * `bash -c`, is read from each of its words. A rule that matches more than it
 * says there asks or denies more often, never less. Still, it is matched by
 * words as they are written: a command run another way, through a script, an
 * alias or a program not in `COMMAND_RUNNERS`, is not caught.
 */

/**
 * The programs, and the shell's own words, whose work is to run another
 * command given in their words: `sudo rm -rf x`, `xargs rm`, `bash -c …`,
 * `time make`. An allow rule may not begin with one, since it would let
 * Claude Code run any command without asking (`permissionRules.ts`), and a
 * deny or an ask rule looks for its command in every word after one. Each is
 * written in small letters, by its name alone. The list cannot hold every
 * program that can run another: `git -c`, `npm exec`, an interpreter given a
 * file and a test runner given a test can each run anything.
 */
export const COMMAND_RUNNERS: readonly string[] = [
  // The shell's own words.
  ".",
  "builtin",
  "command",
  "coproc",
  "eval",
  "exec",
  "nocorrect",
  "noglob",
  "source",
  "time",
  // Programs that run the command after their own words.
  "arch",
  "bunx",
  "caffeinate",
  "chroot",
  "doas",
  "env",
  "flock",
  "gtimeout",
  "ionice",
  "nice",
  "nix-shell",
  "nohup",
  "npx",
  "parallel",
  "pnpx",
  "sandbox-exec",
  "script",
  "setsid",
  "stdbuf",
  "su",
  "sudo",
  "taskset",
  "timeout",
  "unbuffer",
  "uvx",
  "watch",
  "xargs",
  "xcrun",
  // Shells, which run the command they are given or a file.
  "ash",
  "bash",
  "busybox",
  "cmd",
  "csh",
  "dash",
  "fish",
  "ksh",
  "powershell",
  "pwsh",
  "sh",
  "tcsh",
  "zsh",
];

/**
 * The programs that send requests over the network, and the interpreters,
 * which run the code they are given: `curl -d @rule.json http://127.0.0.1:…`,
 * `python -m pytest`, `node build.js`. Through any of them Claude can reach
 * Agent Lookout's own API on this computer, so an allow rule may not begin
 * with one (`permissionRules.ts`): it would let Claude Code add a rule, or
 * answer its own prompt, without asking. Each is written in small letters,
 * by its name alone, and is found with a version after it too, such as
 * `python3`, `python3.12`, `perl5.34` or `tclsh8.6` (`sendsOrRunsCode`). The
 * list cannot hold every program that can: `npm test`, `make` and a test
 * runner each run a file Claude can edit, and `git -c` can run anything.
 */
export const NETWORK_CLIENTS_AND_INTERPRETERS: readonly string[] = [
  // Programs that send requests, or open a connection, to an address.
  "aria2c",
  "curl",
  "elinks",
  "ftp",
  "grpcurl",
  "http",
  "https",
  "httpx",
  "links",
  "lynx",
  "nc",
  "ncat",
  "netcat",
  "scp",
  "sftp",
  "socat",
  "ssh",
  "telnet",
  "w3m",
  "websocat",
  "wget",
  "xh",
  "xhs",
  // Interpreters, which run code given in their words or in a file.
  "awk",
  "bpython",
  "bun",
  "clj",
  "clojure",
  "dart",
  "deno",
  "elixir",
  "erl",
  "escript",
  "esno",
  "expect",
  "gawk",
  "ghci",
  "groovy",
  "guile",
  "iex",
  "ipython",
  "irb",
  "java",
  "jshell",
  "jrunscript",
  "julia",
  "kotlin",
  "lua",
  "luajit",
  "mawk",
  "nawk",
  "node",
  "nodejs",
  "ocaml",
  "osascript",
  "perl",
  "php",
  "pypy",
  "python",
  "r",
  "racket",
  "raku",
  "rakudo",
  "rscript",
  "ruby",
  "runghc",
  "runhaskell",
  "sbcl",
  "scala",
  "swift",
  "tclsh",
  "ts-node",
  "tsx",
  "vite-node",
  "wish",
  "zx",
];

/** The ending of a program on Windows, `curl.exe` or `cmd.com`, run the same from WSL. */
const WINDOWS_PROGRAM_END = /\.(?:exe|com)$/;

/** A letter, which carries a name on: `javac` is not `java`, but `java17` and `java-17` are. */
const LETTER = /[a-z]/;

/** A word as the program it names: its last part after any `/`, in small letters. */
export function programOf(word: string): string {
  return word
    .slice(word.lastIndexOf("/") + 1)
    .toLowerCase()
    .replace(WINDOWS_PROGRAM_END, "");
}

/**
 * The name among `names` a program is, or is with anything after it that
 * does not begin with a letter: a version, as in `python3.12`, `bash5` or
 * `go1.22.0`, or another ending, as in `nc.openbsd`, `ts-node-esm` or
 * `nix-shell-2.3`. It finds more than it must, `ssh-keygen` and
 * `node_exporter` among them, which is the safe side for an allow rule.
 */
function nameIn(program: string, names: Iterable<string>): string | undefined {
  let found: string | undefined;
  for (const name of names) {
    if (program === name) return name;
    // The longest name that fits wins, so `docker-compose` is not `docker`.
    const fits = program.startsWith(name) && !LETTER.test(program.charAt(name.length));
    if (fits && name.length > (found?.length ?? 0)) found = name;
  }
  return found;
}

/** Whether a word names a program that runs another command (`COMMAND_RUNNERS`). */
export function runsAnotherCommand(word: string): boolean {
  return nameIn(programOf(word), COMMAND_RUNNERS) !== undefined;
}

/**
 * Whether a word names a program that sends requests or runs code given in
 * its words (`NETWORK_CLIENTS_AND_INTERPRETERS`), by its name alone, whatever
 * its capitals, its folder and what comes after the name: `/usr/bin/Python3.12`
 * is `python`.
 */
export function sendsOrRunsCode(word: string): boolean {
  return nameIn(programOf(word), NETWORK_CLIENTS_AND_INTERPRETERS) !== undefined;
}

/**
 * The package managers and build tools whose subcommands each do something
 * different, and the subcommands among them that fetch code, or run code they
 * are pointed at: `npm exec`, `pnpm dlx`, `cargo run`, `docker run`, with the
 * aliases the tools accept, such as `bundle e`, `cargo r` and `npm innit`.
 *
 * An allow rule for one of these names its subcommand, `npm test:*`, never the
 * program alone, `npm:*` (`needsItsSubcommand`). Matched word by word, the
 * rule then answers that subcommand and no other, whatever shortened form or
 * second name the tool would also accept. A rule may not name one of the
 * subcommands listed here, and no allowed command holds one before the
 * arguments begin (`runsCodeBySubcommand`).
 */
export const SUBCOMMANDS_THAT_RUN_CODE: Readonly<Record<string, readonly string[]>> = {
  bundle: ["e", "ex", "exe", "exec"],
  bundler: ["e", "ex", "exe", "exec"],
  cargo: ["r", "run"],
  docker: ["build", "buildx", "compose", "container", "create", "exec", "run", "start"],
  "docker-compose": ["create", "exec", "run", "start", "up"],
  dotnet: ["exec", "run", "tool"],
  go: ["generate", "run", "tool"],
  nix: ["develop", "run", "shell"],
  npm: ["create", "exec", "explore", "init", "innit", "x"],
  pipx: ["run"],
  pnpm: ["create", "dlx", "exec", "x"],
  podman: ["build", "compose", "container", "create", "exec", "run", "start"],
  poetry: ["run"],
  uv: ["run", "tool"],
  yarn: ["create", "dlx", "exec", "node"],
  yarnpkg: ["create", "dlx", "exec", "node"],
};

/** The tools that take any start of a subcommand's name that is not shared, as `npm exe` for `npm exec`. */
const TAKES_A_SHORTENED_SUBCOMMAND: readonly string[] = ["npm"];

/** The tool among `SUBCOMMANDS_THAT_RUN_CODE` a word names, or undefined. */
function subcommandToolOf(word: string): string | undefined {
  return nameIn(programOf(word), Object.keys(SUBCOMMANDS_THAT_RUN_CODE));
}

/**
 * Whether an allow rule's words name one of the tools above without its
 * subcommand: the program alone, or followed by an option.
 */
export function needsItsSubcommand(words: readonly string[]): boolean {
  const [first, second] = words;
  if (first === undefined || subcommandToolOf(first) === undefined) return false;
  return second === undefined || second.startsWith("-");
}

/**
 * Whether a command's words hold one of its tool's subcommands that fetch or
 * run code, in any capitals and, for npm, in any shortened form of two
 * letters or more. Every word is looked at until the arguments begin: a `--`
 * after the subcommand, though not one before it, as npm reads `npm -- exec`
 * as `npm exec`. So an option before the subcommand, as in `npm --yes exec`,
 * does not step around it. That refuses more than it must, which is the safe
 * side for an allow rule.
 */
export function runsCodeBySubcommand(words: readonly string[]): boolean {
  const [first, ...rest] = words;
  if (first === undefined) return false;
  const tool = subcommandToolOf(first);
  if (tool === undefined) return false;
  const listed = SUBCOMMANDS_THAT_RUN_CODE[tool] ?? [];
  const shortened = TAKES_A_SHORTENED_SUBCOMMAND.includes(tool);
  let pastOptions = false;
  for (const word of rest) {
    if (word === "--") {
      if (pastOptions) return false;
      continue;
    }
    if (!word.startsWith("-")) pastOptions = true;
    const lower = word.toLowerCase();
    if (listed.includes(lower)) return true;
    if (shortened && lower.length >= 2 && listed.some((name) => name.startsWith(lower)))
      return true;
  }
  return false;
}

/**
 * The options through which a program runs another program named in them:
 * `go test -exec=./x`, `go build -toolexec`, `npm test --script-shell=./x`,
 * `git -c core.pager=./x log`. Written without their dashes, as an option is
 * found with one dash or two, and with or without `=` and a value. Compared in
 * their own capitals: git's `-C`, which names a folder, is not its `-c`.
 */
export const OPTIONS_THAT_RUN_A_PROGRAM: Readonly<Record<string, readonly string[]>> = {
  git: ["c", "config-env", "exec-path", "receive-pack", "upload-pack"],
  go: ["exec", "toolexec", "vettool"],
  npm: ["call", "node-options", "script-shell"],
};

/** Whether a command's words hold an option through which its program runs another. */
export function runsAProgramByOption(words: readonly string[]): boolean {
  const [first, ...rest] = words;
  if (first === undefined) return false;
  const program = nameIn(programOf(first), Object.keys(OPTIONS_THAT_RUN_A_PROGRAM));
  if (program === undefined) return false;
  const options = OPTIONS_THAT_RUN_A_PROGRAM[program] ?? [];
  return rest.some((word) => {
    if (!word.startsWith("-")) return false;
    const [name = ""] = word.replace(/^-+/, "").split("=");
    return options.includes(name);
  });
}

/** Agent Lookout's own folder, as any word that names it holds it. */
const OWN_FOLDER_NAME = ".agent-lookout";

/** The path macOS reaches any file by, by its disk's and its own numbers, with no name. */
const BY_NUMBER = "/.vol";

/**
 * A path written in a word, made plain from its words alone, with no disk:
 * in small letters, as a Mac's disk compares names, with `//` and `/./` as
 * `/`, `..` stepping back a folder, and no `/` at the end. A word that does
 * not begin with `/` is left as it is.
 */
export function plainPath(word: string): string {
  const lower = word.toLowerCase();
  if (!lower.startsWith("/")) return lower;
  const parts: string[] = [];
  for (const part of lower.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** Every folder above a path, up to `/`: `/a/b/c` gives `/a/b`, `/a` and `/`. */
function foldersAbove(file: string): string[] {
  const folders: string[] = [];
  let at = file;
  while (at !== "/" && at !== "") {
    at = at.slice(0, at.lastIndexOf("/")) || "/";
    folders.push(at);
  }
  return folders;
}

/**
 * Whether any word names Agent Lookout's own files, or a folder that holds
 * them: a word with `.agent-lookout` in it, in any capitals; a path, or the
 * value of an option such as `--directory=…`, that is the settings file, the
 * socket, or any folder above them, up to your home folder and `/`, written
 * with `..`, `//` or `/./` as well; a word that ends in the settings file's
 * own name where a setting put it outside `.agent-lookout`; and any path
 * under `/.vol`, which reaches a file by number. With the session's folder
 * known, each word is also read as a path from there, so `../..` from a
 * project is your home folder. A command that names them could change the
 * rules or answer prompts, through the file or by writing into a folder
 * above it, so an allow rule never answers it.
 */
export function namesOwnFiles(
  words: readonly string[],
  ownPaths: readonly string[] = [],
  folder?: string,
): boolean {
  const own = ownPaths.filter((name) => name.startsWith("/")).map(plainPath);
  const above = new Set(own.flatMap(foldersAbove));
  const ownNames = own
    .filter((name) => !name.includes(OWN_FOLDER_NAME))
    .map((name) => name.slice(name.lastIndexOf("/") + 1));
  const from = folder?.startsWith("/") ? folder : undefined;
  return words.some((word) => {
    const lower = word.toLowerCase();
    if (lower.includes(OWN_FOLDER_NAME)) return true;
    const parts = [lower, ...lower.split("=").slice(1)];
    const read = parts.flatMap((part) =>
      from !== undefined && !part.startsWith("/") && !part.startsWith("-")
        ? [part, `${from}/${part}`]
        : [part],
    );
    return read.some((part) => {
      const path = plainPath(part);
      if (path === BY_NUMBER || path.startsWith(`${BY_NUMBER}/`)) return true;
      if (own.some((name) => path === name || path.startsWith(`${name}/`))) return true;
      if (above.has(path)) return true;
      return ownNames.some((name) => path === name || path.endsWith(`/${name}`));
    });
  });
}

/**
 * Whether a session's folder is one of Agent Lookout's own folders or one
 * above them, such as your home folder: from there a command can reach the
 * settings file by a path that names nothing of it, `.agent-lookout/…` aside,
 * so an allow rule answers no command of a session there.
 */
export function folderReachesOwnFiles(folder: string, ownPaths: readonly string[] = []): boolean {
  const own = ownPaths.filter((name) => name.startsWith("/")).map(plainPath);
  const path = plainPath(folder);
  return own.some((name) => name === path || name.startsWith(`${path === "/" ? "" : path}/`));
}

/** A character a word of a plain command may hold: nothing any shell gives a meaning to. */
const PLAIN_WORD = /^[A-Za-z0-9_\-.,/:=+@%]+$/;

/** A word that sets a variable for the command after it, `NAME=value`. */
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The words of one plain command, as they run, or null when the command is
 * anything more: see the top of this file.
 */
export function plainCommandWords(command: string): string[] | null {
  if (command === "") return null;
  const words = command.split(" ");
  for (const word of words) {
    // Empty is a space at either end, or two in a row.
    if (word === "" || !PLAIN_WORD.test(word)) return null;
    // zsh expands `=word` to the path of the program `word`.
    if (word.startsWith("=")) return null;
  }
  // `NAME=value command` runs the command with another environment.
  if (ASSIGNMENT.test(words[0] as string)) return null;
  return words;
}

/**
 * Where one command in a line ends and the next begins, for a deny or an ask
 * rule: `;`, `&`, `|`, a line break, the parentheses of a subshell or of
 * `$( )`, a backtick, the braces of a group, and a redirection, whose target
 * is no word of the command.
 */
const SEPARATORS = /[;&|\n\r()`{}<>]/;

/** The `$` of ANSI-C quoting, `$'rm'`, or of `$"rm"`, which the shell takes away with the quotes. */
const DOLLAR_QUOTE = /\$(?=['"])/g;

/** The marks the shell takes away from a word as it reads it. */
const QUOTING = /['"\\]/g;

/**
 * The shell's words that begin a clause and are followed by a command, as in
 * `if true; then rm -rf x; fi` or `for f in a; do rm x; done`, and `!`, which
 * only turns the command's exit status round.
 */
const CLAUSE_WORDS: readonly string[] = ["!", "if", "then", "else", "elif", "do", "while", "until"];

/**
 * The words of every command in the line, read loosely, for a deny or an ask
 * rule: each command split at the shell's separators, each word with its
 * quotes and backslashes taken out, and the variables set before a command,
 * a `!` and a word that begins a clause passed over. A command with no words
 * is left out.
 */
export function looseCommandWords(command: string): string[][] {
  const commands: string[][] = [];
  for (const part of command.split(SEPARATORS)) {
    const words = part
      .split(/\s+/u)
      .map((word) => word.replace(DOLLAR_QUOTE, "").replace(QUOTING, ""))
      .filter((word) => word !== "");
    let first = 0;
    for (;;) {
      const word = words[first];
      if (word === undefined) break;
      if (!ASSIGNMENT.test(word) && !CLAUSE_WORDS.includes(word)) break;
      first += 1;
    }
    if (first < words.length) commands.push(words.slice(first));
  }
  return commands;
}

/** What ends a rule's command that matches every command beginning with its words. */
export const PREFIX_MARK = ":*";

/**
 * A rule's command read as words: an exact command, `npm test`, or a prefix,
 * `npm test:*`, whose words must be a command's first words, each the same.
 */
export interface RuleCommand {
  words: string[];
  prefix: boolean;
}

/** A rule's command as words. It has been checked as a rule's command is (`permissionRules.ts`). */
export function ruleCommandOf(command: string): RuleCommand {
  const prefix = command.endsWith(PREFIX_MARK);
  const words = (prefix ? command.slice(0, -PREFIX_MARK.length) : command).split(" ");
  return { words, prefix };
}

/**
 * Whether a command's words are what the rule's command says, word by word
 * and never as a part of one: `npm test:*` takes `npm test` and
 * `npm test --watch`, and not `npm testing`. This is how an allow rule
 * matches: strictly, every word in its place.
 */
export function wordsMatch(rule: RuleCommand, words: readonly string[]): boolean {
  if (rule.prefix ? words.length < rule.words.length : words.length !== rule.words.length) {
    return false;
  }
  return rule.words.every((word, index) => words[index] === word);
}

/** Where `wanted` is found in order in `words`, from `from` up to `to`, or -1: the index after the last. */
function inOrder(wanted: readonly string[], words: readonly string[], from: number, to: number) {
  let at = from;
  for (const word of wanted) {
    while (at < to && words[at] !== word) at += 1;
    if (at >= to) return -1;
    at += 1;
  }
  return at;
}

/** Whether the rule's command is the command that begins at `start`, read loosely. */
function looselyFrom(rule: RuleCommand, words: readonly string[], start: number): boolean {
  const [program, ...rest] = rule.words;
  if (program === undefined || programOf(words[start] as string) !== programOf(program)) {
    return false;
  }
  // A prefix: the rest of its words in order, with any words between and after them.
  if (rule.prefix) return inOrder(rest, words, start + 1, words.length) >= 0;
  // An exact command: the same, but with nothing after its last word.
  const last = rest.at(-1);
  if (last === undefined) return words.length === start + 1;
  const end = words.length - 1;
  return (
    end > start && words[end] === last && inOrder(rest.slice(0, -1), words, start + 1, end) >= 0
  );
}

/**
 * Whether a command's words are what the rule's command says, read loosely,
 * for a deny or an ask rule, which only holds a command back:
 *
 * - The program is compared by its name alone, whatever its capitals and its
 *   folder: `rm:*` takes `RM -rf x` and `/bin/rm -rf x`, since a Mac's disk
 *   finds `RM` as `rm`.
 * - The rule's other words must follow in order, with any words between
 *   them: `git push:*` takes `git -C . push` and `git --no-pager push`, and
 *   `git push --force:*` takes `git push origin main --force`. So it also
 *   takes `git commit -m push`, which asks or denies more than it says,
 *   never less. An exact command, `git push`, takes nothing after its last
 *   word.
 * - A command that begins with a program that runs another, `sudo`, `xargs`,
 *   `env`, `bash` and the rest of `COMMAND_RUNNERS`, is read from each of
 *   its words as well: `rm:*` takes `sudo rm -rf x` and `xargs rm`.
 */
export function looselyMatches(rule: RuleCommand, words: readonly string[]): boolean {
  const first = words[0];
  if (first === undefined) return false;
  const starts = runsAnotherCommand(first) ? words.length : 1;
  for (let start = 0; start < starts; start += 1) {
    if (looselyFrom(rule, words, start)) return true;
  }
  return false;
}
