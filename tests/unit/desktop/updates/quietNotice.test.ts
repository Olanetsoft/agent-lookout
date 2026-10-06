import { describe, expect, test } from "vitest";

import { createQuietNotice } from "@desktop/updates/quietNotice";

describe("the notice of a version found, in quiet hours", () => {
  test("is shown at once when it is not quiet", () => {
    const shown: string[] = [];
    const notice = createQuietNotice<string>({ isQuiet: () => false, show: (v) => shown.push(v) });
    notice.found("0.2.9");
    expect(shown).toEqual(["0.2.9"]);
    notice.quietNow(false);
    expect(shown).toEqual(["0.2.9"]);
  });

  test("found while it is quiet, is held until a snapshot says it is not, and shown once", () => {
    const shown: string[] = [];
    let quiet = true;
    const notice = createQuietNotice<string>({ isQuiet: () => quiet, show: (v) => shown.push(v) });
    notice.found("0.2.8");
    // A later one found meanwhile takes its place.
    notice.found("0.2.9");
    notice.quietNow(true);
    expect(shown).toEqual([]);
    quiet = false;
    notice.quietNow(false);
    notice.quietNow(false);
    expect(shown).toEqual(["0.2.9"]);
  });
});
