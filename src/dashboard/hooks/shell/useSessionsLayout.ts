import { useCallback, useState } from "react";

import {
  keepSessionsLayout,
  readSessionsLayout,
  type SessionsLayout,
} from "@dashboard/lib/shell/sessionsLayout";

/**
 * The Sessions card's layout, list or board, read from local storage when the
 * card first draws, and kept there each time the person chooses.
 */
export function useSessionsLayout(): [SessionsLayout, (layout: SessionsLayout) => void] {
  const [layout, setLayout] = useState(readSessionsLayout);
  const choose = useCallback((next: SessionsLayout) => {
    keepSessionsLayout(next);
    setLayout(next);
  }, []);
  return [layout, choose];
}
