// A stand-in for the collector's notifier: the seam in
// `src/collector/notifications/systemNotifier.ts`. It writes down what it was
// asked to show and shows nothing, so no test raises a notification on the
// machine it runs on.

import type { SystemNotifier } from "@collector/notifications/systemNotifier";
import type { Notice } from "@core/sessions/waiting";

export interface FakeSystemNotifier extends SystemNotifier {
  /** Everything it was asked to show, in order. */
  shown: Notice[];
  /** Makes the next `show` throw, as a notifier never should. */
  throwsNext: boolean;
}

export function fakeSystemNotifier(): FakeSystemNotifier {
  const notifier: FakeSystemNotifier = {
    shown: [],
    throwsNext: false,
    show(notice) {
      if (notifier.throwsNext) {
        notifier.throwsNext = false;
        throw new Error("The fake notifier was told to throw.");
      }
      notifier.shown.push(notice);
    },
  };
  return notifier;
}
