// One scripted run of the Pi adapter's shared body, for the golden tests of
// Pi and Kimchi: a list of what each poll gave, what it asked of the files,
// which bytes it read and what it asked `ps`. The tests hold each run to the
// one recorded before Prime Agent's options were added to the shared body,
// so a change made for Prime Agent that moves anything for Pi or Kimchi
// shows. Nothing here touches a real file or runs a program: `ps` is the
// stand-in the test file puts in place of `runPs`.

import type { Adapter } from "@collector/adapters/adapter";
import { RECHECK_MS, type PiAdapterOptions } from "@collector/adapters/pi/index";
import type { PiProfile } from "@collector/adapters/pi/profile";
import { SWEEP_MS } from "@collector/adapters/pi/sessionFiles";
import type { PsAnswer } from "@collector/processes/ps";
import { subagentMarkerLine } from "@tests/fixtures/kimchi/kimchi";
import {
  conversationLines,
  DAY,
  headerFields,
  HOME,
  line,
  nameLine,
  NOW,
  PROJECT,
  SECOND,
  sessionIdOf,
} from "@tests/fixtures/pi/pi";
import { handClock, memoryFiles } from "@tests/support/adapters/codexAdapter";

/** What the test file's stand-in for `runPs` was asked, and what it answers next. */
export interface RecordingPs {
  asked: string[][];
  answer: PsAnswer;
}

/** The folder a profile's adapter reads in this run, with its own variable set or not. */
function sessionsDirOf(profile: PiProfile, named: boolean): string {
  return named ? `${HOME}/al-home/sessions` : `${HOME}/${profile.agentDir.join("/")}/sessions`;
}

/** The folder a run's session runs in, as Pi names a project folder. */
const projectFolder = (dir: string) =>
  `${dir}/--${PROJECT.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`;

/**
 * Runs one script of polls through an adapter `make` builds, and gives back
 * every poll's result with the calls, reads and `ps` questions it made.
 */
export async function goldenRun(
  make: (options: PiAdapterOptions) => Adapter,
  profile: PiProfile,
  platform: NodeJS.Platform,
  named: boolean,
  ps: RecordingPs,
): Promise<unknown[]> {
  const clock = handClock(NOW);
  const files = memoryFiles(clock.now);
  const program = [...profile.programs][0] as string;
  const running: PsAnswer = { ok: true, stdout: `/bin/zsh\n/opt/demo/bin/${program}\n` };
  const none: PsAnswer = { ok: true, stdout: "/bin/zsh\nlogin\n" };
  ps.asked.length = 0;
  ps.answer = running;

  const dir = sessionsDirOf(profile, named);
  const folder = projectFolder(dir);
  const first = `${folder}/2026-10-01T11-00-00-000Z_${sessionIdOf(1)}.jsonl`;
  const flat = `${dir}/${sessionIdOf(2)}.jsonl`;
  const marked = `${folder}/2026-10-01T11-30-00-000Z_${sessionIdOf(3)}.jsonl`;
  const old = `${dir}/${sessionIdOf(4)}.jsonl`;

  const adapter = make({
    env: named ? { [profile.homeEnv]: `${HOME}/al-home` } : {},
    homeDir: HOME,
    now: clock.now,
    io: files.io,
    platform,
  });

  const log: unknown[] = [];
  async function poll(step: string) {
    files.forget();
    ps.asked.length = 0;
    const result = await adapter.poll();
    log.push({
      step,
      at: clock.now() - NOW,
      result,
      calls: [...files.calls],
      reads: [...files.reads],
      ps: ps.asked.map((args) => [...args]),
    });
  }

  await poll("no folder yet");
  clock.advance(SECOND);
  await poll("a second later");

  clock.advance(RECHECK_MS);
  files.write(first, line(headerFields(sessionIdOf(1))));
  files.write(flat, line(headerFields(sessionIdOf(2))) + conversationLines());
  files.write(marked, line(headerFields(sessionIdOf(3))) + subagentMarkerLine());
  files.write(old, line(headerFields(sessionIdOf(4))), { mtimeMs: NOW - 2 * DAY });
  files.write(`${dir}/${sessionIdOf(2)}.info-cache.json`, "{}");
  files.touch(dir, clock.now());
  files.touch(folder, clock.now());
  await poll("a new file in a project folder and in the folder itself");

  clock.advance(2 * SECOND);
  files.append(first, conversationLines());
  await poll("one grew");

  clock.advance(2 * SECOND);
  files.append(first, nameLine("demo name"));
  files.append(flat, nameLine("flat name"));
  await poll("name lines");

  clock.advance(2 * SECOND);
  files.write(flat, line(headerFields(sessionIdOf(2))) + nameLine("rewritten name"));
  await poll("a rewrite to a new file at the same name");

  clock.advance(10 * SECOND);
  ps.answer = none;
  await poll("ps says none runs");

  clock.advance(3 * SECOND);
  files.append(first, conversationLines());
  await poll("written 3 seconds after ps said none runs");

  clock.advance(10 * SECOND);
  ps.answer = { ok: false, stdout: "" };
  await poll("ps fails");

  clock.advance(SWEEP_MS);
  ps.answer = running;
  await poll("past a sweep");

  clock.advance(2 * SECOND);
  files.remove(dir);
  await poll("the folder went");

  clock.advance(2 * SECOND);
  await poll("two seconds after it went");

  clock.advance(RECHECK_MS);
  files.mkdir(dir);
  await poll("the folder came back empty");
  return log;
}
