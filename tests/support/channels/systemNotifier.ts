// A stand-in for the collector's notifier: the seam in
// `src/collector/notifications/systemNotifier.ts`. It writes down what it was
// asked to show, and each wait it was told has ended, and shows nothing, so no
// test raises a notification on the machine it runs on. Like the system's own,
// it leaves `pagesNotify` out unless a test says the pages show none of their
// own, as the Mac app's notifier does.

import type { NoticeAbout, SystemNotifier } from "@collector/notifications/systemNotifier";
import type { Notice } from "@core/notices/waiting";

export interface FakeSystemNotifier
  extends Required<Omit<SystemNotifier, "pagesNotify">>, Pick<SystemNotifier, "pagesNotify"> {
  /** Everything it was asked to show, in order. */
  shown: Notice[];
  /** What each was about, beside it, or undefined for one about nothing. */
  about: (NoticeAbout | undefined)[];
  /** The session of each wait it was told has ended, in order. */
  ended: string[];
  /** How many times it was told the notifications of waits were switched off. */
  waitsOffs: number;
  /** What it was told, in order: to show one, that a wait ended, or that waits were switched off. */
  calls: ("show" | "waitEnded" | "waitsOff")[];
  /** Makes the next `show` throw, as a notifier never should. */
  throwsNext: boolean;
}

export function fakeSystemNotifier(options: { pagesNotify?: boolean } = {}): FakeSystemNotifier {
  const notifier: FakeSystemNotifier = {
    ...(options.pagesNotify !== undefined && { pagesNotify: options.pagesNotify }),
    shown: [],
    about: [],
    ended: [],
    waitsOffs: 0,
    calls: [],
    throwsNext: false,
    show(notice, about) {
      if (notifier.throwsNext) {
        notifier.throwsNext = false;
        throw new Error("The fake notifier was told to throw.");
      }
      notifier.shown.push(notice);
      notifier.about.push(about);
      notifier.calls.push("show");
    },
    waitEnded(sessionId) {
      notifier.ended.push(sessionId);
      notifier.calls.push("waitEnded");
    },
    waitsOff() {
      notifier.waitsOffs += 1;
      notifier.calls.push("waitsOff");
    },
  };
  return notifier;
}
