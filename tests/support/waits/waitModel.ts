// A model of waits, for the tests that compare the waits with it over many
// histories made up at random. It goes by what each poll saw and by the runs
// the polls were made in, and knows nothing of sightings, marks or files.

/** What a poll saw of one source: its state, and the sessions waiting while it answered. */
export interface SeenSource {
  state: "ok" | "unavailable" | "error";
  waiting: ReadonlySet<string>;
}

export interface SeenPoll {
  at: number;
  /** Which run made it, counting up. */
  run: number;
  sources: ReadonlyMap<string, SeenSource>;
  /** The sessions an event of this poll says began to wait. */
  begun: ReadonlySet<string>;
}

interface ModelWait {
  id: string;
  from: number;
  to: number;
  /** The last run and the last poll that saw it. */
  run: number;
  seenAt: number;
  /** Set while its source has been unavailable since. */
  lost: boolean;
  /** No event began it: a run's first answer of its source found it. */
  found: boolean;
}

/** Every wait the polls saw, up to `now`: a wait of no time is left out. */
export function modelWaits(polls: readonly SeenPoll[], now: number): ModelWait[] {
  const runEnds = new Map(polls.map((poll) => [poll.run, poll.at]));
  const newest = polls[polls.length - 1];
  const standing = new Map<string, ModelWait>();
  const waits: ModelWait[] = [];
  /** Ends a wait that was not seen to end: where it was lost, or else as its run was. */
  const endUnseen = (wait: ModelWait, inRun: number, at: number) => {
    const ended = wait.run === inRun ? at : (runEnds.get(wait.run) as number);
    waits.push({ ...wait, to: wait.lost ? wait.seenAt : ended });
    standing.delete(wait.id);
  };
  for (const { at, run, sources, begun } of polls) {
    for (const [source, { state, waiting }] of sources) {
      const own = [...standing.values()].filter((wait) => wait.id.startsWith(`${source}:`));
      if (state === "unavailable") for (const wait of own) wait.lost ||= wait.run === run;
      if (state !== "ok") continue;
      for (const wait of own) {
        const missed = wait.found && (wait.run < run - 1 || (wait.run < run && begun.has(wait.id)));
        if (missed || !waiting.has(wait.id)) endUnseen(wait, run, at);
      }
      for (const id of waiting) {
        const from = standing.get(id)?.from ?? at;
        const found = standing.get(id)?.found ?? !begun.has(id);
        standing.set(id, { id, from, to: now, run, seenAt: at, lost: false, found });
      }
    }
  }
  for (const wait of [...standing.values()]) {
    const source = newest?.sources.get(wait.id.slice(0, wait.id.lastIndexOf(":")));
    if (source?.state === "ok") waits.push(wait);
    else endUnseen(wait, newest?.run as number, now);
  }
  return waits
    .map((wait) => ({ ...wait, to: Math.min(wait.to, now) }))
    .filter((wait) => wait.to > wait.from);
}

/**
 * The time measured up to `now`: between polls of one run that missed no
 * source, at most 8 seconds apart, and from the last of them to now when that
 * is no longer.
 */
export function modelMeasured(polls: readonly SeenPoll[], now: number): [number, number][] {
  let settled = new Map<string, string>();
  let last: SeenPoll | null = null;
  let newest = -Infinity;
  const steps: [number, number][] = [];
  for (const poll of polls) {
    if (poll.run !== last?.run) {
      settled = new Map();
      last = null;
      newest = -Infinity;
    }
    const states = [...poll.sources].map(([id, { state }]) => ({ id, state }));
    const missed = states.some(({ id, state }) => state !== "ok" && settled.get(id) === "ok");
    for (const { id, state } of states) if (state !== "error") settled.set(id, state);
    if (missed || !states.some(({ state }) => state === "ok")) continue;
    if (last && poll.at > last.at && poll.at - last.at <= 8_000) steps.push([last.at, poll.at]);
    last = poll;
    newest = Math.max(newest, poll.at);
  }
  if (newest < now && now - newest <= 8_000) steps.push([newest, now]);
  // The clock can be set back, so a moment can be in two of them: each counts once.
  const apart: [number, number][] = [];
  let reached = -Infinity;
  for (const [from, to] of steps.sort((a, b) => a[0] - b[0])) {
    const end = Math.min(to, now);
    if (end > Math.max(from, reached)) apart.push([Math.max(from, reached), end]);
    reached = Math.max(reached, end);
  }
  return apart;
}

/** A moment's local day, as `2026-10-06`. */
function dayOf(at: number): string {
  const date = new Date(at);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** The first moment of the local day after `from`'s, up to `to`, found by looking for where the day changes. */
function dayEnds(from: number, to: number): number {
  let low = from;
  let high = to;
  if (dayOf(high - 1) === dayOf(low)) return to;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (dayOf(middle) === dayOf(low)) low = middle;
    else high = middle;
  }
  return high;
}

/** What each local day waited, in how many waits, and how much of it was measured, from `since` on. */
export function modelDays(polls: readonly SeenPoll[], now: number, since: number) {
  const waits = modelWaits(polls, now);
  const days = new Map<string, { waitedMs: number; measuredMs: number; waits: Set<ModelWait> }>();
  for (const [start, end] of modelMeasured(polls, now)) {
    for (let from = Math.max(start, since); from < end;) {
      const to = dayEnds(from, end);
      const day = days.get(dayOf(from)) ?? { waitedMs: 0, measuredMs: 0, waits: new Set() };
      days.set(dayOf(from), day);
      day.measuredMs += to - from;
      for (const wait of waits) {
        const ms = Math.min(to, wait.to) - Math.max(from, wait.from);
        if (ms <= 0) continue;
        day.waitedMs += ms;
        day.waits.add(wait);
      }
      from = to;
    }
  }
  return days;
}
