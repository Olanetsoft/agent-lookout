import { expect, test } from "vitest";

import {
  commandK,
  isTextField,
  onMac,
  searchKeyShortcuts,
  shortcutFor,
  shortcutGroups,
  type KeyPress,
} from "@dashboard/lib/shell/shortcuts";

/** A key press with nothing held, as the browser reports it. */
function press(key: string, held: Partial<KeyPress> = {}): KeyPress {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...held };
}

const MAC = { mac: true, typing: false };
const PC = { mac: false, typing: false };

test('"/" opens the search and "?" the shortcuts, on a Mac and elsewhere', () => {
  for (const where of [MAC, PC]) {
    expect(shortcutFor(press("/"), where)).toBe("search");
    // Most keyboards type "?" with Shift, and some type "/" with it.
    expect(shortcutFor(press("?", { shiftKey: true }), where)).toBe("shortcuts");
    expect(shortcutFor(press("/", { shiftKey: true }), where)).toBe("search");
  }
});

test('"/" and "?" are typed, not shortcuts, while focus is in a text field', () => {
  for (const mac of [true, false]) {
    expect(shortcutFor(press("/"), { mac, typing: true })).toBeNull();
    expect(shortcutFor(press("?", { shiftKey: true }), { mac, typing: true })).toBeNull();
  }
});

test('"/" and "?" with Cmd, Ctrl or Alt held are someone else\'s', () => {
  for (const held of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
    expect(shortcutFor(press("/", held), MAC)).toBeNull();
    expect(shortcutFor(press("?", held), PC)).toBeNull();
  }
});

test("Cmd+K opens the search on a Mac and Ctrl+K elsewhere, in a text field too", () => {
  expect(shortcutFor(press("k", { metaKey: true }), MAC)).toBe("search");
  expect(shortcutFor(press("k", { metaKey: true }), { mac: true, typing: true })).toBe("search");
  expect(shortcutFor(press("k", { ctrlKey: true }), PC)).toBe("search");
  expect(shortcutFor(press("k", { ctrlKey: true }), { mac: false, typing: true })).toBe("search");
  // With Caps Lock on.
  expect(shortcutFor(press("K", { metaKey: true }), MAC)).toBe("search");
});

test("the other platform's key, more keys held, or K alone, open nothing", () => {
  // Ctrl+K on a Mac deletes to the end of a line in a text field.
  expect(shortcutFor(press("k", { ctrlKey: true }), MAC)).toBeNull();
  // The Windows key on a PC.
  expect(shortcutFor(press("k", { metaKey: true }), PC)).toBeNull();
  // With Shift or Option held it is another key: Firefox's Web Console is Cmd+Option+K on a
  // Mac and Ctrl+Shift+K elsewhere.
  expect(shortcutFor(press("K", { metaKey: true, shiftKey: true }), MAC)).toBeNull();
  expect(shortcutFor(press("k", { metaKey: true, altKey: true }), MAC)).toBeNull();
  expect(shortcutFor(press("k", { ctrlKey: true, metaKey: true }), MAC)).toBeNull();
  expect(shortcutFor(press("k", { ctrlKey: true, metaKey: true }), PC)).toBeNull();
  expect(shortcutFor(press("k"), MAC)).toBeNull();
  expect(shortcutFor(press("j", { metaKey: true }), MAC)).toBeNull();
});

test("on a keyboard that types no Latin letters, Cmd+K is found by the key's place", () => {
  // A Russian layout types "л" on the key where K is.
  expect(shortcutFor(press("л", { metaKey: true, code: "KeyK" }), MAC)).toBe("search");
  expect(shortcutFor(press("л", { ctrlKey: true, code: "KeyK" }), PC)).toBe("search");
  // On a layout that does type Latin letters, the letter decides, wherever the key is.
  expect(shortcutFor(press("t", { metaKey: true, code: "KeyK" }), MAC)).toBeNull();
  expect(shortcutFor(press("k", { metaKey: true, code: "KeyV" }), MAC)).toBe("search");
});

