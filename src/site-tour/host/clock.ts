/**
 * The frame's clock, which a still scene holds.
 *
 * The dashboard reads the time from `Date.now`, once a second. The frame's
 * day starts at the time of day the page's two pictures show, so the
 * dashboard that takes their place shows the same clock times, and goes on
 * from there at the real pace.
 *
 * While a scene is drawn as a still picture, every duration on it stays as it
 * was: the clock is held at a moment, and goes on from the real pace once it
 * is let go.
 */

export interface Clock {
  now(): number;
  /** Holds the time where it is now, or at `at`, until `release`. */
  hold(at?: number): void;
  release(): void;
  readonly held: boolean;
}

/** The time of day the page's pictures were taken at: 09:12:00. */
export const PICTURE_TIME = { hours: 9, minutes: 12, seconds: 0 } as const;

/** Today, in the local time zone, at the pictures' time of day. */
export function pictureMoment(real: number, DateType: DateConstructor = Date): number {
  const day = new DateType(real);
  day.setHours(PICTURE_TIME.hours, PICTURE_TIME.minutes, PICTURE_TIME.seconds, 0);
  return day.getTime();
}

export function installClock(target: { Date: DateConstructor } = window): Clock {
  const real = target.Date.now.bind(target.Date);
  const loadedAt = real();
  const shift = pictureMoment(loadedAt, target.Date) - loadedAt;
  let heldAt: number | null = null;
  const now = () => heldAt ?? real() + shift;
  target.Date.now = now;
  return {
    now,
    hold(at) {
      heldAt = at ?? heldAt ?? real() + shift;
    },
    release() {
      heldAt = null;
    },
    get held() {
      return heldAt !== null;
    },
  };
}
