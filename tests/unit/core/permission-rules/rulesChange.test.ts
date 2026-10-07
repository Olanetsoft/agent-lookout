import { describe, expect, test } from "vitest";

import { MAX_RULES, type PermissionRule } from "@core/permission-rules/permissionRules";
import { applyRulesChange, CHANGE_SHAPE, rulesChangeIn } from "@core/permission-rules/rulesChange";

const A: PermissionRule = {
  id: "aaaaaaaaaaaa",
  decision: "allow",
  tool: "Bash",
  command: "npm test:*",
};
const B: PermissionRule = { id: "bbbbbbbbbbbb", decision: "deny", tool: "Write" };
const C: PermissionRule = { id: "cccccccccccc", decision: "ask", tool: "*" };

/** Ids made in turn, so a test can say which one a new rule gets. */
function ids(...made: string[]) {
  return () => made.shift() ?? "ffffffffffff";
}

describe("a change, as the route reads its body", () => {
  test.each([
    [
      { add: { decision: "deny", tool: "Write" } },
      { kind: "add", words: { decision: "deny", tool: "Write" } },
    ],
    [
      { edit: { id: "aaaaaaaaaaaa", decision: "ask", tool: "Bash", command: "git push:*" } },
      {
        kind: "edit",
        id: "aaaaaaaaaaaa",
        words: { decision: "ask", tool: "Bash", command: "git push:*" },
      },
    ],
    [
      { move: { id: "aaaaaaaaaaaa", to: "down" } },
      { kind: "move", id: "aaaaaaaaaaaa", to: "down" },
    ],
    [{ remove: { id: "aaaaaaaaaaaa" } }, { kind: "remove", id: "aaaaaaaaaaaa" }],
  ])("%j is read", (body, change) => {
    expect(rulesChangeIn(body)).toEqual({ ok: true, change });
  });

  test.each([
    null,
    [],
    {},
    { add: { decision: "deny", tool: "Write" }, remove: { id: "aaaaaaaaaaaa" } },
    { replace: [] },
    { add: "deny Write" },
    { edit: { decision: "deny", tool: "Write" } },
    { edit: { id: "two words", decision: "deny", tool: "Write" } },
    { move: { id: "aaaaaaaaaaaa", to: "top" } },
    { move: { id: "aaaaaaaaaaaa", to: "up", by: 2 } },
    { remove: { id: "aaaaaaaaaaaa", also: "bbbbbbbbbbbb" } },
    { remove: {} },
  ])("%j is refused whole, with the sentence that says what one is", (body) => {
    expect(rulesChangeIn(body)).toEqual({ ok: false, problem: CHANGE_SHAPE });
  });

  test("a rule that is no rule is refused with the rule's own sentence", () => {
    const read = rulesChangeIn({ add: { decision: "allow", tool: "Bash" } });
    expect(read).toEqual({ ok: false, problem: expect.stringMatching(/names a command/) });
    const edit = rulesChangeIn({
      edit: { id: "aaaaaaaaaaaa", decision: "allow", tool: "Bash", command: "npm test && rm" },
    });
    expect(edit.ok).toBe(false);
  });
});

describe("what a change makes of the list", () => {
  test("a new rule goes to the end, with an id of its own", () => {
    const made = applyRulesChange(
      [A],
      { kind: "add", words: { decision: "deny", tool: "Write" } },
      ids("aaaaaaaaaaaa", "dddddddddddd"),
    );
    expect(made).toEqual({
      ok: true,
      rules: [A, { id: "dddddddddddd", decision: "deny", tool: "Write" }],
      changed: true,
    });
  });

  test("a rule that says what one there says already is refused", () => {
    const made = applyRulesChange(
      [A, B],
      { kind: "add", words: { decision: "deny", tool: "Write" } },
      ids(),
    );
    expect(made).toMatchObject({ ok: false, reason: "duplicate" });
  });

  test(`a list of ${MAX_RULES} rules takes no more`, () => {
    const full = Array.from({ length: MAX_RULES }, (_, index): PermissionRule => ({
      id: `r${index}`,
      decision: "deny",
      tool: "Bash",
      command: `rm${index}`,
    }));
    const made = applyRulesChange(
      full,
      { kind: "add", words: { decision: "deny", tool: "Read" } },
      ids(),
    );
    expect(made).toMatchObject({ ok: false, reason: "full" });
  });

  test("an edit keeps the rule's place and its id", () => {
    const made = applyRulesChange(
      [A, B, C],
      { kind: "edit", id: B.id, words: { decision: "ask", tool: "Write" } },
      ids(),
    );
    expect(made).toEqual({
      ok: true,
      rules: [A, { id: B.id, decision: "ask", tool: "Write" }, C],
      changed: true,
    });
  });

  test("an edit to what it says already changes nothing, and one to what another says is refused", () => {
    expect(
      applyRulesChange(
        [A, B],
        { kind: "edit", id: B.id, words: { decision: "deny", tool: "Write" } },
        ids(),
      ),
    ).toEqual({ ok: true, rules: [A, B], changed: false });
    expect(
      applyRulesChange(
        [A, B],
        {
          kind: "edit",
          id: B.id,
          words: { decision: "allow", tool: "Bash", command: "npm test:*" },
        },
        ids(),
      ),
    ).toMatchObject({ ok: false, reason: "duplicate" });
  });

  test("a move swaps a rule with the one beside it, and at an end changes nothing", () => {
    expect(applyRulesChange([A, B, C], { kind: "move", id: B.id, to: "up" }, ids())).toEqual({
      ok: true,
      rules: [B, A, C],
      changed: true,
    });
    expect(applyRulesChange([A, B, C], { kind: "move", id: B.id, to: "down" }, ids())).toEqual({
      ok: true,
      rules: [A, C, B],
      changed: true,
    });
    expect(applyRulesChange([A, B, C], { kind: "move", id: A.id, to: "up" }, ids())).toEqual({
      ok: true,
      rules: [A, B, C],
      changed: false,
    });
    expect(
      applyRulesChange([A, B, C], { kind: "move", id: C.id, to: "down" }, ids()),
    ).toMatchObject({
      changed: false,
    });
  });

  test("a removal takes the rule out, and the others keep their order", () => {
    expect(applyRulesChange([A, B, C], { kind: "remove", id: B.id }, ids())).toEqual({
      ok: true,
      rules: [A, C],
      changed: true,
    });
  });

  test.each(["edit", "move", "remove"] as const)(
    "%s of a rule the list does not hold, as one removed in another tab, is refused",
    (kind) => {
      const change =
        kind === "edit"
          ? { kind, id: "eeeeeeeeeeee", words: { decision: "deny" as const, tool: "Read" } }
          : kind === "move"
            ? { kind, id: "eeeeeeeeeeee", to: "up" as const }
            : { kind, id: "eeeeeeeeeeee" };
      expect(applyRulesChange([A, B], change, ids())).toMatchObject({
        ok: false,
        reason: "no-rule",
      });
    },
  );
});
