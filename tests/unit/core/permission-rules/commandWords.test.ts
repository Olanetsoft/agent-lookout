import { describe, expect, test } from "vitest";

import {
  COMMAND_RUNNERS,
  looseCommandWords,
  looselyMatches,
  folderReachesOwnFiles,
  namesOwnFiles,
  needsItsSubcommand,
  NETWORK_CLIENTS_AND_INTERPRETERS,
  plainCommandWords,
  plainPath,
  programOf,
  ruleCommandOf,
  runsAnotherCommand,
  runsAProgramByOption,
  runsCodeBySubcommand,
  sendsOrRunsCode,
  SUBCOMMANDS_THAT_RUN_CODE,
  wordsMatch,
} from "@core/permission-rules/commandWords";

describe("one plain command, which an allow rule may answer", () => {
  test.each([
    ["npm test", ["npm", "test"]],
    ["npm run test:unit", ["npm", "run", "test:unit"]],
    ["npm test -- --grep=checkout", ["npm", "test", "--", "--grep=checkout"]],
    ["git log --format=%H -n 5", ["git", "log", "--format=%H", "-n", "5"]],
    ["ls ./src/core,docs", ["ls", "./src/core,docs"]],
    ["npx vitest@4 run", ["npx", "vitest@4", "run"]],
    ["make", ["make"]],
  ])("%j is the words %j", (command, words) => {
    expect(plainCommandWords(command)).toEqual(words);
  });

  test.each([
    // A second command, joined in any way a shell joins them.
    ["npm test; rm -rf build", "a semicolon"],
    ["npm test & rm -rf build", "an ampersand"],
    ["npm test | sh", "a pipe"],
    ["npm test && rm -rf build", "&&"],
    ["npm test || rm -rf build", "||"],
    ["npm test\nrm -rf build", "a line break"],
    ["npm test\r\nrm -rf build", "a carriage return"],
    // Something that runs before the words are known.
    ["npm test `rm -rf build`", "a backtick"],
    ["npm test $(rm -rf build)", "$( )"],
    ["npm test $HOME", "$VAR"],
    ["npm test ${HOME}", "${ }"],
    ["npm test $'\\x41'", "$' '"],
    // Where its output goes, or its input comes from.
    ["npm test > /etc/hosts", ">"],
    ["npm test >> notes.txt", ">>"],
    ["npm test < secrets.txt", "<"],
    ["npm test <<EOF", "a here-document"],
    ["npm test 2>&1", "a redirection of a stream"],
    // A subshell or a group.
    ["(npm test)", "a subshell"],
    ["{ npm test; }", "a group"],
    // Words the shell makes other words of.
    ["npm test *.ts", "*"],
    ["npm test file?.ts", "?"],
    ["npm test [ab].ts", "[ ]"],
    ["npm test {a,b}", "a brace expansion"],
    ["cat ~/.ssh/id_rsa", "~"],
    ["npm test !!", "! history"],
    ["^npm^rm", "^ history"],
    ["npm test # rm -rf build", "a comment"],
    ["ls =rm", "a word zsh expands"],
    // Quotes, which make where a word ends a matter of reading them.
    ['npm test "a b"', "double quotes"],
    ["npm test 'a b'", "single quotes"],
    ["npm\\ test", "a backslash"],
    // Spaces that are not single spaces between words.
    [" npm test", "a space at the start"],
    ["npm test ", "a space at the end"],
    ["npm  test", "two spaces"],
    ["npm\ttest", "a tab"],
    ["npm test", "a no-break space"],
    ["npm test", "an em space"],
    // A variable set for the command.
    ["NODE_OPTIONS=--require=./evil.js npm test", "a variable set before it"],
    ["PATH=/tmp npm test", "PATH set before it"],
    // Letters that look like others.
    ["npm tеst", "a Cyrillic e"],
    ["nрm test", "a Cyrillic r"],
    ["npm test​", "a zero-width space"],
    ["npm test ‮rm", "a right-to-left override"],
    ["npm tést", "an accented letter"],
    ["", "nothing at all"],
  ])("%j is no plain command: %s", (command) => {
    expect(plainCommandWords(command)).toBeNull();
  });

  test("a very long command of plain words is still read word by word", () => {
    const command = `npm test ${"a ".repeat(5_000)}b`;
    expect(plainCommandWords(command)?.length).toBe(5_003);
    expect(plainCommandWords(`${command};`)).toBeNull();
  });
});

