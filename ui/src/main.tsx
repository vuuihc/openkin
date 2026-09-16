import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { bootstrapTokenFromURL } from "./api/client";
import { initTheme } from "./lib/theme";
import "./index.css";

initTheme();

const root = document.getElementById("root");
if (!root) {
  throw new Error("root element missing");
}

void bootstrapTokenFromURL().finally(() => {
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
});
