// Histories of the Mac app's updates, made up at random: the real updater in a
// world of the test's own, with the things that can happen to it happening in
// any order and at any moment, and what must hold after each.

import { mkdir, rm, truncate } from "node:fs/promises";
import path from "node:path";

import { expect, vi } from "vitest";

import { HELPER_WAIT_MS } from "@desktop/updates/install/installHelper";
import { FIRST_CHECK_DELAY_MS } from "@desktop/updates/updater";

import { makeUpdateWorld, versionIn } from "./updateWorld";

const HOUR = 60 * 60 * 1000;

/** Waits, also while the timers are fake ones. */
const realTimeout = globalThis.setTimeout;
const moment = (ms: number) => new Promise<void>((resolve) => realTimeout(resolve, ms));

/** A source of random numbers that gives the same ones for the same seed. */
function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const patch = (version: string) => Number(version.split(".")[2]);

/**
 * One history made up at random: releases come and are withdrawn, checks and
 * downloads are answered, fail or are kept waiting, what waits is cleared,
 * Install and Restart is pressed, and the app quits and opens, each at any
 * moment. After each, the app in its place is one that can be opened. Once
 * things settle, the state shown is the one the disk and the requests are
 * in, and at the end the newest version can be installed.
 */
export async function playHistory(seed: number, met: Set<string>): Promise<void> {
  const random = randomFrom(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  const world = await makeUpdateWorld();
  const steps: string[] = [];
  const where = () => `seed ${seed}: ${steps.join(", ")}`;
  /** The folders that were there when the app opened, and how long ago that was. */
  let found: string[] = [];
  let openFor = 0;
  let waited = 0;
  /** The version that was ready once things settled, and whether something since may take it away. */
  let kept: string | null = null;
  let excused = false;
  let cleared = false;
  /** Whether the test has taken a folder away. */
  let folderWent = false;

  /** Whether the app quit with an install under way. */
  let handedOver = false;

  const opened = async () => {
    // What the copy that quit had still to do is done, as its process has ended.
    await moment(8);
    waited = 0;
    found = await world.folders();
    openFor = 0;
    kept = null;
    world.updater.start();
  };
  const pass = (ms: number) => {
    world.now += ms;
    openFor += ms;
    // The helper waits for the app to quit for two minutes, and then ends.
    waited = world.helper === null ? 0 : waited + ms;
    if (waited >= HELPER_WAIT_MS) world.helper = null;
    vi.advanceTimersByTime(ms);
  };
  const phase = () => world.updater.status().update;

  const safe = () => {
    expect(versionIn(world.bundle), where()).not.toBeNull();
    if (world.helper !== null) {
      const update = phase();
      expect(update.phase, where()).toBe("installing");
      const version = update.phase === "installing" ? update.version : "";
      if (!folderWent) expect(versionIn(world.helper.replacement), where()).toBe(version);
    }
  };

  const settled = async () => {
    await moment(4);
    await vi.waitFor(
      async () => {
        const folders = await world.folders();
        if (!world.open) {
          // Only what a helper that has since given up was handed is left, until the app opens.
          const own = folders.filter((name) => !found.includes(name));
          expect(own.length, where()).toBeLessThanOrEqual(handedOver ? 1 : 0);
          return;
        }
        const update = phase();
        const holds = update.phase === "ready" || update.phase === "installing" ? 1 : 0;
        if (update.phase === "checking") expect(world.heldChecks.length, where()).toBe(1);
        if (update.phase === "installing" && waited < HELPER_WAIT_MS) {
          expect(world.helper, where()).not.toBeNull();
        }
        if (update.phase === "downloading") expect(world.heldDownloads.length, where()).toBe(1);
        if (update.phase === "ready") {
          expect(update.newer !== undefined, where()).toBe(world.heldDownloads.length === 1);
          expect(patch(update.version), where()).toBeGreaterThan(
            patch(world.updater.status().version),
          );
        }
        // What an earlier run left is there until this one has run a while, and then not.
        const left = folders.filter((name) => found.includes(name));
        expect(left, where()).toEqual(openFor >= FIRST_CHECK_DELAY_MS ? [] : found);
        const own = folders.length - left.length;
        const expected = holds + world.heldDownloads.length;
        expect(own, where()).toBeLessThanOrEqual(expected);
        if (!folderWent) expect(own, where()).toBe(expected);
      },
      { timeout: 1_000, interval: 3 },
    );
    if (!world.open) return;
    const update = phase();
    const ready = update.phase === "ready" ? update.version : null;
    const withdrawn = kept !== null && world.latest !== null && patch(world.latest) < patch(kept);
    if (kept !== null && !excused && !cleared && !withdrawn && world.writable) {
      expect(ready, where()).not.toBeNull();
      expect(patch(ready ?? ""), where()).toBeGreaterThanOrEqual(patch(kept));
    }
    met.add(update.phase);
    if (update.phase === "ready" && update.newer !== undefined) met.add("a newer one coming");
    if (update.phase === "downloading" && update.again === true) met.add("downloaded again");
    if (kept !== null && ready !== null && ready !== kept) met.add("a newer one ready");
    kept = ready;
    excused = false;
    if (ready === null) cleared = false;
  };

  const ACTIONS: Record<string, () => void | Promise<void>> = {
    release: () => {
      const newest = Math.max(patch(world.latest ?? "0.2.0"), patch(versionIn(world.bundle)!));
      world.latest = `0.2.${newest + 1}`;
    },
    withdraw: () => {
      world.latest = pick([
        versionIn(world.bundle),
        `0.2.${Math.max(0, patch(world.latest ?? "0.2.0") - 1)}`,
      ]);
    },
    "no Mac app": () => {
      world.latest = null;
    },
    "checks change": () => {
      world.checks = pick(["answer", "answer", "fail", "hold"]);
    },
    "downloads change": () => {
      world.downloads = pick(["whole", "network", "wrong-hash", "hold", "hold", "hold"]);
    },
    "a check is answered": () => world.heldChecks[0]?.answer(pick(["answer", "answer", "fail"])),
    "a download is answered": () =>
      world.heldDownloads[0]?.answer(pick(["whole", "whole", "whole", "network", "wrong-size"])),
    check: () => void world.updater.check(),
    "an hour passes": () => pass(HOUR),
    "a day passes": () => pass(24 * HOUR),
    "a minute passes": () => pass(60_000),
    "four minutes pass": () => pass(4 * 60_000),
    "the zip goes": async () => {
      cleared = true;
      const zip = await world.zip();
      if (zip !== null) await rm(zip, { force: true });
    },
    "the zip is cut short": async () => {
      cleared = true;
      const zip = await world.zip();
      if (zip !== null) await truncate(zip, 20).catch(() => {});
    },
    "the folder goes": async () => {
      cleared = true;
      const zip = await world.zip();
      if (zip === null) return;
      folderWent = true;
      found = found.filter((name) => name !== path.basename(path.dirname(zip)));
      await rm(path.dirname(zip), { recursive: true, force: true }).catch(() => {});
    },
    install: () => {
      excused = true;
      void world.updater.install();
    },
    "install twice": () => {
      excused = true;
      void world.updater.install();
      void world.updater.install();
    },
    quit: async () => {
      const version = versionIn(world.bundle);
      const plan = world.helper;
      const update = phase();
      const whole = plan !== null && versionIn(plan.replacement) !== null;
      handedOver = update.phase === "installing";
      world.quit();
      safe();
      if (plan === null) return;
      // It opened again, as the new version or as the one that was put back, which says so.
      const opens = world.newOpens && whole && update.phase === "installing";
      expect(world.updater.status().version, where()).toBe(
        opens ? (update as { version: string }).version : version,
      );
      expect(phase().phase, where()).toBe(opens ? "idle" : "failed");
      met.add(opens ? "installed" : "put back");
      await opened();
    },
    "where it is changes": () => {
      world.writable = !world.writable;
    },
    "the helper changes": () => {
      world.helperStarts = random() < 0.8;
      world.newOpens = random() < 0.7;
    },
  };
  const names = Object.keys(ACTIONS);
  // What moves things on comes up more than the rest.
  names.push("release", "release", "check", "check", "check", "a check is answered");
  names.push("a download is answered", "a download is answered", "install", "install");

  world.latest = "0.2.1";
  world.downloads = pick(["whole", "hold"]);
  await opened();
  const length = 8 + Math.floor(random() * 24);
  for (let step = 0; step < length; step += 1) {
    const usual = world.helper !== null && random() < 0.4 ? "quit" : pick(names);
    const name = world.open ? usual : pick(["open", "a crash left something"]);
    steps.push(name);
    if (name === "open") {
      world.launch();
      await opened();
    } else if (name === "a crash left something") {
      await mkdir(path.join(world.data, `agent-lookout-update-crash${step}`), {
        recursive: true,
      });
      world.launch();
      await opened();
    } else {
      await ACTIONS[name]!();
    }
    safe();
    const pause = random();
    if (pause < 0.45) {
      steps.push("settle");
      await settled();
      safe();
    } else if (pause < 0.7) {
      await moment(random() * 3);
      safe();
    }
  }

  // With nothing in the way, the newest version is found, downloaded and installed.
  steps.push("the end");
  if (!world.open) {
    world.launch();
    await opened();
  }
  Object.assign(world, { checks: "answer", downloads: "whole", writable: true });
  Object.assign(world, { helperStarts: true, newOpens: true });
  for (const held of [...world.heldChecks]) held.answer("answer");
  for (const held of [...world.heldDownloads]) held.answer("whole");
  excused = true;
  await settled();
  if (phase().phase === "installing") {
    world.quit();
    if (!world.open) world.launch();
    await opened();
  }
  const newest = `0.2.${patch(versionIn(world.bundle)!) + 5}`;
  world.latest = newest;
  for (let tries = 0; tries < 3; tries += 1) {
    await world.updater.check();
    excused = true;
    await settled();
    if (phase().phase === "ready" && (phase() as { version: string }).version === newest) break;
  }
  expect(phase(), where()).toMatchObject({ phase: "ready", version: newest });
  expect((await world.updater.install()).ok, where()).toBe(true);
  world.quit();
  await opened();
  expect(world.updater.status(), where()).toMatchObject({
    version: newest,
    update: { phase: "idle" },
  });
  pass(FIRST_CHECK_DELAY_MS);
  await settled();
  world.quit();
  await settled();
}