describe("every command in a line, read loosely for a deny or an ask rule", () => {
  test("each command after a separator is read on its own", () => {
    expect(looseCommandWords("cd /tmp && rm -rf build; echo done | tee log")).toEqual([
      ["cd", "/tmp"],
      ["rm", "-rf", "build"],
      ["echo", "done"],
      ["tee", "log"],
    ]);
  });

  test("a command inside $( ), backticks, a subshell or a group is read too", () => {
    expect(looseCommandWords("echo $(rm -rf build) `git push` (curl x) { wget y; }")).toEqual([
      ["echo", "$"],
      ["rm", "-rf", "build"],
      ["git", "push"],
      ["curl", "x"],
      ["wget", "y"],
    ]);
  });

  test("quotes and backslashes are taken out, as the shell takes them out", () => {
    expect(looseCommandWords(`"rm" -rf 'build' r\\m`)).toEqual([["rm", "-rf", "build", "rm"]]);
  });

  test("variables set before a command, and a !, are passed over", () => {
    expect(looseCommandWords("FORCE=1 DEBUG=x rm -rf build")).toEqual([["rm", "-rf", "build"]]);
    expect(looseCommandWords("! git push")).toEqual([["git", "push"]]);
  });

  test("tabs, line breaks and other spaces part words, and empty commands are left out", () => {
    expect(looseCommandWords("\trm\t-rf build ;; \n")).toEqual([["rm", "-rf", "build"]]);
    expect(looseCommandWords("   ")).toEqual([]);
  });

  test("a redirection's target is not a word of the command", () => {
    expect(looseCommandWords("git push > out.txt")).toEqual([["git", "push"], ["out.txt"]]);
  });

  test("the shell's words that begin a clause are passed over, so the command after one is read", () => {
    expect(looseCommandWords("if true; then rm -rf x; else rm y; fi")).toEqual([
      ["true"],
      ["rm", "-rf", "x"],
      ["rm", "y"],
      ["fi"],
    ]);
    expect(looseCommandWords("for f in a; do rm $f; done")).toEqual([
      ["for", "f", "in", "a"],
      ["rm", "$f"],
      ["done"],
    ]);
    expect(looseCommandWords("while true; do ! FORCE=1 rm x; done")[1]).toEqual(["rm", "x"]);
    expect(looseCommandWords("until false; do git push; done")[1]).toEqual(["git", "push"]);
  });

  test("the $ of ANSI-C quoting goes with its quotes, as the shell takes it away", () => {
    expect(looseCommandWords("$'rm' -rf x")).toEqual([["rm", "-rf", "x"]]);
    expect(looseCommandWords('$"rm" -rf x')).toEqual([["rm", "-rf", "x"]]);
    // A $ that starts a variable stays: it is no word the rule can name.
    expect(looseCommandWords("rm $HOME")).toEqual([["rm", "$HOME"]]);
  });
});

