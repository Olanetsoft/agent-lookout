import { realpathSync } from "node:fs";

import { followZone } from "../../core/time-rules/localTime.ts";

/** The computer's time zone, on macOS and Linux: a link that leads to its zone's file. */
const ZONE_LINK = "/etc/localtime";

/**
 * A zone's name, at the end of where the link leads. On a Mac that still has
 * the zones macOS came with, that is in `/usr/share/zoneinfo.default`.
 */
const ZONE_NAME = /\/zoneinfo(?:\.default)?\/(?:posix\/|right\/)?(.+)$/;

/** How often the link is looked at, so a change is followed within a minute. */
export const ZONE_LOOK_MS = 30_000;

export interface ZoneFollowerOptions {
  env?: NodeJS.ProcessEnv;
  /** Where the link leads. Throws when there is none. */
  resolve?: () => string;
  now?: () => number;
}

/**
 * Keeps quiet hours and the times in messages in the computer's time zone
 * while it changes: what this returns is called at each poll. It looks only
 * at where the link leads, with no file opened, and follows the zone it names,
 * from the first look on, since the dev server can make a collector in a Node
 * that started in another zone. Where there is no such link, as on Windows, or
 * where it is a plain file, the zone stays the one Node started in. So does
 * one set through `TZ`, and then the link is not looked at.
 *
 * Node can be made to read the zone again, by setting or deleting `TZ` in its
 * own environment, but then every local time is read in the new zone. A
 * program that was running before the change goes on writing its own in the
 * old one, as `agy` does in its log, so a wait there would seem to have begun
 * anew. Nor does Node on Windows read the zone again.
 */
export function createZoneFollower(options: ZoneFollowerOptions = {}): () => void {
  const env = options.env ?? process.env;
  const resolve = options.resolve ?? (() => realpathSync.native(ZONE_LINK));
  const now = options.now ?? Date.now;

  function look(): string | null {
    if (env.TZ !== undefined) return null;
    try {
      return ZONE_NAME.exec(resolve())?.[1] ?? null;
    } catch {
      return null;
    }
  }

  let zone: string | null = null;
  let lookedAt = -Infinity;
  return () => {
    const at = now();
    // However the clock has been set since.
    if (Math.abs(at - lookedAt) < ZONE_LOOK_MS) return;
    lookedAt = at;
    const found = look();
    if (found === null || found === zone) return;
    zone = found;
    try {
      followZone(found);
    } catch {
      // Not a zone Node knows. The one gone by stays.
    }
  };
}
