/**
 * The three views the rail moves between. Each has its own address in the
 * fragment of the page's URL, so the browser's back button, a reload and a
 * bookmark all land on the same view. Anything the page does not know is the
 * Overview, so a mistyped address is never an empty page. So is the address of
 * a session's details, which open over it: see `sessionDetails.ts`.
 */

export type ViewId = "overview" | "sources" | "settings";

export interface ViewEntry {
  id: ViewId;
  /** What the rail calls it. */
  label: string;
  /** The link to it. */
  href: string;
}

/** In the order the rail lists them. */
export const VIEWS: readonly ViewEntry[] = [
  { id: "overview", label: "Overview", href: "#overview" },
  { id: "sources", label: "Sources", href: "#sources" },
  { id: "settings", label: "Settings", href: "#settings" },
];

/** The view a URL fragment names, such as "#sources". Anything else is the Overview. */
export function viewFromHash(hash: string): ViewId {
  switch (hash) {
    case "#sources":
      return "sources";
    case "#settings":
      return "settings";
    default:
      return "overview";
  }
}

/** What the rail and the main area call a view. */
export function viewLabel(view: ViewId): string {
  return VIEWS.find((entry) => entry.id === view)?.label ?? "Overview";
}
