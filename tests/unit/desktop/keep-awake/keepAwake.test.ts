import { describe, expect, test, vi } from "vitest";

import type { Session } from "@core/sessions/session";
import { createKeepAwake, type KeepAwakeBlocker } from "@desktop/keep-awake/keepAwake";
import type { KeepAwakeSettings } from "@desktop/keep-awake/keepAwakeSettings";
import { makeSession } from "@tests/fixtures/session";

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const MINUTE = 60_000;

/** A blocker that records what it was asked, and gives ids from 7 up. */
function fakeBlocker() {
  let next = 7;
  const held = new Set<number>();
  const blocker = {
    start: vi.fn<KeepAwakeBlocker["start"]>(() => {
      const id = next++;
      held.add(id);
      return id;
    }),
    stop: vi.fn<KeepAwakeBlocker["stop"]>((id) => {
      held.delete(id);
    }),
  };
  return { blocker, held };
}

/** A store in memory, holding what it was last given. */
function memoryStore(on = false) {
  let kept: KeepAwakeSettings = { on };
  return {
    read: vi.fn(() => kept),
    write: vi.fn((settings: KeepAwakeSettings) => {
      kept = settings;
    }),
  };
}

const snapshot = (sessions: Session[], generatedAt = NOW) => ({ generatedAt, sessions });
const counting = () => snapshot([makeSession({ status: "needs-you" })]);
const quiet = () => snapshot([makeSession({ status: "idle" })]);

function keepAwake(on: boolean) {
  const { blocker, held } = fakeBlocker();
  const settings = memoryStore(on);
  const warn = vi.fn<(line: string) => void>();
  const awake = createKeepAwake({ blocker, settings, warn });
  return { awake, blocker, held, settings, warn };
}

describe("with the switch off", () => {
  test("a session that counts never takes a blocker", () => {
    const { awake, blocker } = keepAwake(false);
    for (let i = 0; i < 5; i++) awake.follow(counting());
    expect(blocker.start).not.toHaveBeenCalled();
    expect(awake.status()).toEqual({ on: false });
  });
});

describe("with the switch on", () => {
  test("the first snapshot that counts takes one blocker, and later ones take no more", () => {
    const { awake, blocker, held } = keepAwake(true);
    awake.follow(quiet());
    expect(blocker.start).not.toHaveBeenCalled();

    awake.follow(counting());
    expect(blocker.start).toHaveBeenCalledExactlyOnceWith("prevent-app-suspension");
    for (let i = 0; i < 10; i++) awake.follow(counting());
    expect(blocker.start).toHaveBeenCalledOnce();
    expect(held.size).toBe(1);
  });

  test("a snapshot in which nothing counts lets go of the blocker it took", () => {
    const { awake, blocker, held } = keepAwake(true);
    awake.follow(counting());
    const id = blocker.start.mock.results[0]?.value as number;
    awake.follow(quiet());
    expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(id);
    expect(held.size).toBe(0);

    awake.follow(quiet());
    expect(blocker.stop).toHaveBeenCalledOnce();
    awake.follow(snapshot([]));
    expect(blocker.stop).toHaveBeenCalledOnce();
  });

  test("a working session lets go once its last write is 30 minutes old", () => {
    const { awake, blocker, held } = keepAwake(true);
    // An agent whose writes are measured: a Claude Code session would count while listed.
    const working = makeSession({
      id: "gemini-cli:session-1",
      source: "gemini-cli",
      status: "working",
      lastWriteAt: NOW,
    });
    awake.follow(snapshot([working], NOW + 29 * MINUTE));
    expect(held.size).toBe(1);
    awake.follow(snapshot([working], NOW + 30 * MINUTE));
    expect(held.size).toBe(0);
    expect(blocker.stop).toHaveBeenCalledOnce();
  });
});

