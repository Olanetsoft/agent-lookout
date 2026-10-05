import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/index.css";
import App from "@dashboard/App";
import { ErrorBoundary } from "@dashboard/components/ui/feedback/ErrorBoundary";

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html has no #root element to render into.");
}

createRoot(container).render(
  <StrictMode>
    {/* Whatever goes wrong while drawing, the page says so. It is never left empty. */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