describe("a deny or an ask rule's command, matched loosely, which only holds more back", () => {
  const matches = (rule: string, command: string) =>
    looseCommandWords(command).some((words) => looselyMatches(ruleCommandOf(rule), words));

  test.each([
    ["git push:*", "git push origin"],
    // An option before the rule's words, or between them.
    ["git push:*", "git -C . push origin"],
    ["git push:*", "git --no-pager push"],
    ["git push:*", "git -c core.sshCommand=touch push"],
    ["git push --force:*", "git push origin main --force"],
    ["git push --force:*", "git push --force"],
    // The program by its name, whatever its capitals or its folder.
    ["rm:*", "RM -rf x"],
    ["rm:*", "Rm -rf x"],
    ["rm:*", "/bin/rm -rf x"],
    ["rm:*", "./rm x"],
    // A program that runs another, before it.
    ["rm:*", "time rm x"],
    ["rm:*", "time -p rm x"],
    ["rm:*", "sudo rm -rf x"],
    ["rm:*", "sudo -u root rm -rf x"],
    ["rm:*", "env FOO=1 rm x"],
    ["rm:*", "nohup nice -n 5 rm x"],
    ["rm:*", "ls | xargs rm"],
    ["rm:*", "xargs -0 /bin/RM"],
    ["rm:*", "bash -c 'rm -rf x'"],
    ["rm:*", 'zsh -c "rm -rf x"'],
    ["rm:*", "eval rm -rf x"],
    ["rm:*", "command rm x"],
    ["git push:*", "sh -c 'git -C . push'"],
    // After a reserved word, in ANSI-C quotes, and with spaces and tabs of any kind.
    ["rm:*", "if true; then rm -rf x; fi"],
    ["rm:*", "for f in a; do rm $f; done"],
    ["rm:*", "$'rm' -rf x"],
    ["rm:*", "  rm   -rf x  "],
    ["rm:*", "\trm\t-rf x"],
    // An exact command: its words in order, with any between, and none after.
    ["git push", "git push"],
    ["git push", "git -C . push"],
    ["ls", "ls"],
    ["ls", "sudo ls"],
    // More than it says, which is the safe way to be wrong.
    ["git push:*", "git commit -m push"],
  ])("%j holds back %j", (rule, command) => {
    expect(matches(rule, command)).toBe(true);
  });

  test.each([
    ["git push:*", "git status"],
    ["git push:*", "git pushx"],
    ["git push --force:*", "git push --force-with-lease"],
    ["rm:*", "rmdir build"],
    ["rm:*", "echo rm"],
    ["rm:*", "grep -r rm src"],
    // A program not known to run another is not read past its own words.
    ["rm:*", "npm exec rm x"],
    // A letter that only looks like one is another word.
    ["rm:*", "r\u043c -rf x"],
    ["rm:*", "rm\u200b -rf x"],
    // An exact command takes nothing after its last word, and needs every word.
    ["git push", "git push origin"],
    ["ls", "ls -la"],
    ["git push origin", "git push"],
  ])("%j does not hold back %j", (rule, command) => {
    expect(matches(rule, command)).toBe(false);
  });

  test("a very long line of words is read in good time", () => {
    const command = `sudo ${"a ".repeat(2_000)}git push`;
    const started = performance.now();
    expect(matches("git push --force:*", command)).toBe(false);
    expect(matches("git push:*", command)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("the programs that run another command", () => {
  test.each(["sudo", "env", "xargs", "bash", "sh", "zsh", "eval", "exec", "time", ".", "source"])(
    "%s is one",
    (word) => {
      expect(runsAnotherCommand(word)).toBe(true);
    },
  );

  test("by its name alone, whatever its capitals or its folder", () => {
    expect(programOf("/usr/bin/ENV")).toBe("env");
    expect(runsAnotherCommand("/usr/bin/env")).toBe(true);
    expect(runsAnotherCommand("SUDO")).toBe(true);
    expect(runsAnotherCommand("npm")).toBe(false);
    expect(runsAnotherCommand("sudoku")).toBe(false);
  });

  test.each(["npx", "bunx", "uvx", "xcrun", "pwsh", "powershell", "cmd"])(
    "%s, which runs another program or is a shell, is one",
    (word) => {
      expect(runsAnotherCommand(word)).toBe(true);
    },
  );

  test("a Windows program, run the same from WSL, is found by its name without .exe or .com", () => {
    expect(programOf("C:/Windows/System32/BASH.EXE")).toBe("bash");
    expect(runsAnotherCommand("bash.exe")).toBe(true);
    expect(runsAnotherCommand("cmd.com")).toBe(true);
    expect(runsAnotherCommand("npm.exe")).toBe(false);
  });

  test("the list is written in small letters, each once", () => {
    expect(COMMAND_RUNNERS.every((name) => name === name.toLowerCase())).toBe(true);
    expect(new Set(COMMAND_RUNNERS).size).toBe(COMMAND_RUNNERS.length);
  });
});

describe("the programs that send requests or run the code they are given", () => {
  test.each([
    "curl",
    "wget",
    "nc",
    "ncat",
    "netcat",
    "socat",
    "telnet",
    "http",
    "https",
    "xh",
    "aria2c",
    "ftp",
    "sftp",
    "scp",
    "ssh",
    "node",
    "nodejs",
    "deno",
    "bun",
    "python",
    "python3",
    "python2",
    "python3.12",
    "pypy",
    "pypy3",
    "ruby",
    "perl",
    "perl5.34",
    "php",
    "lua",
    "lua5.4",
    "osascript",
    "swift",
    "Rscript",
    "julia",
    "tclsh",
    "tclsh8.6",
    "wish",
    "expect",
    "awk",
    "gawk",
    "nawk",
  ])("%s is one", (word) => {
    expect(sendsOrRunsCode(word)).toBe(true);
  });

  test("by its name alone, whatever its capitals, its folder or a version after it", () => {
    expect(sendsOrRunsCode("/usr/bin/curl")).toBe(true);
    expect(sendsOrRunsCode("CURL")).toBe(true);
    expect(sendsOrRunsCode("/opt/homebrew/bin/Python3.12")).toBe(true);
    expect(sendsOrRunsCode("./node_modules/.bin/node")).toBe(true);
    expect(sendsOrRunsCode("/usr/local/bin/rscript")).toBe(true);
  });

  test("not jq, nor a program whose name only begins like one, nor a runner, which has its own list", () => {
    for (const word of ["jq", "ncdu", "curly", "nodemon", "pythonista", "npm"]) {
      expect(sendsOrRunsCode(word)).toBe(false);
    }
    expect(sendsOrRunsCode("sudo")).toBe(false);
    expect(sendsOrRunsCode("bash")).toBe(false);
  });

  test("the list is written in small letters, each once, and shares no name with the runners", () => {
    const list = NETWORK_CLIENTS_AND_INTERPRETERS;
    expect(list.every((name) => name === name.toLowerCase())).toBe(true);
    expect(new Set(list).size).toBe(list.length);
    expect(list.some((name) => COMMAND_RUNNERS.includes(name))).toBe(false);
    expect(list).not.toContain("jq");
  });
});

describe("a rule's command, matched word by word", () => {
  test("an exact command matches those words alone", () => {
    const rule = ruleCommandOf("npm test");
    expect(rule).toEqual({ words: ["npm", "test"], prefix: false });
    expect(wordsMatch(rule, ["npm", "test"])).toBe(true);
    expect(wordsMatch(rule, ["npm", "test", "--watch"])).toBe(false);
    expect(wordsMatch(rule, ["npm"])).toBe(false);
  });

  test("a prefix matches the bare command and any that goes on after its words", () => {
    const rule = ruleCommandOf("npm test:*");
    expect(rule).toEqual({ words: ["npm", "test"], prefix: true });
    expect(wordsMatch(rule, ["npm", "test"])).toBe(true);
    expect(wordsMatch(rule, ["npm", "test", "--watch"])).toBe(true);
  });

  test("never as a part of a word: npm test:* is not npm testing, nor npm test:unit", () => {
    const rule = ruleCommandOf("npm test:*");
    expect(wordsMatch(rule, ["npm", "testing"])).toBe(false);
    expect(wordsMatch(rule, ["npm", "test:unit"])).toBe(false);
    expect(wordsMatch(rule, ["npmx", "test"])).toBe(false);
    expect(wordsMatch(rule, ["npm"])).toBe(false);
  });
});

describe("the programs that send requests or run code, by the name their own begins with", () => {
  test.each([
    "curl.exe",
    "C:/Windows/System32/CURL.EXE",
    "python.exe",
    "python3.12.exe",
    "node.exe",
    "python3-intel64",
    "python3.13t",
    "nc.openbsd",
    "nc.traditional",
    "gawk-5.3.1",
    "mawk",
    "luajit",
    "irb",
    "jrunscript",
    "xhs",
  ])("%s is one", (word) => {
    expect(sendsOrRunsCode(word)).toBe(true);
  });

  test("a program named for one with a dash after it is refused too, the safe side", () => {
    expect(sendsOrRunsCode("python-config")).toBe(true);
    expect(sendsOrRunsCode("ssh-keygen")).toBe(true);
  });

  test.each([
    "npm",
    "make",
    "git",
    "cargo",
    "swiftlint",
    "nodemon",
    "curlie",
    "ncdu",
    "pytest",
    "jq",
  ])("%s is not", (word) => {
    expect(sendsOrRunsCode(word)).toBe(false);
  });
});

describe("a shell or a runner with a version in its name is still one", () => {
  test.each(["bash5", "ksh93", "zsh-5.9", "bash-5.2", "pwsh-preview", "pnpx", "nix-shell"])(
    "%s is one",
    (word) => {
      expect(runsAnotherCommand(word)).toBe(true);
    },
  );
});

describe("more interpreters and clients whose main purpose is running code or sending requests", () => {
  test.each([
    "java",
    "jshell",
    "ts-node",
    "tsx",
    "zx",
    "R",
    "elixir",
    "iex",
    "erl",
    "ghci",
    "scala",
    "kotlin",
    "ipython",
    "websocat",
    "lynx",
    "w3m",
    "grpcurl",
  ])("%s is one", (word) => {
    expect(sendsOrRunsCode(word)).toBe(true);
  });

  test("javac, a compiler, is not, and nor is rm, which only begins with r", () => {
    expect(sendsOrRunsCode("javac")).toBe(false);
    expect(sendsOrRunsCode("rm")).toBe(false);
    expect(sendsOrRunsCode("rsync")).toBe(false);
  });
});

describe("a subcommand that fetches or runs code", () => {
  test.each([
    ["npm exec some-pkg"],
    ["npm x some-pkg"],
    ["npm --yes exec some-pkg"],
    ["npm init some-pkg"],
    ["npm create some-pkg"],
    ["pnpm dlx some-pkg"],
    ["yarn dlx some-pkg"],
    ["uv tool run some-pkg"],
    ["uv run main.py"],
    ["pipx run some-pkg"],
    ["go run example.com/x@latest"],
    ["cargo run"],
    ["docker run some-image"],
    ["podman exec box sh"],
    ["NPM.exe EXEC some-pkg"],
  ])("%s runs code", (command) => {
    expect(runsCodeBySubcommand(command.split(" "))).toBe(true);
  });

  test.each([
    ["npm test"],
    ["npm run build"],
    ["go test -run TestX"],
    ["npm test -- exec"],
    ["docker ps"],
    ["git status"],
  ])("%s does not", (command) => {
    expect(runsCodeBySubcommand(command.split(" "))).toBe(false);
  });

  test("the list is written in small letters", () => {
    for (const [program, subcommands] of Object.entries(SUBCOMMANDS_THAT_RUN_CODE)) {
      expect(program).toBe(program.toLowerCase());
      expect(subcommands.every((name) => name === name.toLowerCase())).toBe(true);
    }
  });
});

describe("a command that names Agent Lookout's own files", () => {
  test("its folder, wherever it is written from, whatever its capitals", () => {
    expect(
      namesOwnFiles(["sed", "-i", "s/deny/allow/", "/Users/example/.agent-lookout/settings.json"]),
    ).toBe(true);
    expect(namesOwnFiles(["cp", "x", "../../.Agent-Lookout/"])).toBe(true);
    expect(namesOwnFiles(["ls", "-la"])).toBe(false);
  });

  test("a settings file or a socket a setting put elsewhere", () => {
    const own = ["/tmp/rules/settings.json", "/tmp/al/answer.sock"];
    expect(namesOwnFiles(["cp", "x", "/tmp/rules/settings.json"], own)).toBe(true);
    expect(namesOwnFiles(["rm", "/tmp/al/answer.sock"], own)).toBe(true);
    expect(namesOwnFiles(["cp", "x", "/tmp/rules/other.json"], own)).toBe(false);
    expect(namesOwnFiles(["ls"], ["", ""])).toBe(false);
  });
});

describe("a list name with anything after it that is not a letter is that name", () => {
  test.each([
    "ts-node-esm",
    "ts-node-script",
    "nix-shell-2.3",
    "aria2c-1.36",
    "vite-node_x",
    "go1.22.0",
  ])("%s is caught", (word) => {
    expect(runsAnotherCommand(word) || sendsOrRunsCode(word) || needsItsSubcommand([word])).toBe(
      true,
    );
  });
});

describe("a package manager or build tool names its subcommand", () => {
  test("alone, or with an option first, it does not", () => {
    expect(needsItsSubcommand(["npm"])).toBe(true);
    expect(needsItsSubcommand(["npm", "--yes"])).toBe(true);
    expect(needsItsSubcommand(["npm", "test"])).toBe(false);
    expect(needsItsSubcommand(["git"])).toBe(false);
  });

  test("a -- before the subcommand does not hide it, and one after it ends the search", () => {
    expect(runsCodeBySubcommand(["npm", "--", "exec", "x"])).toBe(true);
    expect(runsCodeBySubcommand(["npm", "test", "--", "exec"])).toBe(false);
  });

  test.each([
    ["npm exe x"],
    ["npm ini foo"],
    ["npm innit foo"],
    ["npm explo x"],
    ["bundle e rake"],
    ["bundler exec rake"],
    ["cargo r"],
    ["yarnpkg dlx x"],
    ["yarn node x.js"],
    ["docker-compose up"],
    ["docker build ."],
    ["dotnet exec app.dll"],
    ["go tool x"],
  ])("%s runs code", (command) => {
    expect(runsCodeBySubcommand(command.split(" "))).toBe(true);
  });
});

describe("an option through which a program runs another", () => {
  test.each([
    ["go test -exec=./x ."],
    ["go build --toolexec ./x ."],
    ["npm test --script-shell=./x.sh"],
    ["git -c core.pager=./x log"],
  ])("%s", (command) => {
    expect(runsAProgramByOption(command.split(" "))).toBe(true);
  });

  test("ordinary options are not", () => {
    expect(runsAProgramByOption(["go", "test", "-run", "TestX"])).toBe(false);
    expect(runsAProgramByOption(["git", "commit", "--cached"])).toBe(false);
    expect(runsAProgramByOption(["npm", "test", "--watch"])).toBe(false);
  });
});

describe("Agent Lookout's own files and the folders above them", () => {
  const own = [
    "/Users/example/.agent-lookout/settings.json",
    "/Users/example/.agent-lookout/answer.sock",
  ];

  test("a path made plain from its words", () => {
    expect(plainPath("/Users//Example/./code/../.agent-lookout/")).toBe(
      "/users/example/.agent-lookout",
    );
    expect(plainPath("src/app")).toBe("src/app");
  });

  test("a folder above them, an option's value and a path by number", () => {
    expect(namesOwnFiles(["tar", "-xf", "p.tar", "-C", "/Users/example"], own)).toBe(true);
    expect(namesOwnFiles(["git", "apply", "--directory=/Users/example", "x.diff"], own)).toBe(true);
    expect(namesOwnFiles(["ls", "/"], own)).toBe(true);
    expect(namesOwnFiles(["cp", "x", "/.vol/16777232/123/settings.json"], own)).toBe(true);
    expect(namesOwnFiles(["ls", "/Users/example/code"], own)).toBe(false);
  });

  test("a settings file a setting put elsewhere, by its own name too", () => {
    const elsewhere = ["/Users/example/proj/al.json"];
    expect(namesOwnFiles(["cp", "evil.json", "al.json"], elsewhere)).toBe(true);
    expect(namesOwnFiles(["cp", "evil.json", "/Users/example/proj//al.json"], elsewhere)).toBe(
      true,
    );
    expect(namesOwnFiles(["cp", "-R", "payload/", "/Users/example/proj"], elsewhere)).toBe(true);
  });

  test("a relative path read from the session's folder", () => {
    expect(namesOwnFiles(["cp", "-R", "payload/", "../.."], own, "/Users/example/code/shop")).toBe(
      true,
    );
    expect(namesOwnFiles(["cp", "-R", "payload/", "build"], own, "/Users/example/code/shop")).toBe(
      false,
    );
  });

  test("a session in your home folder or above reaches them, one in a project does not", () => {
    expect(folderReachesOwnFiles("/Users/example", own)).toBe(true);
    expect(folderReachesOwnFiles("/Users/example/", own)).toBe(true);
    expect(folderReachesOwnFiles("/", own)).toBe(true);
    expect(folderReachesOwnFiles("/Users/example/code/shop", own)).toBe(false);
  });
});
