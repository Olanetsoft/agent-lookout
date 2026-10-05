import { expect, test } from "vitest";

import type { SessionEvent } from "@core/sessions/session";
import {
  countNew,
  NEW_SEEN_MS,
  nextNewSince,
  startNewSince,
  type Look,
  type NewSince,
} from "@dashboard/lib/sessions/newSince";

const T0 = 1_700_000_000_000;
const SECOND = 1_000;
const MINUTE = 60_000;

type Change = Partial<Omit<Look, "now">>;

/**
 * A page and its clock. Each step is a look at a later moment: the page in
 * sight on the Overview, with the line out of view and no events, until a step
 * changes one of those.
 */
function page(lastLookedAt: number | null = null) {
  let state = startNewSince(lastLookedAt);
  let now = T0;
  let look: Omit<Look, "now"> = {
    visible: true,
    overview: true,
    lineInView: false,
    newestAt: null,
  };
  const step = (afterMs: number, change: Change = {}): NewSince => {
    now += afterMs;
    look = { ...look, ...change };
    state = nextNewSince(state, { now, ...look });
    return state;
  };
  return {
    step,
    /** An event arrives, `afterMs` from the last step. */
    arrive: (afterMs: number, change: Change = {}) =>
      step(afterMs, { ...change, newestAt: now + afterMs }),
    /** The page goes out of sight, and this is when. */
    hide: (afterMs = SECOND): number => {
      step(afterMs, { visible: false });
      return now;
    },
    /** The page comes back into sight. */
    show: (afterMs = SECOND, change: Change = {}) => step(afterMs, { ...change, visible: true }),
    get state() {
      return state;
    },
    get now() {
      return now;
    },
  };
}

test("with the page in sight the whole time, no line appears, however many events arrive", () => {
  const tab = page();
  tab.step(0);
  for (let second = 1; second <= 120; second += 1) {
    tab.arrive(SECOND, { lineInView: second % 2 === 0 });
    expect(tab.state.since).toBeNull();
  }
});

test("hidden, then in sight again with events that arrived meanwhile: the line sits at the moment the page was hidden", () => {
  const tab = page();
  tab.step(0, { newestAt: T0 - MINUTE });
  const hiddenAt = tab.hide(30 * SECOND);
  expect(tab.state.since).toBeNull();

  // Three events while it was away.
  tab.arrive(4 * MINUTE);
  tab.arrive(4 * MINUTE);
  tab.arrive(4 * MINUTE);
  tab.show(8 * MINUTE);

  expect(tab.state.since).toBe(hiddenAt);
});

test("an event drawn after the clock's last tick, before the page was hidden, was seen", () => {
  const tab = page();
  tab.step(0);
  // The clock ticks once a second, and an answer can land between two ticks.
  tab.step(SECOND, { newestAt: T0 + SECOND + 400 });
  tab.hide(0);
  tab.arrive(MINUTE);
  tab.show();

  expect(tab.state.since).toBe(T0 + SECOND + 400);
});

test("hidden, then in sight again with nothing new: no line", () => {
  const tab = page();
  tab.step(0, { newestAt: T0 - MINUTE });
  tab.hide();
  tab.show(20 * MINUTE);

  expect(tab.state.since).toBeNull();
  // And an event that then arrives while the page is in sight draws none either.
  tab.arrive(SECOND);
  expect(tab.state.since).toBeNull();
});

test("the line goes once it has been in view for ten seconds, and not while it is out of view", () => {
  const tab = page();
  tab.step(0);
  const hiddenAt = tab.hide();
  tab.arrive(5 * MINUTE);
  tab.show();
  expect(tab.state.since).toBe(hiddenAt);

  // Out of view, below the fold, for a minute: it stays.
  for (let second = 0; second < 60; second += 1) tab.step(SECOND);
  expect(tab.state.since).toBe(hiddenAt);

  // In view, it stays for ten seconds and then goes.
  tab.step(SECOND, { lineInView: true });
  tab.step(NEW_SEEN_MS - SECOND);
  expect(tab.state.since).toBe(hiddenAt);
  tab.step(SECOND);
  expect(tab.state.since).toBeNull();
});

test("the ten seconds start again when the line leaves view before they are up", () => {
  const tab = page();
  tab.step(0);
  tab.hide();
  tab.arrive(MINUTE);
  tab.show(SECOND, { lineInView: true });
  tab.step(8 * SECOND);
  // Scrolled out of view, then back.
  tab.step(SECOND, { lineInView: false });
  tab.step(SECOND, { lineInView: true });
  tab.step(8 * SECOND);
  expect(tab.state.since).not.toBeNull();
  tab.step(2 * SECOND);
  expect(tab.state.since).toBeNull();
});

test("time while the page is hidden is not time the line was in view", () => {
  const tab = page();
  tab.step(0);
  const hiddenAt = tab.hide();
  tab.arrive(MINUTE);
  tab.show(SECOND, { lineInView: true });
  tab.step(3 * SECOND);
  // Away again for an hour. The line was last in view, and nobody saw it.
  tab.hide();
  tab.arrive(60 * MINUTE);
  tab.show();

  // The first line keeps its place: what is above it was barely seen.
  expect(tab.state.since).toBe(hiddenAt);
  tab.step(NEW_SEEN_MS - SECOND);
  expect(tab.state.since).toBe(hiddenAt);
  tab.step(SECOND);
  expect(tab.state.since).toBeNull();
});

