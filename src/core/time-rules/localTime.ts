/**
 * The local clock that quiet hours and the times in messages go by. It is the
 * one `Date` reads, in the time zone this process, or the page, started in,
 * until `followZone` names one. The collector names the computer's, which can
 * change while it runs: Node reads the zone once, as it starts.
 */

let zone: Intl.DateTimeFormat | null = null;

/** Goes by this time zone from now on, or with null by the one this process started in. Throws for a zone not known here. */
export function followZone(name: string | null): void {
  zone =
    name === null
      ? null
      : new Intl.DateTimeFormat("en-US", {
          timeZone: name,
          hourCycle: "h23",
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "numeric",
          minute: "numeric",
          second: "numeric",
        });
}

/** A moment on the local clock, as a `Date` whose UTC fields hold the local date and time. */
export function localDate(at: number): Date {
  const date = new Date(at);
  if (zone === null) return new Date(at - date.getTimezoneOffset() * 60_000);
  const part = new Map(zone.formatToParts(date).map(({ type, value }) => [type, Number(value)]));
  const of = (type: Intl.DateTimeFormatPartTypes) => part.get(type) ?? 0;
  return new Date(
    Date.UTC(
      of("year"),
      of("month") - 1,
      of("day"),
      of("hour"),
      of("minute"),
      of("second"),
      date.getUTCMilliseconds(),
    ),
  );
}
