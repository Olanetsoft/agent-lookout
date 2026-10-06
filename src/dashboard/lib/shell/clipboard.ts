/** What a copy came to: the text is on the clipboard, or the page was not let write it. */
export type CopyOutcome = "copied" | "refused";

/**
 * Puts text on the clipboard, for a press of a button that copies. It never
 * reads the clipboard, and never rejects.
 *
 * It is the browser's own `navigator.clipboard.writeText`, which a page served
 * from a loopback address, or from the Mac app's own scheme, may use while
 * the person presses something on it. In the Mac app the window's session
 * lets the page write and never read. A browser can still refuse, as one
 * without the clipboard, or a page in a frame, does: that is `refused`, and
 * the page leaves the text where the person can select it.
 */
export async function copyText(text: string): Promise<CopyOutcome> {
  try {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (typeof clipboard?.writeText !== "function") return "refused";
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "refused";
  }
}
