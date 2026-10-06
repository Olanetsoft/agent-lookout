/**
 * The one seam between the dashboard and the page's own address.
 *
 * A view, and a session's details, each have a fragment of their own, so a
 * link, Back and a reload land on them. Where the dashboard moves the page to
 * one itself, as when a session's details open, it goes through `goTo`. In a
 * browser tab that is a new entry in the tab's history, so Back steps out of
 * it again.
 *
 * A page that holds the dashboard inside a frame of its own, as the landing
 * page does, installs a host with `setAddressHost` that replaces the address
 * instead. A frame's entries are the page's own entries, so Back there would
 * otherwise step through the dashboard before it left the page.
 */

export interface AddressHost {
  /**
   * Moves the page to a fragment of its own address, such as `#overview`.
   * Says whether that added an entry to the browser's history, which Back
   * then steps out of.
   */
  go(href: string): boolean;
}

const browserAddress: AddressHost = {
  go(href) {
    window.location.hash = href;
    return true;
  },
};

let currentHost: AddressHost = browserAddress;

/** Replaces the way the address is moved. Call with no argument to restore the browser's own. */
export function setAddressHost(host: AddressHost = browserAddress): void {
  currentHost = host;
}

/**
 * Moves the page to a fragment of its own address, the way the host in use
 * does. True when an entry was added to the history.
 */
export function goTo(href: string): boolean {
  return currentHost.go(href);
}
