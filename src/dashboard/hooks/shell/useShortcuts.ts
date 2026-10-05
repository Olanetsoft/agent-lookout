import { useEffect, useEffectEvent } from "react";

import {
  isTextField,
  onMac,
  shortcutFor,
  type KeyTarget,
  type Shortcut,
} from "@dashboard/lib/shell/shortcuts";

/**
 * Listens for the page's shortcuts on every view, and hands each one to
 * `onShortcut`, which says whether it took it. One it took is kept from the
 * browser. One it did not, as while a history dialog is open, is left to the
 * browser, as any other key is.
 *
 * A key held down repeats, and a key that finishes a character still being
 * composed, as with an input method for Japanese, is part of typing: neither
 * is a shortcut.
 */
export function useShortcuts(onShortcut: (shortcut: Shortcut) => boolean): void {
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.isComposing) return;
    const typing = isTextField(event.target as KeyTarget | null);
    const shortcut = shortcutFor(event, { mac: onMac(), typing });
    if (shortcut !== null && onShortcut(shortcut)) event.preventDefault();
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);
}
