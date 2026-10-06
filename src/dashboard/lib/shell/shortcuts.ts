/**
 * The page's own keyboard shortcuts: which key press does what, and the list
 * the sheet of shortcuts shows.
 *
 * Three keys work on every view. "/" and Cmd+K, or Ctrl+K away from a Mac,
 * open the search, and "?" opens the sheet. "/" and "?" are characters a
 * person types, so they are left alone while focus is in a text field. Cmd+K
 * types nothing, so it works there too.
 *
 * None of them is a key the browser keeps for itself. Some browsers do use two
 * of them when the page leaves them alone: Firefox starts its quick find on
 * "/", and Firefox's Cmd+K or Ctrl+K, and Chrome's Ctrl+K on Windows and
 * Linux, search the web from the address bar. While this page has focus they
 * open the search here instead. Cmd+F or Ctrl+F still finds in the page.
 */

export type Shortcut = "search" | "shortcuts";

/** What a shortcut needs to know of a key press. A `KeyboardEvent` is one. */
export interface KeyPress {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** What a shortcut needs to know of where focus is. An element is one. */
export interface KeyTarget {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
}

/** The inputs that take no typed text. Every other kind of input does. */
const NOT_TEXT = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Whether keys pressed here are typed into it: a text input, a text area, a list to choose from, or editable text. */
export function isTextField(target: KeyTarget | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable === true) return true;
  switch (target.tagName) {
    case "TEXTAREA":
    case "SELECT":
      return true;
    case "INPUT":
      return !NOT_TEXT.has((target.type ?? "text").toLowerCase());
    default:
      return false;
  }
}

/** Whether the page runs on a Mac, or an iPad or iPhone, where the command key does what Control does elsewhere. */
export function onMac(
  platform = typeof navigator === "undefined"
    ? ""
    : navigator.platform || navigator.userAgent || "",
): boolean {
  return /Mac|iPhone|iPad|iPod/.test(platform);
}

/**
 * The letter a key press stands for. On a keyboard that types no Latin
 * letters, as with a Russian layout, the key's place on the keyboard says it,
 * as it does for the browser's own shortcuts.
 */
function letterOf(press: KeyPress): string {
  if (/^[a-z]$/i.test(press.key)) return press.key.toLowerCase();
  return press.code?.startsWith("Key") ? press.code.slice(3).toLowerCase() : press.key;
}

/**
 * The shortcut a key press is, or null. `typing` says that focus is in a text
 * field, where only Cmd+K or Ctrl+K is one.
 */
export function shortcutFor(
  press: KeyPress,
  { mac, typing }: { mac: boolean; typing: boolean },
): Shortcut | null {
  const command = mac ? press.metaKey && !press.ctrlKey : press.ctrlKey && !press.metaKey;
  if (command && !press.altKey && !press.shiftKey && letterOf(press) === "k") return "search";
  if (typing || press.metaKey || press.ctrlKey || press.altKey) return null;
  // Shift is how most keyboards type "?", and some type "/", so it is not asked about.
  if (press.key === "/") return "search";
  if (press.key === "?") return "shortcuts";
  return null;
}

/** A key as the sheet shows it, and as a screen reader says it when the sign alone would not do. */
export interface Key {
  shown: string;
  said?: string;
}

/** The second key that opens the search, as this computer names it. */
export function commandK(mac: boolean): Key {
  return mac ? { shown: "⌘K", said: "Command K" } : { shown: "Ctrl+K", said: "Control K" };
}

/** The keys that open the search, as `aria-keyshortcuts` writes them. */
export function searchKeyShortcuts(mac: boolean): string {
  return mac ? "/ Meta+K" : "/ Control+K";
}

export interface ShortcutRow {
  /** What it does. */
  does: string;
  /** The keys, any one of which does it. */
  keys: readonly Key[];
}

export interface ShortcutGroup {
  title: string;
  rows: readonly ShortcutRow[];
}

const LEFT_RIGHT: readonly Key[] = [
  { shown: "←", said: "Left arrow" },
  { shown: "→", said: "Right arrow" },
];

/**
 * Every shortcut the page has, in groups, for the sheet. The arrow keys in the
 * charts, the timeline and the switches were there before the search; the
 * sheet lists them too. Tab, Shift+Tab and Enter on a link or a button are the
 * browser's, and are not listed.
 */
export function shortcutGroups(mac: boolean): readonly ShortcutGroup[] {
  return [
    {
      title: "On every view",
      rows: [
        { does: "Find a session", keys: [{ shown: "/" }, commandK(mac)] },
        { does: "Show these shortcuts", keys: [{ shown: "?" }] },
        { does: "Close a dialog", keys: [{ shown: "Esc", said: "Escape" }] },
      ],
    },
    {
      title: "In the search",
      rows: [
        {
          does: "Move through the sessions",
          keys: [
            { shown: "↑", said: "Up arrow" },
            { shown: "↓", said: "Down arrow" },
          ],
        },
        { does: "Jump to the session, or open its details", keys: [{ shown: "Enter" }] },
      ],
    },
    {
      title: "In a chart or the timeline",
      rows: [
        { does: "Move along it", keys: LEFT_RIGHT },
        { does: "Go to the first or the last", keys: [{ shown: "Home" }, { shown: "End" }] },
        {
          does: "Ten steps in a history chart",
          keys: [{ shown: "Page Up" }, { shown: "Page Down" }],
        },
      ],
    },
    {
      title: "In a switch",
      rows: [{ does: "Choose the next or the previous option", keys: LEFT_RIGHT }],
    },
  ];
}
