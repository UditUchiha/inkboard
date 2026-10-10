import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary, PageCrashed } from "./components/ErrorBoundary";
import { reloadOnce } from "./lib/chunkReload";
import "./index.css";

// Vite reports here when a file a page needs (its code or styles) can't be downloaded, typically because a deploy
// replaced it since this tab loaded. Reloading gets the new version. The error isn't cancelled: cancelling would hand
// the page an empty module instead, while letting it through reaches lazyPage, which waits for the reload (or, when
// the reload was just tried, shows the error page).
window.addEventListener("vite:preloadError", () => reloadOnce());

// index.html always has the #root element this mounts into.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary fallback={PageCrashed}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
