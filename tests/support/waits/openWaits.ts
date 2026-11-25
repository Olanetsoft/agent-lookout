// A model of what a session waits on, for the tests that compare an adapter
// with it over many histories made up at random, and what those tests share.
// It goes by what was asked and answered, and knows nothing of files or folds.

import type { Adapter } from "@collector/adapters/adapter";
import { createEventStore } from "@collector/eventStore";
import { createHistoryStore } from "@collector/historyStore";
import { createPoller } from "@collector/poller";
import { EMPTY_WAIT_MEMORY, waitChanges } from "@core/notices/sessionChanges";

/** The same numbers from 0 to 1 each run, for a seed. */
export function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

/** What is open in a session, and since when something has been. */
export function createOpenWaits() {
  const asked = new Map<string, number>();
  let since: number | null = null;
  return {
    open: asked as ReadonlyMap<string, number>,
    /** When the wait that stands began: something has been open ever since. */
    since: () => since,
    ask(id: string, at: number) {
      if (asked.has(id)) return;
      if (asked.size === 0) since = at;
      asked.set(id, at);
    },
    answer(id: string) {
      asked.delete(id);
      if (asked.size === 0) since = null;
    },
    clear() {
      asked.clear();
      since = null;
    },
    /** A run that remembers nothing knows of what is open, and of nothing answered before it. */
    forgetAnswered() {
      since = asked.size === 0 ? null : Math.min(...asked.values());
    },
  };
}

/** What each poll of one run announces and takes down, given the wait it shows, by when that began. */
export function createAnnouncements() {
  let shown: number | null | undefined;
  return {
    poll(since: number | null) {
      const before = shown;
      shown = since;
      // A run's first poll is what it begins from, and announces nothing.
      if (before === undefined || before === since) return { started: 0, stopped: 0 };
      return { started: since === null ? 0 : 1, stopped: before === null ? 0 : 1 };
    },
    restart() {
      shown = undefined;
    },
  };
}

/** Polls an adapter of one session through the poller, and says what the poll shows and announces. */
export function watchWaits(adapter: Adapter, now: () => number) {
  const poller = createPoller({
    adapters: [adapter],
    events: createEventStore(),
    history: createHistoryStore(),
    now,
  });
  let memory = EMPTY_WAIT_MEMORY;
  return async () => {
    const snapshot = await poller.pollOnce();
    const changes = waitChanges(memory, snapshot);
    memory = changes.memory;
    const [session] = snapshot.sessions;
    const waits = session?.status === "needs-you";
    return {
      status: session?.status,
      since: waits ? (session?.statusSince ?? null) : null,
      started: changes.started.length,
      stopped: changes.stopped.length,
    };
  };
}
