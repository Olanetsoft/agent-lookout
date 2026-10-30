import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/index.css";
import Page from "@dashboard/Page";
import { markAppWindow } from "@dashboard/lib/shell/appWindow";

// In the Mac app's window, the rail makes room for the window's buttons.
markAppWindow();

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html has no #root element to render into.");
}

createRoot(container).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
