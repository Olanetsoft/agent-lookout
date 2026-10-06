// What a right-click in the page offers: Cut, Copy and Paste where they can be
// done, as in any Mac app, and nothing else. Copy is there for selected text;
// in a field, such as the search, Cut, Paste and Select All are there too.
// Where none of them can be done, no menu opens.
//
// It imports only types from Electron, so it is tested in plain Node.

import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

/** What the menu is made from: where the click was, and what can be done there. */
export type ContextMenuPlace = Pick<ContextMenuParams, "isEditable" | "selectionText"> & {
  editFlags: Pick<
    ContextMenuParams["editFlags"],
    "canCut" | "canCopy" | "canPaste" | "canSelectAll"
  >;
};

/** The items for a right-click, or none when nothing can be done there. */
export function contextMenuTemplate(place: ContextMenuPlace): MenuItemConstructorOptions[] {
  const { isEditable, selectionText, editFlags } = place;
  const selected = selectionText.trim() !== "";
  const items: MenuItemConstructorOptions[] = [];
  if (isEditable && editFlags.canCut) items.push({ role: "cut" });
  if (editFlags.canCopy && (isEditable || selected)) items.push({ role: "copy" });
  if (isEditable && editFlags.canPaste) items.push({ role: "paste" });
  if (isEditable && editFlags.canSelectAll) {
    if (items.length > 0) items.push({ type: "separator" });
    items.push({ role: "selectAll" });
  }
  return items;
}
