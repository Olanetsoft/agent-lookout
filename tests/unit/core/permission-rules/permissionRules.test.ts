import { describe, expect, test } from "vitest";

import {
  MAX_RULES,
  readPermissionRules,
  ruleProblem,
  ruleText,
  ruleWordsIn,
  sameWords,
  type PermissionRule,
  type RuleWords,
} from "@core/permission-rules/permissionRules";

const rule = (words: RuleWords, id = "a1b2c3d4e5f6"): PermissionRule => ({ id, ...words });

describe("the rules a person can write", () => {
  test.each<RuleWords>([
    { decision: "allow", tool: "Bash", command: "npm test" },
    { decision: "allow", tool: "Bash", command: "npm test:*" },
    { decision: "allow", tool: "Bash", command: "npm run test:unit:*" },
    { decision: "allow", tool: "WebFetch" },
    { decision: "allow", tool: "Read" },
    { decision: "allow", tool: "mcp__docs__search" },
    { decision: "allow", tool: "mcp__my-server__look_up" },
    { decision: "ask", tool: "Bash", command: "git push:*" },
    { decision: "ask", tool: "*" },
    { decision: "deny", tool: "Bash" },
    { decision: "deny", tool: "Bash", command: "rm -rf ~" },
    { decision: "deny", tool: "Bash", command: "git push --force:*" },
    { decision: "deny", tool: "Write" },
    { decision: "deny", tool: "*" },
  ])("%j is a rule", (words) => {
    expect(ruleProblem(words)).toBeNull();
  });

  test.each<[RuleWords, RegExp]>([
    [{ decision: "allow", tool: "" }, /Name a tool/],
    [{ decision: "deny", tool: "Bash(npm test)" }, /command in its own field/],
    [{ decision: "deny", tool: "bash" }, /writes this tool's name Bash/],
    [{ decision: "deny", tool: "BASH", command: "rm:*" }, /writes this tool's name Bash/],
    [{ decision: "deny", tool: "Web Fetch" }, /as Claude Code writes it/],
    [{ decision: "deny", tool: "1Password" }, /as Claude Code writes it/],
    [{ decision: "deny", tool: "Bash​" }, /as Claude Code writes it/],
    [{ decision: "deny", tool: "Bаsh" }, /as Claude Code writes it/],
    [{ decision: "deny", tool: `mcp__${"x".repeat(130)}` }, /as Claude Code writes it/],
    [{ decision: "deny", tool: "WebFetch", command: "curl:*" }, /goes with Bash only/],
    [{ decision: "deny", tool: "*", command: "rm:*" }, /goes with Bash only/],
  ])("%j is no rule", (words, problem) => {
    expect(ruleProblem(words)).toMatch(problem);
  });

  test("an allow rule names one tool, and for Bash a command: allowing everything is refused", () => {
    expect(ruleProblem({ decision: "allow", tool: "*" })).toMatch(/names one tool/);
    expect(ruleProblem({ decision: "allow", tool: "Bash" })).toMatch(/names a command/);
  });

  test.each(["Edit", "Write", "MultiEdit", "NotebookEdit"])(
    "an allow rule for %s is refused, since the change is never shown",
    (tool) => {
      expect(ruleProblem({ decision: "allow", tool })).toMatch(/never allows one/);
      expect(ruleProblem({ decision: "deny", tool })).toBeNull();
    },
  );

  test.each(["ExitPlanMode", "AskUserQuestion"])(
    "an allow rule for %s is refused, since it takes more than yes or no",
    (tool) => {
      expect(ruleProblem({ decision: "allow", tool })).toMatch(/more than yes or no/);
    },
  );

  test.each([
    ["npm test; rm -rf build", /no ;, &, \|/],
    ["npm test && rm", /no ;, &, \|/],
    ["npm test | sh", /no ;, &, \|/],
    ["npm test > out", /no ;, &, \|/],
    ["echo $(id)", /no ;, &, \|/],
    ["echo `id`", /no ;, &, \|/],
    ["echo $HOME", /no ;, &, \|/],
    ['git commit -m "wip"', /no ;, &, \|/],
    ["rm *.log", /no ;, &, \|/],
    ["npm *test", /no ;, &, \|/],
    ["npm test *", /Write a prefix with :\*/],
    ["npm test :*", /straight after the words/],
    [":*", /straight after the words/],
    ["npm test\nrm", /plain ASCII/],
    [" npm test", /plain ASCII/],
    ["npm test ", /plain ASCII/],
    ["npm  test", /plain ASCII/],
    ["npm\ttest", /plain ASCII/],
    ["npm tеst", /plain ASCII/],
    ["npm test‮", /plain ASCII/],
    ["", /plain ASCII/],
    [`npm ${"a".repeat(200)}`, /200 characters at most/],
  ])("the command %j is refused for any rule", (command, problem) => {
    for (const decision of ["allow", "ask", "deny"] as const) {
      expect(ruleProblem({ decision, tool: "Bash", command })).toMatch(problem);
    }
  });

  test.each(["cat ~/.ssh/config", "npm test #x", "ls file?.ts", "ls =rm"])(
    "%j may be denied, but never allowed by a rule",
    (command) => {
      expect(ruleProblem({ decision: "deny", tool: "Bash", command })).toBeNull();
      expect(ruleProblem({ decision: "allow", tool: "Bash", command })).toMatch(
        /one plain command/,
      );
    },
  );

  test("a command that begins by setting a variable is refused, since it would match nothing", () => {
    for (const decision of ["ask", "deny"] as const) {
      expect(ruleProblem({ decision, tool: "Bash", command: "FORCE=1 npm test" })).toMatch(
        /Begin the command with the program's name/,
      );
    }
    expect(ruleProblem({ decision: "allow", tool: "Bash", command: "FORCE=1 npm test" })).toMatch(
      /one plain command/,
    );
  });

  test.each([
    "eval:*",
    "exec:*",
    "env:*",
    "env NODE_ENV=test npm test",
    "command:*",
    "builtin:*",
    "nohup:*",
    "time npm test",
    "nice:*",
    "timeout 5 npm test",
    "xargs:*",
    "sudo:*",
    "sudo npm test",
    "doas:*",
    "sh:*",
    "sh -c:*",
    "bash:*",
    "bash scripts/check.sh",
    "zsh:*",
    "dash:*",
    "ksh:*",
    "fish:*",
    "source:*",
    ". ./env.sh",
    "/usr/bin/env:*",
    "ENV:*",
    "Sudo npm test",
  ])(
    "an allow rule for %j, which runs another command, is refused, but it may be denied",
    (command) => {
      expect(ruleProblem({ decision: "allow", tool: "Bash", command })).toMatch(
        /runs another command, so an allow rule for it would let Claude Code run anything without asking you/,
      );
      expect(ruleProblem({ decision: "deny", tool: "Bash", command })).toBeNull();
      expect(ruleProblem({ decision: "ask", tool: "Bash", command })).toBeNull();
    },
  );

  test.each([
    "curl:*",
    "curl -s http://127.0.0.1:4777/api/health",
    "wget:*",
    "nc:*",
    "socat:*",
    "ssh:*",
    "scp:*",
    "http:*",
    "xh:*",
    "node:*",
    "node scripts/build.js",
    "deno:*",
    "bun:*",
    "python:*",
    "python -m pytest",
    "python3 -m pytest:*",
    "python3.12:*",
    "ruby:*",
    "perl:*",
    "php:*",
    "lua:*",
    "osascript:*",
    "swift:*",
    "Rscript:*",
    "awk:*",
    "gawk:*",
    "expect:*",
    "/usr/bin/curl:*",
    "CURL:*",
    "/opt/homebrew/bin/Python3 -m pytest",
  ])(
    "an allow rule for %j, which can send requests or run the code it is given, is refused, but it may be denied",
    (command) => {
      const problem = ruleProblem({ decision: "allow", tool: "Bash", command });
      expect(problem).toMatch(
        /can send requests, or run code that does, so an allow rule for it would let Claude Code reach Agent Lookout on this computer and add a rule or answer its own prompts without asking you/,
      );
      expect(problem).toMatch(
        /Answer such commands by hand, or allow a script the project owns, such as \.\/scripts\/test\.sh, knowing Claude can edit it\./,
      );
      expect(ruleProblem({ decision: "deny", tool: "Bash", command })).toBeNull();
      expect(ruleProblem({ decision: "ask", tool: "Bash", command })).toBeNull();
    },
  );

  test("the refusal names the program as it was written", () => {
    expect(ruleProblem({ decision: "allow", tool: "Bash", command: "python3 -m pytest" })).toMatch(
      /^python3 can send requests/,
    );
  });

  test("a program that runs another is still refused as one, before it is read as anything else", () => {
    expect(ruleProblem({ decision: "allow", tool: "Bash", command: "env python3 x.py" })).toMatch(
      /^env runs another command/,
    );
  });

  test("jq, a script the project owns, and a command that only names such a program later may be allowed", () => {
    for (const command of ["jq:*", "./scripts/test.sh", "npm run python", "make curl", "ncdu:*"]) {
      expect(ruleProblem({ decision: "allow", tool: "Bash", command })).toBeNull();
    }
  });

  test("a program whose name only begins like one that runs others may be allowed", () => {
    expect(ruleProblem({ decision: "allow", tool: "Bash", command: "envsubst:*" })).toBeNull();
    expect(ruleProblem({ decision: "allow", tool: "Bash", command: "shellcheck:*" })).toBeNull();
    expect(ruleProblem({ decision: "allow", tool: "Bash", command: "npm run env" })).toBeNull();
  });

  test("an MCP server alone may be denied or asked for, but an allow rule names one of its tools", () => {
    expect(ruleProblem({ decision: "deny", tool: "mcp__docs" })).toBeNull();
    expect(ruleProblem({ decision: "ask", tool: "mcp__my-server" })).toBeNull();
    expect(ruleProblem({ decision: "allow", tool: "mcp__docs" })).toMatch(
      /names one tool of a server, such as mcp__docs__search/,
    );
    expect(ruleProblem({ decision: "allow", tool: "mcp__docs__search" })).toBeNull();
    for (const tool of ["mcp__", "mcp__docs__"]) {
      expect(ruleProblem({ decision: "deny", tool })).toMatch(/as Claude Code writes it/);
    }
  });
});

describe("a rule as the route takes it", () => {
  test("exactly a decision, a tool and perhaps a command", () => {
    expect(ruleWordsIn({ decision: "allow", tool: "Bash", command: "npm test" })).toEqual({
      ok: true,
      words: { decision: "allow", tool: "Bash", command: "npm test" },
    });
    expect(ruleWordsIn({ decision: "deny", tool: "Write" })).toEqual({
      ok: true,
      words: { decision: "deny", tool: "Write" },
    });
  });

  test.each([
    null,
    [],
    "allow Bash",
    { decision: "allow" },
    { tool: "Bash" },
    { decision: "always", tool: "Read" },
    { decision: "allow", tool: 7 },
    { decision: "allow", tool: "Bash", command: 7 },
    { decision: "allow", tool: "Bash", command: null },
    { decision: "allow", tool: "Read", path: "/etc" },
    { id: "a1", decision: "allow", tool: "Read" },
  ])("%j is refused whole", (value) => {
    expect(ruleWordsIn(value).ok).toBe(false);
  });
});

describe("the rules a file holds", () => {
  const ALLOW = rule({ decision: "allow", tool: "Bash", command: "npm test:*" }, "r1");
  const DENY = rule({ decision: "deny", tool: "Write" }, "r2");

  test("nothing there is no rule", () => {
    expect(readPermissionRules(undefined)).toEqual({ ok: true, rules: [] });
    expect(readPermissionRules([])).toEqual({ ok: true, rules: [] });
  });

  test("a list of rules is read in its order", () => {
    expect(readPermissionRules([DENY, ALLOW])).toEqual({ ok: true, rules: [DENY, ALLOW] });
  });

  test.each([
    ["not a list", { r1: ALLOW }],
    ["a rule that cannot be read", [ALLOW, { ...DENY, decision: "never" }]],
    ["a rule with a field this version does not know", [ALLOW, { ...DENY, path: "/x" }]],
    ["a rule with no id", [ALLOW, { decision: "deny", tool: "Write" }]],
    ["a rule with an id that is not one", [ALLOW, { ...DENY, id: "two words" }]],
    ["two rules with one id", [ALLOW, { ...DENY, id: "r1" }]],
    ["an allow rule for every command", [{ id: "r3", decision: "allow", tool: "Bash" }]],
    [
      "an allow rule for a program that sends requests, as saved before it was refused",
      [ALLOW, { id: "r3", decision: "allow", tool: "Bash", command: "curl:*" }, DENY],
    ],
    [
      "an allow rule for an interpreter, exactly",
      [{ id: "r3", decision: "allow", tool: "Bash", command: "python -m pytest" }, DENY],
    ],
    [
      "more rules than the list holds",
      Array.from({ length: MAX_RULES + 1 }, (_, index) => ({ ...DENY, id: `r${index}` })),
    ],
  ])("%s is no rule at all, so nothing is half read", (_why, value) => {
    expect(readPermissionRules(value)).toEqual({ ok: false });
  });

  test(`${MAX_RULES} rules are read`, () => {
    const rules = Array.from({ length: MAX_RULES }, (_, index) =>
      rule({ decision: "deny", tool: "Bash", command: `rm${index}` }, `r${index}`),
    );
    expect(readPermissionRules(rules)).toEqual({ ok: true, rules });
  });
});

describe("a rule in words", () => {
  test("as Claude Code writes one, and every tool in words", () => {
    expect(ruleText({ tool: "Bash", command: "npm test:*" })).toBe("Bash(npm test:*)");
    expect(ruleText({ tool: "WebFetch" })).toBe("WebFetch");
    expect(ruleText({ tool: "*" })).toBeNull();
  });

  test("two rules say the same when their words do, whatever their ids", () => {
    const words: RuleWords = { decision: "deny", tool: "Bash", command: "rm:*" };
    expect(sameWords(rule(words, "a"), rule(words, "b"))).toBe(true);
    expect(sameWords(words, { ...words, decision: "ask" })).toBe(false);
    expect(sameWords(words, { decision: "deny", tool: "Bash" })).toBe(false);
  });
});
