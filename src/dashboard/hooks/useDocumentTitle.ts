import { useEffect } from "react";

const APP_NAME = "Agent Lookout";

/**
 * Puts the number of sessions that need the person in the tab title, as
 * "(2) Agent Lookout", so it can be read while the tab is in the background.
 */
export function useDocumentTitle(needsYou: number): void {
  useEffect(() => {
    document.title = needsYou > 0 ? `(${needsYou}) ${APP_NAME}` : APP_NAME;
    return () => {
      document.title = APP_NAME;
    };
  }, [needsYou]);
}
