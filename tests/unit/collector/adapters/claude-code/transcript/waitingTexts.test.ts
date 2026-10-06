import { describe, expect, test } from "vitest";

import {
  createWaitingTextReader,
  LOOK_AGAIN_MS,
  WAITING_TEXT_ENV,
  waitingTextOff,
} from "@collector/adapters/claude-code/transcript/waitingTexts";
import type { Session } from "@core/sessions/session";
import { ids } from "@tests/fixtures/claudeCode";
import {
  said,
  toolResult,
  toolUse,
  toolUseId,
  transcript,
  waitingToRun,
} from "@tests/fixtures/claudeTranscript";
import { makeSession } from "@tests/fixtures/session";
import { handClock, memoryFiles } from "@tests/support/adapters/codexAdapter";

const HOME = "/Users/example/.claude";
const CWD = "/Users/example/code/demo-api";
const FILE = `${HOME}/projects/-Users-example-code-demo-api/${ids.permission}.jsonl`;
const SINCE = 1_700_000_050_000;

/** The session waiting for permission, as the adapter gives it. */
function waiting(overrides: Partial<Session> = {}): Session {
  return makeSession({
    id: `claude-code:${ids.permission}`,
    name: "demo-api",
    cwd: CWD,
    project: "demo-api",
    status: "needs-you",
    waitingReason: "permission",
    statusSince: SINCE,
    ...overrides,
  });
}

function setUp() {
  const files = memoryFiles();
  const clock = handClock(SINCE + 1_000);
  const reader = createWaitingTextReader({ claudeHome: HOME, io: files.io, now: clock.now });
  return { files, clock, reader };
}

describe("AGENT_LOOKOUT_WAITING_TEXT", () => {
  test("off, in any case and with spaces, turns the reading off, and anything else leaves it on", () => {
    expect(WAITING_TEXT_ENV).toBe("AGENT_LOOKOUT_WAITING_TEXT");
    expect(waitingTextOff({ AGENT_LOOKOUT_WAITING_TEXT: "off" })).toBe(true);
    expect(waitingTextOff({ AGENT_LOOKOUT_WAITING_TEXT: " OFF " })).toBe(true);
    expect(waitingTextOff({ AGENT_LOOKOUT_WAITING_TEXT: "on" })).toBe(false);
    expect(waitingTextOff({ AGENT_LOOKOUT_WAITING_TEXT: "" })).toBe(false);
    expect(waitingTextOff({})).toBe(false);
  });
});

describe("what a waiting session is asking", () => {
  test("is read from the end of its transcript and given as waitingText", async () => {
    const { files, reader } = setUp();
    files.write(FILE, waitingToRun("npm test"));
    const [session] = await reader.annotate([waiting()]);
    expect(session?.waitingText).toBe("Run: npm test");
  });

  test("only a waiting Claude Code session is read, and the others are handed back as they are", async () => {
    const { files, reader } = setUp();
    files.write(FILE, waitingToRun("npm test"));
    const working = waiting({ status: "working", waitingReason: undefined });
    const codex = waiting({ source: "codex", id: `codex:${ids.permission}` });
    const statusFile = waiting({ source: "status-files", id: `status-files:${ids.permission}` });
    const job = waiting({ id: "claude-code:job-0001" });
    const sessions = [working, codex, statusFile, job];
    const annotated = await reader.annotate(sessions);
    annotated.forEach((session, index) => expect(session).toBe(sessions[index]));
    expect(files.calls).toEqual([]);
    expect(reader.size).toBe(0);
  });

  test("is not read again while the transcript has not changed, and is read again once it has", async () => {
    const { files, reader } = setUp();
    files.write(FILE, waitingToRun("npm test"));
    await reader.annotate([waiting()]);
    files.forget();

    for (let poll = 0; poll < 5; poll += 1) {
      const [session] = await reader.annotate([waiting()]);
      expect(session?.waitingText).toBe("Run: npm test");
    }
    // Opened to compare its stamp, never read, and never looked for again.
    expect(files.reads).toEqual([]);
    expect(files.count("readdir")).toBe(0);
    expect(files.count("lstat")).toBe(0);

    const next = toolUseId();
    files.append(FILE, transcript([toolUse(next, "Edit", { file_path: `${CWD}/src/app.ts` })]));
    const [session] = await reader.annotate([waiting()]);
    expect(session?.waitingText).toBe("Edit: src/app.ts");
    expect(files.reads).toHaveLength(1);
  });

  test("is forgotten as soon as the session is not waiting, and a later wait is read afresh", async () => {
    const { files, reader } = setUp();
    files.write(FILE, waitingToRun("npm test"));
    await reader.annotate([waiting()]);
    expect(reader.size).toBe(1);

    // Answered: nothing of the wait is kept.
    const [working] = await reader.annotate([waiting({ status: "working" })]);
    expect(working?.waitingText).toBeUndefined();
    expect(reader.size).toBe(0);

    // Gone from the list: the same.
    await reader.annotate([waiting()]);
    await reader.annotate([]);
    expect(reader.size).toBe(0);

    // A new wait, even unseen, with a later status time, is looked for again.
    await reader.annotate([waiting()]);
    files.forget();
    await reader.annotate([waiting({ statusSince: SINCE + 60_000 })]);
    expect(files.count("lstat")).toBe(1);
  });

  test("a wait whose tool use was answered, or a transcript with none, has no text", async () => {
    const { files, reader } = setUp();
    const id = toolUseId();
    files.write(
      FILE,
      transcript([toolUse(id, "Bash", { command: "npm test" }), toolResult(id), said("Done.")]),
    );
    const [session] = await reader.annotate([waiting()]);
    expect(session).not.toHaveProperty("waitingText");
  });

  test("a transcript that is not found is looked for again only after a while", async () => {
    const { files, clock, reader } = setUp();
    files.mkdir(`${HOME}/projects/-Users-example-code-other`);
    await reader.annotate([waiting()]);
    expect(files.count("readdir")).toBe(1);

    clock.advance(LOOK_AGAIN_MS - 1);
    await reader.annotate([waiting()]);
    expect(files.count("readdir")).toBe(1);

    files.write(FILE, waitingToRun("npm test"));
    clock.advance(1);
    const [session] = await reader.annotate([waiting()]);
    expect(session?.waitingText).toBe("Run: npm test");
  });

  test("a transcript that goes away is looked for again, and one that cannot be read gives no text", async () => {
    const { files, clock, reader } = setUp();
    files.write(FILE, waitingToRun("npm test"));
    await reader.annotate([waiting()]);

    files.remove(FILE);
    const [gone] = await reader.annotate([waiting()]);
    expect(gone?.waitingText).toBeUndefined();

    const moved = `${HOME}/projects/-Users-example-code-moved/${ids.permission}.jsonl`;
    files.write(moved, waitingToRun("npm run lint"));
    clock.advance(LOOK_AGAIN_MS);
    const [found] = await reader.annotate([waiting()]);
    expect(found?.waitingText).toBe("Run: npm run lint");

    files.fail(moved, "EACCES");
    const [refused] = await reader.annotate([waiting()]);
    expect(refused?.waitingText).toBeUndefined();
  });

  test("never rejects, whatever the file system does", async () => {
    const { files, reader } = setUp();
    files.failAll("EIO");
    const sessions = [waiting()];
    await expect(reader.annotate(sessions)).resolves.toEqual(sessions);
  });
});