test("other keys are not shortcuts", () => {
  for (const key of ["Escape", "Enter", "ArrowDown", "k", "s", "f", " ", "Tab"]) {
    expect(shortcutFor(press(key), MAC)).toBeNull();
    expect(shortcutFor(press(key), PC)).toBeNull();
  }
});

test.each([
  [{ tagName: "INPUT", type: "text" }, true],
  [{ tagName: "INPUT", type: "search" }, true],
  [{ tagName: "INPUT", type: "email" }, true],
  [{ tagName: "INPUT", type: "password" }, true],
  [{ tagName: "INPUT", type: "number" }, true],
  [{ tagName: "INPUT", type: "url" }, true],
  [{ tagName: "INPUT" }, true],
  [{ tagName: "INPUT", type: "TEXT" }, true],
  [{ tagName: "TEXTAREA" }, true],
  [{ tagName: "SELECT" }, true],
  [{ tagName: "DIV", isContentEditable: true }, true],
  [{ tagName: "INPUT", type: "checkbox" }, false],
  [{ tagName: "INPUT", type: "radio" }, false],
  [{ tagName: "INPUT", type: "button" }, false],
  [{ tagName: "INPUT", type: "range" }, false],
  [{ tagName: "INPUT", type: "submit" }, false],
  [{ tagName: "BUTTON" }, false],
  [{ tagName: "A" }, false],
  [{ tagName: "BODY", isContentEditable: false }, false],
  [{}, false],
] as const)("%j is a text field: %s", (target, expected) => {
  expect(isTextField(target)).toBe(expected);
});

test("nothing focused is no text field", () => {
  expect(isTextField(null)).toBe(false);
  expect(isTextField(undefined)).toBe(false);
});

test.each([
  ["MacIntel", true],
  ["iPhone", true],
  ["iPad", true],
  ["Win32", false],
  ["Linux x86_64", false],
  ["", false],
])("%j is a Mac: %s", (platform, expected) => {
  expect(onMac(platform)).toBe(expected);
});

test("the search's second key is named as each computer names it, for the eye, the ear and assistive technology", () => {
  expect(commandK(true)).toEqual({ shown: "⌘K", said: "Command K" });
  expect(commandK(false)).toEqual({ shown: "Ctrl+K", said: "Control K" });
  expect(searchKeyShortcuts(true)).toBe("/ Meta+K");
  expect(searchKeyShortcuts(false)).toBe("/ Control+K");
});

test("the sheet lists the search's keys and every key the page already had, each row with keys", () => {
  for (const mac of [true, false]) {
    const groups = shortcutGroups(mac);
    expect(groups.map((group) => group.title)).toEqual([
      "On every view",
      "In the search",
      "In a chart or the timeline",
      "In a switch",
    ]);
    const rows = groups.flatMap((group) => group.rows);
    for (const row of rows) expect(row.keys.length, row.does).toBeGreaterThan(0);
    const keysFor = (does: string) =>
      rows.find((row) => row.does === does)?.keys.map((key) => key.shown);

    expect(keysFor("Find a session")).toEqual(["/", mac ? "⌘K" : "Ctrl+K"]);
    expect(keysFor("Show these shortcuts")).toEqual(["?"]);
    expect(keysFor("Close a dialog")).toEqual(["Esc"]);
    expect(keysFor("Move through the sessions")).toEqual(["↑", "↓"]);
    expect(keysFor("Jump to the session, or open its details")).toEqual(["Enter"]);
    // Last hour, a history chart and the timeline had these before the search.
    expect(keysFor("Move along it")).toEqual(["←", "→"]);
    expect(keysFor("Go to the first or the last")).toEqual(["Home", "End"]);
    expect(keysFor("Ten steps in a history chart")).toEqual(["Page Up", "Page Down"]);
    // The theme switch and the switches in Settings.
    expect(keysFor("Choose the next or the previous option")).toEqual(["←", "→"]);
    // A sign is said in words.
    for (const key of rows.flatMap((row) => row.keys)) {
      if (!/^[\w ]+$|^[/?]$/.test(key.shown)) expect(key.said, key.shown).toBeTruthy();
    }
  }
});
