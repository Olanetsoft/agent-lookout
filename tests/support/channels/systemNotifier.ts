// A stand-in for the collector's notifier: the seam in
// `src/collector/notifications/systemNotifier.ts`. It writes down what it was
// asked to show and shows nothing, so no test raises a notification on the
// machine it runs on.

import type { NoticeAbout, SystemNotifier } from "@collector/notifications/systemNotifier";
import type { Notice } from "@core/notices/waiting";

export interface FakeSystemNotifier extends SystemNotifier {
  /** Everything it was asked to show, in order. */
  shown: Notice[];
  /** The session each was about, beside it, or undefined for one about none. */
  about: (NoticeAbout | undefined)[];
  /** Makes the next `show` throw, as a notifier never should. */
  throwsNext: boolean;
}

export function fakeSystemNotifier(): FakeSystemNotifier {
  const notifier: FakeSystemNotifier = {
    shown: [],
    about: [],
    throwsNext: false,
    show(notice, about) {
      if (notifier.throwsNext) {
        notifier.throwsNext = false;
        throw new Error("The fake notifier was told to throw.");
      }
      notifier.shown.push(notice);
      notifier.about.push(about);
    },
  };
  return notifier;
}
