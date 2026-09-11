import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installRuntime } from "./lib/module-ui";
import "./index.css";

// Before anything renders: module scripts read React and the query client from
// here rather than bundling their own, and a second React would break hooks.
installRuntime();

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

/*
 * Hold the application itself, so a reload with no connection still opens.
 *
 * For the till above all: a counter serving people does not stop because a
 * router did, and the till already keeps its menu and queues what it sells —
 * but none of that survived somebody pressing reload, because the application
 * is served by the instance.
 *
 * Only in a built instance. In development the page is served by Vite and a
 * worker sitting in front of it would answer a reload with whatever it happened
 * to have, which is a very confusing way to spend an afternoon.
 */
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // Failure is not worth reporting: an instance served over plain http on a
    // private network cannot register one at all, and it still works — it just
    // does not survive a reload with the line down.
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
