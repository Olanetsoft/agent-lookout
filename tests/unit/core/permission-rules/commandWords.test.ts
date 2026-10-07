import { describe, expect, test } from "vitest";

import {
  COMMAND_RUNNERS,
  looseCommandWords,
  looselyMatches,
  plainCommandWords,
  programOf,
  ruleCommandOf,
  runsAnotherCommand,
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

  test("the list is written in small letters, each once", () => {
    expect(COMMAND_RUNNERS.every((name) => name === name.toLowerCase())).toBe(true);
    expect(new Set(COMMAND_RUNNERS).size).toBe(COMMAND_RUNNERS.length);
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
