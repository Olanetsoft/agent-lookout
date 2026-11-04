import { describe, expect, test } from "vitest";

import { paneFacts } from "@collector/adapters/paneFacts";
import { LIST_PANES_ARGS } from "@collector/tmux/panes";
import type { PaneAsker } from "@collector/tmux/paneFinder";
import { PS_PARENTS_ARGS } from "@collector/processes/processParents";
import {
  PANE_CHECK,
  PANE_CHECK_RUN,
  PANE_PARENT_CHECK,
  PANE_PARENT_CHECK_RUN,
} from "@tests/support/node/tmux";

/** An asker that says what a test sets, and looks at nothing. */
const asker = (says: {
  installed?: boolean;
  asked?: boolean;
  parentsAsked?: boolean;
}): PaneAsker => ({
  look: async () => {},
  paneOf: () => undefined,
  installed: () => says.installed ?? true,
  asked: () => says.asked ?? false,
  parentsAsked: () => says.parentsAsked ?? false,
});

const valueOf = (facts: ReturnType<typeof paneFacts>, label: string) =>
  facts.find((fact) => fact.label === label)?.value;

describe("paneFacts", () => {
  test("names the commands as they are run", () => {
    const facts = paneFacts(asker({}), "darwin");

    expect(valueOf(facts, "Pane check")).toBe(PANE_CHECK);
    expect(valueOf(facts, "Pane check")?.replace(/'/g, "")).toBe(
      `tmux ${LIST_PANES_ARGS.join(" ")}`,
    );
    expect(valueOf(facts, "Pane parent check")).toBe(PANE_PARENT_CHECK);
    expect(valueOf(facts, "Pane parent check")).toBe(`ps ${PS_PARENTS_ARGS.join(" ")}`);
  });

  test("says not run for each until the asker says it has asked", () => {
    const none = paneFacts(asker({}), "linux");
    expect(valueOf(none, "Pane check run")).toBe("not run");
    expect(valueOf(none, "Pane parent check run")).toBe("not run");

    const tmuxAlone = paneFacts(asker({ asked: true }), "linux");
    expect(valueOf(tmuxAlone, "Pane check run")).toBe(PANE_CHECK_RUN);
    expect(valueOf(tmuxAlone, "Pane parent check run")).toBe("not run");

    const both = paneFacts(asker({ asked: true, parentsAsked: true }), "linux");
    expect(valueOf(both, "Pane check run")).toBe(PANE_CHECK_RUN);
    expect(valueOf(both, "Pane parent check run")).toBe(PANE_PARENT_CHECK_RUN);
  });

  test("says nothing with no finder, without tmux or on Windows", () => {
    expect(paneFacts(undefined, "darwin")).toEqual([]);
    expect(paneFacts(asker({ installed: false, asked: true }), "darwin")).toEqual([]);
    expect(paneFacts(asker({ asked: true, parentsAsked: true }), "win32")).toEqual([]);
  });
});