describe("turning the switch", () => {
  test("off lets go at once, and is remembered", () => {
    const { awake, blocker, held, settings } = keepAwake(true);
    awake.follow(counting());
    expect(held.size).toBe(1);

    expect(awake.setOn(false)).toEqual({ on: false });
    expect(held.size).toBe(0);
    expect(blocker.stop).toHaveBeenCalledOnce();
    expect(settings.write).toHaveBeenLastCalledWith({ on: false });
    expect(awake.status()).toEqual({ on: false });

    // Nothing is taken while it is off.
    awake.follow(counting());
    expect(blocker.start).toHaveBeenCalledOnce();
  });

  test("on takes the blocker at once when the last snapshot counted, and is remembered", () => {
    const { awake, blocker, held, settings } = keepAwake(false);
    awake.follow(counting());
    expect(blocker.start).not.toHaveBeenCalled();

    expect(awake.setOn(true)).toEqual({ on: true });
    expect(blocker.start).toHaveBeenCalledExactlyOnceWith("prevent-app-suspension");
    expect(held.size).toBe(1);
    expect(settings.write).toHaveBeenLastCalledWith({ on: true });

    // Turned on again, it takes no second one.
    awake.setOn(true);
    expect(blocker.start).toHaveBeenCalledOnce();
  });

  test("on takes nothing while no session counts", () => {
    const { awake, blocker } = keepAwake(false);
    awake.follow(quiet());
    awake.setOn(true);
    expect(blocker.start).not.toHaveBeenCalled();
  });

  test("reads the switch from the store once, as it is made", () => {
    const { awake, settings } = keepAwake(true);
    expect(awake.status()).toEqual({ on: true });
    awake.follow(counting());
    awake.status();
    expect(settings.read).toHaveBeenCalledOnce();
  });
});

describe("stopping, as the app quits", () => {
  test("lets go of the blocker, and a second stop does nothing", () => {
    const { awake, blocker, held } = keepAwake(true);
    awake.follow(counting());
    awake.stop();
    expect(held.size).toBe(0);
    expect(blocker.stop).toHaveBeenCalledOnce();
    awake.stop();
    expect(blocker.stop).toHaveBeenCalledOnce();
  });

  test("takes nothing after it", () => {
    const { awake, blocker } = keepAwake(true);
    awake.stop();
    awake.follow(counting());
    awake.setOn(true);
    expect(blocker.start).not.toHaveBeenCalled();
  });

  test("with nothing held does nothing", () => {
    const { awake, blocker } = keepAwake(true);
    awake.stop();
    expect(blocker.stop).not.toHaveBeenCalled();
  });
});

describe("a blocker that fails", () => {
  test("to start is told of once, throws nothing and is tried again at the next poll", () => {
    const { awake, blocker, held, warn } = keepAwake(true);
    blocker.start.mockImplementationOnce(() => {
      throw new Error("no assertion");
    });
    blocker.start.mockImplementationOnce(() => {
      throw new Error("no assertion");
    });

    expect(() => awake.follow(counting())).not.toThrow();
    expect(() => awake.follow(counting())).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("could not be kept awake");
    expect(held.size).toBe(0);

    awake.follow(counting());
    expect(blocker.start).toHaveBeenCalledTimes(3);
    expect(held.size).toBe(1);
  });

  test("to stop is told of, and the blocker is taken as let go", () => {
    const { awake, blocker, warn } = keepAwake(true);
    awake.follow(counting());
    blocker.stop.mockImplementationOnce(() => {
      throw new Error("gone");
    });
    expect(() => awake.follow(quiet())).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();

    // It is not let go a second time.
    awake.stop();
    expect(blocker.stop).toHaveBeenCalledOnce();
  });

  test("to stop still leaves one blocker at most when a session counts again", () => {
    const { awake, blocker } = keepAwake(true);
    awake.follow(counting());
    blocker.stop.mockImplementationOnce(() => {
      throw new Error("gone");
    });
    awake.follow(quiet());
    awake.follow(counting());
    awake.follow(counting());
    expect(blocker.start).toHaveBeenCalledTimes(2);
  });
});
