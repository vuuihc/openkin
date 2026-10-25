import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { bootstrapTokenFromURL, getToken } from "./api/client";
import { applyVisitGate, refreshAccount } from "./api/account";
import { initTheme } from "./lib/theme";
import "./index.css";

initTheme();

const root = document.getElementById("root");
if (!root) {
  throw new Error("root element missing");
}

/**
 * Resolve the auth gate before the first render.
 *
 * Both halves are needed to know which gate applies: the URL may carry a device
 * token, and the daemon may be a Hub that signs browsers in with a cookie
 * instead. Probing first means a signed-in Hub user never sees the token screen
 * flash by, and a standalone daemon never sees a login form it cannot serve.
 */
void Promise.all([bootstrapTokenFromURL(), refreshAccount()]).then(() => {
  // A device token still works on a Hub, so it wins when one is present.
  if (!getToken()) applyVisitGate();
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
});
