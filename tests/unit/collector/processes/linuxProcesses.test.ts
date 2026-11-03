import { describe, expect, test } from "vitest";

import {
  BOOT_ID_FILE,
  bootIdOf,
  createPidNamespaceRead,
  createStartTokenReader,
  PID_NAMESPACE_FILE,
  startTicksOf,
  statFileOf,
} from "@collector/processes/linuxProcesses";
import { BOOT_ID, PID_NAMESPACE, startToken } from "@tests/fixtures/qwen-code/qwenCode";

/**
 * A `/proc/<pid>/stat` line as Linux writes it: the pid, the program name in
 * brackets, then fields 3 to 52, with generic values and the start, field 22.
 */
function statLine(pid: number, name: string, ticks: number | string): string {
  // Fields 3 to 21: the state, the parent, the group and the session, the
  // terminal, the flags, the faults, the times, the priority and the threads.
  const before = ["S", "1", `${pid}`, `${pid}`, "34817", `${pid}`, "4194560", "1200", "0", "0"];
  const times = ["0", "12", "4", "0", "0", "20", "0", "11", "0"];
  const after = Array.from({ length: 30 }, (_, index) => `${index}`);
  return `${pid} (${name}) ${[...before, ...times, `${ticks}`, ...after].join(" ")}\n`;
}

/** A `/proc` held in memory, which writes down every file it was asked for. */
function standInProc(files: Record<string, string | Error>) {
  const known = new Map(Object.entries(files));
  const asked: string[] = [];
  return {
    known,
    asked,
    async readFile(file: string) {
      asked.push(file);
      const content = known.get(file);
      if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (content instanceof Error) throw content;
      return content;
    },
  };
}

describe("startTicksOf", () => {
  test("is field 22 of a stat line, the start in clock ticks since the boot", () => {
    expect(startTicksOf(statLine(41001, "node", 8_812_345))).toBe("8812345");
  });

  test("counts from the line's last bracket, so a name with brackets and spaces of its own does not move it", () => {
    for (const name of ["qwen ) (x", ") (", "a b c", "((", "))", "x) S 1 2 3 (y"]) {
      expect(startTicksOf(statLine(41001, name, 42)), name).toBe("42");
    }
  });

  test("keeps the start and nothing of the name", () => {
    const ticks = startTicksOf(statLine(41001, "secret-name ) (", 42));
    expect(ticks).toBe("42");
    expect(ticks).not.toContain("secret");
  });

  test.each([
    ["no bracket", "41001 node S 1 2 3"],
    ["too few fields", "41001 (node) S 1 2 3\n"],
    ["a start that is not a number", statLine(41001, "node", "-5")],
    ["an empty line", ""],
  ])("a line with %s has none", (_what, line) => {
    expect(startTicksOf(line)).toBeNull();
  });
});

describe("bootIdOf", () => {
  test("is the boot id the kernel writes, without its newline", () => {
    expect(bootIdOf(`${BOOT_ID}\n`)).toBe(BOOT_ID);
  });

  test.each(["", "\n", "not a boot id", "0000:0000", "0000 0000"])("%j is none", (text) => {
    expect(bootIdOf(text)).toBeNull();
  });
});

describe("createStartTokenReader", () => {
  test("joins the boot id and each process's start, as Qwen Code writes its token", async () => {
    const proc = standInProc({
      [BOOT_ID_FILE]: `${BOOT_ID}\n`,
      [statFileOf(41001)]: statLine(41001, "node", 500),
      [statFileOf(41004)]: statLine(41004, "qwen ) (x", 900),
    });
    const read = createStartTokenReader(proc.readFile);

    expect(await read([41001, 41004])).toEqual(
      new Map([
        [41001, startToken(500)],
        [41004, startToken(900)],
      ]),
    );
  });

  test("reads the boot id once, and each process's stat each time, and no other file", async () => {
    const proc = standInProc({
      [BOOT_ID_FILE]: `${BOOT_ID}\n`,
      [statFileOf(41001)]: statLine(41001, "node", 500),
    });
    const read = createStartTokenReader(proc.readFile);
    await read([41001]);
    await read([41001]);

    expect(proc.asked).toEqual([BOOT_ID_FILE, statFileOf(41001), statFileOf(41001)]);
  });

  test("leaves out a process whose stat cannot be read or holds no start", async () => {
    const proc = standInProc({
      [BOOT_ID_FILE]: `${BOOT_ID}\n`,
      [statFileOf(41001)]: statLine(41001, "node", 500),
      [statFileOf(41002)]: Object.assign(new Error("EACCES"), { code: "EACCES" }),
      [statFileOf(41003)]: "41003 (node) Z\n",
    });
    const read = createStartTokenReader(proc.readFile);

    expect(await read([41001, 41002, 41003, 41009])).toEqual(new Map([[41001, startToken(500)]]));
  });

  test("with no boot id, gives no token, reads no stat, and reads the boot id again next time", async () => {
    const proc = standInProc({ [statFileOf(41001)]: statLine(41001, "node", 500) });
    const read = createStartTokenReader(proc.readFile);
    expect((await read([41001])).size).toBe(0);

    proc.known.set(BOOT_ID_FILE, "not a boot id\n");
    expect((await read([41001])).size).toBe(0);
    expect(proc.asked).toEqual([BOOT_ID_FILE, BOOT_ID_FILE]);

    proc.known.set(BOOT_ID_FILE, `${BOOT_ID}\n`);
    expect(await read([41001])).toEqual(new Map([[41001, startToken(500)]]));
  });

  test("reads nothing for no pid, or for one that is not a pid", async () => {
    const proc = standInProc({ [BOOT_ID_FILE]: `${BOOT_ID}\n` });
    const read = createStartTokenReader(proc.readFile);
    expect((await read([])).size).toBe(0);
    expect((await read([0, -1, 1.5])).size).toBe(0);
    expect(proc.asked).toEqual([]);
  });
});

describe("createPidNamespaceRead", () => {
  /** A stand-in for the inode of a file, which answers in turn, and the files it was asked for. */
  function standInInodes(...answers: (number | Error)[]) {
    const asked: string[] = [];
    return {
      asked,
      async inodeOf(file: string) {
        asked.push(file);
        const answer = answers[Math.min(asked.length - 1, answers.length - 1)];
        if (answer instanceof Error) throw answer;
        return answer as number;
      },
    };
  }

  test("reads the inode of /proc/self/ns/pid once and keeps it, since a process never moves to another", async () => {
    const inodes = standInInodes(PID_NAMESPACE, 99);
    const read = createPidNamespaceRead(inodes.inodeOf);
    expect(await read()).toBe(PID_NAMESPACE);
    expect(await read()).toBe(PID_NAMESPACE);
    expect(inodes.asked).toEqual([PID_NAMESPACE_FILE]);
  });

  test("a read that failed, or gave no inode, is not kept, and is tried again next time", async () => {
    const inodes = standInInodes(new Error("ENOENT"), 0, PID_NAMESPACE);
    const read = createPidNamespaceRead(inodes.inodeOf);
    expect(await read()).toBeNull();
    expect(await read()).toBeNull();
    expect(await read()).toBe(PID_NAMESPACE);
    expect(await read()).toBe(PID_NAMESPACE);
    expect(inodes.asked).toHaveLength(3);
  });
});
