import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { captureTokenFromURL } from "./api/client";
import { initTheme } from "./lib/theme";
import "./index.css";

// Spec §6: QR / shared links pass ?token=; stash in localStorage and strip URL.
captureTokenFromURL();
initTheme();

const root = document.getElementById("root");
if (!root) {
  throw new Error("root element missing");
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
