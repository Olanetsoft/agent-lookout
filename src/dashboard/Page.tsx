import { useState } from "react";

import App from "@dashboard/App";
import { ErrorBoundary } from "@dashboard/components/ui/feedback/ErrorBoundary";
import { workerBeat } from "@dashboard/lib/api/beat";
import { createCollectorStore } from "@dashboard/lib/api/collectorStore";

/**
 * The app with a store that polls the local server, on a beat that keeps time
 * while the tab is in the background. The store starts nothing until the app
 * subscribes to it.
 */
function PolledApp() {
  const [store] = useState(() => createCollectorStore({ beat: workerBeat }));
  return <App store={store} />;
}

/**
 * The dashboard as its own page draws it: the app and its store, under the
 * boundary that says so when drawing fails.
 *
 * The store is made under the boundary, so each time the app is drawn afresh
 * it has a new one. After a fault, "Try again" starts from a store that asks
 * the server again and draws what it answers now, not the answer that could
 * not be drawn. The landing page's tour renders the app with its own store
 * instead, so its build carries none of this.
 */
export default function Page() {
  return (
    // Whatever goes wrong while drawing, the page says so. It is never left empty.
    <ErrorBoundary>
      <PolledApp />
    </ErrorBoundary>
  );
}
