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

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