test("moving to another view and back takes the line away", () => {
  const tab = page();
  tab.step(0);
  tab.hide();
  tab.arrive(MINUTE);
  tab.show();
  expect(tab.state.since).not.toBeNull();

  tab.step(2 * SECOND, { overview: false });
  expect(tab.state.since).toBeNull();
  tab.arrive(5 * SECOND, { overview: true });
  expect(tab.state.since).toBeNull();
});

test.each(["Sources", "Settings"])(
  "when the page comes back with %s showing, the line waits for the Overview, and its ten seconds start there",
  () => {
    const tab = page();
    tab.step(0);
    const hiddenAt = tab.hide();
    tab.arrive(10 * MINUTE);
    tab.show(SECOND, { overview: false });

    // Held while the log is not on the page, however long that is.
    expect(tab.state.since).toBe(hiddenAt);
    tab.step(MINUTE);
    expect(tab.state.since).toBe(hiddenAt);

    tab.step(SECOND, { overview: true, lineInView: true });
    expect(tab.state.since).toBe(hiddenAt);
    tab.step(NEW_SEEN_MS - SECOND);
    expect(tab.state.since).toBe(hiddenAt);
    tab.step(SECOND);
    expect(tab.state.since).toBeNull();
  },
);

test("hidden while another view showed, the line sits where the Overview was left, not where the page was hidden", () => {
  const tab = page();
  tab.step(0);
  tab.step(MINUTE, { overview: false });
  const leftAt = tab.now;
  tab.arrive(5 * MINUTE);
  tab.hide();
  tab.show(10 * MINUTE);
  tab.step(SECOND, { overview: true });

  expect(tab.state.since).toBe(leftAt);
});

test("moving between views with the page in sight the whole time draws no line", () => {
  const tab = page();
  tab.step(0);
  tab.step(MINUTE, { overview: false });
  tab.arrive(10 * MINUTE);
  tab.step(SECOND, { overview: true });

  expect(tab.state.since).toBeNull();
});

test("a page loaded again starts from the time kept, and draws the line when something is newer", () => {
  const kept = T0 - 30 * MINUTE;
  const reloaded = page(kept);
  // Nothing is drawn before the first answer, so that is when it looks.
  reloaded.step(0, { visible: false });
  reloaded.show(SECOND, { newestAt: T0 - 5 * MINUTE });
  expect(reloaded.state.since).toBe(kept);

  // With nothing newer than the time kept, as after a reload a second long, no line.
  const quick = page(T0 - SECOND);
  quick.step(SECOND, { newestAt: T0 - MINUTE });
  expect(quick.state.since).toBeNull();

  // And with no time kept, as on the very first visit, none either.
  const first = page(null);
  first.step(SECOND, { newestAt: T0 });
  expect(first.state.since).toBeNull();
});

test("before the page has anything to show it does not look, so the line waits for the first answer", () => {
  const tab = page(T0 - 10 * MINUTE);
  tab.step(0, { visible: false });
  tab.step(SECOND);
  expect(tab.state.since).toBeNull();
  tab.show(SECOND, { newestAt: T0 - MINUTE });
  expect(tab.state.since).toBe(T0 - 10 * MINUTE);
});

test("the line goes when nothing newer than it is held any longer", () => {
  const tab = page();
  tab.step(0);
  tab.hide();
  tab.arrive(MINUTE);
  tab.show();
  expect(tab.state.since).not.toBeNull();

  // The app was started again and its events began again, empty.
  tab.step(SECOND, { newestAt: null });
  expect(tab.state.since).toBeNull();
});

test("a step that changes nothing returns the same state, and a second step with the same look changes nothing", () => {
  const tab = page();
  tab.step(0);
  const settled = tab.state;
  const still: Look = {
    now: tab.now,
    visible: true,
    overview: true,
    lineInView: false,
    newestAt: null,
  };
  expect(nextNewSince(settled, still)).toBe(settled);

  // Through going away, coming back, the line in view and leaving the Overview.
  const newestAt = T0 + 30 * SECOND;
  const looks: Look[] = [
    { ...still, now: T0 + SECOND, visible: false },
    { ...still, now: T0 + MINUTE, visible: false, newestAt },
    { ...still, now: T0 + MINUTE + SECOND, lineInView: true, newestAt },
    { ...still, now: T0 + 2 * MINUTE, lineInView: true, newestAt },
    { ...still, now: T0 + 2 * MINUTE + SECOND, overview: false, newestAt },
  ];
  let state = settled;
  for (const look of looks) {
    const once = nextNewSince(state, look);
    expect(nextNewSince(once, look)).toBe(once);
    state = once;
  }
});

test("the new events are those after the line, counted from the newest", () => {
  const at = (minutes: number) => T0 + minutes * MINUTE;
  const events = [5, 4, 3, 1].map((minutes, index): SessionEvent => ({
    id: `event-${index}`,
    at: at(minutes),
    sessionId: `status-files:checkout-flow-${index}`,
    sessionName: "checkout-flow",
    kind: "status-changed",
    from: "working",
    to: "idle",
    severity: "advisory",
  }));

  expect(countNew(events, at(2))).toBe(3);
  // An event at the very moment of the line was there to be seen.
  expect(countNew(events, at(3))).toBe(2);
  expect(countNew(events, at(6))).toBe(0);
  expect(countNew(events, null)).toBe(0);
  expect(countNew([], at(0))).toBe(0);
});
