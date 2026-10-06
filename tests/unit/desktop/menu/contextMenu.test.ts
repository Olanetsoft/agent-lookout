import { describe, expect, test } from "vitest";

import { contextMenuTemplate, type ContextMenuPlace } from "@desktop/menu/contextMenu";

const NOTHING = { canCut: false, canCopy: false, canPaste: false, canSelectAll: false };

function place(overrides: Partial<ContextMenuPlace>): ContextMenuPlace {
  return { isEditable: false, selectionText: "", editFlags: NOTHING, ...overrides };
}

/** What each item does, a separator as a dash. */
const roles = (template: ReturnType<typeof contextMenuTemplate>) =>
  template.map((item) => item.role ?? (item.type === "separator" ? "-" : item.label));

describe("a right-click in the page", () => {
  test("on selected text offers Copy, and nothing else", () => {
    const template = contextMenuTemplate(
      place({ selectionText: "Nothing needs you", editFlags: { ...NOTHING, canCopy: true } }),
    );
    expect(roles(template)).toEqual(["copy"]);
  });

  test("in a field offers what can be done there", () => {
    const all = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };
    expect(roles(contextMenuTemplate(place({ isEditable: true, editFlags: all })))).toEqual([
      "cut",
      "copy",
      "paste",
      "-",
      "selectAll",
    ]);
    // An empty field: nothing to cut or copy, and something to paste.
    expect(
      roles(
        contextMenuTemplate(
          place({
            isEditable: true,
            editFlags: { ...NOTHING, canPaste: true, canSelectAll: true },
          }),
        ),
      ),
    ).toEqual(["paste", "-", "selectAll"]);
    expect(
      roles(
        contextMenuTemplate(
          place({ isEditable: true, editFlags: { ...NOTHING, canSelectAll: true } }),
        ),
      ),
    ).toEqual(["selectAll"]);
  });

  test("where nothing can be done, opens no menu", () => {
    expect(contextMenuTemplate(place({}))).toEqual([]);
    // Outside a field, with no text selected, Select All and Paste are not offered.
    expect(
      contextMenuTemplate(
        place({ editFlags: { canCut: false, canCopy: true, canPaste: true, canSelectAll: true } }),
      ),
    ).toEqual([]);
    expect(
      contextMenuTemplate(
        place({ selectionText: "  \n", editFlags: { ...NOTHING, canCopy: true } }),
      ),
    ).toEqual([]);
  });
});
