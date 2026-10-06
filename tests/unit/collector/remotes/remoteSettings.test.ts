import { describe, expect, test } from "vitest";

import {
  DEFAULT_REMOTE_PORT,
  isSshTarget,
  MAX_REMOTES,
  readRemotesSetup,
  remotesProblemLine,
  REMOTES_ENV,
} from "@collector/remotes/remoteSettings";
import { isMachineName } from "@core/sessions/session";

function setup(value: string | undefined) {
  return readRemotesSetup(value === undefined ? {} : { [REMOTES_ENV]: value });
}

describe("readRemotesSetup", () => {
  test("unset, empty or only commas, no machine is read and nothing is wrong", () => {
    for (const value of [undefined, "", "   ", ",", " , ,"]) {
      expect(setup(value), String(value)).toEqual({ on: false, problem: null });
    }
  });

  test("reads each machine as name=target, with Agent Lookout's own port unless one is given", () => {
    expect(setup("devbox=dev@devbox.local, gpu=gpu-vm:4800 ,build=192.168.1.20")).toEqual({
      on: true,
      remotes: [
        { name: "devbox", target: "dev@devbox.local", port: DEFAULT_REMOTE_PORT },
        { name: "gpu", target: "gpu-vm", port: 4800 },
        { name: "build", target: "192.168.1.20", port: DEFAULT_REMOTE_PORT },
      ],
    });
    expect(DEFAULT_REMOTE_PORT).toBe(4777);
  });

  test.each([
    ["-oProxyCommand=sh", "an option for a target"],
    ["dev@-oProxyCommand=sh", "an option after the user"],
    ["-devbox", "a leading dash"],
    ["dev box", "a space"],
    ["devbox;rm", "a semicolon"],
    ["devbox&&true", "an ampersand"],
    ["devbox|cat", "a pipe"],
    ["$(whoami)", "a substitution"],
    ["`id`", "a backtick"],
    ["dev@box@host", "two @"],
    ["@devbox", "no user before the @"],
    ["dev@", "no host after the @"],
    ["", "nothing at all"],
    ["dev\tbox", "a tab"],
    ["devbox\nhost", "a line break"],
    ["devbox#2", "a hash"],
    ["dev'box", "a quote"],
    ["host/path", "a slash"],
  ])("a target with %j, %s, is refused, and the setting with it", (target, _why) => {
    const result = setup(`ok=devbox,devbox=${target}`);
    expect(result.on).toBe(false);
    expect(result).toEqual({
      on: false,
      problem: expect.stringContaining(
        `${REMOTES_ENV} gives devbox a target that Agent Lookout does not hand to ssh.`,
      ),
    });
  });

  test("a sentence about a target never repeats it", () => {
    const result = setup("devbox=-oProxyCommand=curl example.com|sh");
    if (result.on) throw new Error("expected the setting to be refused");
    expect(result.problem).not.toContain("ProxyCommand");
    expect(result.problem).not.toContain("example.com");
  });

  test.each([
    ["dev box", "a space"],
    ["dev;box", "a semicolon"],
    ["-devbox", "a leading dash"],
    ["dev_box", "an underscore"],
    ["dev.box", "a dot"],
    ["a".repeat(25), "more than 24 characters"],
    ["", "no name"],
  ])("a name with %j, %s, is refused", (name) => {
    expect(isMachineName(name)).toBe(false);
    expect(setup(`${name}=devbox`)).toEqual({
      on: false,
      problem: `${REMOTES_ENV} gives the 1st machine a name that is not one: use letters, digits and dashes, up to 24, starting with a letter or a digit.`,
    });
  });

  test("a name is letters, digits and dashes", () => {
    for (const name of ["devbox", "gpu-vm-2", "A1", "a".repeat(24)]) {
      expect(isMachineName(name), name).toBe(true);
    }
  });

  test("an entry with no = says which entry it is", () => {
    expect(setup("devbox=dev@devbox.local,gpu-vm")).toEqual({
      on: false,
      problem: `${REMOTES_ENV} has an entry, the 2nd, with no = in it. Write each machine as name=target, such as devbox=dev@devbox.local.`,
    });
  });

  test.each(["0", "65536", "port", "-1", "", "4777x", "47 77"])(
    "a port of %j is refused",
    (port) => {
      expect(setup(`devbox=dev@devbox.local:${port}`)).toEqual({
        on: false,
        problem: `${REMOTES_ENV} gives devbox a port that is not a number from 1 to 65535.`,
      });
    },
  );

  test("a name given twice, in any case, is refused", () => {
    expect(setup("devbox=a,DevBox=b")).toEqual({
      on: false,
      problem: `${REMOTES_ENV} names DevBox twice.`,
    });
  });

  test(`more than ${MAX_REMOTES} machines are refused`, () => {
    const many = Array.from({ length: MAX_REMOTES + 1 }, (_, index) => `m${index}=host${index}`);
    expect(setup(many.join(","))).toEqual({
      on: false,
      problem: `${REMOTES_ENV} names 9 machines, and Agent Lookout reads 8 at most.`,
    });
    expect(setup(many.slice(0, MAX_REMOTES).join(",")).on).toBe(true);
  });

  test("the line on the console says that other machines are not read", () => {
    expect(remotesProblemLine(`${REMOTES_ENV} names devbox twice.`)).toBe(
      `Other machines are not read: ${REMOTES_ENV} names devbox twice.`,
    );
  });
});

describe("isSshTarget", () => {
  test("takes a host alias, a host name, an address and user@host", () => {
    for (const target of [
      "devbox",
      "devbox.local",
      "dev@devbox.local",
      "gpu-vm",
      "_vm",
      "10.0.0.2",
      "a.b-c_d@e.f",
    ]) {
      expect(isSshTarget(target), target).toBe(true);
    }
  });

  test("refuses a leading dash or dot, an option and every space and shell character", () => {
    for (const target of [
      "-p22",
      ".hidden",
      "dev@.host",
      "-oProxyCommand=x",
      "a b",
      "a;b",
      "a$b",
      "a*",
      "a?",
      "a~",
      "[::1]",
      "a:22",
    ]) {
      expect(isSshTarget(target), target).toBe(false);
    }
  });
});
