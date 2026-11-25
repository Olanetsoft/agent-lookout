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
  /** The folders an earlier run left, which stay until the app has run a while, and how long it has. */
  const left = new Set<string>();
  let openFor = 0;
  /** Those it was sweeping when it quit. */
  const swept = new Set<string>();
  let waited = 0;
  /** The version that was ready once things settled, and whether something since may take it away. */
  let kept: string | null = null;
  let mayGo = false;
  /** The newest version that is out, as a check last could have seen it. */
  let newestOut = "0.2.1";
  /** Whether the test has taken a folder away. */
  let folderWent = false;
  /** Those of `left` that came after the sweep, as the app quit or while it was not open. */
  const fresh = new Set<string>();
  /** The folder the helper was started for. */
  let handedOver: string | null = null;

  const opened = () => {
    // Its sweep began, and may have been cut short as it quit.
    if (openFor >= FIRST_CHECK_DELAY_MS) {
      for (const name of left) if (!fresh.has(name)) swept.add(name);
      for (const name of swept) left.delete(name);
    }
    fresh.clear();
    waited = 0;
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
      handedOver = path.basename(path.dirname(path.dirname(world.helper.aside)));
    }
  };

  const settled = async () => {
    await moment(4);
    await vi.waitFor(
      async () => {
        const folders = await world.folders();
        const before = folders.filter((name) => left.has(name));
        const going = folders.filter((name) => swept.has(name));
        const own = folders.length - before.length - going.length;
        // Nothing of a copy that quit is there but what it handed to the helper.
        if (!world.open) {
          expect(own, where()).toBe(0);
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
        const ranAWhile = openFor >= FIRST_CHECK_DELAY_MS;
        expect(before.length, where()).toBe(ranAWhile ? 0 : left.size);
        if (ranAWhile) expect(going, where()).toEqual([]);
        const expected = holds + world.heldDownloads.length;
        expect(own, where()).toBeLessThanOrEqual(expected);
        if (!folderWent) expect(own, where()).toBe(expected);
      },
      { timeout: 5_000, interval: 3 },
    );
    if (!world.open) return;
    if (openFor >= FIRST_CHECK_DELAY_MS) {
      left.clear();
      swept.clear();
    }
    const update = phase();
    const ready = update.phase === "ready" ? update.version : null;
    const stays = !mayGo && world.writable && patch(newestOut) >= patch(kept ?? "0.2.0");
    if (kept !== null && stays) {
      expect(ready, where()).not.toBeNull();
      expect(patch(ready ?? ""), where()).toBeGreaterThanOrEqual(patch(kept));
    }
    met.add(update.phase);
    if (update.phase === "ready" && update.newer !== undefined) met.add("a newer one coming");
    if (update.phase === "downloading" && update.again === true) met.add("downloaded again");
    if (kept !== null && ready !== null && ready !== kept) met.add("a newer one ready");
    kept = ready;
    if (ready === null) mayGo = false;
  };

  const ACTIONS: Record<string, () => void | Promise<void>> = {
    release: () => {
      const newest = Math.max(patch(world.latest ?? "0.2.0"), patch(versionIn(world.bundle)!));
      world.latest = newestOut = `0.2.${newest + 1}`;
    },
    withdraw: () => {
      mayGo = true;
      world.latest = newestOut = pick([
        versionIn(world.bundle)!,
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
      mayGo = true;
      const zip = await world.zip();
      if (zip !== null) await rm(zip, { force: true });
    },
    "the zip is cut short": async () => {
      mayGo = true;
      const zip = await world.zip();
      if (zip !== null) await truncate(zip, 20).catch(() => {});
    },
    "the folder goes": async () => {
      mayGo = true;
      const zip = await world.zip();
      if (zip === null) return;
      folderWent = true;
      left.delete(path.basename(path.dirname(zip)));
      await rm(path.dirname(zip), { recursive: true, force: true }).catch(() => {});
    },
    install: () => {
      mayGo = true;
      void world.updater.install();
    },
    "install twice": () => {
      mayGo = true;
      void world.updater.install();
      void world.updater.install();
    },
    quit: async () => {
      safe();
      const version = versionIn(world.bundle);
      const plan = world.helper;
      const update = phase();
      const whole = plan !== null && versionIn(plan.replacement) !== null;
      // The folder is the helper's, also when it has given up by now.
      const helped = update.phase === "installing" && (plan !== null || waited >= HELPER_WAIT_MS);
      const there = helped
        ? (await world.folders()).find((name) => name === handedOver)
        : undefined;
      if (there !== undefined) {
        left.add(there);
        fresh.add(there);
      }
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
      opened();
    },
    "where it is changes": () => {
      mayGo = true;
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
  opened();
  const length = 8 + Math.floor(random() * 24);
  for (let step = 0; step < length; step += 1) {
    const usual = world.helper !== null && random() < 0.4 ? "quit" : pick(names);
    const name = world.open ? usual : pick(["open", "a crash left something"]);
    steps.push(name);
    if (name === "open") {
      world.launch();
      opened();
    } else if (name === "a crash left something") {
      left.add(`agent-lookout-update-crash${step}`);
      fresh.add(`agent-lookout-update-crash${step}`);
      await mkdir(path.join(world.data, `agent-lookout-update-crash${step}`));
      world.launch();
      opened();
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
    opened();
  }
  Object.assign(world, { checks: "answer", downloads: "whole", writable: true });
  Object.assign(world, { helperStarts: true, newOpens: true });
  for (const held of [...world.heldChecks]) held.answer("answer");
  for (const held of [...world.heldDownloads]) held.answer("whole");
  mayGo = true;
  await settled();
  if (phase().phase === "installing") {
    await ACTIONS.quit!();
    if (!world.open) {
      world.launch();
      opened();
    }
  }
  const newest = `0.2.${patch(versionIn(world.bundle)!) + 5}`;
  world.latest = newest;
  for (let tries = 0; tries < 3; tries += 1) {
    await world.updater.check();
    mayGo = true;
    await settled();
    if (phase().phase === "ready" && (phase() as { version: string }).version === newest) break;
  }
  expect(phase(), where()).toMatchObject({ phase: "ready", version: newest });
  expect((await world.updater.install()).ok, where()).toBe(true);
  safe();
  await ACTIONS.quit!();
  expect(world.updater.status(), where()).toMatchObject({
    version: newest,
    update: { phase: "idle" },
  });
  pass(FIRST_CHECK_DELAY_MS);
  await settled();
  world.quit();
  await settled();
}
