import { afterEach, describe, expect, test } from "vitest";

import { createZoneFollower, ZONE_LOOK_MS } from "@collector/settings/timeZone";
import { followZone, localDate } from "@core/time-rules/localTime";

const T0 = Date.UTC(2026, 10, 24, 8);
const NEW_YORK = "/usr/share/zoneinfo/America/New_York";
const LAGOS = "/var/db/timezone/tz/2026c.1.0/zoneinfo/Africa/Lagos";

afterEach(() => followZone(null));

/** A follower over a link the test points, with the hour it is on the local clock. */
function setUp(link: string | null, env: NodeJS.ProcessEnv = {}) {
  const system = { link, looks: 0, now: T0 };
  const follow = createZoneFollower({
    env,
    resolve: () => {
      system.looks += 1;
      if (system.link === null) throw new Error("ENOENT");
      return system.link;
    },
    now: () => system.now,
  });
  return {
    system,
    /** What a poll this long after the last one finds. */
    poll(afterMs = ZONE_LOOK_MS) {
      system.now += afterMs;
      follow();
      return localDate(T0).getUTCHours();
    },
  };
}

/** The hour at T0 in the zone the tests run in. */
const OWN = new Date(T0).getHours();

describe("the computer's time zone", () => {
  test("is followed within a minute of a change, as often as it changes", () => {
    const { system, poll } = setUp(LAGOS);
    expect(poll()).toBe(OWN);
    system.link = NEW_YORK;
    expect(poll(ZONE_LOOK_MS - 1)).toBe(OWN);
    expect(poll(1)).toBe(3);
    system.link = LAGOS;
    expect(poll()).toBe(9);
    expect(ZONE_LOOK_MS).toBeLessThan(60_000);
  });

  test("is looked at no more often than that, however many polls there are", () => {
    const { system, poll } = setUp(LAGOS);
    for (let polls = 0; polls < 45; polls += 1) poll(2_000);
    // As it was made, and every 30 seconds of the 90.
    expect(system.looks).toBe(4);
  });

  test("is looked at as often after the clock is set back", () => {
    const { system, poll } = setUp(LAGOS);
    system.link = NEW_YORK;
    expect(poll(-3_600_000)).toBe(3);
    expect(poll(2_000)).toBe(3);
    expect(system.looks).toBe(2);
  });

  test("set through TZ is left as it is, and the link is not looked at", () => {
    for (const TZ of ["UTC", ""]) {
      const { system, poll } = setUp(LAGOS, { TZ });
      system.link = NEW_YORK;
      expect(poll()).toBe(OWN);
      expect(system.looks).toBe(0);
    }
  });

  test.each([
    ["a plain file", "/etc/localtime"],
    ["a zone Node does not know", "/usr/share/zoneinfo/Nowhere/None"],
    ["gone", null],
  ])("stays as it was when the link is %s, and nothing throws", (_what, link) => {
    const { system, poll } = setUp(NEW_YORK);
    system.link = link;
    expect(poll()).toBe(OWN);
    expect(poll()).toBe(OWN);
    // One it knows is followed all the same.
    system.link = LAGOS;
    expect(poll()).toBe(9);
  });

  test("is followed once there is a link, and by its own name among the zones with leap seconds or without", () => {
    const { system, poll } = setUp(null);
    expect(poll()).toBe(OWN);
    system.link = "/usr/share/zoneinfo/posix/Asia/Tokyo";
    expect(poll()).toBe(17);
    system.link = "/usr/share/zoneinfo/right/Asia/Kolkata";
    expect(poll()).toBe(13);
  });

  test("the same zone by another path, as after the system's zones are updated, is no change", () => {
    const { system, poll } = setUp(LAGOS);
    system.link = "/var/db/timezone/tz/2026d.1.0/zoneinfo/Africa/Lagos";
    expect(poll()).toBe(OWN);
  });
});
