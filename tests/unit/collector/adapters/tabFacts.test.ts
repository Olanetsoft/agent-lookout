import { describe, expect, test } from "vitest";

import { tabFacts } from "@collector/adapters/tabFacts";
import { PS_TABLE_ARGS } from "@collector/processes/processTable";
import type { TabAsker } from "@collector/terminal/tabFinder";
import { TAB_CHECK, TAB_CHECK_RUN } from "@tests/support/node/terminal";

/** An asker that says what a test sets, and looks at nothing. */
const asker = (asked: boolean): TabAsker => ({
  look: async () => {},
  tabOf: () => undefined,
  asked: () => asked,
});

describe("tabFacts", () => {
  test("names the command as it is run", () => {
    const [check] = tabFacts(asker(false), "darwin");

    expect(check).toEqual({ label: "Tab check", value: TAB_CHECK });
    expect(check?.value).toBe(`ps ${PS_TABLE_ARGS.join(" ")}`);
  });

  test("says not run until the asker says it has asked", () => {
    expect(tabFacts(asker(false), "darwin")[1]).toEqual({
      label: "Tab check run",
      value: "not run",
    });
    expect(tabFacts(asker(true), "darwin")[1]).toEqual({
      label: "Tab check run",
      value: TAB_CHECK_RUN,
    });
  });

  test("says nothing with no finder, or anywhere but a Mac", () => {
    expect(tabFacts(undefined, "darwin")).toEqual([]);
    expect(tabFacts(asker(true), "linux")).toEqual([]);
    expect(tabFacts(asker(true), "win32")).toEqual([]);
  });
});
